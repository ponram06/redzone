// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VaultV5Base} from "./VaultV5.t.sol";
import {PQGuard} from "../../src/PQGuard.sol";
import {PQAccess} from "../../src/v3/PQAccess.sol";
import {MLDSA87} from "../../src/v3/MLDSA87.sol";
import {QoreXMessage} from "../../src/QoreXMessage.sol";
import {RobotRegistryV4} from "../../src/v4/RobotRegistryV4.sol";
import {EscrowVaultV5} from "../../src/v5/EscrowVaultV5.sol";

/// @dev A precompile stand-in that answers with only 32 bytes (too short for pqcKeyStatus).
contract ShortAnswerPrecompile {
    fallback() external {
        assembly {
            mstore(0, 1)
            return(0, 32)
        }
    }
}

/// @dev A precompile stand-in that always reverts.
contract RevertingPrecompile {
    fallback() external {
        revert("down");
    }
}

/// @dev A pqcVerify stand-in that answers with a value that is not a bool (2).
contract NotABoolPrecompile {
    fallback() external {
        assembly {
            mstore(0, 2)
            return(0, 32)
        }
    }
}

/// @dev A registry whose time limits do not fit the vault's, to prove the vault refuses it.
contract WrongTimingRegistry {
    uint256 public immutable MAX_START_TTL;
    uint256 public immutable SESSION_TTL;
    uint256 public constant RESULT_GRACE = 1 hours;

    constructor(uint256 maxStartTtl, uint256 sessionTtl) {
        MAX_START_TTL = maxStartTtl;
        SESSION_TTL = sessionTtl;
    }
}

/// @dev Exposes library helpers the live contracts do not call, so their checks are tested too.
contract LibraryHarness {
    function requireAccountSig(address a, bytes32 d, bytes calldata s) external view {
        PQGuard.requireAccountSig(a, d, s);
    }

    function requireAccountMessageSig(address a, bytes calldata m, bytes calldata s) external view {
        PQGuard.requireAccountMessageSig(a, m, s);
    }

    function requirePubkeySig(bytes calldata pk, bytes32 d, bytes calldata s) external view {
        PQGuard.requirePubkeySig(pk, d, s);
    }

    function hasPQKey(address a) external view returns (bool) {
        return PQGuard.hasPQKey(a);
    }

    function checkChainId(bytes calldata c) external pure {
        QoreXMessage.checkChainId(c);
    }
}

