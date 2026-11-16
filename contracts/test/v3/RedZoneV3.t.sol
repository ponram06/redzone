// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PQGuard} from "../../src/PQGuard.sol";
import {PQAccess} from "../../src/v3/PQAccess.sol";
import {RobotRegistryV3} from "../../src/v3/RobotRegistryV3.sol";
import {EscrowVaultV2} from "../../src/v3/EscrowVaultV2.sol";
import {MockPQC} from "../mocks/MockPQC.sol";

/// @dev Re-enters the vault from its receive hook.
contract Reenterer {
    EscrowVaultV2 internal vault;
    uint256 internal bountyId;
    uint256 internal sessionId;
    bool public tried;
    bool public reentered;

    constructor(EscrowVaultV2 v) {
        vault = v;
    }

    function arm(uint256 b, uint256 s) external {
        bountyId = b;
        sessionId = s;
    }

    receive() external payable {
        if (tried) return;
        tried = true;
        try vault.claimBounty(bountyId, sessionId) {
            reentered = true;
        } catch {}
    }
}

/// @dev Refuses all payments.
contract Refuser {
    receive() external payable {
        revert("no");
    }
}

contract RedZoneV3Test is Test {
    address constant VERIFY = 0x0000000000000000000000000000000000000a01;
    address constant STATUS = 0x0000000000000000000000000000000000000a02;
    bytes constant CHAIN = "qorechain-diana";

    RobotRegistryV3 internal reg;
    EscrowVaultV2 internal vault;
    MockPQC internal keys;

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
        MockPQC impl = new MockPQC();
        vm.etch(VERIFY, address(impl).code);
        vm.etch(STATUS, address(impl).code);
        keys = MockPQC(STATUS);
        keys.setKey(admin, adminPk);
        keys.setKey(owner, ownerPk);
        keys.setKey(player, playerPk);
        keys.setKey(player2, player2Pk);
        keys.setKey(attacker, attackerPk);

        vm.startPrank(admin);
        reg = new RobotRegistryV3(refereePk, CHAIN);
        vault = new EscrowVaultV2(reg, CHAIN);
        vm.stopPrank();

        vm.deal(relayer, 1000 ether);
        vm.deal(attacker, 10 ether);
        robotId = _registerRobot("Guard Dog");
    }

    // -------------------------------------------------------------- helpers

    /// @dev Same scheme as MockPQC.sign, computed locally so vm.expectRevert targets the contract call.
    function _sig(bytes memory pk, bytes32 digest) internal pure returns (bytes memory) {
        return abi.encodePacked(keccak256(abi.encode(pk, abi.encodePacked(digest))));
    }

    function _walletSig(PQAccess c, bytes memory pk, string memory action, bytes32 digest) internal view returns (bytes memory) {
        return abi.encodePacked(MockPQC(VERIFY).sign(pk, c.walletMessage(action, digest)));
    }

    function _dl() internal view returns (uint256) {
        return block.timestamp + 10 minutes;
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
        RobotRegistryV3.Session memory s = reg.getSession(sid);
        uint256 d = uint256(s.startedAt) + 70 minutes;
        bytes32 dg = reg.resultDigest(sid, s.robotId, s.player, breached, keccak256("replay"), d);
        reg.recordResult(sid, breached, keccak256("replay"), d, _sig(refereePk, dg));
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

    function _status(uint256 id) internal view returns (EscrowVaultV2.Status st) {
        (,,,,,, st) = vault.bounties(id);
    }

    // ------------------------------------------------------ happy paths

    function test_FullRound_BreachPaysPlayer() public {
        uint256 id = _deposit(5 ether);
        uint256 sid = _start(player, playerPk);
        _record(sid, true);
        vm.prank(attacker); // anyone can trigger; money still goes to the player
        vault.claimBounty(id, sid);
        assertEq(player.balance, 5 ether);
        assertEq(vault.totalLocked(), 0);
        assertEq(address(vault).balance, 0);
        assertEq(uint8(_status(id)), uint8(EscrowVaultV2.Status.Claimed));
    }

    function test_BountyBelongsToRobotOwnerNotFunder() public {
        uint256 id = _deposit(2 ether);
        (,, address o,,,,) = vault.bounties(id);
        assertEq(o, owner);
    }

    function test_Withdraw_TwoStepAfterDelay() public {
        uint256 id = _deposit(3 ether);
        _requestWithdraw(id, owner);
        vm.expectRevert(EscrowVaultV2.WithdrawLocked.selector);
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
        vm.expectRevert(EscrowVaultV2.NotBreached.selector); // no result yet
        vault.claimBounty(id, sid);
        _record(sid, false);
        vm.expectRevert(EscrowVaultV2.NotBreached.selector); // defended
        vault.claimBounty(id, sid);
    }

    function test_Attack_ClaimWithUnknownSession() public {
        uint256 id = _deposit(1 ether);
        vm.expectRevert(EscrowVaultV2.WrongRobot.selector);
        vault.claimBounty(id, 999);
    }

    function test_Attack_ClaimWithBreachOfOtherRobot() public {
        uint256 other = _registerRobot("Other");
        uint256 id = _deposit(1 ether); // on robotId
        uint256 d = _dl();
        bytes32 dg = reg.startSessionDigest(other, player, reg.nonces(player), d);
        uint256 sid = reg.startSessionFor(other, player, d, _sig(playerPk, dg));
        _record(sid, true);
        vm.expectRevert(EscrowVaultV2.WrongRobot.selector);
        vault.claimBounty(id, sid);
    }

    function test_Attack_OldBreachCannotTakeNewBounty() public {
        uint256 sid = _start(player, playerPk);
        _record(sid, true);
        vm.warp(block.timestamp + 1);
        uint256 id = _deposit(1 ether);
        vm.expectRevert(EscrowVaultV2.SessionBeforeBounty.selector);
        vault.claimBounty(id, sid);
    }

    function test_Attack_DoubleClaim() public {
        uint256 id = _deposit(1 ether);
        uint256 sid = _start(player, playerPk);
        _record(sid, true);
        vault.claimBounty(id, sid);
        vm.expectRevert(EscrowVaultV2.BountyNotOpen.selector);
        vault.claimBounty(id, sid);
    }

    function test_OneBreachClaimsEveryOpenBounty() public {
        uint256 a = _deposit(1 ether);
        uint256 b = _deposit(2 ether);
        uint256 sid = _start(player, playerPk);
        _record(sid, true);
        vault.claimBounty(a, sid);
        vault.claimBounty(b, sid);
        assertEq(player.balance, 3 ether);
    }

    function test_Attack_ReentrancyOnClaim() public {
        Reenterer r = new Reenterer(vault);
        keys.setKey(address(r), hex"0e0e");
        uint256 a = _deposit(1 ether);
        uint256 b = _deposit(1 ether);
        uint256 d = _dl();
        bytes32 dg = reg.startSessionDigest(robotId, address(r), reg.nonces(address(r)), d);
        uint256 sid = reg.startSessionFor(robotId, address(r), d, _sig(hex"0e0e", dg));
        _record(sid, true);
        r.arm(b, sid);
        vault.claimBounty(a, sid);
        assertTrue(r.tried());
        assertFalse(r.reentered());
        assertEq(uint8(_status(b)), uint8(EscrowVaultV2.Status.Open));
        assertEq(vault.totalLocked(), 1 ether);
    }

    function test_FailedPaymentRevertsEverything() public {
        Refuser r = new Refuser();
        keys.setKey(address(r), hex"0f0f");
        uint256 id = _deposit(1 ether);
        uint256 d = _dl();
        bytes32 dg = reg.startSessionDigest(robotId, address(r), reg.nonces(address(r)), d);
        uint256 sid = reg.startSessionFor(robotId, address(r), d, _sig(hex"0f0f", dg));
        _record(sid, true);
        vm.expectRevert(abi.encodeWithSelector(EscrowVaultV2.TransferFailed.selector, address(r), 1 ether));
        vault.claimBounty(id, sid);
        assertEq(uint8(_status(id)), uint8(EscrowVaultV2.Status.Open));
        assertEq(vault.totalLocked(), 1 ether);
    }

    // ------------------------------------------- withdraw vs payout race (self-review #1)

    function test_WinInProgressIsPaidBeforeWithdrawal() public {
        uint256 id = _deposit(4 ether);
        uint256 sid = _start(player, playerPk);
        _requestWithdraw(id, owner); // owner sees the attack coming and tries to pull out
        vm.warp(block.timestamp + 70 minutes); // latest moment the result can still be recorded
        _record(sid, true);
        vault.claimBounty(id, sid);
        assertEq(player.balance, 4 ether);
        vm.warp(block.timestamp + 3 hours);
        vm.expectRevert(EscrowVaultV2.BountyNotOpen.selector);
        vault.finalizeWithdraw(id);
    }

    function test_SessionAfterWithdrawRequestCannotClaim() public {
        uint256 id = _deposit(1 ether);
        _requestWithdraw(id, owner);
        vm.warp(block.timestamp + 10 minutes + 1);
        uint256 sid = _start(player, playerPk);
        _record(sid, true);
        vm.expectRevert(EscrowVaultV2.SessionAfterWithdrawRequest.selector);
        vault.claimBounty(id, sid);
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
        vm.expectRevert(EscrowVaultV2.WithdrawNotRequested.selector);
        vault.finalizeWithdraw(id);
    }

    // ----------------------------------------------------------- deposits

    function test_Attack_DepositChecks() public {
        vm.prank(relayer);
        vm.expectRevert(EscrowVaultV2.AmountTooSmall.selector);
        vault.depositBounty{value: 0.5 ether}(robotId);
        vm.prank(relayer);
        vm.expectRevert(EscrowVaultV2.UnknownRobot.selector);
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
        vault.claimBounty(claimFirst ? i : j, sid);
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
        vault.claimBounty(id, sid);
        assertEq(player.balance, 1 ether);
    }

    function test_Pause_ResultDuringPauseWaits() public {
        uint256 id = _deposit(1 ether);
        uint256 sid = _start(player, playerPk);
        _pause(true);
        _record(sid, true); // registry is not paused
        vm.expectRevert(EscrowVaultV2.ResultDuringPause.selector);
        vault.claimBounty(id, sid);
        _pause(false);
        vault.claimBounty(id, sid);
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
        vm.expectRevert(EscrowVaultV2.WithdrawLocked.selector); // wins get UNPAUSE_GRACE first
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
        vm.expectRevert(EscrowVaultV2.WithdrawLocked.selector);
        vault.finalizeWithdraw(id);
        vault.claimBounty(id, sid);
        assertEq(player.balance, 2 ether);
    }

    function test_Pause_RegistryPauseKeepsVerdicts() public {
        uint256 sid = _start(player, playerPk);
        uint256 d = _dl();
        reg.setPaused(true, d, _sig(adminPk, reg.setPausedDigest(true, reg.nonces(admin), d)));
        _record(sid, true); // already-started rounds still get their verdict
        assertEq(uint8(reg.getSession(sid).outcome), uint8(RobotRegistryV3.Outcome.Breached));
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
        vault.claimBounty(id, sid);
        assertEq(player.balance, 1 ether);
    }

    /// Reviewer L-1: a withdrawal to an address that refuses payment can be re-requested.
    function test_Withdraw_ReRequestFixesBadDestination() public {
        Refuser r = new Refuser();
        uint256 id = _deposit(1 ether);
        _requestWithdraw(id, address(r));
        vm.warp(block.timestamp + 3 hours);
        vm.expectRevert(abi.encodeWithSelector(EscrowVaultV2.TransferFailed.selector, address(r), 1 ether));
        vault.finalizeWithdraw(id);
        _requestWithdraw(id, owner);
        vm.expectRevert(EscrowVaultV2.WithdrawLocked.selector); // delay restarts
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

        dg = reg.proposeRefereeDigest(keccak256(attackerPk), reg.nonces(admin), d);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.proposeReferee(attackerPk, d, _sig(attackerPk, dg));
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

        dg = reg.acceptAdminDigest(player, reg.nonces(player), d);
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
        bytes memory newPk = hex"7777";
        bytes32 dg = reg.proposeRefereeDigest(keccak256(newPk), reg.nonces(admin), d);
        reg.proposeReferee(newPk, d, _sig(adminPk, dg));

        // the new key can't record anything yet
        uint256 sid = _start(player, playerPk);
        uint256 rd = block.timestamp + 70 minutes;
        bytes32 rdg = reg.resultDigest(sid, robotId, player, true, keccak256("r"), rd);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.recordResult(sid, true, keccak256("r"), rd, _sig(newPk, rdg));
        vm.expectRevert(RobotRegistryV3.RefereeDelayNotOver.selector);
        reg.activateReferee();

        vm.warp(block.timestamp + 2 days);
        reg.activateReferee();
        assertEq(reg.refereePubkey(), newPk);
        vm.expectRevert(RobotRegistryV3.NoPendingReferee.selector);
        reg.activateReferee();
    }

    // ----------------------------------------------------- results (QCAI #4 replay)

    function test_Attack_ResultBoundToRobotAndPlayer() public {
        uint256 sid = _start(player, playerPk);
        uint256 d = block.timestamp + 70 minutes;
        // a verdict signed for another player or robot does not fit this session
        bytes32 wrongPlayer = reg.resultDigest(sid, robotId, player2, true, keccak256("r"), d);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.recordResult(sid, true, keccak256("r"), d, _sig(refereePk, wrongPlayer));
        bytes32 wrongRobot = reg.resultDigest(sid, robotId + 1, player, true, keccak256("r"), d);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.recordResult(sid, true, keccak256("r"), d, _sig(refereePk, wrongRobot));
        // flipping the outcome breaks the signature
        bytes32 defended = reg.resultDigest(sid, robotId, player, false, keccak256("r"), d);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.recordResult(sid, true, keccak256("r"), d, _sig(refereePk, defended));
    }

    function test_Attack_ResultReplayAndTiming() public {
        uint256 sid = _start(player, playerPk);
        _record(sid, false);
        RobotRegistryV3.Session memory s = reg.getSession(sid);
        assertEq(s.resultAt, block.timestamp);
        uint256 d = uint256(s.startedAt) + 70 minutes;
        bytes32 dg = reg.resultDigest(sid, robotId, player, true, keccak256("replay"), d);
        vm.expectRevert(RobotRegistryV3.AlreadyRecorded.selector);
        reg.recordResult(sid, true, keccak256("replay"), d, _sig(refereePk, dg));

        uint256 sid2 = _start(player, playerPk);
        vm.warp(block.timestamp + 70 minutes + 1);
        d = block.timestamp + 1;
        dg = reg.resultDigest(sid2, robotId, player, true, keccak256("replay"), d);
        vm.expectRevert(RobotRegistryV3.ResultTooLate.selector);
        reg.recordResult(sid2, true, keccak256("replay"), d, _sig(refereePk, dg));
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
        vm.expectRevert(RobotRegistryV3.OwnRobot.selector);
        reg.startSessionFor(robotId, owner, d, _sig(ownerPk, dg));
    }

    function test_DailyLimit() public {
        for (uint256 i = 0; i < 5; i++) _start(player, playerPk);
        uint256 d = _dl();
        bytes32 dg = reg.startSessionDigest(robotId, player, reg.nonces(player), d);
        vm.expectRevert(RobotRegistryV3.DailyLimitReached.selector);
        reg.startSessionFor(robotId, player, d, _sig(playerPk, dg));
    }

    // ------------------------------------------------------------ names (QCAI #5)

    function test_Attack_BadNames() public {
        string[5] memory bad = ["", " lead", "trail ", "tab\there", "\xe2\x80\xaeevil"];
        for (uint256 i = 0; i < bad.length; i++) {
            vm.prank(owner);
            vm.expectRevert(RobotRegistryV3.BadName.selector);
            reg.registerRobot(bad[i], keccak256("b"));
        }
        bytes memory long = new bytes(65);
        for (uint256 i = 0; i < 65; i++) long[i] = "a";
        vm.prank(owner);
        vm.expectRevert(RobotRegistryV3.BadName.selector);
        reg.registerRobot(string(long), keccak256("b"));
    }

    function test_Utility_ReplayAndBounds() public {
        uint256 d = _dl();
        bytes32 dg = reg.utilityDigest(robotId, 11, keccak256("u"), 0, d);
        vm.expectRevert(RobotRegistryV3.BadUtility.selector);
        reg.recordUtility(robotId, 11, keccak256("u"), d, _sig(refereePk, dg));
        dg = reg.utilityDigest(robotId, 8, keccak256("u"), 0, d);
        bytes memory s = _sig(refereePk, dg);
        reg.recordUtility(robotId, 8, keccak256("u"), d, s);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.recordUtility(robotId, 8, keccak256("u"), d, s);
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
        bytes32 dg = reg.acceptAdminDigest(player, reg.nonces(player), d);
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
        RobotRegistryV3.Robot memory r = reg.getRobot(robotId);
        assertEq(r.attacks, 0);
        assertEq(r.breached, 0);
        assertEq(uint8(reg.getSession(sid).outcome), uint8(RobotRegistryV3.Outcome.Breached));
    }

    /// Reviewer L-6: a relayer can't hold a start request for long.
    function test_Attack_StartRequestHeldTooLong() public {
        uint256 d = block.timestamp + 30 minutes;
        bytes32 dg = reg.startSessionDigest(robotId, player, reg.nonces(player), d);
        vm.expectRevert(RobotRegistryV3.StartRequestTooLong.selector);
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
        vm.expectRevert(EscrowVaultV2.WithdrawLocked.selector); // wins get UNPAUSE_GRACE first
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
}
