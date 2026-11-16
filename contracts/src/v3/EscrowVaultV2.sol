// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PQAccess} from "./PQAccess.sol";
import {RobotRegistryV3} from "./RobotRegistryV3.sol";

/// @title EscrowVaultV2
/// @notice Holds RedZone bounties in native QOR.
///
/// Who can move money:
///   - claimBounty   : nobody decides. It pays only if the registry has a recorded *Breached*
///                     session against the bounty's robot, and always pays that session's player.
///                     Anyone may trigger it.
///   - requestWithdraw / finalizeWithdraw : the robot owner, by ML-DSA signature (QoreX), and only
///                     after WITHDRAW_DELAY, so a win that is already in progress is paid first.
///   - admin         : can pause (an emergency freeze of deposits, withdrawals and claims of
///                     results recorded during the pause). The admin can never take, redirect or
///                     pay out funds. A pause ends by itself after MAX_PAUSE (7 days) and cannot be
///                     renewed for PAUSE_COOLDOWN (1 day), and after it ends pending wins get
///                     UNPAUSE_GRACE (1 hour) to be claimed before any withdrawal completes. So the
///                     admin can delay payouts by at most MAX_PAUSE + UNPAUSE_GRACE.
///
/// A bounty always belongs to the robot's on-chain owner, whoever funds it, so a relayer that
/// deposits for a QoreX user never owns the money.
contract EscrowVaultV2 is PQAccess {
    enum Status {
        None,
        Open,
        Claimed,
        Withdrawn
    }

    struct Bounty {
        uint256 robotId;
        uint256 amount; // full uint256: no down-casting of msg.value anywhere
        address owner; // robot owner at deposit time (robots cannot change owner)
        uint64 depositedAt;
        uint64 withdrawRequestedAt; // 0 = no withdrawal requested
        address withdrawTo;
        Status status;
    }

    // ------------------------------------------------------------------ constants

    /// @notice Smallest bounty (1 QOR). Keeps dust bounties from making claims expensive.
    uint256 public constant MIN_BOUNTY = 1 ether;
    /// @notice Sessions that start up to this long after a withdrawal request can still win the
    ///         bounty, so an owner cannot front-run a player's start with a withdrawal request.
    ///         At least the registry's MAX_START_TTL (checked in the constructor).
    uint256 public constant START_GRACE = 10 minutes;
    /// @notice Time between a withdrawal request and payout. It covers START_GRACE + SESSION_TTL +
    ///         RESULT_GRACE (80 min) plus at least an hour to claim, so every breach that could win
    ///         the bounty is recorded and claimable before the owner is paid.
    uint256 public constant WITHDRAW_DELAY = 3 hours;
    /// @notice After an unpause, withdrawals wait this long so wins recorded during the pause are paid first.
    uint256 public constant UNPAUSE_GRACE = 1 hours;
    /// @dev Minimum time left to claim after the latest possible verdict.
    uint256 internal constant MIN_CLAIM_WINDOW = 1 hours;

    bytes32 public constant WITHDRAW_TYPEHASH = keccak256("RedZone.Withdraw(uint256 bountyId,address to,uint256 nonce,uint256 deadline)");
    string public constant ACTION_WITHDRAW = "WithdrawBounty";

    // ---------------------------------------------------------------------- state

    RobotRegistryV3 public immutable registry;

    uint256 public nextBountyId = 1;
    /// @notice Sum of all open bounties. address(this).balance >= totalLocked at all times (equal
    ///         unless someone force-sends QOR, which no logic reads).
    uint256 public totalLocked;
    mapping(uint256 => Bounty) public bounties;

    uint256 private _lock = 1;

    // --------------------------------------------------------------------- events

    event BountyDeposited(uint256 indexed bountyId, uint256 indexed robotId, address indexed owner, address funder, uint256 amount);
    event BountyClaimed(uint256 indexed bountyId, uint256 indexed sessionId, address indexed player, bytes32 replayHash, uint256 amount);
    event WithdrawRequested(uint256 indexed bountyId, address indexed to, uint256 unlocksAt);
    event BountyWithdrawn(uint256 indexed bountyId, address indexed to, uint256 amount);

    // --------------------------------------------------------------------- errors

    error AmountTooSmall();
    error UnknownRobot();
    error BountyNotOpen();
    error WrongRobot();
    error NotBreached();
    error SessionBeforeBounty();
    error SessionAfterWithdrawRequest();
    error ResultDuringPause();
    error WithdrawNotRequested();
    error WithdrawLocked();
    error TransferFailed(address to, uint256 amount);
    error Reentrancy();
    error DirectTransferRefused();
    error BadDelays();

    // ------------------------------------------------------------------ modifiers

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    // ---------------------------------------------------------------- constructor

    constructor(RobotRegistryV3 registry_, bytes memory nativeChainId_) PQAccess("RedZone.EscrowVault.v2", nativeChainId_) {
        if (address(registry_) == address(0)) revert ZeroAddress();
        // The withdrawal delay must outlast the latest moment a started session can be judged.
        if (START_GRACE < registry_.MAX_START_TTL()) revert BadDelays();
        if (WITHDRAW_DELAY < START_GRACE + registry_.SESSION_TTL() + registry_.RESULT_GRACE() + MIN_CLAIM_WINDOW) revert BadDelays();
        registry = registry_;
    }

    // ------------------------------------------------------------------- deposits

    /// @notice Lock native QOR as a bounty on a registered robot. The robot's owner owns the
    ///         bounty, whoever sends the QOR.
    function depositBounty(uint256 robotId) external payable whenNotPaused nonReentrant returns (uint256 bountyId) {
        if (msg.value < MIN_BOUNTY) revert AmountTooSmall();
        address owner = registry.robotOwner(robotId);
        if (owner == address(0)) revert UnknownRobot();

        bountyId = nextBountyId++;
        bounties[bountyId] = Bounty({
            robotId: robotId,
            amount: msg.value,
            owner: owner,
            depositedAt: uint64(block.timestamp),
            withdrawRequestedAt: 0,
            withdrawTo: address(0),
            status: Status.Open
        });
        totalLocked += msg.value;
        emit BountyDeposited(bountyId, robotId, owner, msg.sender, msg.value);
    }

    // --------------------------------------------------------------------- claims

    /// @notice Pay a bounty to the player of a recorded breach. Anyone may call.
    /// @dev Requirements, all read from the registry:
    ///        - the session is Breached and against the bounty's robot;
    ///        - it started after the bounty was deposited (no old wins on new money);
    ///        - it started no later than START_GRACE after a pending withdrawal request;
    ///        - while the vault is paused, only results recorded before the pause are paid.
    ///      One breach wins every open bounty on the robot (each bounty is paid once, then closed):
    ///      that is the game's rule, not a double claim. Effects happen before the transfer, and
    ///      the call is guarded against re-entry. The payee is always the session's player.
    function claimBounty(uint256 bountyId, uint256 sessionId) external nonReentrant {
        Bounty storage b = bounties[bountyId];
        if (b.status != Status.Open) revert BountyNotOpen();

        RobotRegistryV3.Session memory s = registry.getSession(sessionId);
        if (s.robotId != b.robotId) revert WrongRobot();
        if (s.outcome != RobotRegistryV3.Outcome.Breached) revert NotBreached();
        if (s.startedAt < b.depositedAt) revert SessionBeforeBounty();
        if (b.withdrawRequestedAt != 0 && s.startedAt > b.withdrawRequestedAt + START_GRACE) revert SessionAfterWithdrawRequest();
        if (isPaused() && s.resultAt >= pausedAt) revert ResultDuringPause();

        uint256 amount = b.amount;
        b.status = Status.Claimed;
        b.amount = 0;
        totalLocked -= amount;
        emit BountyClaimed(bountyId, sessionId, s.player, s.replayHash, amount);
        _send(s.player, amount);
    }

    // ---------------------------------------------------------------- withdrawals

    /// @notice Step 1: the robot owner asks for the bounty back, signed with their ML-DSA key.
    ///         The bounty stays claimable by sessions starting up to START_GRACE later. Asking again
    ///         replaces the destination and restarts the delay (e.g. if the first address rejects
    ///         payment). Allowed while paused; the payout itself waits for the unpause.
    function requestWithdraw(uint256 bountyId, address to, uint256 deadline, bytes calldata ownerSig) external validDeadline(deadline) {
        if (to == address(0)) revert ZeroAddress();
        Bounty storage b = bounties[bountyId];
        if (b.status != Status.Open) revert BountyNotOpen();

        address owner = b.owner;
        _requireUserSig(owner, ACTION_WITHDRAW, withdrawDigest(bountyId, to, nonces[owner], deadline), ownerSig);
        nonces[owner] = nonces[owner] + 1;

        b.withdrawRequestedAt = uint64(block.timestamp);
        b.withdrawTo = to;
        emit WithdrawRequested(bountyId, to, block.timestamp + WITHDRAW_DELAY);
    }

    /// @notice Step 2: after WITHDRAW_DELAY, pay the bounty to the address the owner signed for.
    ///         Anyone may call; the destination is fixed by the owner's signature.
    function finalizeWithdraw(uint256 bountyId) external whenNotPaused nonReentrant {
        Bounty storage b = bounties[bountyId];
        if (b.status != Status.Open) revert BountyNotOpen();
        uint256 requestedAt = b.withdrawRequestedAt;
        if (requestedAt == 0) revert WithdrawNotRequested();
        if (block.timestamp < requestedAt + WITHDRAW_DELAY) revert WithdrawLocked();
        uint256 lastUnpause = lastUnpausedAt();
        if (lastUnpause != 0 && block.timestamp < lastUnpause + UNPAUSE_GRACE) revert WithdrawLocked();

        address to = b.withdrawTo;
        uint256 amount = b.amount;
        b.status = Status.Withdrawn;
        b.amount = 0;
        totalLocked -= amount;
        emit BountyWithdrawn(bountyId, to, amount);
        _send(to, amount);
    }

    // -------------------------------------------------------------------- digests

    function withdrawDigest(uint256 bountyId, address to, uint256 nonce, uint256 deadline) public view returns (bytes32) {
        return _digest(abi.encode(WITHDRAW_TYPEHASH, bountyId, to, nonce, deadline));
    }

    // ------------------------------------------------------------------- internal

    /// @dev Sends native QOR and reverts the whole transaction if the transfer fails, so a bounty is
    ///      never marked paid without the money arriving. The return value is always checked.
    function _send(address to, uint256 amount) internal {
        (bool success,) = payable(to).call{value: amount}("");
        require(success, TransferFailed(to, amount));
    }

    /// @dev Plain transfers are refused so every QOR in the vault belongs to a tracked bounty.
    receive() external payable {
        revert DirectTransferRefused();
    }
}
