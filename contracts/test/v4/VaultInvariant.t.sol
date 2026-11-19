// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PQAccess} from "../../src/v3/PQAccess.sol";
import {MLDSA87} from "../../src/v3/MLDSA87.sol";
import {RobotRegistryV4} from "../../src/v4/RobotRegistryV4.sol";
import {EscrowVaultV3} from "../../src/v4/EscrowVaultV3.sol";
import {MockPQC87} from "../mocks/MockPQC87.sol";

/// @dev Drives random sequences of deposits, rounds, verdicts, claims, withdrawals, pauses and
///      time jumps. Every call is allowed to fail; the invariants must hold whatever happens.
contract VaultHandlerV4 is Test {
    RobotRegistryV4 internal reg;
    EscrowVaultV3 internal vault;
    uint256 internal robotId;
    address internal owner;
    address internal admin;
    bytes internal ownerPk;
    bytes internal adminPk;
    bytes internal refereePk;
    address[3] internal players;
    bytes[3] internal playerPks;

    uint256[] public sessionIds;
    uint256 public paidToPlayers;
    uint256 public paidToOwner;
    uint256 public deposited;

    constructor(
        RobotRegistryV4 r,
        EscrowVaultV3 v,
        uint256 id,
        address o,
        bytes memory oPk,
        address a,
        bytes memory aPk,
        bytes memory refPk,
        address[3] memory ps,
        bytes[3] memory pks
    ) {
        reg = r;
        vault = v;
        robotId = id;
        owner = o;
        ownerPk = oPk;
        admin = a;
        adminPk = aPk;
        refereePk = refPk;
        players = ps;
        playerPks = pks;
    }

    function _sig(bytes memory pk, bytes32 digest) internal pure returns (bytes memory) {
        return abi.encodePacked(keccak256(abi.encode(pk, abi.encodePacked(digest))), new bytes(MLDSA87.SIGNATURE_LENGTH - 32));
    }

    function deposit(uint96 amount) external {
        uint256 a = bound(uint256(amount), 1 ether, 50 ether);
        vm.deal(address(this), a);
        try vault.depositBounty{value: a}(robotId) {
            deposited += a;
        } catch {}
    }

    function play(uint8 who, bool breach, uint32 thinkTime) external {
        uint256 i = who % 3;
        uint256 d = block.timestamp + 5 minutes;
        bytes32 dg = reg.startSessionDigest(robotId, players[i], reg.nonces(players[i]), d);
        try reg.startSessionFor(robotId, players[i], d, _sig(playerPks[i], dg)) returns (uint256 sid) {
            sessionIds.push(sid);
            vm.warp(block.timestamp + bound(uint256(thinkTime), 0, 80 minutes));
            _judge(sid, breach);
        } catch {}
    }

    /// Start a round now and judge it later (another handler call), so verdicts interleave with
    /// pauses, withdrawal requests and time jumps.
    function startOnly(uint8 who) external {
        uint256 i = who % 3;
        uint256 d = block.timestamp + 5 minutes;
        bytes32 dg = reg.startSessionDigest(robotId, players[i], reg.nonces(players[i]), d);
        try reg.startSessionFor(robotId, players[i], d, _sig(playerPks[i], dg)) returns (uint256 sid) {
            sessionIds.push(sid);
        } catch {}
    }

    function judgeLater(uint8 seed, bool breach) external {
        if (sessionIds.length == 0) return;
        _judge(sessionIds[uint256(seed) % sessionIds.length], breach);
    }

    function _judge(uint256 sid, bool breach) internal {
        address p = reg.getSession(sid).player;
        uint256 rd = block.timestamp + 1;
        bytes32 rdg = reg.resultDigest(sid, robotId, p, breach, keccak256(abi.encode(sid)), rd);
        try reg.recordResult(sid, breach, keccak256(abi.encode(sid)), rd, refereePk, _sig(refereePk, rdg)) {} catch {}
    }

    /// Set when a withdrawal completed although a breach that could win the bounty was still
    /// unjudged, or had been judged less than an hour earlier (no fair chance to claim).
    bool public winBeatenByWithdrawal;

    function _bountyTimes(uint256 b) internal view returns (uint256 r, uint64 dep, uint64 req) {
        (, bytes memory raw) = address(vault).staticcall(abi.encodeCall(vault.bounties, (b)));
        EscrowVaultV3.Bounty memory x = abi.decode(raw, (EscrowVaultV3.Bounty));
        return (x.robotId, x.depositedAt, x.withdrawRequestedAt);
    }

    function _winnableBreachPending(uint256 b) internal view returns (bool) {
        (uint256 bRobot, uint64 depositedAt, uint64 requestedAt) = _bountyTimes(b);
        for (uint256 k = 0; k < sessionIds.length; k++) {
            RobotRegistryV4.Session memory s = reg.getSession(sessionIds[k]);
            if (s.robotId != bRobot || s.startedAt < depositedAt) continue;
            if (s.startedAt > uint256(requestedAt) + vault.START_GRACE()) continue;
            if (s.outcome == RobotRegistryV4.Outcome.None && block.timestamp <= uint256(s.startedAt) + reg.SESSION_TTL() + reg.RESULT_GRACE()) return true; // could still be a breach
            if (s.outcome == RobotRegistryV4.Outcome.Breached && block.timestamp < uint256(s.resultAt) + 1 hours) return true;
        }
        return false;
    }

    /// Skip unpayable breaches, then claim the earliest valid one (as the relayer does).
    function claim(uint8 bountySeed) external {
        uint256 n = vault.nextBountyId();
        if (n == 1) return;
        uint256 b = 1 + (uint256(bountySeed) % (n - 1));
        _skipAll(b);
        (EscrowVaultV3.Next st, uint256 sid) = vault.nextBreach(b);
        if (st != EscrowVaultV3.Next.Claimable) return;
        address p = reg.getSession(sid).player;
        uint256 before = p.balance;
        vault.claimBounty(b);
        paidToPlayers += p.balance - before;
    }

    function _skipAll(uint256 b) internal {
        for (uint256 k = 0; k < 50; k++) {
            (EscrowVaultV3.Next st,) = vault.nextBreach(b);
            if (st != EscrowVaultV3.Next.Skippable) return;
            vault.skipBreach(b);
        }
    }

    function requestWithdraw(uint8 bountySeed) external {
        uint256 n = vault.nextBountyId();
        if (n == 1) return;
        uint256 b = 1 + (uint256(bountySeed) % (n - 1));
        uint256 d = block.timestamp + 5 minutes;
        bytes32 dg = vault.withdrawDigest(b, owner, vault.nonces(owner), d);
        try vault.requestWithdraw(b, owner, d, _sig(ownerPk, dg)) {} catch {}
    }

    function finalize(uint8 bountySeed) external {
        uint256 n = vault.nextBountyId();
        if (n == 1) return;
        uint256 b = 1 + (uint256(bountySeed) % (n - 1));
        _skipAll(b);
        uint256 before = owner.balance;
        bool pending = _winnableBreachPending(b);
        try vault.finalizeWithdraw(b) {
            paidToOwner += owner.balance - before;
            if (pending) winBeatenByWithdrawal = true;
        } catch {}
    }

    function togglePause() external {
        bool p = !vault.paused();
        uint256 d = block.timestamp + 5 minutes;
        bytes32 dg = vault.setPausedDigest(p, vault.nonces(admin), d);
        try vault.setPaused(p, d, _sig(adminPk, dg)) {} catch {}
    }

    function wait(uint32 secs) external {
        vm.warp(block.timestamp + bound(uint256(secs), 1, 8 days));
    }
}

