// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RobotRegistry} from "../src/RobotRegistry.sol";
import {PQGuard} from "../src/PQGuard.sol";
import {PQAdmin} from "../src/PQAdmin.sol";
import {MockPQC} from "./mocks/MockPQC.sol";

contract RobotRegistryTest is Test {
    address constant VERIFY = 0x0000000000000000000000000000000000000a01;
    address constant STATUS = 0x0000000000000000000000000000000000000a02;

    RobotRegistry internal reg;
    MockPQC internal registry;

    address internal admin = makeAddr("admin");
    address internal owner = makeAddr("robotOwner");
    address internal player = makeAddr("player");
    address internal nobody = makeAddr("noPQKey");

    bytes internal adminPk = hex"a11ce0";
    bytes internal ownerPk = hex"0b0b0b";
    bytes internal playerPk = hex"1a1a1a";
    bytes internal refereePk = hex"5e5e5e";

    bytes32 internal constant BRAIN = keccak256("claude-sonnet-5-5|system-prompt-v1");
    bytes32 internal constant REPLAY = keccak256("replay");

    uint256 internal robotId;

    function setUp() public {
        vm.warp(1_700_000_000);
        MockPQC impl = new MockPQC();
        vm.etch(VERIFY, address(impl).code);
        vm.etch(STATUS, address(impl).code);
        registry = MockPQC(STATUS);
        registry.setKey(admin, adminPk);
        registry.setKey(owner, ownerPk);
        registry.setKey(player, playerPk);

        vm.prank(admin);
        reg = new RobotRegistry(refereePk);

        vm.prank(owner);
        robotId = reg.registerRobot("Sentinel-01", BRAIN);
    }

    // ----------------------------------------------------------- helpers

    function _sig(bytes memory pk, bytes32 digest) internal view returns (bytes memory) {
        return abi.encodePacked(MockPQC(VERIFY).sign(pk, abi.encodePacked(digest)));
    }

    function _start() internal returns (uint256 id) {
        vm.prank(player);
        id = reg.startSession(robotId);
    }

    function _result(uint256 sessionId, bool breached) internal {
        uint256 deadline = block.timestamp + 1 hours;
        reg.recordResult(sessionId, breached, REPLAY, deadline, _sig(refereePk, reg.resultDigest(sessionId, breached, REPLAY, deadline)));
    }

    function _utility(uint8 tasks) internal {
        uint256 deadline = block.timestamp + 1 hours;
        uint32 nonce = reg.getRobot(robotId).utilityNonce;
        reg.recordUtility(robotId, tasks, REPLAY, deadline, _sig(refereePk, reg.utilityDigest(robotId, tasks, REPLAY, nonce, deadline)));
    }

    // ---------------------------------------------------------- register

    function test_RegisterRobot() public view {
        RobotRegistry.Robot memory r = reg.getRobot(robotId);
        assertEq(r.owner, owner);
        assertEq(r.brainHash, BRAIN);
        assertEq(r.name, "Sentinel-01");
        assertEq(reg.getRating(robotId), 0);
    }

    function test_RevertWhen_RegisterWithoutPQKey() public {
        vm.prank(nobody);
        vm.expectRevert(abi.encodeWithSelector(PQGuard.PQCKeyNotRegistered.selector, nobody));
        reg.registerRobot("x", BRAIN);
    }

    function test_RevertWhen_RegisterBadName() public {
        vm.startPrank(owner);
        vm.expectRevert(RobotRegistry.BadName.selector);
        reg.registerRobot("", BRAIN);
        vm.expectRevert(RobotRegistry.BadName.selector);
        reg.registerRobot(string(new bytes(65)), BRAIN);
        vm.stopPrank();
    }

    // ---------------------------------------------------------- sessions

    function test_StartSession() public {
        uint256 id = _start();
        (uint256 rid, address p, uint64 startedAt, RobotRegistry.Outcome o,) = reg.sessions(id);
        assertEq(rid, robotId);
        assertEq(p, player);
        assertEq(startedAt, block.timestamp);
        assertEq(uint8(o), uint8(RobotRegistry.Outcome.None));
        assertEq(reg.attemptsLeftToday(player), 4);
    }

    function test_DailyLimitAndReset() public {
        for (uint256 i; i < 5; i++) _start();
        assertEq(reg.attemptsLeftToday(player), 0);
        vm.prank(player);
        vm.expectRevert(RobotRegistry.DailyLimitReached.selector);
        reg.startSession(robotId);

        vm.warp(block.timestamp + 1 days);
        assertEq(reg.attemptsLeftToday(player), 5);
        _start();
    }

    function test_RevertWhen_SessionWithoutPQKey() public {
        vm.prank(nobody);
        vm.expectRevert(abi.encodeWithSelector(PQGuard.PQCKeyNotRegistered.selector, nobody));
        reg.startSession(robotId);
    }

    function test_RevertWhen_OwnerAttacksOwnRobot() public {
        vm.prank(owner);
        vm.expectRevert(RobotRegistry.OwnRobot.selector);
        reg.startSession(robotId);
    }

    function test_RevertWhen_UnknownRobot() public {
        vm.prank(player);
        vm.expectRevert(RobotRegistry.UnknownRobot.selector);
        reg.startSession(999);
    }

    // ----------------------------------------------------------- results

    function test_RecordDefenseAndBreach() public {
        _result(_start(), false);
        _result(_start(), true);
        RobotRegistry.Robot memory r = reg.getRobot(robotId);
        assertEq(r.attacks, 2);
        assertEq(r.defended, 1);
        assertEq(r.breached, 1);
    }

    function test_RevertWhen_ResultForged() public {
        uint256 id = _start();
        uint256 deadline = block.timestamp + 1 hours;
        // Player signs "defended=false" themself instead of the referee.
        bytes memory sig = _sig(playerPk, reg.resultDigest(id, true, REPLAY, deadline));
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.recordResult(id, true, REPLAY, deadline, sig);
    }

    function test_RevertWhen_ResultFlipped() public {
        uint256 id = _start();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(refereePk, reg.resultDigest(id, false, REPLAY, deadline));
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.recordResult(id, true, REPLAY, deadline, sig);
    }

    function test_RevertWhen_ResultRecordedTwice() public {
        uint256 id = _start();
        _result(id, false);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(refereePk, reg.resultDigest(id, false, REPLAY, deadline));
        vm.expectRevert(RobotRegistry.AlreadyRecorded.selector);
        reg.recordResult(id, false, REPLAY, deadline, sig);
    }

    function test_RevertWhen_ResultTooLate() public {
        uint256 id = _start();
        vm.warp(block.timestamp + 10 minutes + 1 hours + 1);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(refereePk, reg.resultDigest(id, false, REPLAY, deadline));
        vm.expectRevert(RobotRegistry.ResultTooLate.selector);
        reg.recordResult(id, false, REPLAY, deadline, sig);
    }

    function test_RevertWhen_UnknownSession() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(refereePk, reg.resultDigest(42, false, REPLAY, deadline));
        vm.expectRevert(RobotRegistry.UnknownSession.selector);
        reg.recordResult(42, false, REPLAY, deadline, sig);
    }

    // ------------------------------------------------------------ rating

    function test_RatingNeedsUtility() public {
        _result(_start(), false);
        assertEq(reg.getRating(robotId), 0, "refuse-everything robot scores 0");
        _utility(10);
        assertEq(reg.getRating(robotId), 10_000);
    }

    function test_RatingFormula() public {
        // 3 defended, 1 breached, 8/10 tasks -> 0.75 * 0.8 = 0.6
        _result(_start(), false);
        _result(_start(), false);
        _result(_start(), false);
        _result(_start(), true);
        _utility(8);
        assertEq(reg.getRating(robotId), 6_000);
    }

    function test_RevertWhen_UtilityReplayed() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(refereePk, reg.utilityDigest(robotId, 10, REPLAY, 0, deadline));
        reg.recordUtility(robotId, 10, REPLAY, deadline, sig);
        _utility(2);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.recordUtility(robotId, 10, REPLAY, deadline, sig);
    }

    function test_RevertWhen_UtilityOutOfRange() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(refereePk, reg.utilityDigest(robotId, 11, REPLAY, 0, deadline));
        vm.expectRevert(RobotRegistry.BadUtility.selector);
        reg.recordUtility(robotId, 11, REPLAY, deadline, sig);
    }

    function test_Tiers() public {
        _utility(10);
        assertEq(uint8(reg.getTier(robotId)), uint8(RobotRegistry.Tier.Rookie));
        address[] memory players = new address[](10);
        for (uint256 i; i < 10; i++) {
            players[i] = address(uint160(0x1000 + i));
            registry.setKey(players[i], abi.encodePacked(i + 1));
        }
        uint256 n;
        for (uint256 i; i < 10; i++) {
            for (uint256 j; j < 5; j++) {
                vm.prank(players[i]);
                _result(reg.startSession(robotId), false);
                n++;
                if (n == 10) assertEq(uint8(reg.getTier(robotId)), uint8(RobotRegistry.Tier.Guard));
            }
        }
        assertEq(uint8(reg.getTier(robotId)), uint8(RobotRegistry.Tier.Sentinel));
    }

    // ------------------------------------------------------------- brain

    function test_UpdateBrainResetsStats() public {
        _result(_start(), false);
        _utility(10);
        bytes32 newBrain = keccak256("brain-v2");
        uint256 deadline = block.timestamp + 1 hours;
        reg.updateBrain(robotId, newBrain, deadline, _sig(ownerPk, reg.updateBrainDigest(robotId, newBrain, 0, deadline)));
        RobotRegistry.Robot memory r = reg.getRobot(robotId);
        assertEq(r.brainHash, newBrain);
        assertEq(r.attacks, 0);
        assertEq(r.utilityScore, 0);
        assertEq(reg.getRating(robotId), 0);
    }

    function test_RevertWhen_UpdateBrainWithLeakedECDSAOnly() public {
        bytes32 newBrain = keccak256("weak-brain");
        uint256 deadline = block.timestamp + 1 hours;
        vm.prank(owner);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.updateBrain(robotId, newBrain, deadline, hex"");
    }

    // ------------------------------------------------------------- admin

    function test_PauseBlocksSessions() public {
        uint256 deadline = block.timestamp + 1 hours;
        reg.setPaused(true, deadline, _sig(adminPk, reg.setPausedDigest(true, 0, deadline)));
        vm.prank(player);
        vm.expectRevert(PQAdmin.Paused.selector);
        reg.startSession(robotId);
    }

    function test_RefereeSigForVaultIsUselessHere() public {
        // Same referee key, same struct, different domain tag => digest differs.
        uint256 id = _start();
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 foreign = keccak256(
            abi.encodePacked(
                keccak256("RedZone.EscrowVault.v1"),
                block.chainid,
                address(reg),
                keccak256(abi.encode(reg.RESULT_TYPEHASH(), id, true, REPLAY, deadline))
            )
        );
        bytes memory sig = _sig(refereePk, foreign);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        reg.recordResult(id, true, REPLAY, deadline, sig);
    }
}