/// @notice Verification pass (22 Nov 2026): one test for every branch of the live contracts that
///         the main suites did not reach (see audits/verification/TRIAGE.md, "Coverage").
contract BranchesV6Test is VaultV5Base {
    // ------------------------------------------- precompile misbehaviour: always fail closed

    function _startSig() internal view returns (uint256 d, bytes memory sg) {
        d = _dl();
        sg = _walletSig(reg, playerPk, "StartSession", reg.startSessionDigest(robotId, player, reg.nonces(player), d));
    }

    function test_Branch_KeyStatusShortAnswerFailsClosed() public {
        (uint256 d, bytes memory sg) = _startSig();
        vm.etch(STATUS, address(new ShortAnswerPrecompile()).code);
        vm.expectRevert(PQGuard.PQCPrecompileUnavailable.selector);
        reg.startSessionFor(robotId, player, d, sg);
    }

    function test_Branch_KeyStatusRevertFailsClosed() public {
        (uint256 d, bytes memory sg) = _startSig();
        vm.etch(STATUS, address(new RevertingPrecompile()).code);
        vm.expectRevert(PQGuard.PQCPrecompileUnavailable.selector);
        reg.startSessionFor(robotId, player, d, sg);
    }

    function test_Branch_VerifyRevertFailsClosed() public {
        (uint256 d, bytes memory sg) = _startSig();
        vm.etch(VERIFY, address(new RevertingPrecompile()).code);
        vm.expectRevert(PQGuard.PQCPrecompileUnavailable.selector);
        reg.startSessionFor(robotId, player, d, sg);
    }

    function test_Branch_VerifyEmptyAnswerFailsClosed() public {
        (uint256 d, bytes memory sg) = _startSig();
        vm.etch(VERIFY, hex"00"); // code that stops without returning anything
        vm.expectRevert(PQGuard.PQCPrecompileUnavailable.selector);
        reg.startSessionFor(robotId, player, d, sg);
    }

    function test_Branch_VerifyGarbageAnswerFailsClosed() public {
        (uint256 d, bytes memory sg) = _startSig();
        vm.etch(VERIFY, address(new NotABoolPrecompile()).code);
        vm.expectRevert(); // abi.decode refuses a bool that is not 0 or 1
        reg.startSessionFor(robotId, player, d, sg);
        assertEq(reg.nonces(player), 0); // nothing happened
    }

    function test_Branch_MisbehavingPrecompileNeverPays() public {
        uint256 id = _deposit(1 ether);
        uint256 sid = _start(player, playerPk);
        RobotRegistryV4.Session memory s = reg.getSession(sid);
        uint256 rd = uint256(s.startedAt) + 70 minutes;
        bytes32 dg = reg.resultDigest(sid, robotId, player, true, keccak256("replay"), rd);
        bytes memory rs = _sig(refereePk, dg);
        vm.etch(VERIFY, address(new NotABoolPrecompile()).code);
        vm.expectRevert();
        reg.recordResult(sid, true, keccak256("replay"), rd, refereePk, rs);
        vm.etch(VERIFY, address(new RevertingPrecompile()).code);
        vm.expectRevert(PQGuard.PQCPrecompileUnavailable.selector);
        reg.recordResult(sid, true, keccak256("replay"), rd, refereePk, rs);
        vm.expectRevert(abi.encodeWithSelector(EscrowVaultV5.NothingToClaim.selector, EscrowVaultV5.Next.None));
        vault.claimBounty(id);
        assertEq(address(vault).balance, 1 ether);
    }

    // --------------------------------------------------------- keys that are missing or wrong

    function test_Branch_AdminWithoutKeyCannotAct() public {
        keys.setKeyWithAlgorithm(admin, "", 0); // key gone
        uint256 d = _dl();
        bytes32 dg = vault.setPausedDigest(true, vault.nonces(admin), d);
        vm.expectRevert(abi.encodeWithSelector(PQGuard.PQCKeyNotRegistered.selector, admin));
        vault.setPaused(true, d, _sig(adminPk, dg));
    }

    function test_Branch_NewAdminMustHoldKey() public {
        address stranger = makeAddr("stranger"); // no key
        uint256 d = _dl();
        bytes32 dg = reg.transferAdminDigest(stranger, reg.nonces(admin), d);
        vm.expectRevert(abi.encodeWithSelector(PQGuard.PQCKeyNotRegistered.selector, stranger));
        reg.transferAdmin(stranger, d, _sig(adminPk, dg));
    }

    function test_Branch_NewAdminMustHoldMLDSA87Key() public {
        keys.setKeyWithAlgorithm(player2, player2Pk, 2); // registered, but not ML-DSA-87
        uint256 d = _dl();
        bytes32 dg = reg.transferAdminDigest(player2, reg.nonces(admin), d);
        vm.expectRevert(abi.encodeWithSelector(MLDSA87.NotMLDSA87Key.selector, player2, uint8(2)));
        reg.transferAdmin(player2, d, _sig(adminPk, dg));
    }

    function test_Branch_DeployerWithoutKeyCannotDeploy() public {
        address noKey = makeAddr("noKey");
        bytes memory proof = _sig(adminPk, _deployDigest("RedZone.EscrowVault.v5", noKey));
        vm.prank(noKey);
        vm.expectRevert(abi.encodeWithSelector(PQGuard.PQCKeyNotRegistered.selector, noKey));
        new EscrowVaultV5(reg, CHAIN, proof);
    }

    function test_Branch_ChainIdBadCharacterRefused() public {
        vm.startPrank(admin);
        vm.expectRevert(QoreXMessage.BadNativeChainId.selector);
        _newReg(refereePk, "qorechain diana"); // space
        vm.expectRevert(QoreXMessage.BadNativeChainId.selector);
        _newReg(refereePk, "qorechain|diana"); // the QoreX separator itself
        vm.stopPrank();
    }

    // ------------------------------------------------------------------- registry branches

    function test_Branch_ResultAfterItsDeadlineRefused() public {
        uint256 sid = _start(player, playerPk);
        uint256 rd = block.timestamp + 5 minutes;
        bytes32 dg = reg.resultDigest(sid, robotId, player, true, keccak256("r"), rd);
        bytes memory rs = _sig(refereePk, dg);
        vm.warp(rd + 1);
        vm.expectRevert(PQAccess.Expired.selector);
        reg.recordResult(sid, true, keccak256("r"), rd, refereePk, rs);
        vm.warp(rd); // the deadline itself is still in time
        reg.recordResult(sid, true, keccak256("r"), rd, refereePk, rs);
    }

    function test_Branch_UtilityAfterItsDeadlineRefused() public {
        uint256 d = block.timestamp + 5 minutes;
        bytes32 dg = reg.utilityDigest(robotId, 3, keccak256("u"), 0, d);
        bytes memory rs = _sig(refereePk, dg);
        vm.warp(d + 1);
        vm.expectRevert(PQAccess.Expired.selector);
        reg.recordUtility(robotId, 3, keccak256("u"), d, refereePk, rs);
    }

    function test_Branch_VerdictForUnknownSessionRefused() public {
        uint256 rd = block.timestamp + 5 minutes;
        bytes32 dg = reg.resultDigest(999, 0, address(0), true, keccak256("r"), rd);
        bytes memory rs = _sig(refereePk, dg);
        vm.expectRevert(RobotRegistryV4.UnknownSession.selector); // even with a real referee signature
        reg.recordResult(999, true, keccak256("r"), rd, refereePk, rs);
    }

    function test_Branch_EmptyRefereeKeyRefusedAtDeploy() public {
        bytes memory proof = _sig(adminPk, _deployDigest("RedZone.RobotRegistry.v4", admin));
        vm.prank(admin);
        vm.expectRevert(RobotRegistryV4.EmptyPubkey.selector);
        new RobotRegistryV4("", CHAIN, proof, "", 0, address(0));
    }

    function test_Branch_EmptyRefereeKeyRefusedOnProposal() public {
        uint256 d = _dl();
        bytes32 dg = _proposeRefereeDigest(keccak256(""), reg.nonces(admin), d);
        bytes memory sg = _sig(adminPk, dg);
        vm.expectRevert(RobotRegistryV4.EmptyPubkey.selector);
        reg.proposeReferee("", d, sg, "");
    }

    function test_Branch_CancelWithNothingPendingRefused() public {
        uint256 d = _dl();
        bytes32 cg = _cancelRefereeDigest(bytes32(0), reg.nonces(admin), d);
        bytes memory sg = _sig(adminPk, cg);
        vm.expectRevert(RobotRegistryV4.NoPendingReferee.selector);
        reg.cancelReferee(d, sg);
    }

    function test_Branch_RobotForZeroAddressRefused() public {
        // address(0) has no key on a real chain; give it one here so the zero check itself is reached
        bytes memory zpk = _key(hex"2020");
        keys.setKey(address(0), zpk);
        uint256 d = _dl();
        bytes32 dg = reg.registerRobotDigest(address(0), keccak256("Zero"), keccak256("brain"), reg.nonces(address(0)), d);
        bytes memory sg = _walletSig(reg, zpk, "RegisterRobot", dg);
        vm.expectRevert(PQAccess.ZeroAddress.selector);
        reg.registerRobotFor(address(0), "Zero", keccak256("brain"), d, sg);
    }

    // ---------------------------------------------------------------------- vault branches

    function test_Branch_VaultNeedsRegistry() public {
        bytes memory proof = _sig(adminPk, _deployDigest("RedZone.EscrowVault.v5", admin));
        vm.prank(admin);
        vm.expectRevert(PQAccess.ZeroAddress.selector);
        new EscrowVaultV5(RobotRegistryV4(address(0)), CHAIN, proof);
    }

    function test_Branch_VaultRefusesRegistryWithLongerStartWindow() public {
        WrongTimingRegistry w = new WrongTimingRegistry(11 minutes, 10 minutes);
        bytes memory proof = _sig(adminPk, _deployDigest("RedZone.EscrowVault.v5", admin));
        vm.prank(admin);
        vm.expectRevert(EscrowVaultV5.BadDelays.selector);
        new EscrowVaultV5(RobotRegistryV4(address(w)), CHAIN, proof);
    }

    function test_Branch_VaultRefusesRegistryWithLongerSessions() public {
        WrongTimingRegistry w = new WrongTimingRegistry(10 minutes, 2 hours);
        bytes memory proof = _sig(adminPk, _deployDigest("RedZone.EscrowVault.v5", admin));
        vm.prank(admin);
        vm.expectRevert(EscrowVaultV5.BadDelays.selector);
        new EscrowVaultV5(RobotRegistryV4(address(w)), CHAIN, proof);
    }

    function test_Branch_VaultTimingsFitTheLiveRegistry() public view {
        // the constructor's sums, written out: a win in progress always lands before a take-back
        assertGe(vault.START_GRACE(), reg.MAX_START_TTL());
        assertGe(vault.WITHDRAW_DELAY(), vault.START_GRACE() + reg.SESSION_TTL() + reg.RESULT_GRACE() + 1 hours);
        assertGe(vault.CLAIM_WINDOW(), 1 hours);
    }

    function test_Branch_SkipOnClosedOrMissingBountyRefused() public {
        uint256 id = _deposit(1 ether);
        uint256 sid = _start(player, playerPk);
        _record(sid, true);
        vault.claimBounty(id);
        vm.expectRevert(EscrowVaultV5.BountyNotOpen.selector);
        vault.skipBreach(id);
        vm.expectRevert(EscrowVaultV5.BountyNotOpen.selector);
        vault.skipBreach(12345);
    }

    function test_Branch_ClosedBountyHasNoNextBreach() public {
        uint256 id = _deposit(1 ether);
        uint256 sid = _start(player, playerPk);
        _record(sid, true);
        (EscrowVaultV5.Next st, uint256 at) = vault.nextBreach(id);
        assertEq(uint8(st), uint8(EscrowVaultV5.Next.Claimable));
        assertEq(at, sid);
        vault.claimBounty(id);
        (st, at) = vault.nextBreach(id);
        assertEq(uint8(st), uint8(EscrowVaultV5.Next.None));
        assertEq(at, 0);
        (st,) = vault.nextBreach(777); // never created
        assertEq(uint8(st), uint8(EscrowVaultV5.Next.None));
    }

    function test_Branch_WithdrawOnClosedBountyRefused() public {
        uint256 id = _deposit(1 ether);
        uint256 sid = _start(player, playerPk);
        _record(sid, true);
        vault.claimBounty(id);
        uint256 d = _dl();
        bytes32 dg = vault.withdrawDigest(id, owner, vault.nonces(owner), d);
        bytes memory sg = _walletSig(vault, ownerPk, "WithdrawBounty", dg);
        vm.expectRevert(EscrowVaultV5.BountyNotOpen.selector);
        vault.requestWithdraw(id, owner, d, sg);
        assertEq(vault.nonces(owner), 0); // the signature was not used up
    }

    /// A round started before the pool existed can't win it, even if its verdict lands afterwards.
    function test_Branch_RoundStartedBeforeDepositCannotWinIt() public {
        uint256 sid = _start(player, playerPk);
        vm.warp(block.timestamp + 1);
        uint256 id = _deposit(1 ether);
        _record(sid, true); // breach recorded after the deposit
        (EscrowVaultV5.Next st, uint256 at) = vault.nextBreach(id);
        assertEq(uint8(st), uint8(EscrowVaultV5.Next.Skippable));
        assertEq(at, sid);
        vm.expectRevert(abi.encodeWithSelector(EscrowVaultV5.NothingToClaim.selector, EscrowVaultV5.Next.Skippable));
        vault.claimBounty(id);
        vault.skipBreach(id);
        (st,) = vault.nextBreach(id);
        assertEq(uint8(st), uint8(EscrowVaultV5.Next.None));
        // a round started in the same second as the deposit does count
        uint256 id2 = _deposit(1 ether);
        uint256 sid2 = _start(player2, player2Pk);
        _record(sid2, true);
        vault.claimBounty(id2);
        assertEq(player2.balance, 1 ether);
    }

    function test_Branch_WithdrawToZeroAddressRefused() public {
        uint256 id = _deposit(1 ether);
        uint256 d = _dl();
        bytes32 dg = vault.withdrawDigest(id, address(0), vault.nonces(owner), d);
        bytes memory sg = _walletSig(vault, ownerPk, "WithdrawBounty", dg);
        vm.expectRevert(PQAccess.ZeroAddress.selector);
        vault.requestWithdraw(id, address(0), d, sg);
    }

    // ------------------------------------------------------ edge values (fuzzed)

    function _breachBy(uint256 i) internal returns (address p) {
        p = makeAddr(string(abi.encode("winner", i)));
        bytes memory pk = _key(abi.encodePacked(uint16(i + 3000)));
        keys.setKey(p, pk);
        _record(_start(p, pk), true);
    }

    /// Open pool, any legal size and prize: every winner gets min(prize, what is left), the total
    /// paid is exactly the pool, and the pool closes on the last payment.
    function testFuzz_Edge_OpenPoolPaysExactlyThePool(uint96 prizeSeed, uint96 amountSeed, uint8 winsSeed) public {
        uint256 prize = bound(prizeSeed, vault.MIN_PRIZE(), 10 ether);
        uint256 maxWins = bound(winsSeed, 1, 12);
        uint256 lo = prize > vault.MIN_BOUNTY() ? prize : vault.MIN_BOUNTY();
        uint256 hi = prize * maxWins;
        if (hi < lo) hi = lo;
        uint256 amount = bound(amountSeed, lo, hi);
        vm.prank(relayer);
        uint256 id = vault.depositPool{value: amount}(robotId, prize, false);

        uint256 paid;
        uint256 i;
        while (_status(id) == EscrowVaultV5.Status.Open) {
            address p = _breachBy(i++);
            uint256 left = amount - paid;
            uint256 expect = prize < left ? prize : left;
            vault.claimBounty(id);
            assertEq(p.balance, expect);
            paid += expect;
        }
        assertEq(i, (amount + prize - 1) / prize); // exactly ceil(pool / prize) winners
        assertEq(paid, amount);
        assertEq(vault.totalLocked(), 0);
        assertEq(address(vault).balance, 0);
        _breachBy(i); // one more winner finds the pool closed
        vm.expectRevert(EscrowVaultV5.BountyNotOpen.selector);
        vault.claimBounty(id);
    }

    /// Once-per-brain pool: of any number of breaches of one brain version, exactly one is paid.
    function testFuzz_Edge_OncePerBrainPaysOncePerVersion(uint96 prizeSeed, uint8 breachesSeed) public {
        uint256 prize = bound(prizeSeed, vault.MIN_PRIZE(), 5 ether);
        uint256 n = bound(breachesSeed, 1, 8);
        vm.prank(relayer);
        uint256 id = vault.depositPool{value: 5 ether}(robotId, prize, true);
        for (uint256 i = 0; i < n; i++) _breachBy(i);
        vault.claimBounty(id);
        for (uint256 i = 1; i < n; i++) {
            (EscrowVaultV5.Next st,) = vault.nextBreach(id);
            assertEq(uint8(st), uint8(EscrowVaultV5.Next.Skippable));
            vault.skipBreach(id);
        }
        (EscrowVaultV5.Next last,) = vault.nextBreach(id);
        assertEq(uint8(last), uint8(EscrowVaultV5.Next.None));
        assertEq(vault.totalLocked(), 5 ether - prize);
    }

    /// The smallest legal pool and prize work; one wei less is refused.
    function test_Edge_MinimumPoolAndPrize() public {
        uint256 minB = vault.MIN_BOUNTY();
        uint256 minP = vault.MIN_PRIZE();
        vm.startPrank(relayer);
        vm.expectRevert(EscrowVaultV5.AmountTooSmall.selector);
        vault.depositPool{value: minB - 1}(robotId, minP, false);
        vm.expectRevert(EscrowVaultV5.BadPrize.selector);
        vault.depositPool{value: minB}(robotId, minP - 1, false);
        vm.expectRevert(EscrowVaultV5.BadPrize.selector);
        vault.depositPool{value: minB}(robotId, minB + 1, false);
        uint256 id = vault.depositPool{value: minB}(robotId, minB, false); // prize = pool
        vm.stopPrank();
        address p = _breachBy(0);
        vault.claimBounty(id);
        assertEq(p.balance, minB);
        assertEq(uint8(_status(id)), uint8(EscrowVaultV5.Status.Claimed));
    }

    // ------------------------------------------- library helpers not used by the live contracts

    function test_Branch_LibraryHelpersFailClosed() public {
        LibraryHarness h = new LibraryHarness();
        bytes32 dg = keccak256("x");
        address nobody = makeAddr("nobody");
        assertFalse(h.hasPQKey(nobody));
        assertTrue(h.hasPQKey(player));

        vm.expectRevert(abi.encodeWithSelector(PQGuard.PQCKeyNotRegistered.selector, nobody));
        h.requireAccountSig(nobody, dg, "");
        bytes memory bad = _sig(attackerPk, dg);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        h.requireAccountSig(player, dg, bad);
        h.requireAccountSig(player, dg, _sig(playerPk, dg));

        vm.expectRevert(abi.encodeWithSelector(PQGuard.PQCKeyNotRegistered.selector, nobody));
        h.requireAccountMessageSig(nobody, "m", "");
        bad = _sigOver(attackerPk, "m");
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        h.requireAccountMessageSig(player, "m", bad);
        h.requireAccountMessageSig(player, "m", _sigOver(playerPk, "m"));

        bad = _sig(attackerPk, dg);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        h.requirePubkeySig(playerPk, dg, bad);
        h.requirePubkeySig(playerPk, dg, _sig(playerPk, dg));
    }

    function test_Branch_ChainIdLengthInLibrary() public {
        LibraryHarness h = new LibraryHarness();
        vm.expectRevert(QoreXMessage.BadNativeChainId.selector);
        h.checkChainId("");
        bytes memory tooLong = new bytes(65);
        vm.expectRevert(QoreXMessage.BadNativeChainId.selector);
        h.checkChainId(tooLong);
        h.checkChainId("qorechain-diana");
        h.checkChainId("A.b_9-z");
    }
}
