// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RobotRegistryV2} from "../src/RobotRegistryV2.sol";
import {PQGuard} from "../src/PQGuard.sol";
import {PQAdmin} from "../src/PQAdmin.sol";
import {QoreXMessage} from "../src/QoreXMessage.sol";
import {MockPQC} from "./mocks/MockPQC.sol";

/// @notice Functional tests plus an attacker's playbook against RobotRegistryV2.
///         Attackers here hold every classical (ECDSA) key and can call anything, but they do
///         not hold the victims' ML-DSA secret keys (the mock models ML-DSA as an unforgeable
///         keccak over pubkey and message).
contract RobotRegistryV2Test is Test {
    address constant VERIFY = 0x0000000000000000000000000000000000000a01;
    address constant STATUS = 0x0000000000000000000000000000000000000a02;
    bytes constant CHAIN = "qorechain-diana";

    RobotRegistryV2 internal reg;
    MockPQC internal keys;

    address internal admin = makeAddr("admin");
    address internal owner = makeAddr("robotOwner");
    address internal player = makeAddr("player");
    address internal player2 = makeAddr("player2");
    address internal attacker = makeAddr("attacker");
    address internal relayer = makeAddr("relayer");
    address internal nobody = makeAddr("noPQKey");

    bytes internal adminPk = hex"a11ce0";
    bytes internal ownerPk = hex"0b0b0b";
    bytes internal playerPk = hex"1a1a1a";
    bytes internal player2Pk = hex"2b2b2b";
    bytes internal attackerPk = hex"666666";
    bytes internal refereePk = hex"5e5e5e";

    bytes32 internal constant BRAIN = keccak256("brain-v1");
    bytes32 internal constant BRAIN2 = keccak256("brain-v2");
    bytes32 internal constant REPLAY = keccak256("replay");

    uint256 internal robotId;

    function setUp() public {
        vm.warp(1_800_000_000);
        MockPQC impl = new MockPQC();
        vm.etch(VERIFY, address(impl).code);
        vm.etch(STATUS, address(impl).code);
        keys = MockPQC(STATUS);
        keys.setKey(admin, adminPk);
        keys.setKey(owner, ownerPk);
        keys.setKey(player, playerPk);
        keys.setKey(player2, player2Pk);
        keys.setKey(attacker, attackerPk);

        vm.prank(admin);
        reg = new RobotRegistryV2(refereePk, CHAIN);

        vm.prank(owner);
        robotId = reg.registerRobot("Sentinel-01", BRAIN);
    }

    // ================================================================ helpers

    function _raw(bytes memory pk, bytes32 digest) internal view returns (bytes memory) {
        return abi.encodePacked(MockPQC(VERIFY).sign(pk, abi.encodePacked(digest)));
    }

    function _qorex(bytes memory pk, string memory action, bytes32 digest) internal view returns (bytes memory) {
        return abi.encodePacked(MockPQC(VERIFY).sign(pk, reg.walletMessage(action, digest)));
    }

    function _qorexFor(RobotRegistryV2 r, bytes memory pk, string memory action, bytes32 digest) internal view returns (bytes memory) {
        return abi.encodePacked(MockPQC(VERIFY).sign(pk, r.walletMessage(action, digest)));
    }

    function _startSig(address who, bytes memory pk, uint256 rid, uint256 deadline) internal view returns (bytes memory) {
        return _qorex(pk, "StartSession", reg.startSessionDigest(rid, who, reg.nonces(who), deadline));
    }

    function _startFor(address who, bytes memory pk) internal returns (uint256) {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _startSig(who, pk, robotId, deadline);
        vm.prank(relayer);
        return reg.startSessionFor(robotId, who, deadline, sig);
    }

    function _result(uint256 sessionId, bool breached) internal {
        uint256 deadline = block.timestamp + 1 hours;
        reg.recordResult(sessionId, breached, REPLAY, deadline, _raw(refereePk, reg.resultDigest(sessionId, breached, REPLAY, deadline)));
    }

    function _utility(uint8 tasks) internal {
        uint256 deadline = block.timestamp + 1 hours;
        uint32 n = reg.getRobot(robotId).utilityNonce;
        reg.recordUtility(robotId, tasks, REPLAY, deadline, _raw(refereePk, reg.utilityDigest(robotId, tasks, REPLAY, n, deadline)));
    }

    function _adminSig(bytes32 digest) internal view returns (bytes memory) {
        return _raw(adminPk, digest);
    }

    // ============================================================ functional

    function test_WalletMessageIsTheExactQoreXFormat() public view {
        bytes32 d = bytes32(uint256(0xabcdef));
        bytes memory expected = abi.encodePacked(
            "qorechain-msg-v1|qorechain-diana|RedZone authorisation\naction: StartSession\ndigest: 0x",
            "0000000000000000000000000000000000000000000000000000000000abcdef"
        );
        assertEq(reg.walletMessage("StartSession", d), expected);
        assertEq(QoreXMessage.toHex(bytes32(type(uint256).max)), bytes("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"));
    }

    function test_StartSessionFor_QoreXSignature_RelayedByAnyone() public {
        uint256 id = _startFor(player, playerPk);
        (uint256 rid, address p,, RobotRegistryV2.Outcome o,) = reg.sessions(id);
        assertEq(rid, robotId);
        assertEq(p, player, "session belongs to the player, not the relayer");
        assertEq(uint8(o), 0);
        assertEq(reg.nonces(player), 1);
        assertEq(reg.attemptsLeftToday(player), 4);
        assertEq(reg.attemptsLeftToday(relayer), 5);
    }

    function test_StartSessionFor_RawDigestSignature() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _raw(playerPk, reg.startSessionDigest(robotId, player, 0, deadline));
        uint256 id = reg.startSessionFor(robotId, player, deadline, sig);
        (, address p,,,) = reg.sessions(id);
        assertEq(p, player);
    }

    function test_StartSession_Direct() public {
        vm.prank(player);
        uint256 id = reg.startSession(robotId);
        (, address p,,,) = reg.sessions(id);
        assertEq(p, player);
    }

    function test_RegisterRobotFor_QoreX() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _qorex(playerPk, "RegisterRobot", reg.registerRobotDigest(player, keccak256("Bot-2"), BRAIN2, 0, deadline));
        vm.prank(relayer);
        uint256 id = reg.registerRobotFor(player, "Bot-2", BRAIN2, deadline, sig);
        RobotRegistryV2.Robot memory r = reg.getRobot(id);
        assertEq(r.owner, player);
        assertEq(r.brainHash, BRAIN2);
        assertEq(r.name, "Bot-2");
    }

    function test_UpdateBrain_QoreX_ResetsStats() public {
        uint256 s = _startFor(player, playerPk);
        _result(s, false);
        _utility(9);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _qorex(ownerPk, "UpdateBrain", reg.updateBrainDigest(robotId, BRAIN2, 0, deadline));
        reg.updateBrain(robotId, BRAIN2, deadline, sig);
        RobotRegistryV2.Robot memory r = reg.getRobot(robotId);
        assertEq(r.brainHash, BRAIN2);
        assertEq(r.attacks, 0);
        assertEq(r.utilityScore, 0);
    }

    function test_FullRound_RatingAndTier() public {
        _utility(10);
        for (uint256 day = 0; day < 2; day++) {
            for (uint256 i = 0; i < 5; i++) {
                uint256 s = _startFor(player, playerPk);
                _result(s, false);
            }
            vm.warp(block.timestamp + 1 days);
        }
        assertEq(reg.getRating(robotId), 10_000);
        assertEq(uint8(reg.getTier(robotId)), uint8(RobotRegistryV2.Tier.Guard));
        uint256 b = _startFor(player, playerPk);
        _result(b, true);
        assertEq(reg.getRobot(robotId).breached, 1);
    }

    // ===================================================== attacks: signatures

    /// Replay: the same signed request can start only one session.
    function test_Attack_ReplayStartRequest() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _startSig(player, playerPk, robotId, deadline);
        reg.startSessionFor(robotId, player, deadline, sig);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.startSessionFor(robotId, player, deadline, sig);
    }

    /// Identity swap: player's signature cannot start a session for someone else.
    function test_Attack_UseVictimSigForOtherPlayer() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _startSig(player, playerPk, robotId, deadline);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.startSessionFor(robotId, player2, deadline, sig);
    }

    /// Attacker signs with their own ML-DSA key but names the victim as player.
    function test_Attack_OwnKeyForVictim() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _qorex(attackerPk, "StartSession", reg.startSessionDigest(robotId, player, 0, deadline));
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.startSessionFor(robotId, player, deadline, sig);
    }

    /// Retarget: a request for robot 1 cannot be used on robot 2.
    function test_Attack_RetargetRobot() public {
        vm.prank(player2);
        uint256 robot2 = reg.registerRobot("Other", BRAIN);
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _startSig(player, playerPk, robotId, deadline);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.startSessionFor(robot2, player, deadline, sig);
    }

    /// Tamper with the deadline after signing.
    function test_Attack_ChangeDeadline() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _startSig(player, playerPk, robotId, deadline);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.startSessionFor(robotId, player, deadline + 1, sig);
    }

    /// Cross-contract replay: a request signed for another deployment is useless here.
    function test_Attack_ReplayFromOtherDeployment() public {
        vm.prank(admin);
        RobotRegistryV2 other = new RobotRegistryV2(refereePk, CHAIN);
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _qorexFor(other, playerPk, "StartSession", other.startSessionDigest(robotId, player, 0, deadline));
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.startSessionFor(robotId, player, deadline, sig);
    }

    /// Cross-chain replay: a QoreX signature made for mainnet ("qorechain-vladi") fails on testnet.
    function test_Attack_ReplayFromOtherNativeChain() public {
        vm.prank(admin);
        RobotRegistryV2 mainnetTwin = new RobotRegistryV2(refereePk, "qorechain-vladi");
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 d = reg.startSessionDigest(robotId, player, 0, deadline);
        bytes memory sig = abi.encodePacked(MockPQC(VERIFY).sign(playerPk, mainnetTwin.walletMessage("StartSession", d)));
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.startSessionFor(robotId, player, deadline, sig);
    }

    /// Cross-chain replay at the EVM level: same contract address, different chain id.
    function test_Attack_ReplayOnOtherEvmChainId() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _startSig(player, playerPk, robotId, deadline);
        vm.chainId(1);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.startSessionFor(robotId, player, deadline, sig);
    }

    /// Action confusion: the same digest signed under another action label is refused.
    function test_Attack_WrongActionLabel() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _qorex(playerPk, "RegisterRobot", reg.startSessionDigest(robotId, player, 0, deadline));
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.startSessionFor(robotId, player, deadline, sig);
    }

    /// Type confusion: a signed RegisterRobot request cannot start a session (different typehash).
    function test_Attack_RegisterSigUsedAsStartSig() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 regDigest = reg.registerRobotDigest(player, keccak256("x"), BRAIN, 0, deadline);
        bytes memory sig = _qorex(playerPk, "StartSession", regDigest);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.startSessionFor(robotId, player, deadline, sig);
    }

    /// Signature over arbitrary text the victim signed elsewhere (phishing-style reuse).
    function test_Attack_ReuseUnrelatedWalletSignature() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = abi.encodePacked(MockPQC(VERIFY).sign(playerPk, "qorechain-msg-v1|qorechain-diana|hello world"));
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.startSessionFor(robotId, player, deadline, sig);
    }

    function test_Attack_EmptyAndGarbageSignatures() public {
        uint256 deadline = block.timestamp + 10 minutes;
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.startSessionFor(robotId, player, deadline, "");
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.startSessionFor(robotId, player, deadline, new bytes(4627));
    }

    function testFuzz_Attack_RandomSignatureNeverPasses(bytes calldata sig) public {
        uint256 deadline = block.timestamp + 10 minutes;
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.startSessionFor(robotId, player, deadline, sig);
    }

    /// Stolen ECDSA key: sending as the player without an ML-DSA signature fails.
    function test_Attack_StolenEcdsaKeyCannotUseFor() public {
        vm.prank(player);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.startSessionFor(robotId, player, block.timestamp + 10 minutes, hex"00");
    }

    // ======================================================= attacks: timing

    function test_Attack_ExpiredRequest() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _startSig(player, playerPk, robotId, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(PQAdmin.Expired.selector);
        reg.startSessionFor(robotId, player, deadline, sig);
    }

    /// A relayer cannot hold a request for days: far deadlines are refused up front.
    function test_Attack_FarDeadlineRefused() public {
        uint256 deadline = block.timestamp + 2 hours;
        bytes memory sig = _startSig(player, playerPk, robotId, deadline);
        vm.expectRevert(RobotRegistryV2.DeadlineTooFar.selector);
        reg.startSessionFor(robotId, player, deadline, sig);
    }

    // ======================================================== attacks: rules

    function test_Attack_PlayerWithoutPQKey() public {
        uint256 deadline = block.timestamp + 10 minutes;
        vm.expectRevert(abi.encodeWithSelector(PQGuard.PQCKeyNotRegistered.selector, nobody));
        reg.startSessionFor(robotId, nobody, deadline, hex"00");
        vm.prank(nobody);
        vm.expectRevert(abi.encodeWithSelector(PQGuard.PQCKeyNotRegistered.selector, nobody));
        reg.startSession(robotId);
    }

    function test_Attack_ZeroAddressPlayer() public {
        vm.expectRevert(abi.encodeWithSelector(PQGuard.PQCKeyNotRegistered.selector, address(0)));
        reg.startSessionFor(robotId, address(0), block.timestamp + 10 minutes, hex"00");
    }

    function test_Attack_OwnerAttacksOwnRobotViaRelay() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _startSig(owner, ownerPk, robotId, deadline);
        vm.expectRevert(RobotRegistryV2.OwnRobot.selector);
        reg.startSessionFor(robotId, owner, deadline, sig);
    }

    function test_Attack_UnknownRobot() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _startSig(player, playerPk, 999, deadline);
        vm.expectRevert(RobotRegistryV2.UnknownRobot.selector);
        reg.startSessionFor(999, player, deadline, sig);
    }

    /// Daily limit holds across direct and relayed starts, and resets the next UTC day.
    function test_Attack_DailyLimitCannotBeBypassed() public {
        for (uint256 i = 0; i < 3; i++) _startFor(player, playerPk);
        vm.startPrank(player);
        reg.startSession(robotId);
        reg.startSession(robotId);
        vm.expectRevert(RobotRegistryV2.DailyLimitReached.selector);
        reg.startSession(robotId);
        vm.stopPrank();
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _startSig(player, playerPk, robotId, deadline);
        vm.expectRevert(RobotRegistryV2.DailyLimitReached.selector);
        reg.startSessionFor(robotId, player, deadline, sig);

        vm.warp((block.timestamp / 1 days + 1) * 1 days);
        _startFor(player, playerPk);
        assertEq(reg.attemptsLeftToday(player), 4);
    }

    /// Front-running a player's request only starts the player's own session.
    function test_Attack_FrontRunRequestBenefitsNoOne() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _startSig(player, playerPk, robotId, deadline);
        vm.prank(attacker);
        uint256 id = reg.startSessionFor(robotId, player, deadline, sig);
        (, address p,,,) = reg.sessions(id);
        assertEq(p, player);
        assertEq(reg.attemptsLeftToday(attacker), 5);
    }

    function test_Attack_PausedBlocksRelayedStarts() public {
        uint256 deadline = block.timestamp + 1 hours;
        reg.setPaused(true, deadline, _adminSig(reg.setPausedDigest(true, 0, deadline)));
        uint256 d2 = block.timestamp + 10 minutes;
        bytes memory sig = _startSig(player, playerPk, robotId, d2);
        vm.expectRevert(PQAdmin.Paused.selector);
        reg.startSessionFor(robotId, player, d2, sig);
    }

    // ===================================================== attacks: register

    function test_Attack_RegisterFor_ReplayAndTamper() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _qorex(playerPk, "RegisterRobot", reg.registerRobotDigest(player, keccak256("Bot-2"), BRAIN2, 0, deadline));
        // Tamper: different name, different brain, different owner.
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.registerRobotFor(player, "Bot-3", BRAIN2, deadline, sig);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.registerRobotFor(player, "Bot-2", BRAIN, deadline, sig);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.registerRobotFor(attacker, "Bot-2", BRAIN2, deadline, sig);
        // Honest use, then replay.
        reg.registerRobotFor(player, "Bot-2", BRAIN2, deadline, sig);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.registerRobotFor(player, "Bot-2", BRAIN2, deadline, sig);
    }

    function test_Attack_BadRobotNames() public {
        string[7] memory bad = [
            "",
            " lead",
            "trail ",
            "new\nline",
            "tab\there",
            string(hex"636166c3a9"), // "café" (non-ASCII)
            string(hex"72746ce280ae6576696c") // "rtl" + U+202E right-to-left override + "evil"
        ];
        vm.startPrank(player);
        for (uint256 i = 0; i < bad.length; i++) {
            vm.expectRevert(RobotRegistryV2.BadName.selector);
            reg.registerRobot(bad[i], BRAIN);
        }
        vm.expectRevert(RobotRegistryV2.BadName.selector);
        reg.registerRobot(string(new bytes(65)), BRAIN);
        reg.registerRobot("Ok name-1_(v2)", BRAIN);
        vm.stopPrank();
    }

    // ================================================== attacks: brain update

    function test_Attack_UpdateBrain_WithoutOwnerSig() public {
        uint256 deadline = block.timestamp + 1 hours;
        // Stolen ECDSA key of the owner: no ML-DSA signature, no change.
        vm.prank(owner);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.updateBrain(robotId, BRAIN2, deadline, hex"00");
        // Attacker's own key.
        bytes memory sig = _qorex(attackerPk, "UpdateBrain", reg.updateBrainDigest(robotId, BRAIN2, 0, deadline));
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.updateBrain(robotId, BRAIN2, deadline, sig);
    }

    function test_Attack_UpdateBrain_ReplayAndSwap() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _qorex(ownerPk, "UpdateBrain", reg.updateBrainDigest(robotId, BRAIN2, 0, deadline));
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.updateBrain(robotId, BRAIN, deadline, sig); // different brain
        reg.updateBrain(robotId, BRAIN2, deadline, sig);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.updateBrain(robotId, BRAIN2, deadline, sig); // replay
    }

    /// A relayer cannot sit on an owner's signed brain change: far deadlines are refused.
    function test_Attack_UpdateBrain_FarDeadlineRefused() public {
        uint256 deadline = block.timestamp + 3 days;
        bytes memory sig = _qorex(ownerPk, "UpdateBrain", reg.updateBrainDigest(robotId, BRAIN2, 0, deadline));
        vm.expectRevert(RobotRegistryV2.DeadlineTooFar.selector);
        reg.updateBrain(robotId, BRAIN2, deadline, sig);
    }

    /// A player's start-session signature cannot be turned into a brain update.
    function test_Attack_StartSigUsedForUpdateBrain() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _startSig(owner, ownerPk, robotId, deadline);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.updateBrain(robotId, BRAIN2, deadline, sig);
    }

    // ===================================================== attacks: verdicts

    function test_Attack_ForgedVerdicts() public {
        uint256 s = _startFor(player, playerPk);
        uint256 deadline = block.timestamp + 1 hours;
        // Player signs their own "breach" verdict.
        bytes memory own = _raw(playerPk, reg.resultDigest(s, true, REPLAY, deadline));
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.recordResult(s, true, REPLAY, deadline, own);
        // Defended verdict flipped to breached.
        bytes memory defended = _raw(refereePk, reg.resultDigest(s, false, REPLAY, deadline));
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.recordResult(s, true, REPLAY, deadline, defended);
        // Verdict for session s applied to another session.
        uint256 s2 = _startFor(player2, player2Pk);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.recordResult(s2, false, REPLAY, deadline, defended);
        // Utility signature used as a result signature.
        bytes memory util = _raw(refereePk, reg.utilityDigest(robotId, 10, REPLAY, 0, deadline));
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.recordResult(s, false, REPLAY, deadline, util);
    }

    function test_Attack_VerdictReplayAndTiming() public {
        uint256 s = _startFor(player, playerPk);
        _result(s, false);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _raw(refereePk, reg.resultDigest(s, true, REPLAY, deadline));
        vm.expectRevert(RobotRegistryV2.AlreadyRecorded.selector);
        reg.recordResult(s, true, REPLAY, deadline, sig);

        bytes memory ghost = _raw(refereePk, reg.resultDigest(9999, true, REPLAY, deadline));
        vm.expectRevert(RobotRegistryV2.UnknownSession.selector);
        reg.recordResult(9999, true, REPLAY, deadline, ghost);

        uint256 late = _startFor(player, playerPk);
        vm.warp(block.timestamp + 10 minutes + 1 hours + 1);
        uint256 d2 = block.timestamp + 1 hours;
        bytes memory lateSig = _raw(refereePk, reg.resultDigest(late, true, REPLAY, d2));
        vm.expectRevert(RobotRegistryV2.ResultTooLate.selector);
        reg.recordResult(late, true, REPLAY, d2, lateSig);

        // An expired verdict deadline is refused even inside the grace period.
        uint256 s3 = _startFor(player2, player2Pk);
        uint256 d3 = block.timestamp + 5 minutes;
        bytes memory sig3 = _raw(refereePk, reg.resultDigest(s3, true, REPLAY, d3));
        vm.warp(d3 + 1);
        vm.expectRevert(PQAdmin.Expired.selector);
        reg.recordResult(s3, true, REPLAY, d3, sig3);
    }

    function test_Attack_UtilityReplayAndBounds() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _raw(refereePk, reg.utilityDigest(robotId, 10, REPLAY, 0, deadline));
        reg.recordUtility(robotId, 10, REPLAY, deadline, sig);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.recordUtility(robotId, 10, REPLAY, deadline, sig);
        vm.expectRevert(RobotRegistryV2.BadUtility.selector);
        reg.recordUtility(robotId, 11, REPLAY, deadline, sig);
    }

    // ========================================================= attacks: admin

    /// The drill bot's view: it has the admin's ECDSA key and nothing else.
    function test_Attack_StolenAdminEcdsaKey() public {
        uint256 deadline = block.timestamp + 1 hours;
        vm.startPrank(admin);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.setReferee(attackerPk, deadline, hex"00");
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.setPaused(true, deadline, hex"00");
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.transferAdmin(attacker, deadline, hex"00");
        vm.stopPrank();
        // Attacker signs admin actions with their own ML-DSA key.
        bytes memory sig = _raw(attackerPk, reg.transferAdminDigest(attacker, 0, deadline));
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.transferAdmin(attacker, deadline, sig);
        assertEq(reg.admin(), admin);
    }

    function test_Attack_AdminSigReplay() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _adminSig(reg.setPausedDigest(true, 0, deadline));
        reg.setPaused(true, deadline, sig);
        reg.setPaused(false, deadline, _adminSig(reg.setPausedDigest(false, 1, deadline)));
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.setPaused(true, deadline, sig);
    }

    // ================================================ attacks: infrastructure

    /// If the PQC precompile is missing, everything fails closed (nothing is let through).
    function test_Attack_PrecompileMissingFailsClosed() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _startSig(player, playerPk, robotId, deadline);
        vm.etch(VERIFY, "");
        vm.expectRevert(PQGuard.PQCPrecompileUnavailable.selector);
        reg.startSessionFor(robotId, player, deadline, sig);
    }

    /// A precompile answering junk is refused, not read as "valid".
    function test_Attack_PrecompileJunkFailsClosed() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _startSig(player, playerPk, robotId, deadline);
        vm.etch(VERIFY, hex"60016000f3"); // returns 1 byte
        vm.expectRevert(PQGuard.PQCPrecompileUnavailable.selector);
        reg.startSessionFor(robotId, player, deadline, sig);
    }

    function test_Constructor_RejectsBadChainIds() public {
        vm.startPrank(admin);
        vm.expectRevert(QoreXMessage.BadNativeChainId.selector);
        new RobotRegistryV2(refereePk, "");
        vm.expectRevert(QoreXMessage.BadNativeChainId.selector);
        new RobotRegistryV2(refereePk, "chain|evil");
        vm.expectRevert(QoreXMessage.BadNativeChainId.selector);
        new RobotRegistryV2(refereePk, "chain id");
        vm.expectRevert(PQAdmin.EmptyPubkey.selector);
        new RobotRegistryV2("", CHAIN);
        vm.stopPrank();
        vm.prank(nobody);
        vm.expectRevert(abi.encodeWithSelector(PQGuard.PQCKeyNotRegistered.selector, nobody));
        new RobotRegistryV2(refereePk, CHAIN);
    }

    /// The contract can never hold value.
    function test_Attack_SendValueRefused() public {
        vm.deal(attacker, 1 ether);
        vm.prank(attacker);
        (bool ok,) = address(reg).call{value: 1 ether}("");
        assertFalse(ok);
    }
}