contract VaultInvariantV4Test is Test {
    address constant VERIFY = 0x0000000000000000000000000000000000000a01;
    address constant STATUS = 0x0000000000000000000000000000000000000a02;

    RobotRegistryV4 internal reg;
    EscrowVaultV3 internal vault;
    VaultHandlerV4 internal handler;

    function _key(bytes memory seed) internal pure returns (bytes memory pk) {
        pk = new bytes(MLDSA87.PUBKEY_LENGTH);
        for (uint256 i = 0; i < seed.length; i++) pk[i] = seed[i];
    }

    function _sig(bytes memory pk, bytes32 digest) internal pure returns (bytes memory) {
        return abi.encodePacked(keccak256(abi.encode(pk, abi.encodePacked(digest))), new bytes(MLDSA87.SIGNATURE_LENGTH - 32));
    }

    function setUp() public {
        vm.warp(1_700_000_000);
        MockPQC87 impl = new MockPQC87();
        vm.etch(VERIFY, address(impl).code);
        vm.etch(STATUS, address(impl).code);
        MockPQC87 keys = MockPQC87(STATUS);

        address admin = makeAddr("admin");
        address owner = makeAddr("owner");
        bytes memory adminPk = _key(hex"a1");
        bytes memory ownerPk = _key(hex"b2");
        bytes memory refereePk = _key(hex"c3");
        keys.setKey(admin, adminPk);
        keys.setKey(owner, ownerPk);
        address[3] memory ps = [makeAddr("p0"), makeAddr("p1"), makeAddr("p2")];
        bytes[3] memory pks = [_key(hex"d0"), _key(hex"d1"), _key(hex"d2")];
        for (uint256 i = 0; i < 3; i++) keys.setKey(ps[i], pks[i]);

        {
            bytes32 td = keccak256("RedZone.Deploy(bytes32 domainTag,uint256 chainId,address deployer)");
            bytes32 rd = keccak256(abi.encode(td, keccak256("RedZone.RobotRegistry.v4"), block.chainid, admin));
            bytes32 vd = keccak256(abi.encode(td, keccak256("RedZone.EscrowVault.v3"), block.chainid, admin));
            vm.startPrank(admin);
            reg = new RobotRegistryV4(refereePk, "qorechain-diana", _sig(adminPk, rd), _sig(refereePk, rd), 0, address(0));
            vault = new EscrowVaultV3(reg, "qorechain-diana", _sig(adminPk, vd));
            vm.stopPrank();
        }

        uint256 robotId;
        {
            uint256 dl = block.timestamp + 5 minutes;
            bytes32 rgd = reg.registerRobotDigest(owner, keccak256("Guard Dog"), keccak256("brain"), 0, dl);
            robotId = reg.registerRobotFor(owner, "Guard Dog", keccak256("brain"), dl, _sig(ownerPk, rgd));
        }

        handler = new VaultHandlerV4(reg, vault, robotId, owner, ownerPk, admin, adminPk, refereePk, ps, pks);
        targetContract(address(handler));
    }

    /// The vault always holds at least what it owes.
    function invariant_BalanceCoversLocked() public view {
        assertGe(address(vault).balance, vault.totalLocked());
    }

    /// Money in = money still locked + money paid out. Nothing is created or lost.
    function invariant_MoneyIsConserved() public view {
        assertEq(handler.deposited(), vault.totalLocked() + handler.paidToPlayers() + handler.paidToOwner());
    }

    function _amountStatus(uint256 i) internal view returns (uint256 amount, EscrowVaultV3.Status st) {
        (, bytes memory raw) = address(vault).staticcall(abi.encodeCall(vault.bounties, (i)));
        EscrowVaultV3.Bounty memory x = abi.decode(raw, (EscrowVaultV3.Bounty));
        return (x.amount, x.status);
    }

    /// totalLocked equals the sum of open bounties, and closed bounties hold nothing.
    function invariant_LockedMatchesOpenBounties() public view {
        uint256 sum;
        uint256 n = vault.nextBountyId();
        for (uint256 i = 1; i < n; i++) {
            (uint256 amount, EscrowVaultV3.Status st) = _amountStatus(i);
            if (st == EscrowVaultV3.Status.Open) sum += amount;
            else assertEq(amount, 0);
        }
        assertEq(sum, vault.totalLocked());
    }

    /// A breach that could win a bounty is never beaten by the owner's withdrawal: the owner is
    /// paid only after every eligible round is judged and each win had at least an hour to claim.
    function invariant_WinsAreNeverBeatenByWithdrawal() public view {
        assertFalse(handler.winBeatenByWithdrawal());
    }

    /// Sanity: the handler really reaches payouts (so the invariants are not vacuous).
    function test_HandlerReachesPayouts() public {
        handler.deposit(5 ether);
        handler.deposit(3 ether);
        handler.play(0, true, 60); // breach, judged in time
        handler.claim(0);
        handler.claim(1);
        assertEq(handler.paidToPlayers(), 8 ether);
        handler.deposit(2 ether);
        handler.requestWithdraw(2);
        handler.wait(4 hours);
        handler.finalize(2);
        assertEq(handler.paidToOwner(), 2 ether);
        assertEq(vault.totalLocked(), 0);
    }
}
