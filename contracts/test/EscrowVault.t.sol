// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EscrowVault} from "../src/EscrowVault.sol";
import {PQGuard} from "../src/PQGuard.sol";
import {MockPQC} from "./mocks/MockPQC.sol";

contract ReentrantClaimer {
    EscrowVault internal vault;
    uint256 internal targetId;
    bytes32 internal replayHash;
    uint256 internal deadline;
    bytes internal sig;

    constructor(EscrowVault v) {
        vault = v;
    }

    function arm(uint256 id, bytes32 r, uint256 d, bytes memory s) external {
        targetId = id;
        replayHash = r;
        deadline = d;
        sig = s;
    }

    receive() external payable {
        // Try to claim a second bounty while the first payment is in flight.
        vault.claimBounty(targetId, address(this), replayHash, deadline, sig);
    }
}

contract EscrowVaultTest is Test {
    address constant VERIFY = 0x0000000000000000000000000000000000000a01;
    address constant STATUS = 0x0000000000000000000000000000000000000a02;

    EscrowVault internal vault;
    MockPQC internal registry; // the 0x0A02 copy, holds keys

    address internal admin = makeAddr("admin");
    address internal owner = makeAddr("robotOwner");
    address internal player = makeAddr("player");
    address internal attacker = makeAddr("attacker"); // holds a leaked ECDSA key, no PQ key

    bytes internal adminPk = hex"a11ce0";
    bytes internal ownerPk = hex"0b0b0b";
    bytes internal refereePk = hex"5e5e5e";

    bytes32 internal constant ROBOT = keccak256("robot-1");
    bytes32 internal constant REPLAY = keccak256("replay-1");

    function setUp() public {
        vm.warp(1_700_000_000);
        MockPQC impl = new MockPQC();
        vm.etch(VERIFY, address(impl).code);
        vm.etch(STATUS, address(impl).code);
        registry = MockPQC(STATUS);
        registry.setKey(admin, adminPk);
        registry.setKey(owner, ownerPk);

        vm.prank(admin);
        vault = new EscrowVault(refereePk);

        vm.deal(owner, 100 ether);
        vm.deal(attacker, 1 ether);
    }

    // ----------------------------------------------------------- helpers

    function _sig(bytes memory pk, bytes32 digest) internal view returns (bytes memory) {
        return abi.encodePacked(MockPQC(VERIFY).sign(pk, abi.encodePacked(digest)));
    }

    function _deposit(uint256 amount) internal returns (uint256 id) {
        vm.prank(owner);
        id = vault.depositBounty{value: amount}(ROBOT);
    }

    function _refereeSig(uint256 id, address claimer, uint256 deadline) internal view returns (bytes memory) {
        return _sig(refereePk, vault.claimDigest(id, claimer, REPLAY, deadline));
    }

    // ------------------------------------------------------------ deploy

    function test_ConstructorSetsAdminAndReferee() public view {
        assertEq(vault.admin(), admin);
        assertEq(vault.refereePubkey(), refereePk);
    }

    function test_RevertWhen_DeployerHasNoPQKey() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(PQGuard.PQCKeyNotRegistered.selector, attacker));
        new EscrowVault(refereePk);
    }

    function test_RevertWhen_PrecompileMissing() public {
        vm.etch(STATUS, "");
        vm.prank(admin);
        vm.expectRevert(PQGuard.PQCPrecompileUnavailable.selector);
        new EscrowVault(refereePk);
    }

    // ----------------------------------------------------------- deposit

    function test_Deposit() public {
        uint256 id = _deposit(5 ether);
        (address o, bytes32 r, uint128 amt, EscrowVault.Status s) = vault.bounties(id);
        assertEq(o, owner);
        assertEq(r, ROBOT);
        assertEq(amt, 5 ether);
        assertEq(uint8(s), uint8(EscrowVault.Status.Open));
        assertEq(vault.totalLocked(), 5 ether);
        assertEq(address(vault).balance, 5 ether);
    }

    function test_RevertWhen_DepositWithoutPQKey() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(PQGuard.PQCKeyNotRegistered.selector, attacker));
        vault.depositBounty{value: 1 ether}(ROBOT);
    }

    function test_RevertWhen_DepositZero() public {
        vm.prank(owner);
        vm.expectRevert(EscrowVault.ZeroAmount.selector);
        vault.depositBounty{value: 0}(ROBOT);
    }

    function test_RevertWhen_PlainTransfer() public {
        vm.prank(owner);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok);
    }

    // ------------------------------------------------------------- claim

    function test_ClaimPaysBoundClaimer() public {
        uint256 id = _deposit(5 ether);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _refereeSig(id, player, deadline);

        // Anyone may relay; the attacker relaying still pays the player.
        vm.prank(attacker);
        vault.claimBounty(id, player, REPLAY, deadline, sig);

        assertEq(player.balance, 5 ether);
        assertEq(vault.totalLocked(), 0);
        (,,, EscrowVault.Status s) = vault.bounties(id);
        assertEq(uint8(s), uint8(EscrowVault.Status.Claimed));
    }

    function test_RevertWhen_ClaimerSwapped() public {
        uint256 id = _deposit(5 ether);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _refereeSig(id, player, deadline);
        vm.prank(attacker);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        vault.claimBounty(id, attacker, REPLAY, deadline, sig);
    }

    function test_RevertWhen_ClaimReplayed() public {
        uint256 id = _deposit(5 ether);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _refereeSig(id, player, deadline);
        vault.claimBounty(id, player, REPLAY, deadline, sig);
        vm.expectRevert(EscrowVault.BountyNotOpen.selector);
        vault.claimBounty(id, player, REPLAY, deadline, sig);
    }

    function test_RevertWhen_ClaimExpired() public {
        uint256 id = _deposit(5 ether);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _refereeSig(id, player, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(EscrowVault.Expired.selector);
        vault.claimBounty(id, player, REPLAY, deadline, sig);
    }

    function test_RevertWhen_ClaimSignedForOtherVault() public {
        vm.prank(admin);
        EscrowVault other = new EscrowVault(refereePk);
        uint256 id = _deposit(5 ether);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(refereePk, other.claimDigest(id, player, REPLAY, deadline));
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        vault.claimBounty(id, player, REPLAY, deadline, sig);
    }

    function test_RevertWhen_ClaimReentrant() public {
        ReentrantClaimer evil = new ReentrantClaimer(vault);
        uint256 a = _deposit(5 ether);
        uint256 b = _deposit(5 ether);
        uint256 deadline = block.timestamp + 1 hours;
        evil.arm(b, REPLAY, deadline, _refereeSig(b, address(evil), deadline));
        bytes memory sigA = _refereeSig(a, address(evil), deadline);
        vm.expectRevert(EscrowVault.TransferFailed.selector);
        vault.claimBounty(a, address(evil), REPLAY, deadline, sigA);
        assertEq(vault.totalLocked(), 10 ether);
    }

    function testFuzz_RandomSignatureNeverClaims(bytes calldata junk) public {
        uint256 id = _deposit(1 ether);
        uint256 deadline = block.timestamp + 1 hours;
        vm.assume(keccak256(junk) != keccak256(_refereeSig(id, attacker, deadline)));
        vm.prank(attacker);
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        vault.claimBounty(id, attacker, REPLAY, deadline, junk);
    }

    // ----------------------------------------------------------- withdraw

    function test_WithdrawWithOwnerPQSig() public {
        uint256 id = _deposit(5 ether);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(ownerPk, vault.withdrawDigest(id, owner, 0, deadline));
        uint256 before = owner.balance;
        vault.withdrawBounty(id, owner, deadline, sig);
        assertEq(owner.balance, before + 5 ether);
        assertEq(vault.nonces(owner), 1);
    }

    /// Q-Day Drill: the attacker controls the owner's ECDSA key (acts as msg.sender == owner)
    /// but has no ML-DSA key. Every drain path must fail.
    function test_QDay_LeakedECDSAKeyCannotDrain() public {
        uint256 id = _deposit(5 ether);
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory forged = _sig(hex"deadbeef", vault.withdrawDigest(id, attacker, 0, deadline));

        vm.startPrank(owner); // attacker signs as the owner with the leaked ECDSA key
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        vault.withdrawBounty(id, attacker, deadline, hex"");

        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        vault.withdrawBounty(id, attacker, deadline, forged);

        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        vault.claimBounty(id, attacker, REPLAY, deadline, hex"");
        vm.stopPrank();

        vm.startPrank(admin); // leaked admin ECDSA key: cannot swap referee or admin
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        vault.setReferee(hex"bad0", deadline, hex"");
        vm.stopPrank();

        assertEq(address(vault).balance, 5 ether);
        assertEq(vault.refereePubkey(), refereePk);
    }

    function test_RevertWhen_WithdrawRedirected() public {
        uint256 id = _deposit(5 ether);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(ownerPk, vault.withdrawDigest(id, owner, 0, deadline));
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        vault.withdrawBounty(id, attacker, deadline, sig);
    }

    function test_RevertWhen_WithdrawNonceReused() public {
        uint256 a = _deposit(1 ether);
        uint256 deadline = block.timestamp + 1 hours;
        vault.withdrawBounty(a, owner, deadline, _sig(ownerPk, vault.withdrawDigest(a, owner, 0, deadline)));
        uint256 b = _deposit(1 ether);
        bytes memory stale = _sig(ownerPk, vault.withdrawDigest(b, owner, 0, deadline));
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        vault.withdrawBounty(b, owner, deadline, stale);
    }

    function test_RevertWhen_WithdrawAfterClaim() public {
        uint256 id = _deposit(5 ether);
        uint256 deadline = block.timestamp + 1 hours;
        vault.claimBounty(id, player, REPLAY, deadline, _refereeSig(id, player, deadline));
        bytes memory sig = _sig(ownerPk, vault.withdrawDigest(id, owner, 0, deadline));
        vm.expectRevert(EscrowVault.BountyNotOpen.selector);
        vault.withdrawBounty(id, owner, deadline, sig);
    }

    function test_KeyRotationIsHonoured() public {
        uint256 id = _deposit(5 ether);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory oldSig = _sig(ownerPk, vault.withdrawDigest(id, owner, 0, deadline));
        registry.setKey(owner, hex"0c0c0c"); // owner rotates PQ key (hybrid-signed on chain)
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        vault.withdrawBounty(id, owner, deadline, oldSig);
        vault.withdrawBounty(id, owner, deadline, _sig(hex"0c0c0c", vault.withdrawDigest(id, owner, 0, deadline)));
    }

    // -------------------------------------------------------------- admin

    function test_SetRefereeWithAdminSig() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory newPk = hex"777777";
        vault.setReferee(newPk, deadline, _sig(adminPk, vault.setRefereeDigest(keccak256(newPk), 0, deadline)));
        assertEq(vault.refereePubkey(), newPk);
        assertEq(vault.nonces(admin), 1);
    }

    function test_PauseBlocksClaimNotWithdraw() public {
        uint256 id = _deposit(5 ether);
        uint256 deadline = block.timestamp + 1 hours;
        vault.setPaused(true, deadline, _sig(adminPk, vault.setPausedDigest(true, 0, deadline)));

        bytes memory claimSig = _refereeSig(id, player, deadline);
        vm.expectRevert(EscrowVault.Paused.selector);
        vault.claimBounty(id, player, REPLAY, deadline, claimSig);

        vault.withdrawBounty(id, owner, deadline, _sig(ownerPk, vault.withdrawDigest(id, owner, 0, deadline)));
        assertEq(vault.totalLocked(), 0);
    }

    function test_TransferAdmin() public {
        uint256 deadline = block.timestamp + 1 hours;
        vault.transferAdmin(owner, deadline, _sig(adminPk, vault.transferAdminDigest(owner, 0, deadline)));
        assertEq(vault.admin(), owner);
        // Old admin's next signature (nonce 1) no longer works.
        bytes memory sig = _sig(adminPk, vault.setPausedDigest(true, 1, deadline));
        vm.expectRevert(PQGuard.PQCSignatureInvalid.selector);
        vault.setPaused(true, deadline, sig);
    }

    function test_RevertWhen_TransferAdminToKeylessAccount() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(adminPk, vault.transferAdminDigest(attacker, 0, deadline));
        vm.expectRevert(abi.encodeWithSelector(PQGuard.PQCKeyNotRegistered.selector, attacker));
        vault.transferAdmin(attacker, deadline, sig);
    }
}
