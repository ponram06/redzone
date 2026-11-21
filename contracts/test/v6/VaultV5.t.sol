// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PQGuard} from "../../src/PQGuard.sol";
import {PQAccess} from "../../src/v3/PQAccess.sol";
import {RobotRegistryV4} from "../../src/v4/RobotRegistryV4.sol";
import {EscrowVaultV5} from "../../src/v5/EscrowVaultV5.sol";
import {MockPQC87} from "../mocks/MockPQC87.sol";
import {MLDSA87} from "../../src/v3/MLDSA87.sol";
import {QoreXMessage} from "../../src/QoreXMessage.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev Re-enters the vault from its receive hook.
contract ReentererV6 {
    EscrowVaultV5 internal vault;
    uint256 internal bountyId;
    uint256 internal sessionId;
    bool public tried;
    bool public reentered;

    constructor(EscrowVaultV5 v) {
        vault = v;
    }

    function arm(uint256 b, uint256 s) external {
        bountyId = b;
        sessionId = s; // kept for readability: the vault pays the earliest breach itself
    }

    receive() external payable {
        if (tried) return;
        tried = true;
        try vault.claimBounty(bountyId) {
            reentered = true;
        } catch {}
    }
}

/// @dev Refuses all payments.
contract RefuserV6 {
    receive() external payable {
        revert("no");
    }
}

/// @dev Shared setup and helpers (also used by Branches.t.sol).
abstract contract VaultV5Base is Test {
    address constant VERIFY = 0x0000000000000000000000000000000000000a01;
    address constant STATUS = 0x0000000000000000000000000000000000000a02;
    bytes constant CHAIN = "qorechain-diana";

    RobotRegistryV4 internal reg;
    EscrowVaultV5 internal vault;
    MockPQC87 internal keys;

    address internal admin = makeAddr("admin");
    address internal owner = makeAddr("owner");
    address internal player = makeAddr("player");
    address internal player2 = makeAddr("player2");
    address internal relayer = makeAddr("relayer");
    address internal attacker = makeAddr("attacker");

    bytes internal adminPk = hex"a11ce0";
    bytes internal ownerPk = hex"0b0b0b";
    bytes internal playerPk = hex"0c0c0c";
    bytes internal player2Pk = hex"0d0d0d";
    bytes internal refereePk = hex"5e5e5e";
    bytes internal attackerPk = hex"bad0";

    uint256 internal robotId;

    function setUp() public {
        vm.warp(1_700_000_000);
        adminPk = _key(adminPk);
        ownerPk = _key(ownerPk);
        playerPk = _key(playerPk);
        player2Pk = _key(player2Pk);
        refereePk = _key(refereePk);
        attackerPk = _key(attackerPk);
        MockPQC87 impl = new MockPQC87();
        vm.etch(VERIFY, address(impl).code);
        vm.etch(STATUS, address(impl).code);
        keys = MockPQC87(STATUS);
        keys.setKey(admin, adminPk);
        keys.setKey(owner, ownerPk);
        keys.setKey(player, playerPk);
        keys.setKey(player2, player2Pk);
        keys.setKey(attacker, attackerPk);

        vm.startPrank(admin);
        reg = _newReg(refereePk, CHAIN);
        vault = _newVault(reg, CHAIN);
        vm.stopPrank();

        vm.deal(relayer, 1000 ether);
        vm.deal(attacker, 10 ether);
        robotId = _registerRobot("Guard Dog");
    }

    // -------------------------------------------------------------- helpers

    bytes32 internal constant DEPLOY_TYPEHASH = keccak256("RedZone.Deploy(bytes32 domainTag,uint256 chainId,address deployer)");

    function _deployDigest(string memory tag, address deployer) internal view returns (bytes32) {
        return keccak256(abi.encode(DEPLOY_TYPEHASH, keccak256(bytes(tag)), block.chainid, deployer));
    }

    /// @dev Deploy the registry as `admin` with real deploy-time proofs.
    function _newReg(bytes memory refPk, bytes memory chain) internal returns (RobotRegistryV4) {
        bytes32 dg = _deployDigest("RedZone.RobotRegistry.v4", admin);
        return new RobotRegistryV4(refPk, chain, _sig(adminPk, dg), _sig(refPk, dg), 0, address(0));
    }

    function _newVault(RobotRegistryV4 r, bytes memory chain) internal returns (EscrowVaultV5) {
        return new EscrowVaultV5(r, chain, _sig(adminPk, _deployDigest("RedZone.EscrowVault.v5", admin)));
    }

    /// @dev A 2592-byte test public key derived from a short seed.
    function _key(bytes memory seed) internal pure returns (bytes memory pk) {
        pk = new bytes(MLDSA87.PUBKEY_LENGTH);
        for (uint256 i = 0; i < seed.length; i++) pk[i] = seed[i];
    }

    /// @dev Same scheme as MockPQC87, computed locally so vm.expectRevert targets the contract call.
    function _sigOver(bytes memory pk, bytes memory message) internal pure returns (bytes memory) {
        return abi.encodePacked(keccak256(abi.encode(pk, message)), new bytes(MLDSA87.SIGNATURE_LENGTH - 32));
    }

    function _sig(bytes memory pk, bytes32 digest) internal pure returns (bytes memory) {
        return _sigOver(pk, abi.encodePacked(digest));
    }

    function _walletSig(PQAccess c, bytes memory pk, string memory action, bytes32 digest) internal view returns (bytes memory) {
        return _sigOver(pk, c.walletMessage(action, digest));
    }

    function _dl() internal view returns (uint256) {
        return block.timestamp + 10 minutes;
    }

    // v4 keeps the admin-only digest helpers internal (smaller code); tests compute them the same way.
    function _regDigest(bytes memory structData) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(keccak256("RedZone.RobotRegistry.v4"), block.chainid, address(reg), keccak256(structData)));
    }

    function _proposeRefereeDigest(bytes32 h, uint256 nonce, uint256 deadline) internal view returns (bytes32) {
        return _regDigest(abi.encode(keccak256("RedZone.ProposeReferee(bytes32 pubkeyHash,uint256 nonce,uint256 deadline)"), h, nonce, deadline));
    }

    function _cancelRefereeDigest(bytes32 h, uint256 nonce, uint256 deadline) internal view returns (bytes32) {
        return _regDigest(abi.encode(keccak256("RedZone.CancelReferee(bytes32 pubkeyHash,uint256 nonce,uint256 deadline)"), h, nonce, deadline));
    }

    function _setTryPriceDigest(uint256 price, address t, uint256 nonce, uint256 deadline) internal view returns (bytes32) {
        return _regDigest(abi.encode(keccak256("RedZone.SetTryPrice(uint256 price,address treasury,uint256 nonce,uint256 deadline)"), price, t, nonce, deadline));
    }

    function _registerRobot(string memory name) internal returns (uint256 id) {
        uint256 d = _dl();
        bytes32 dg = reg.registerRobotDigest(owner, keccak256(bytes(name)), keccak256("brain"), reg.nonces(owner), d);
        vm.prank(relayer);
        id = reg.registerRobotFor(owner, name, keccak256("brain"), d, _walletSig(reg, ownerPk, "RegisterRobot", dg));
    }

    function _start(address p, bytes memory pk) internal returns (uint256 sid) {
        uint256 d = _dl();
        bytes32 dg = reg.startSessionDigest(robotId, p, reg.nonces(p), d);
        vm.prank(relayer);
        sid = reg.startSessionFor(robotId, p, d, _walletSig(reg, pk, "StartSession", dg));
    }

    function _record(uint256 sid, bool breached) internal {
        RobotRegistryV4.Session memory s = reg.getSession(sid);
        uint256 d = uint256(s.startedAt) + 70 minutes;
        bytes32 dg = reg.resultDigest(sid, s.robotId, s.player, breached, keccak256("replay"), d);
        reg.recordResult(sid, breached, keccak256("replay"), d, refereePk, _sig(refereePk, dg));
    }

    function _deposit(uint256 amount) internal returns (uint256 id) {
        vm.prank(relayer);
        id = vault.depositBounty{value: amount}(robotId);
    }

    function _requestWithdraw(uint256 id, address to) internal {
        uint256 d = _dl();
        bytes32 dg = vault.withdrawDigest(id, to, vault.nonces(owner), d);
        vault.requestWithdraw(id, to, d, _walletSig(vault, ownerPk, "WithdrawBounty", dg));
    }

    function _status(uint256 id) internal view returns (EscrowVaultV5.Status st) {
        (,,,,, st,,,,,) = vault.bounties(id);
    }

}

contract VaultV5Test is VaultV5Base {
    // ------------------------------------------------------ happy paths

    function test_FullRound_BreachPaysPlayer() public {
        uint256 id = _deposit(5 ether);
        uint256 sid = _start(player, playerPk);
        _record(sid, true);
        vm.prank(attacker); // anyone can trigger; money still goes to the player
        vault.claimBounty(id);
        assertEq(player.balance, 5 ether);
        assertEq(vault.totalLocked(), 0);
        assertEq(address(vault).balance, 0);
        assertEq(uint8(_status(id)), uint8(EscrowVaultV5.Status.Claimed));
    }

    function test_BountyBelongsToRobotOwnerNotFunder() public {
        uint256 id = _deposit(2 ether);
        (,,, address o,,,,,,,) = vault.bounties(id);
        assertEq(o, owner);
    }

    function test_Withdraw_TwoStepAfterDelay() public {
        uint256 id = _deposit(3 ether);
        _requestWithdraw(id, owner);
        vm.expectRevert(EscrowVaultV5.WithdrawLocked.selector);
        vault.finalizeWithdraw(id);
        vm.warp(block.timestamp + 3 hours);
        vault.finalizeWithdraw(id);
        assertEq(owner.balance, 3 ether);
        assertEq(vault.totalLocked(), 0);
    }

    // ------------------------------------------------------- claim attacks

    function test_Attack_ClaimWithoutBreach() public {
        uint256 id = _deposit(1 ether);
        uint256 sid = _start(player, playerPk);
        vm.expectRevert(abi.encodeWithSelector(EscrowVaultV5.NothingToClaim.selector, EscrowVaultV5.Next.None)); // no verdict yet
        vault.claimBounty(id);
        _record(sid, false);
        vm.expectRevert(abi.encodeWithSelector(EscrowVaultV5.NothingToClaim.selector, EscrowVaultV5.Next.None)); // defended
        vault.claimBounty(id);
    }

    function test_Attack_ClaimWithNoBreaches() public {
        uint256 id = _deposit(1 ether);
        vm.expectRevert(abi.encodeWithSelector(EscrowVaultV5.NothingToClaim.selector, EscrowVaultV5.Next.None));
        vault.claimBounty(id);
        (EscrowVaultV5.Next st,) = vault.nextBreach(id);
        assertEq(uint8(st), uint8(EscrowVaultV5.Next.None));
    }

    function test_Attack_ClaimWithBreachOfOtherRobot() public {
        uint256 other = _registerRobot("Other");
        uint256 id = _deposit(1 ether); // on robotId
        uint256 d = _dl();
        bytes32 dg = reg.startSessionDigest(other, player, reg.nonces(player), d);
        uint256 sid = reg.startSessionFor(other, player, d, _sig(playerPk, dg));
        _record(sid, true);
        vm.expectRevert(abi.encodeWithSelector(EscrowVaultV5.NothingToClaim.selector, EscrowVaultV5.Next.None)); // a breach of another robot is not in this robot's list
        vault.claimBounty(id);
    }

    function test_Attack_OldBreachCannotTakeNewBounty() public {
        uint256 sid = _start(player, playerPk);
        _record(sid, true);
        vm.warp(block.timestamp + 1);
        uint256 id = _deposit(1 ether); // cursor starts after the existing breach
        vm.expectRevert(abi.encodeWithSelector(EscrowVaultV5.NothingToClaim.selector, EscrowVaultV5.Next.None));
        vault.claimBounty(id);
    }

    function test_Attack_DoubleClaim() public {
        uint256 id = _deposit(1 ether);
        uint256 sid = _start(player, playerPk);
        _record(sid, true);
        vault.claimBounty(id);
        vm.expectRevert(EscrowVaultV5.BountyNotOpen.selector);
        vault.claimBounty(id);
    }

    function test_OneBreachClaimsEveryOpenBounty() public {
        uint256 a = _deposit(1 ether);
        uint256 b = _deposit(2 ether);
        uint256 sid = _start(player, playerPk);
        _record(sid, true);
        vault.claimBounty(a);
        vault.claimBounty(b);
        assertEq(player.balance, 3 ether);
    }

    function test_Attack_ReentrancyOnClaim() public {
        ReentererV6 r = new ReentererV6(vault);
        keys.setKey(address(r), _key(hex"0e0e"));
        uint256 a = _deposit(1 ether);
        uint256 b = _deposit(1 ether);
        uint256 d = _dl();
        bytes32 dg = reg.startSessionDigest(robotId, address(r), reg.nonces(address(r)), d);
        uint256 sid = reg.startSessionFor(robotId, address(r), d, _sig(_key(hex"0e0e"), dg));
        _record(sid, true);
        r.arm(b, sid);
        vault.claimBounty(a);
        assertTrue(r.tried());
        assertFalse(r.reentered());
        assertEq(uint8(_status(b)), uint8(EscrowVaultV5.Status.Open));
        assertEq(vault.totalLocked(), 1 ether);
    }

    function test_FailedPaymentRevertsEverything() public {
        RefuserV6 r = new RefuserV6();
        keys.setKey(address(r), _key(hex"0f0f"));
        uint256 id = _deposit(1 ether);
        uint256 d = _dl();
        bytes32 dg = reg.startSessionDigest(robotId, address(r), reg.nonces(address(r)), d);
        uint256 sid = reg.startSessionFor(robotId, address(r), d, _sig(_key(hex"0f0f"), dg));
        _record(sid, true);
        vm.expectRevert(abi.encodeWithSelector(EscrowVaultV5.TransferFailed.selector, address(r), 1 ether));
        vault.claimBounty(id);
        assertEq(uint8(_status(id)), uint8(EscrowVaultV5.Status.Open));
        assertEq(vault.totalLocked(), 1 ether);
    }

    // ------------------------------------------- withdraw vs payout race (self-review #1)

    function test_WinInProgressIsPaidBeforeWithdrawal() public {
        uint256 id = _deposit(4 ether);
        uint256 sid = _start(player, playerPk);
        _requestWithdraw(id, owner); // owner sees the attack coming and tries to pull out
        vm.warp(block.timestamp + 70 minutes); // latest moment the result can still be recorded
        _record(sid, true);
        vault.claimBounty(id);
        assertEq(player.balance, 4 ether);
        vm.warp(block.timestamp + 3 hours);
        vm.expectRevert(EscrowVaultV5.BountyNotOpen.selector);
        vault.finalizeWithdraw(id);
    }

    function test_SessionAfterWithdrawRequestCannotClaim() public {
        uint256 id = _deposit(1 ether);
        _requestWithdraw(id, owner);
        vm.warp(block.timestamp + 10 minutes + 1);
        uint256 sid = _start(player, playerPk);
        _record(sid, true);
        vm.expectRevert(abi.encodeWithSelector(EscrowVaultV5.NothingToClaim.selector, EscrowVaultV5.Next.Skippable));
        vault.claimBounty(id);
        vault.skipBreach(id);
        (EscrowVaultV5.Next st,) = vault.nextBreach(id);
        assertEq(uint8(st), uint8(EscrowVaultV5.Next.None));
    }

    function test_Attack_WithdrawSignedByOthers() public {
        uint256 id = _deposit(1 ether);
        uint256 d = _dl();
        bytes32 dg = vault.withdrawDigest(id, attacker, vault.nonces(owner), d);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        vault.requestWithdraw(id, attacker, d, _sig(attackerPk, dg));
        // the relayer that funded it can't take it either
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        vault.requestWithdraw(id, relayer, d, _sig(adminPk, dg));
    }

    function test_Attack_WithdrawSigReplayAndRedirect() public {
        uint256 a = _deposit(1 ether);
        uint256 b = _deposit(1 ether);
        uint256 d = _dl();
        bytes32 dg = vault.withdrawDigest(a, owner, vault.nonces(owner), d);
        bytes memory s = _sig(ownerPk, dg);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector); // other destination
        vault.requestWithdraw(a, attacker, d, s);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector); // other bounty
        vault.requestWithdraw(b, owner, d, s);
        vault.requestWithdraw(a, owner, d, s);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector); // nonce used
        vault.requestWithdraw(a, owner, d, s);
    }

    function test_Attack_FinalizeWithoutRequest() public {
        uint256 id = _deposit(1 ether);
        vm.expectRevert(EscrowVaultV5.WithdrawNotRequested.selector);
        vault.finalizeWithdraw(id);
    }

    // ----------------------------------------------------------- deposits

    function test_Attack_DepositChecks() public {
        vm.prank(relayer);
        vm.expectRevert(EscrowVaultV5.AmountTooSmall.selector);
        vault.depositBounty{value: 0.5 ether}(robotId);
        vm.prank(relayer);
        vm.expectRevert(EscrowVaultV5.UnknownRobot.selector);
        vault.depositBounty{value: 1 ether}(42);
        vm.prank(relayer);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok);
    }

    function testFuzz_LockedAlwaysMatchesBalance(uint96 a, uint96 b, bool claimFirst) public {
        uint256 x = bound(uint256(a), 1 ether, 100 ether);
        uint256 y = bound(uint256(b), 1 ether, 100 ether);
        uint256 i = _deposit(x);
        uint256 j = _deposit(y);
        assertEq(vault.totalLocked(), address(vault).balance);
        uint256 sid = _start(player, playerPk);
        _record(sid, true);
        vault.claimBounty(claimFirst ? i : j);
        assertEq(vault.totalLocked(), address(vault).balance);
        assertEq(vault.totalLocked(), claimFirst ? y : x);
    }

    // -------------------------------------------------------------- pause (self-review #3)

    function _pause(bool p) internal {
        uint256 d = _dl();
        bytes32 dg = vault.setPausedDigest(p, vault.nonces(admin), d);
        vault.setPaused(p, d, _sig(adminPk, dg));
    }

    function test_Pause_ResultBeforePauseStaysClaimable() public {
        uint256 id = _deposit(1 ether);
        uint256 sid = _start(player, playerPk);
        _record(sid, true);
        vm.warp(block.timestamp + 1);
        _pause(true);
        vault.claimBounty(id);
        assertEq(player.balance, 1 ether);
    }

    function test_Pause_ResultDuringPauseWaits() public {
        uint256 id = _deposit(1 ether);
        uint256 sid = _start(player, playerPk);
        _pause(true);
        _record(sid, true); // registry is not paused
        vm.expectRevert(abi.encodeWithSelector(EscrowVaultV5.NothingToClaim.selector, EscrowVaultV5.Next.Waiting));
        vault.claimBounty(id);
        vm.expectRevert(abi.encodeWithSelector(EscrowVaultV5.NothingToSkip.selector, EscrowVaultV5.Next.Waiting));
        vault.skipBreach(id); // a waiting win can't be skipped either
        _pause(false);
        vault.claimBounty(id);
        assertEq(player.balance, 1 ether);
    }

    function test_Pause_FreezesDepositsAndPayouts() public {
        uint256 id = _deposit(1 ether);
        _pause(true);
        vm.prank(relayer);
        vm.expectRevert(PQAccess.Paused.selector);
        vault.depositBounty{value: 1 ether}(robotId);
        _requestWithdraw(id, owner); // asking is allowed
        vm.warp(block.timestamp + 3 hours);
        vm.expectRevert(PQAccess.Paused.selector);
        vault.finalizeWithdraw(id);
        _pause(false);
        vm.expectRevert(EscrowVaultV5.WithdrawLocked.selector); // wins get UNPAUSE_GRACE first
        vault.finalizeWithdraw(id);
        vm.warp(block.timestamp + 1 hours);
        vault.finalizeWithdraw(id);
        assertEq(owner.balance, 1 ether);
    }

    /// Reviewer M-1: a win recorded during a pause can't be lost to a withdrawal.
    function test_Pause_WinDuringPauseBeatsWithdrawal() public {
        uint256 id = _deposit(2 ether);
        uint256 sid = _start(player, playerPk);
        _requestWithdraw(id, owner);
        vm.warp(block.timestamp + 59 minutes);
        _pause(true);
        _record(sid, true);
        vm.warp(block.timestamp + 5 hours);
        vm.expectRevert(PQAccess.Paused.selector);
        vault.finalizeWithdraw(id);
        _pause(false);
        vm.expectRevert(EscrowVaultV5.WithdrawLocked.selector);
        vault.finalizeWithdraw(id);
        vault.claimBounty(id);
        assertEq(player.balance, 2 ether);
    }

    function test_Pause_RegistryPauseKeepsVerdicts() public {
        uint256 sid = _start(player, playerPk);
        uint256 d = _dl();
        reg.setPaused(true, d, _sig(adminPk, reg.setPausedDigest(true, reg.nonces(admin), d)));
        _record(sid, true); // already-started rounds still get their verdict
        assertEq(uint8(reg.getSession(sid).outcome), uint8(RobotRegistryV4.Outcome.Breached));
        bytes32 dg = reg.startSessionDigest(robotId, player, reg.nonces(player), d);
        vm.expectRevert(PQAccess.Paused.selector); // but no new rounds
        reg.startSessionFor(robotId, player, d, _sig(playerPk, dg));
    }

    function test_Pause_SameValueRefused() public {
        _pause(true);
        uint256 d = _dl();
        bytes32 dg = vault.setPausedDigest(true, vault.nonces(admin), d);
        vm.expectRevert(PQAccess.PauseUnchanged.selector);
        vault.setPaused(true, d, _sig(adminPk, dg));
    }

    /// Reviewer M-2: an owner can't front-run a player's start with a withdrawal request.
    function test_Attack_OwnerFrontRunsStartWithWithdraw() public {
        uint256 id = _deposit(1 ether);
        _requestWithdraw(id, owner);
        vm.warp(block.timestamp + 10 minutes); // player's start lands later, within START_GRACE
        uint256 sid = _start(player, playerPk);
        vm.warp(block.timestamp + 70 minutes);
        _record(sid, true);
        vault.claimBounty(id);
        assertEq(player.balance, 1 ether);
    }

    /// Reviewer L-1: a withdrawal to an address that refuses payment can be re-requested.
    function test_Withdraw_ReRequestFixesBadDestination() public {
        RefuserV6 r = new RefuserV6();
        uint256 id = _deposit(1 ether);
        _requestWithdraw(id, address(r));
        vm.warp(block.timestamp + 3 hours);
        vm.expectRevert(abi.encodeWithSelector(EscrowVaultV5.TransferFailed.selector, address(r), 1 ether));
        vault.finalizeWithdraw(id);
        _requestWithdraw(id, owner);
        vm.expectRevert(EscrowVaultV5.WithdrawLocked.selector); // delay restarts
        vault.finalizeWithdraw(id);
        vm.warp(block.timestamp + 3 hours);
        vault.finalizeWithdraw(id);
        assertEq(owner.balance, 1 ether);
    }

    // ------------------------------------------------------------- access control (QCAI #1)

    function test_Attack_AdminActionsNeedAdminSignature() public {
        uint256 d = _dl();
        bytes32 dg = vault.setPausedDigest(true, vault.nonces(admin), d);
        vm.prank(admin); // being the admin's EVM address is not enough
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        vault.setPaused(true, d, _sig(attackerPk, dg));

        dg = vault.transferAdminDigest(attacker, vault.nonces(admin), d);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        vault.transferAdmin(attacker, d, _sig(attackerPk, dg));

        dg = _proposeRefereeDigest(keccak256(attackerPk), reg.nonces(admin), d);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.proposeReferee(attackerPk, d, _sig(attackerPk, dg), _sig(attackerPk, dg));
    }

    function test_Attack_AdminSigReplay() public {
        uint256 d = _dl();
        bytes32 dg = vault.setPausedDigest(true, vault.nonces(admin), d);
        bytes memory s = _sig(adminPk, dg);
        vault.setPaused(true, d, s);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        vault.setPaused(true, d, s);
        // a vault signature is useless on the registry
        dg = reg.setPausedDigest(true, reg.nonces(admin), d);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.setPaused(true, d, s);
    }

    function test_AdminTransfer_TwoStep() public {
        uint256 d = _dl();
        bytes32 dg = reg.transferAdminDigest(player, reg.nonces(admin), d);
        reg.transferAdmin(player, d, _sig(adminPk, dg));
        assertEq(reg.admin(), admin); // nothing changes until accepted

        dg = reg.acceptAdminDigest(player, reg.adminProposalId(), reg.nonces(player), d);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.acceptAdmin(d, _sig(attackerPk, dg));
        reg.acceptAdmin(d, _walletSig(reg, playerPk, "AcceptAdmin", dg));
        assertEq(reg.admin(), player);
        assertEq(reg.pendingAdmin(), address(0));
    }

    function test_Attack_AdminDeadlineLimits() public {
        uint256 far = block.timestamp + 2 hours;
        bytes32 dg = vault.setPausedDigest(true, vault.nonces(admin), far);
        vm.expectRevert(PQAccess.DeadlineTooFar.selector);
        vault.setPaused(true, far, _sig(adminPk, dg));
        uint256 past = block.timestamp - 1;
        dg = vault.setPausedDigest(true, vault.nonces(admin), past);
        vm.expectRevert(PQAccess.Expired.selector);
        vault.setPaused(true, past, _sig(adminPk, dg));
    }

    // ------------------------------------------------------- referee time-lock (self-review #2)

    function test_RefereeChange_IsTimeLocked() public {
        uint256 d = _dl();
        bytes memory newPk = _key(hex"7777");
        bytes32 dg = _proposeRefereeDigest(keccak256(newPk), reg.nonces(admin), d);
        reg.proposeReferee(newPk, d, _sig(adminPk, dg), _sig(newPk, dg));

        // the new key can't record anything yet
        uint256 sid = _start(player, playerPk);
        uint256 rd = block.timestamp + 70 minutes;
        bytes32 rdg = reg.resultDigest(sid, robotId, player, true, keccak256("r"), rd);
        vm.expectRevert(RobotRegistryV4.NotReferee.selector); // not active yet
        reg.recordResult(sid, true, keccak256("r"), rd, newPk, _sig(newPk, rdg));
        vm.expectRevert(RobotRegistryV4.RefereeDelayNotOver.selector);
        reg.activateReferee();

        vm.warp(block.timestamp + 2 days);
        reg.activateReferee();
        assertEq(reg.refereeKeyHash(), keccak256(newPk));
        vm.expectRevert(RobotRegistryV4.NoPendingReferee.selector);
        reg.activateReferee();
    }

    // ----------------------------------------------------- results (QCAI #4 replay)

    function test_Attack_ResultBoundToRobotAndPlayer() public {
        uint256 sid = _start(player, playerPk);
        uint256 d = block.timestamp + 70 minutes;
        // a verdict signed for another player or robot does not fit this session
        bytes32 wrongPlayer = reg.resultDigest(sid, robotId, player2, true, keccak256("r"), d);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.recordResult(sid, true, keccak256("r"), d, refereePk, _sig(refereePk, wrongPlayer));
        bytes32 wrongRobot = reg.resultDigest(sid, robotId + 1, player, true, keccak256("r"), d);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.recordResult(sid, true, keccak256("r"), d, refereePk, _sig(refereePk, wrongRobot));
        // flipping the outcome breaks the signature
        bytes32 defended = reg.resultDigest(sid, robotId, player, false, keccak256("r"), d);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.recordResult(sid, true, keccak256("r"), d, refereePk, _sig(refereePk, defended));
    }

    function test_Attack_ResultReplayAndTiming() public {
        uint256 sid = _start(player, playerPk);
        _record(sid, false);
        RobotRegistryV4.Session memory s = reg.getSession(sid);
        assertEq(s.resultAt, block.timestamp);
        uint256 d = uint256(s.startedAt) + 70 minutes;
        bytes32 dg = reg.resultDigest(sid, robotId, player, true, keccak256("replay"), d);
        vm.expectRevert(RobotRegistryV4.AlreadyRecorded.selector);
        reg.recordResult(sid, true, keccak256("replay"), d, refereePk, _sig(refereePk, dg));

        uint256 sid2 = _start(player, playerPk);
        vm.warp(block.timestamp + 70 minutes + 1);
        d = block.timestamp + 1;
        dg = reg.resultDigest(sid2, robotId, player, true, keccak256("replay"), d);
        vm.expectRevert(RobotRegistryV4.ResultTooLate.selector);
        reg.recordResult(sid2, true, keccak256("replay"), d, refereePk, _sig(refereePk, dg));
    }

    function test_Attack_SessionRequestReplay() public {
        uint256 d = _dl();
        bytes32 dg = reg.startSessionDigest(robotId, player, reg.nonces(player), d);
        bytes memory s = _sig(playerPk, dg);
        reg.startSessionFor(robotId, player, d, s);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.startSessionFor(robotId, player, d, s);
    }

    function test_Attack_OwnerCannotAttackOwnRobot() public {
        uint256 d = _dl();
        bytes32 dg = reg.startSessionDigest(robotId, owner, reg.nonces(owner), d);
        vm.expectRevert(RobotRegistryV4.OwnRobot.selector);
        reg.startSessionFor(robotId, owner, d, _sig(ownerPk, dg));
    }

    function test_DailyLimit() public {
        for (uint256 i = 0; i < 5; i++) _start(player, playerPk);
        uint256 d = _dl();
        bytes32 dg = reg.startSessionDigest(robotId, player, reg.nonces(player), d);
        vm.expectRevert(RobotRegistryV4.DailyLimitReached.selector);
        reg.startSessionFor(robotId, player, d, _sig(playerPk, dg));
    }

    // ------------------------------------------------------------ names (QCAI #5)

    function test_Attack_BadNames() public {
        string[5] memory bad = ["", " lead", "trail ", "tab\there", "\xe2\x80\xaeevil"];
        uint256 d = _dl();
        for (uint256 i = 0; i < bad.length; i++) {
            vm.expectRevert(RobotRegistryV4.BadName.selector);
            reg.registerRobotFor(owner, bad[i], keccak256("b"), d, "");
        }
        bytes memory long = new bytes(65);
        for (uint256 i = 0; i < 65; i++) long[i] = "a";
        vm.expectRevert(RobotRegistryV4.BadName.selector);
        reg.registerRobotFor(owner, string(long), keccak256("b"), d, "");
    }

    function test_Utility_ReplayAndBounds() public {
        uint256 d = _dl();
        bytes32 dg = reg.utilityDigest(robotId, 11, keccak256("u"), 0, d);
        vm.expectRevert(RobotRegistryV4.BadUtility.selector);
        reg.recordUtility(robotId, 11, keccak256("u"), d, refereePk, _sig(refereePk, dg));
        dg = reg.utilityDigest(robotId, 8, keccak256("u"), 0, d);
        bytes memory s = _sig(refereePk, dg);
        reg.recordUtility(robotId, 8, keccak256("u"), d, refereePk, s);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.recordUtility(robotId, 8, keccak256("u"), d, refereePk, s);
    }

    function test_Attack_PrecompileMissingFailsClosed() public {
        uint256 id = _deposit(1 ether);
        uint256 d = _dl();
        bytes memory s = _sig(ownerPk, vault.withdrawDigest(id, owner, 0, d));
        vm.etch(VERIFY, "");
        vm.expectRevert(PQGuard.PQCPrecompileUnavailable.selector);
        vault.requestWithdraw(id, owner, d, s);
    }

    /// Reviewer L-3: a pending admin can be cancelled.
    function test_AdminTransfer_Cancel() public {
        uint256 d = _dl();
        reg.transferAdmin(player, d, _sig(adminPk, reg.transferAdminDigest(player, reg.nonces(admin), d)));
        reg.transferAdmin(address(0), d, _sig(adminPk, reg.transferAdminDigest(address(0), reg.nonces(admin), d)));
        bytes32 dg = reg.acceptAdminDigest(player, reg.adminProposalId(), reg.nonces(player), d);
        vm.expectRevert(PQAccess.NotPendingAdmin.selector);
        reg.acceptAdmin(d, _sig(playerPk, dg));
        assertEq(reg.admin(), admin);
    }

    /// Reviewer L-4: a verdict on an old brain doesn't count toward the new brain's stats.
    function test_OldBrainVerdictNotCounted() public {
        uint256 sid = _start(player, playerPk);
        uint256 d = _dl();
        bytes32 dg = reg.updateBrainDigest(robotId, keccak256("brain2"), reg.nonces(owner), d);
        reg.updateBrain(robotId, keccak256("brain2"), d, _sig(ownerPk, dg));
        _record(sid, true);
        RobotRegistryV4.Robot memory r = reg.getRobot(robotId);
        assertEq(r.attacks, 0);
        assertEq(r.breached, 0);
        assertEq(uint8(reg.getSession(sid).outcome), uint8(RobotRegistryV4.Outcome.Breached));
    }

    /// Reviewer L-6: a relayer can't hold a start request for long.
    function test_Attack_StartRequestHeldTooLong() public {
        uint256 d = block.timestamp + 30 minutes;
        bytes32 dg = reg.startSessionDigest(robotId, player, reg.nonces(player), d);
        vm.expectRevert(RobotRegistryV4.StartRequestTooLong.selector);
        reg.startSessionFor(robotId, player, d, _sig(playerPk, dg));
    }

    /// Reviewer M-A: a pause ends by itself, and pauses cannot be chained.
    function test_Pause_ExpiresAndHasCooldown() public {
        uint256 id = _deposit(1 ether);
        _requestWithdraw(id, owner);
        _pause(true);
        vm.warp(block.timestamp + 7 days - 1);
        vm.expectRevert(PQAccess.Paused.selector);
        vault.finalizeWithdraw(id);
        vm.warp(block.timestamp + 1); // pause expired at pausedAt + 7 days
        assertFalse(vault.isPaused());
        vm.expectRevert(EscrowVaultV5.WithdrawLocked.selector); // wins get UNPAUSE_GRACE first
        vault.finalizeWithdraw(id);
        vm.warp(block.timestamp + 1 hours);
        // admin tries to re-freeze right away: must unpause, then wait the cooldown
        _pause(false);
        uint256 d = _dl();
        bytes32 dg = vault.setPausedDigest(true, vault.nonces(admin), d);
        vm.expectRevert(PQAccess.PauseCooldown.selector);
        vault.setPaused(true, d, _sig(adminPk, dg));
        vault.finalizeWithdraw(id);
        assertEq(owner.balance, 1 ether);
    }

    // ================================================ QCAI stage 2 findings

    /// HIGH "signature malleability": a different valid signature over a used digest is refused.
    function test_Stage2_SecondSignatureOverUsedDigestRefused() public {
        uint256 sid = _start(player, playerPk);
        uint256 d = uint256(reg.getSession(sid).startedAt) + 70 minutes;
        bytes32 dg = reg.resultDigest(sid, robotId, player, true, keccak256("r"), d);
        bytes memory s1 = _sig(refereePk, dg);
        reg.recordResult(sid, true, keccak256("r"), d, refereePk, s1);
        assertTrue(reg.usedDigests(dg));
        bytes memory s2 = bytes.concat(s1); // same message, different bytes (another valid ML-DSA signature)
        s2[4626] = 0x01;
        vm.expectRevert(abi.encodeWithSelector(PQAccess.DigestUsed.selector, dg));
        reg.recordResult(sid, true, keccak256("r"), d, refereePk, s2);
    }

    function test_Stage2_UserDigestsMarkedUsed() public {
        uint256 d = _dl();
        bytes32 dg = reg.startSessionDigest(robotId, player, reg.nonces(player), d);
        reg.startSessionFor(robotId, player, d, _sig(playerPk, dg));
        assertTrue(reg.usedDigests(dg));
        assertEq(reg.nonces(player), 1);
    }

    function test_Stage2_WrongSignatureLengthRefused() public {
        uint256 d = _dl();
        bytes32 dg = reg.startSessionDigest(robotId, player, reg.nonces(player), d);
        bytes memory good = _sig(playerPk, dg);
        bytes memory short_ = new bytes(4626);
        bytes memory long_ = bytes.concat(good, hex"00");
        for (uint256 i = 0; i < 32; i++) short_[i] = good[i];
        vm.expectRevert(abi.encodeWithSelector(MLDSA87.BadSignatureLength.selector, 4626));
        reg.startSessionFor(robotId, player, d, short_);
        vm.expectRevert(abi.encodeWithSelector(MLDSA87.BadSignatureLength.selector, 4628));
        reg.startSessionFor(robotId, player, d, long_);
        vm.expectRevert(abi.encodeWithSelector(MLDSA87.BadSignatureLength.selector, 0));
        reg.startSessionFor(robotId, player, d, "");
    }

    function test_Stage2_NonMLDSA87KeyRefused() public {
        keys.setKeyWithAlgorithm(player2, player2Pk, 2); // e.g. another PQ scheme
        uint256 d = _dl();
        bytes32 dg = reg.startSessionDigest(robotId, player2, reg.nonces(player2), d);
        vm.expectRevert(abi.encodeWithSelector(MLDSA87.NotMLDSA87Key.selector, player2, uint8(2)));
        reg.startSessionFor(robotId, player2, d, _sig(player2Pk, dg));
        keys.setKey(player2, hex"0d0d"); // wrong key length
        vm.expectRevert(abi.encodeWithSelector(MLDSA87.BadPubkeyLength.selector, 2));
        reg.startSessionFor(robotId, player2, d, _sig(hex"0d0d", dg));
    }

    function test_Stage2_RefereeKeyMustBeMLDSA87() public {
        uint256 d = _dl();
        bytes memory shortKey = hex"7777";
        bytes32 dg = _proposeRefereeDigest(keccak256(shortKey), reg.nonces(admin), d);
        vm.expectRevert(abi.encodeWithSelector(MLDSA87.BadPubkeyLength.selector, 2));
        reg.proposeReferee(shortKey, d, _sig(adminPk, dg), "");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(MLDSA87.BadPubkeyLength.selector, 3));
        new RobotRegistryV4(hex"5e5e5e", CHAIN, _sig(adminPk, _deployDigest("RedZone.RobotRegistry.v4", admin)), "", 0, address(0));
    }

    /// MEDIUM reentrancy: OpenZeppelin ReentrancyGuard blocks re-entry into any guarded function.
    function test_Stage2_OZGuardBlocksCrossFunctionReentry() public {
        ReentererV6 r = new ReentererV6(vault);
        keys.setKey(address(r), _key(hex"0e0e"));
        uint256 a = _deposit(1 ether);
        uint256 d = _dl();
        bytes32 dg = reg.startSessionDigest(robotId, address(r), reg.nonces(address(r)), d);
        uint256 sid = reg.startSessionFor(robotId, address(r), d, _sig(_key(hex"0e0e"), dg));
        _record(sid, true);
        r.arm(a, sid); // tries to claim the same bounty again from inside the payment
        vault.claimBounty(a);
        assertTrue(r.tried());
        assertFalse(r.reentered());
        assertEq(address(r).balance, 1 ether);
        assertEq(vault.totalLocked(), 0);
    }

    /// MEDIUM session expiry: exact, inclusive boundaries from one source of truth.
    function test_Stage2_SessionBoundaries() public {
        uint256 sid = _start(player, playerPk);
        uint256 t0 = reg.getSession(sid).startedAt;
        // v4 keeps these times internal; the SessionStarted event and the constants give them.
        assertEq(uint256(t0) + reg.SESSION_TTL(), t0 + 10 minutes);
        assertEq(uint256(t0) + reg.SESSION_TTL() + reg.RESULT_GRACE(), t0 + 70 minutes);

        vm.warp(t0 + 70 minutes); // last valid second
        _record(sid, true);

        uint256 sid2 = _start(player, playerPk);
        uint256 t2 = reg.getSession(sid2).startedAt;
        vm.warp(t2 + 70 minutes + 1); // one second late
        uint256 d = block.timestamp;
        bytes32 dg = reg.resultDigest(sid2, robotId, player, true, keccak256("r"), d);
        vm.expectRevert(RobotRegistryV4.ResultTooLate.selector);
        reg.recordResult(sid2, true, keccak256("r"), d, refereePk, _sig(refereePk, dg));
    }

    function testFuzz_Stage2_ResultWindow(uint32 delay) public {
        uint256 sid = _start(player, playerPk);
        uint256 t0 = reg.getSession(sid).startedAt;
        vm.warp(t0 + bound(uint256(delay), 0, 3 hours));
        uint256 d = block.timestamp;
        bytes32 dg = reg.resultDigest(sid, robotId, player, false, keccak256("r"), d);
        bytes memory sg = _sig(refereePk, dg);
        if (block.timestamp > t0 + 70 minutes) {
            vm.expectRevert(RobotRegistryV4.ResultTooLate.selector);
            reg.recordResult(sid, false, keccak256("r"), d, refereePk, sg);
        } else {
            reg.recordResult(sid, false, keccak256("r"), d, refereePk, sg);
            assertEq(uint8(reg.getSession(sid).outcome), uint8(RobotRegistryV4.Outcome.Defended));
        }
    }

    /// LOW chain id length: explicit limit in v3.
    function test_Stage2_ChainIdLength() public {
        assertEq(reg.MAX_CHAIN_ID_LENGTH(), 64);
        bytes memory longId = new bytes(65);
        for (uint256 i = 0; i < 65; i++) longId[i] = "a";
        vm.startPrank(admin);
        vm.expectRevert(PQAccess.BadChainId.selector);
        _newReg(refereePk, longId);
        vm.expectRevert(PQAccess.BadChainId.selector);
        _newReg(refereePk, "");
        bytes memory maxId = new bytes(64);
        for (uint256 i = 0; i < 64; i++) maxId[i] = "a";
        _newReg(refereePk, maxId); // exactly 64 is fine
        vm.stopPrank();
    }

    /// INFO precompile availability: detectable without reverting; actions fail closed.
    function test_Stage2_PrecompileAvailability() public {
        assertTrue(reg.isPQAvailable());
        uint256 d = _dl();
        bytes memory sg = _sig(playerPk, reg.startSessionDigest(robotId, player, 0, d));
        vm.etch(VERIFY, "");
        assertFalse(reg.isPQAvailable());
        vm.expectRevert(PQGuard.PQCPrecompileUnavailable.selector);
        reg.startSessionFor(robotId, player, d, sg);
        vm.etch(STATUS, "");
        assertFalse(vault.isPQAvailable());
    }

    // ================================================ ratings and views

    function _utility(uint8 n) internal {
        uint256 d = _dl();
        bytes32 dg = reg.utilityDigest(robotId, n, keccak256("u"), reg.getRobot(robotId).utilityNonce, d);
        reg.recordUtility(robotId, n, keccak256("u"), d, refereePk, _sig(refereePk, dg));
    }

    function _playMany(uint256 defended, uint256 breached) internal {
        for (uint256 i = 0; i < defended + breached; i++) {
            address p = makeAddr(string(abi.encode("p", i)));
            bytes memory pk = _key(abi.encodePacked(uint16(i + 1000)));
            keys.setKey(p, pk);
            uint256 sid = _start(p, pk);
            _record(sid, i >= defended);
        }
    }

    function test_RatingAndTiers() public {
        assertEq(reg.getRating(robotId), 0);
        assertEq(uint8(reg.getTier(robotId)), uint8(RobotRegistryV4.Tier.Rookie));
        _utility(10);
        _playMany(9, 1); // 90% safe, full utility, 10 attacks
        assertEq(reg.getRating(robotId), 9_000);
        assertEq(uint8(reg.getTier(robotId)), uint8(RobotRegistryV4.Tier.Guard));
        _playMany(40, 0); // 49/50 = 98%
        assertEq(uint8(reg.getTier(robotId)), uint8(RobotRegistryV4.Tier.Sentinel));
        _utility(5); // half utility halves the rating
        assertEq(reg.getRating(robotId), 4_900);
        assertEq(uint8(reg.getTier(robotId)), uint8(RobotRegistryV4.Tier.Rookie));
    }

    function test_Views() public {
        assertEq(reg.attemptsLeftToday(player), 5);
        _start(player, playerPk);
        assertEq(reg.attemptsLeftToday(player), 4);
        for (uint256 i = 0; i < 4; i++) _start(player, playerPk);
        assertEq(reg.attemptsLeftToday(player), 0);
        vm.warp(block.timestamp + 1 days);
        assertEq(reg.attemptsLeftToday(player), 5); // new UTC day

        RobotRegistryV4.Robot memory r = reg.getRobot(robotId);
        assertEq(r.owner, owner);
        assertEq(r.name, "Guard Dog");
        assertEq(reg.robotOwner(robotId), owner);
        assertEq(reg.robotOwner(999), address(0));
        bytes32 dg = keccak256("x");
        assertEq(reg.walletMessage("StartSession", dg), abi.encodePacked("qorechain-msg-v1|qorechain-diana|", QoreXMessage.text("StartSession", dg)));
    }

    /// Audit L-01: there is no msg.sender (ECDSA) path. Holding a player's ECDSA key is not enough.
    function test_NoEcdsaShortcuts() public {
        uint256 d = _dl();
        bytes32 dg = reg.startSessionDigest(robotId, player, reg.nonces(player), d);
        vm.prank(player); // the attacker controls the player's EVM key
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.startSessionFor(robotId, player, d, _sig(attackerPk, dg));
        assertEq(reg.attemptsLeftToday(player), 5);
        bytes32 rg = reg.registerRobotDigest(player, keccak256("Mine"), keccak256("b"), reg.nonces(player), d);
        vm.prank(player);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.registerRobotFor(player, "Mine", keccak256("b"), d, _sig(attackerPk, rg));
    }

    function test_UnknownRobotAndUtilityChecks() public {
        uint256 d = _dl();
        bytes32 dg = reg.startSessionDigest(999, player, reg.nonces(player), d);
        vm.expectRevert(RobotRegistryV4.UnknownRobot.selector);
        reg.startSessionFor(999, player, d, _sig(playerPk, dg));
        dg = reg.utilityDigest(999, 5, keccak256("u"), 0, d);
        vm.expectRevert(RobotRegistryV4.UnknownRobot.selector);
        reg.recordUtility(999, 5, keccak256("u"), d, refereePk, _sig(refereePk, dg));
        dg = reg.updateBrainDigest(robotId, keccak256("b"), reg.nonces(owner), d);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.updateBrain(robotId, keccak256("b"), d, _sig(attackerPk, dg));
    }

    // ================================================ deploy-time format proof

    /// A bad deployer proof fails the deployment (nothing can ever be deposited).
    function test_Deploy_NeedsWorkingDeployerKey() public {
        bytes32 dg = _deployDigest("RedZone.RobotRegistry.v4", admin);
        vm.startPrank(admin);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        new RobotRegistryV4(refereePk, CHAIN, _sig(attackerPk, dg), _sig(refereePk, dg), 0, address(0));
        bytes memory wrongLength = new bytes(4595); // e.g. a round-3 Dilithium5 signature
        vm.expectRevert(abi.encodeWithSelector(MLDSA87.BadSignatureLength.selector, 4595));
        new RobotRegistryV4(refereePk, CHAIN, wrongLength, _sig(refereePk, dg), 0, address(0));
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        new EscrowVaultV5(reg, CHAIN, _sig(adminPk, dg)); // a registry proof is not a vault proof
        vm.stopPrank();
    }

    /// The referee key must prove it works at deployment.
    function test_Deploy_NeedsWorkingRefereeKey() public {
        bytes32 dg = _deployDigest("RedZone.RobotRegistry.v4", admin);
        vm.prank(admin);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        new RobotRegistryV4(refereePk, CHAIN, _sig(adminPk, dg), _sig(attackerPk, dg), 0, address(0));
    }

    /// A deployer proof can't be reused by another deployer or on another chain.
    function test_Deploy_ProofBoundToDeployerAndChain() public {
        bytes32 dg = _deployDigest("RedZone.RobotRegistry.v4", admin);
        bytes memory p = _sig(adminPk, dg);
        vm.prank(owner); // owner has a key, but the proof was for admin
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        new RobotRegistryV4(refereePk, CHAIN, p, _sig(refereePk, dg), 0, address(0));
        vm.chainId(1);
        vm.prank(admin);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        new RobotRegistryV4(refereePk, CHAIN, p, _sig(refereePk, dg), 0, address(0));
        assertEq(reg.deployDigest("RedZone.RobotRegistry.v4", admin), _deployDigest("RedZone.RobotRegistry.v4", admin));
    }

    /// A new referee key must sign its own proposal.
    function test_ProposeReferee_NewKeyMustProveItself() public {
        uint256 d = _dl();
        bytes memory newPk = _key(hex"7777");
        bytes32 dg = _proposeRefereeDigest(keccak256(newPk), reg.nonces(admin), d);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.proposeReferee(newPk, d, _sig(adminPk, dg), _sig(attackerPk, dg));
        vm.expectRevert(abi.encodeWithSelector(MLDSA87.BadSignatureLength.selector, 0));
        reg.proposeReferee(newPk, d, _sig(adminPk, dg), "");
        reg.proposeReferee(newPk, d, _sig(adminPk, dg), _sig(newPk, dg));
        assertEq(reg.pendingRefereeKeyHash(), keccak256(newPk));
    }

    /// Only the key matching refereeKeyHash can judge, even with a valid signature of its own.
    function test_Attack_OtherKeyCannotJudge() public {
        uint256 sid = _start(player, playerPk);
        uint256 d = block.timestamp + 70 minutes;
        bytes32 dg = reg.resultDigest(sid, robotId, player, true, keccak256("r"), d);
        vm.expectRevert(RobotRegistryV4.NotReferee.selector);
        reg.recordResult(sid, true, keccak256("r"), d, attackerPk, _sig(attackerPk, dg));
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector); // right key, wrong signer
        reg.recordResult(sid, true, keccak256("r"), d, refereePk, _sig(attackerPk, dg));
        assertEq(reg.refereeKeyHash(), keccak256(refereePk));
    }

    // ================================================ audit 3 (adversarial review) regressions

    /// M-01: a stored-up sybil breach can no longer steal a later honest win, and the caller
    /// cannot choose which breach is paid.
    function test_Audit3_StockpiledBreachExpires() public {
        address sybil = makeAddr("sybil");
        bytes memory sybilPk = _key(hex"5b1b");
        keys.setKey(sybil, sybilPk);
        uint256 id = _deposit(5 ether);
        uint256 sybilSid = _start(sybil, sybilPk);
        _record(sybilSid, true); // owner's own account "breaches" via a backdoor
        vm.warp(block.timestamp + 1 days + 1); // ... and keeps it for later
        uint256 honestSid = _start(player, playerPk);
        _record(honestSid, true);
        // the sybil breach expired: it can't be paid, only skipped
        vm.expectRevert(abi.encodeWithSelector(EscrowVaultV5.NothingToClaim.selector, EscrowVaultV5.Next.Skippable));
        vault.claimBounty(id);
        vault.skipBreach(id);
        vault.claimBounty(id); // pays the earliest valid breach: the honest player
        assertEq(player.balance, 5 ether);
        assertEq(sybil.balance, 0);
    }

    /// M-01: with two valid breaches, the earlier one is paid whoever calls.
    function test_Audit3_EarliestBreachWinsWhoeverCalls() public {
        uint256 id = _deposit(2 ether);
        uint256 a = _start(player, playerPk);
        uint256 b = _start(player2, player2Pk);
        _record(a, true);
        _record(b, true);
        vm.prank(player2); // the later breacher tries to claim
        vault.claimBounty(id);
        assertEq(player.balance, 2 ether);
        assertEq(player2.balance, 0);
    }

    /// M-01: the owner can't finish a withdrawal while a win is waiting to be claimed.
    function test_Audit3_WithdrawWaitsForPendingWin() public {
        uint256 id = _deposit(3 ether);
        uint256 sid = _start(player, playerPk);
        _record(sid, true);
        _requestWithdraw(id, owner);
        vm.warp(block.timestamp + 3 hours);
        vm.expectRevert(EscrowVaultV5.WinPending.selector);
        vault.finalizeWithdraw(id);
        vault.claimBounty(id);
        assertEq(player.balance, 3 ether);
    }

    /// M-01: an unclaimed win expires after CLAIM_WINDOW; then the owner may withdraw.
    function test_Audit3_ExpiredWinCanBeSkippedThenWithdraw() public {
        uint256 id = _deposit(1 ether);
        uint256 sid = _start(player, playerPk);
        _record(sid, true);
        _requestWithdraw(id, owner);
        vm.warp(block.timestamp + 1 days + 1);
        vm.expectRevert(EscrowVaultV5.WinPending.selector);
        vault.finalizeWithdraw(id);
        vault.skipBreach(id);
        vault.finalizeWithdraw(id);
        assertEq(owner.balance, 1 ether);
    }

    /// L-02: a withdrawal request that is never finalised lapses; the bounty is winnable again.
    function test_Audit3_StaleWithdrawRequestLapses() public {
        uint256 id = _deposit(1 ether);
        _requestWithdraw(id, owner);
        vm.warp(block.timestamp + 3 hours + 7 days + 1);
        vm.expectRevert(EscrowVaultV5.WithdrawExpired.selector);
        vault.finalizeWithdraw(id);
        uint256 sid = _start(player, playerPk);
        _record(sid, true);
        vault.claimBounty(id);
        assertEq(player.balance, 1 ether);
    }

    /// A win recorded during a pause gets a full claim window after the pause ends.
    function test_Audit3_PauseExtendsClaimWindow() public {
        uint256 id = _deposit(1 ether);
        uint256 sid = _start(player, playerPk);
        _pause(true);
        _record(sid, true);
        vm.warp(block.timestamp + 3 days);
        _pause(false);
        assertEq(vault.claimDeadline(reg.getSession(sid).resultAt), block.timestamp + 1 days);
        vm.warp(block.timestamp + 23 hours);
        vault.claimBounty(id);
        assertEq(player.balance, 1 ether);
    }

    /// I-04: an acceptance signature is bound to one admin proposal.
    function test_Audit3_AcceptBoundToProposal() public {
        uint256 d = _dl();
        reg.transferAdmin(player, d, _sig(adminPk, reg.transferAdminDigest(player, reg.nonces(admin), d)));
        bytes32 oldAccept = reg.acceptAdminDigest(player, reg.adminProposalId(), reg.nonces(player), d);
        bytes memory oldSig = _sig(playerPk, oldAccept);
        reg.transferAdmin(address(0), d, _sig(adminPk, reg.transferAdminDigest(address(0), reg.nonces(admin), d)));
        reg.transferAdmin(player, d, _sig(adminPk, reg.transferAdminDigest(player, reg.nonces(admin), d)));
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.acceptAdmin(d, oldSig);
    }

    /// I-02: a pending referee proposal can be cancelled.
    function test_Audit3_CancelRefereeProposal() public {
        uint256 d = _dl();
        bytes memory newPk = _key(hex"7777");
        bytes32 dg = _proposeRefereeDigest(keccak256(newPk), reg.nonces(admin), d);
        reg.proposeReferee(newPk, d, _sig(adminPk, dg), _sig(newPk, dg));
        bytes32 cg = _cancelRefereeDigest(keccak256(newPk), reg.nonces(admin), d);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.cancelReferee(d, _sig(attackerPk, cg));
        reg.cancelReferee(d, _sig(adminPk, cg));
        assertEq(reg.pendingRefereeKeyHash(), bytes32(0));
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(RobotRegistryV4.NoPendingReferee.selector);
        reg.activateReferee();
    }

    // ======================================================== v4: play pass

    function _openPass(address p, bytes memory pk, address operator, uint256 validUntil, uint256 maxRounds) internal {
        uint256 d = _dl();
        bytes32 dg = reg.openPassDigest(p, operator, validUntil, maxRounds, reg.nonces(p), d);
        reg.openPassFor(p, operator, validUntil, maxRounds, d, _walletSig(reg, pk, "OpenPass", dg));
    }

    /// One signature, then several rounds with no further signature.
    function test_Pass_OneSignatureManyRounds() public {
        _openPass(player, playerPk, relayer, block.timestamp + 10 minutes, 3);
        vm.startPrank(relayer);
        uint256 a = reg.startSessionWithPass(robotId, player);
        uint256 b = reg.startSessionWithPass(robotId, player);
        uint256 c = reg.startSessionWithPass(robotId, player);
        vm.expectRevert(RobotRegistryV4.PassUsedUp.selector);
        reg.startSessionWithPass(robotId, player);
        vm.stopPrank();
        assertEq(reg.getSession(a).player, player);
        assertEq(reg.getSession(c).player, player);
        assertTrue(b != a && c != b);
        assertEq(reg.attemptsLeftToday(player), 2); // pass rounds still count toward the daily tries
    }

    function test_Pass_OnlyOperatorAndOnlyInTime() public {
        _openPass(player, playerPk, relayer, block.timestamp + 10 minutes, 5);
        vm.prank(attacker);
        vm.expectRevert(RobotRegistryV4.NotPassOperator.selector);
        reg.startSessionWithPass(robotId, player);
        // No pass at all for player2.
        vm.prank(relayer);
        vm.expectRevert(RobotRegistryV4.NotPassOperator.selector);
        reg.startSessionWithPass(robotId, player2);
        vm.warp(block.timestamp + 10 minutes + 1);
        vm.prank(relayer);
        vm.expectRevert(RobotRegistryV4.PassExpired.selector);
        reg.startSessionWithPass(robotId, player);
    }

    function test_Pass_BoundsAndSignature() public {
        uint256 d = _dl();
        uint256 tooLong = block.timestamp + 10 minutes + 1;
        bytes memory sig = _passSig(player, playerPk, relayer, tooLong, 5, d);
        vm.expectRevert(RobotRegistryV4.BadPass.selector);
        reg.openPassFor(player, relayer, tooLong, 5, d, sig);
        uint256 ok = block.timestamp + 5 minutes;
        for (uint256 n = 0; n <= 21; n += 21) {
            sig = _passSig(player, playerPk, relayer, ok, n, d);
            vm.expectRevert(RobotRegistryV4.BadPass.selector);
            reg.openPassFor(player, relayer, ok, n, d, sig);
        }
        sig = _passSig(player, playerPk, address(0), ok, 5, d);
        vm.expectRevert(RobotRegistryV4.BadPass.selector);
        reg.openPassFor(player, address(0), ok, 5, d, sig);
        // Another key, even with the player's stolen EVM key, can't open a pass for the player.
        sig = _passSig(player, attackerPk, attacker, ok, 20, d);
        vm.prank(player);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.openPassFor(player, attacker, ok, 20, d, sig);
        // A pass signature works once.
        sig = _passSig(player, playerPk, relayer, ok, 2, d);
        reg.openPassFor(player, relayer, ok, 2, d, sig);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.openPassFor(player, relayer, ok, 2, d, sig);
    }

    function _passSig(address p, bytes memory pk, address operator, uint256 validUntil, uint256 maxRounds, uint256 d)
        internal
        view
        returns (bytes memory)
    {
        bytes32 dg = reg.openPassDigest(p, operator, validUntil, maxRounds, reg.nonces(p), d);
        return _walletSig(reg, pk, "OpenPass", dg);
    }

    function test_Pass_CannotAttackOwnRobotOrBeatDailyLimit() public {
        _openPass(owner, ownerPk, relayer, block.timestamp + 10 minutes, 5);
        vm.prank(relayer);
        vm.expectRevert(RobotRegistryV4.OwnRobot.selector);
        reg.startSessionWithPass(robotId, owner);
        for (uint256 i = 0; i < 5; i++) _start(player, playerPk);
        _openPass(player, playerPk, relayer, block.timestamp + 10 minutes, 5);
        vm.prank(relayer);
        vm.expectRevert(RobotRegistryV4.DailyLimitReached.selector);
        reg.startSessionWithPass(robotId, player);
    }

    // ======================================================== v4: paid tries

    address internal treasury = makeAddr("treasury");

    function _setPrice(uint256 price, address t) internal {
        uint256 d = _dl();
        bytes32 dg = _setTryPriceDigest(price, t, reg.nonces(admin), d);
        reg.setTryPrice(price, t, d, _sig(adminPk, dg));
    }

    function test_Tries_OffUntilPriced() public {
        vm.prank(relayer);
        vm.expectRevert(RobotRegistryV4.TriesNotForSale.selector);
        reg.buyTries{value: 0.1 ether}(player, 1);
    }

    function test_Tries_PaymentGoesStraightToTreasury() public {
        _setPrice(0.1 ether, treasury);
        vm.prank(relayer);
        reg.buyTries{value: 0.3 ether}(player, 3);
        assertEq(treasury.balance, 0.3 ether);
        assertEq(address(reg).balance, 0);
        assertEq(reg.extraTries(player), 3);
        assertEq(reg.attemptsLeftToday(player), 8);
        vm.startPrank(relayer);
        vm.expectRevert(abi.encodeWithSelector(RobotRegistryV4.WrongPayment.selector, 0.2 ether, 0.1 ether));
        reg.buyTries{value: 0.1 ether}(player, 2);
        vm.expectRevert(RobotRegistryV4.BadTryCount.selector);
        reg.buyTries{value: 0}(player, 0);
        vm.expectRevert(PQAccess.ZeroAddress.selector);
        reg.buyTries{value: 0.1 ether}(address(0), 1);
        vm.stopPrank();
    }

    function test_Tries_UsedOnlyAfterFreeTriesAndKeptAcrossDays() public {
        _setPrice(0.1 ether, treasury);
        vm.prank(relayer);
        reg.buyTries{value: 0.2 ether}(player, 2);
        for (uint256 i = 0; i < 5; i++) _start(player, playerPk);
        assertEq(reg.extraTries(player), 2); // free tries first
        _start(player, playerPk);
        assertEq(reg.extraTries(player), 1);
        assertEq(reg.attemptsLeftToday(player), 1);
        vm.warp(block.timestamp + 1 days);
        assertEq(reg.attemptsLeftToday(player), 6); // 5 free again + 1 paid kept
        assertEq(reg.attemptsLeftToday(player) - reg.extraTries(player), 5); // 5 free
    }

    function test_Tries_WithPassRunPastTheFreeLimit() public {
        _setPrice(0.1 ether, treasury);
        vm.prank(relayer);
        reg.buyTries{value: 0.2 ether}(player, 2);
        _openPass(player, playerPk, relayer, block.timestamp + 10 minutes, 10);
        vm.startPrank(relayer);
        for (uint256 i = 0; i < 7; i++) reg.startSessionWithPass(robotId, player);
        vm.expectRevert(RobotRegistryV4.DailyLimitReached.selector);
        reg.startSessionWithPass(robotId, player);
        vm.stopPrank();
        assertEq(reg.extraTries(player), 0);
    }

    function test_Tries_PriceIsAdminOnlyAndBounded() public {
        uint256 d = _dl();
        bytes32 dg = _setTryPriceDigest(1 ether, attacker, reg.nonces(admin), d);
        vm.prank(admin); // a stolen admin EVM key is not enough
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.setTryPrice(1 ether, attacker, d, _sig(attackerPk, dg));
        dg = _setTryPriceDigest(11 ether, treasury, reg.nonces(admin), d);
        vm.expectRevert(RobotRegistryV4.BadTryPrice.selector);
        reg.setTryPrice(11 ether, treasury, d, _sig(adminPk, dg));
        dg = _setTryPriceDigest(1 ether, address(0), reg.nonces(admin), d);
        vm.expectRevert(PQAccess.ZeroAddress.selector);
        reg.setTryPrice(1 ether, address(0), d, _sig(adminPk, dg));
        _setPrice(0, address(0)); // switching paid tries off is allowed
        assertEq(reg.tryPrice(), 0);
    }

    function test_Tries_RefusingTreasuryRevertsThePurchase() public {
        RefuserV6 r = new RefuserV6();
        _setPrice(0.1 ether, address(r));
        vm.prank(relayer);
        vm.expectRevert(RobotRegistryV4.PaymentFailed.selector);
        reg.buyTries{value: 0.1 ether}(player, 1);
        assertEq(reg.extraTries(player), 0);
    }

    function test_Tries_ConstructorPrice() public {
        bytes32 dg = _deployDigest("RedZone.RobotRegistry.v4", admin);
        vm.prank(admin);
        RobotRegistryV4 r = new RobotRegistryV4(refereePk, CHAIN, _sig(adminPk, dg), _sig(refereePk, dg), 0.1 ether, treasury);
        assertEq(r.tryPrice(), 0.1 ether);
        assertEq(r.treasury(), treasury);
    }

    // ------------------------------------------------------------ v5: prize pools

    function _pool(uint256 amount, uint256 prize, bool oncePerBrain) internal returns (uint256 id) {
        vm.prank(relayer);
        id = vault.depositPool{value: amount}(robotId, prize, oncePerBrain);
    }

    function _newBrain(bytes32 h) internal {
        uint256 d = _dl();
        bytes32 dg = reg.updateBrainDigest(robotId, h, reg.nonces(owner), d);
        reg.updateBrain(robotId, h, d, _sig(ownerPk, dg));
    }

    function _amount(uint256 id) internal view returns (uint256 a) {
        (, a,,,,,,,,,) = vault.bounties(id);
    }

    function test_Pool_DepositBounds() public {
        vm.startPrank(relayer);
        vm.expectRevert(EscrowVaultV5.BadPrize.selector);
        vault.depositPool{value: 5 ether}(robotId, 0.09 ether, true); // under MIN_PRIZE
        vm.expectRevert(EscrowVaultV5.BadPrize.selector);
        vault.depositPool{value: 5 ether}(robotId, 6 ether, true); // prize above the pool
        vm.expectRevert(EscrowVaultV5.AmountTooSmall.selector);
        vault.depositPool{value: 0.5 ether}(robotId, 0.1 ether, true); // pool under MIN_BOUNTY
        vm.stopPrank();
        uint256 id = _pool(5 ether, 1 ether, false);
        (,,,,,, bool once,,,, uint256 prize) = vault.bounties(id);
        assertEq(prize, 1 ether);
        assertFalse(once);
    }

    /// Fully open pool: every new player who breaks the robot gets one prize; the pool stays open.
    function test_Pool_EachWinnerGetsOnePrize() public {
        uint256 id = _pool(5 ether, 2 ether, false);
        uint256 s1 = _start(player, playerPk);
        uint256 s2 = _start(player2, player2Pk);
        _record(s1, true);
        _record(s2, true);

        uint256 b1 = player.balance;
        vault.claimBounty(id);
        assertEq(player.balance - b1, 2 ether);
        assertEq(_amount(id), 3 ether);
        assertEq(uint256(_status(id)), uint256(EscrowVaultV5.Status.Open));

        uint256 b2 = player2.balance;
        vault.claimBounty(id);
        assertEq(player2.balance - b2, 2 ether);
        assertEq(_amount(id), 1 ether);
        assertEq(vault.totalLocked(), 1 ether);
        assertTrue(vault.hasWon(id, player) && vault.hasWon(id, player2));
    }

    /// The last prize is what is left; the pool then closes.
    function test_Pool_LastPrizeIsTheRemainder() public {
        uint256 id = _pool(3 ether, 2 ether, false);
        uint256 s1 = _start(player, playerPk);
        uint256 s2 = _start(player2, player2Pk);
        _record(s1, true);
        _record(s2, true);
        vault.claimBounty(id);
        uint256 b2 = player2.balance;
        vault.claimBounty(id);
        assertEq(player2.balance - b2, 1 ether);
        assertEq(uint256(_status(id)), uint256(EscrowVaultV5.Status.Claimed));
        assertEq(vault.totalLocked(), 0);
        assertEq(address(vault).balance, 0);
    }

    /// The same player can't win the same pool twice; their second breach is skipped.
    function test_Pool_OnePrizePerPlayer() public {
        uint256 id = _pool(5 ether, 1 ether, false);
        uint256 s1 = _start(player, playerPk);
        uint256 s2 = _start(player, playerPk);
        _record(s1, true);
        _record(s2, true);
        vault.claimBounty(id);
        (EscrowVaultV5.Next st, uint256 sid) = vault.nextBreach(id);
        assertEq(uint256(st), uint256(EscrowVaultV5.Next.Skippable));
        assertEq(sid, s2);
        vm.expectRevert(abi.encodeWithSelector(EscrowVaultV5.NothingToClaim.selector, EscrowVaultV5.Next.Skippable));
        vault.claimBounty(id);
        vault.skipBreach(id);
        assertEq(_amount(id), 4 ether);
    }

    /// oncePerBrain: after a win, a copied trick on the same brain earns nothing; after the maker
    /// updates the robot's rules, a new breach is paid again.
    function test_Pool_OncePerBrainVersion() public {
        uint256 id = _pool(5 ether, 1 ether, true);
        uint256 s1 = _start(player, playerPk);
        uint256 s2 = _start(player2, player2Pk);
        _record(s1, true);
        _record(s2, true); // same brain version: a copy of the same bug
        vault.claimBounty(id);
        (EscrowVaultV5.Next st,) = vault.nextBreach(id);
        assertEq(uint256(st), uint256(EscrowVaultV5.Next.Skippable));
        vault.skipBreach(id);

        // A round on the old brain that ends after the update is still skipped.
        uint256 s3 = _start(attacker, attackerPk);
        _newBrain(keccak256("brain-v2"));
        _record(s3, true);
        (st,) = vault.nextBreach(id);
        assertEq(uint256(st), uint256(EscrowVaultV5.Next.Skippable));
        vault.skipBreach(id);

        // A breach against the new brain is a new bug: paid.
        uint256 s4 = _start(player2, player2Pk);
        _record(s4, true);
        uint256 b = player2.balance;
        vault.claimBounty(id);
        assertEq(player2.balance - b, 1 ether);
        assertEq(_amount(id), 3 ether);
    }

    /// v5: freeze and reopen. A once-per-brain pool pays one breach, then is frozen (any later
    /// breach of that version, by anyone, is skipped). After the owner fixes the robot, the SAME
    /// player who won before is paid for breaking the new version: it can only be a new trick.
    function test_V5_WinnerIsPaidAgainAfterTheFix() public {
        uint256 id = _pool(5 ether, 1 ether, true);
        uint256 s1 = _start(player, playerPk);
        _record(s1, true);
        uint256 b0 = player.balance;
        vault.claimBounty(id);
        assertEq(player.balance - b0, 1 ether);

        // Frozen: the same player, and anyone else, breaking the same version earns nothing.
        uint256 s2 = _start(player, playerPk);
        uint256 s3 = _start(player2, player2Pk);
        _record(s2, true);
        _record(s3, true);
        (EscrowVaultV5.Next st,) = vault.nextBreach(id);
        assertEq(uint256(st), uint256(EscrowVaultV5.Next.Skippable));
        vault.skipBreach(id);
        vault.skipBreach(id);

        // Fixed (version 1): the earlier winner breaks it again and is paid again.
        _newBrain(keccak256("fix-1"));
        uint256 s4 = _start(player, playerPk);
        _record(s4, true);
        uint256 b1 = player.balance;
        vault.claimBounty(id);
        assertEq(player.balance - b1, 1 ether);
        assertEq(_amount(id), 3 ether);

        // And frozen again until the next fix.
        uint256 s5 = _start(player2, player2Pk);
        _record(s5, true);
        (st,) = vault.nextBreach(id);
        assertEq(uint256(st), uint256(EscrowVaultV5.Next.Skippable));
    }

    /// v5 keeps open pools (the demo robot's): one prize per player, even after a brain update.
    function test_V5_OpenPoolStillOnePrizePerPlayerAcrossVersions() public {
        uint256 id = _pool(5 ether, 1 ether, false);
        uint256 s1 = _start(player, playerPk);
        _record(s1, true);
        vault.claimBounty(id);
        _newBrain(keccak256("fix-1"));
        uint256 s2 = _start(player, playerPk);
        _record(s2, true);
        (EscrowVaultV5.Next st,) = vault.nextBreach(id);
        assertEq(uint256(st), uint256(EscrowVaultV5.Next.Skippable));
        // A new player is still paid.
        vault.skipBreach(id);
        uint256 s3 = _start(player2, player2Pk);
        _record(s3, true);
        uint256 b = player2.balance;
        vault.claimBounty(id);
        assertEq(player2.balance - b, 1 ether);
    }

    /// depositBounty keeps the v3 behaviour: one winner takes the whole bounty.
    function test_Pool_SinglePrizeDepositTakesAll() public {
        uint256 id = _deposit(3 ether);
        (,,,,,, bool once,,,, uint256 prize) = vault.bounties(id);
        assertEq(prize, 3 ether);
        assertTrue(once);
        uint256 s1 = _start(player, playerPk);
        _record(s1, true);
        vault.claimBounty(id);
        assertEq(uint256(_status(id)), uint256(EscrowVaultV5.Status.Claimed));
        assertEq(vault.totalLocked(), 0);
    }

    /// The owner can take back what is left of a pool, after skipping breaches that can't be paid.
    function test_Pool_OwnerWithdrawsTheRest() public {
        uint256 id = _pool(5 ether, 2 ether, false);
        uint256 s1 = _start(player, playerPk);
        _record(s1, true);
        vault.claimBounty(id);
        _requestWithdraw(id, owner);
        vm.warp(block.timestamp + vault.WITHDRAW_DELAY());
        uint256 b = owner.balance;
        vault.finalizeWithdraw(id);
        assertEq(owner.balance - b, 3 ether);
        assertEq(vault.totalLocked(), 0);
    }

    /// While a later breach is still payable, the owner's withdrawal waits for it.
    function test_Pool_WinBeatsWithdrawal() public {
        uint256 id = _pool(5 ether, 1 ether, false);
        uint256 s1 = _start(player, playerPk);
        _requestWithdraw(id, owner);
        _record(s1, true);
        vm.warp(block.timestamp + vault.WITHDRAW_DELAY());
        vm.expectRevert(EscrowVaultV5.WinPending.selector);
        vault.finalizeWithdraw(id);
        vault.claimBounty(id);
        vault.finalizeWithdraw(id);
        assertEq(vault.totalLocked(), 0);
    }
}
