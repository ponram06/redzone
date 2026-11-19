// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PQAccess} from "../v3/PQAccess.sol";
import {RobotRegistryV4} from "./RobotRegistryV4.sol";

/// @title EscrowVaultV4
/// @notice Holds RedZone bounties in native QOR, as prize pools: a maker locks a pool and a prize
///         per win, and every new way of breaking the robot is paid that prize until the pool runs out.
///
/// Prize pools (new in v4):
///   - Each eligible breach is paid min(prizePerWin, what is left). The bounty stays open until it
///     is empty, so other players can keep attacking the robot.
///   - One prize per player per bounty: a player who has won it can't win it again.
///   - One prize per brain version (oncePerBrain, the default): after a win, only breaches against a
///     newer brain version (the maker updated the robot's rules) can be paid. Copying a known trick
///     earns nothing; each payout is a new bug.
///   - depositBounty(robotId) keeps the v3 behaviour: the whole bounty is one prize.
///
/// Who wins a prize: the EARLIEST eligible breach. The registry keeps every robot's breaches in
/// the order the referee recorded them. Each bounty has a cursor into that list, starting at the
/// breaches recorded after its deposit. Nobody chooses which breach is paid:
///   - claimBounty(bountyId) pays the breach at the cursor if it is eligible, always to that
///     session's player. Anyone may call it.
///   - skipBreach(bountyId) moves the cursor past a breach that can never be paid (it started
///     before the deposit or after a withdrawal cut-off, or its claim window expired). Anyone may call.
///   A breach must be claimed within CLAIM_WINDOW of its verdict, so an old breach cannot be stored
///   up and used later to take a bounty from an honest winner.
///
/// Withdrawals: the robot owner signs requestWithdraw (ML-DSA, QoreX); finalizeWithdraw pays out
/// only after WITHDRAW_DELAY and only once every recorded breach has been paid or skipped, so a
/// win waiting to be claimed always beats the owner. A request that is not finalised within
/// WITHDRAW_EXPIRY after unlocking lapses, and the bounty is fully winnable again.
///
/// Admin: can pause (an emergency freeze of deposits, withdrawals and claims of results recorded
/// during the pause). The admin can never take, redirect or pay out funds directly. A pause ends by
/// itself after MAX_PAUSE (7 days) and cannot be renewed for PAUSE_COOLDOWN (1 day); wins recorded
/// during a pause get a full CLAIM_WINDOW after it ends, and withdrawals wait UNPAUSE_GRACE.
/// Trust note: the admin also controls who the referee is (2-day time-locked, in the registry);
/// owners should withdraw if they distrust a proposed referee.
///
/// A bounty always belongs to the robot's on-chain owner, whoever funds it, so a relayer that
/// deposits for a QoreX user never owns the money.
contract EscrowVaultV4 is PQAccess, ReentrancyGuard {
    enum Status {
        None,
        Open,
        Claimed, // the pool has been paid out in full
        Withdrawn
    }

    /// @notice State of the breach at a bounty's cursor.
    enum Next {
        None, // no unprocessed breach
        Claimable, // claimBounty pays it now
        Skippable, // can never be paid: skipBreach moves past it
        Waiting // recorded during an active pause: claimable after the pause
    }

    struct Bounty {
        uint256 robotId;
        uint256 amount; // what is left in the pool; full uint256: no down-casting of msg.value anywhere
        uint256 breachCursor; // index into the registry's breach list for this robot
        // Packed: owner, depositedAt, status and oncePerBrain share one slot; the withdrawal fields
        // and minBrainVersion share another.
        address owner; // robot owner at deposit time (robots cannot change owner)
        uint64 depositedAt;
        Status status;
        bool oncePerBrain; // after a win, only breaches against a newer brain version are paid
        uint64 withdrawRequestedAt; // 0 = no withdrawal requested
        address withdrawTo;
        uint32 minBrainVersion; // breaches against an older brain version are skipped
        uint256 prizePerWin; // paid per eligible breach (the last prize may be smaller)
    }

    // ------------------------------------------------------------------ constants

    /// @notice Smallest bounty (1 QOR). Keeps dust bounties from making claims expensive.
    uint256 public constant MIN_BOUNTY = 1 ether;
    /// @notice Smallest prize per win (0.1 QOR).
    uint256 public constant MIN_PRIZE = 0.1 ether;
    /// @notice Sessions that start up to this long after a withdrawal request can still win the
    ///         bounty, so an owner cannot front-run a player's start with a withdrawal request.
    ///         At least the registry's MAX_START_TTL (checked in the constructor).
    uint256 public constant START_GRACE = 10 minutes;
    /// @notice Time between a withdrawal request and payout. It covers START_GRACE + SESSION_TTL +
    ///         RESULT_GRACE (80 min) plus at least an hour, so every session that can still win the
    ///         bounty is judged before the owner can be paid.
    uint256 public constant WITHDRAW_DELAY = 3 hours;
    /// @notice A withdrawal request lapses if not finalised within this long after it unlocks.
    uint256 public constant WITHDRAW_EXPIRY = 7 days;
    /// @notice A breach must be claimed within this long after its verdict (or after the pause it
    ///         was recorded in ends). Stops stockpiling old breaches.
    uint256 public constant CLAIM_WINDOW = 1 days;
    /// @notice After an unpause, withdrawals wait this long.
    uint256 public constant UNPAUSE_GRACE = 1 hours;
    /// @dev Minimum time left to claim after the latest possible verdict.
    uint256 internal constant MIN_CLAIM_WINDOW = 1 hours;

    bytes32 public constant WITHDRAW_TYPEHASH = keccak256("RedZone.Withdraw(uint256 bountyId,address to,uint256 nonce,uint256 deadline)");
    string public constant ACTION_WITHDRAW = "WithdrawBounty";

    // ---------------------------------------------------------------------- state

    RobotRegistryV4 public immutable registry;

    uint256 public nextBountyId = 1;
    /// @notice Sum of all open bounties. address(this).balance >= totalLocked at all times (equal
    ///         unless someone force-sends QOR, which no logic reads).
    uint256 public totalLocked;
    mapping(uint256 => Bounty) public bounties;
    /// @notice bountyId => player => already won a prize from this bounty.
    mapping(uint256 => mapping(address => bool)) public hasWon;

    // --------------------------------------------------------------------- events

    event BountyDeposited(
        uint256 indexed bountyId, uint256 indexed robotId, address indexed owner, address funder, uint256 amount, uint256 prizePerWin, bool oncePerBrain
    );
    event BountyClaimed(uint256 indexed bountyId, uint256 indexed sessionId, address indexed player, bytes32 replayHash, uint256 amount);
    event BreachSkipped(uint256 indexed bountyId, uint256 indexed sessionId);
    event WithdrawRequested(uint256 indexed bountyId, address indexed to, uint256 unlocksAt);
    event BountyWithdrawn(uint256 indexed bountyId, address indexed to, uint256 amount);

    // --------------------------------------------------------------------- errors

    error AmountTooSmall();
    error BadPrize();
    error UnknownRobot();
    error BountyNotOpen();
    error NothingToClaim(Next state);
    error NothingToSkip(Next state);
    error WithdrawNotRequested();
    error WithdrawLocked();
    error WithdrawExpired();
    error WinPending();
    error TransferFailed(address to, uint256 amount);
    error DirectTransferRefused();
    error BadDelays();

    // ---------------------------------------------------------------- constructor

    /// @param deployerProof Deployer's ML-DSA-87 signature over deployDigest("RedZone.EscrowVault.v4", deployer).
    constructor(RobotRegistryV4 registry_, bytes memory nativeChainId_, bytes memory deployerProof)
        PQAccess("RedZone.EscrowVault.v4", nativeChainId_, deployerProof)
    {
        if (address(registry_) == address(0)) revert ZeroAddress();
        if (START_GRACE < registry_.MAX_START_TTL()) revert BadDelays();
        if (WITHDRAW_DELAY < START_GRACE + registry_.SESSION_TTL() + registry_.RESULT_GRACE() + MIN_CLAIM_WINDOW) revert BadDelays();
        if (CLAIM_WINDOW < MIN_CLAIM_WINDOW) revert BadDelays();
        registry = registry_;
    }

    // ------------------------------------------------------------------- deposits

    /// @notice Lock native QOR as a single prize (v3 behaviour): the first eligible breach takes it all.
    function depositBounty(uint256 robotId) external payable returns (uint256) {
        return depositPool(robotId, msg.value, true);
    }

    /// @notice Lock native QOR as a prize pool on a registered robot. Each eligible breach is paid
    ///         `prizePerWin` (the last one gets what is left). The robot's owner owns the pool,
    ///         whoever sends the QOR. Only sessions started after this deposit can win it.
    /// @param oncePerBrain After a win, pay only breaches against a newer brain version.
    function depositPool(uint256 robotId, uint256 prizePerWin, bool oncePerBrain)
        public
        payable
        whenNotPaused
        nonReentrant
        returns (uint256 bountyId)
    {
        if (msg.value < MIN_BOUNTY) revert AmountTooSmall();
        if (prizePerWin < MIN_PRIZE || prizePerWin > msg.value) revert BadPrize();
        address owner = registry.robotOwner(robotId);
        if (owner == address(0)) revert UnknownRobot();

        bountyId = nextBountyId;
        unchecked {
            nextBountyId = bountyId + 1; // cannot overflow: one id per deposit of at least 1 QOR
        }
        // Field-by-field so the all-zero withdrawal slot is never written.
        Bounty storage b = bounties[bountyId];
        b.robotId = robotId;
        b.amount = msg.value;
        b.breachCursor = registry.breachCount(robotId);
        b.owner = owner;
        b.depositedAt = uint64(block.timestamp);
        b.status = Status.Open;
        if (oncePerBrain) b.oncePerBrain = true;
        b.prizePerWin = prizePerWin;
        totalLocked += msg.value;
        emit BountyDeposited(bountyId, robotId, owner, msg.sender, msg.value, prizePerWin, oncePerBrain);
    }

    // --------------------------------------------------------------------- claims

    /// @notice Pay one prize to the earliest eligible breach (the one at the cursor). Anyone may
    ///         call; the payee is always that session's player.
    /// @dev Effects happen before the single value transfer, under ReentrancyGuard.
    function claimBounty(uint256 bountyId) external nonReentrant {
        Bounty storage b = bounties[bountyId];
        if (b.status != Status.Open) revert BountyNotOpen();
        (Next state, uint256 sessionId, RobotRegistryV4.Session memory s) = _next(bountyId, b);
        if (state != Next.Claimable) revert NothingToClaim(state);

        uint256 left = b.amount;
        uint256 amount = b.prizePerWin < left ? b.prizePerWin : left;
        unchecked {
            left -= amount; // amount <= left
        }
        b.amount = left;
        if (left == 0) b.status = Status.Claimed;
        hasWon[bountyId][s.player] = true;
        if (b.oncePerBrain) b.minBrainVersion = s.brainVersion + 1;
        unchecked {
            ++b.breachCursor; // cursor < registry.breachCount here (checked in _next)
        }
        totalLocked -= amount;
        emit BountyClaimed(bountyId, sessionId, s.player, s.replayHash, amount);
        _send(s.player, amount);
    }

    /// @notice Move a bounty's cursor past a breach that can never be paid. Anyone may call.
    function skipBreach(uint256 bountyId) external {
        Bounty storage b = bounties[bountyId];
        if (b.status != Status.Open) revert BountyNotOpen();
        (Next state, uint256 sessionId,) = _next(bountyId, b);
        if (state != Next.Skippable) revert NothingToSkip(state);
        unchecked {
            ++b.breachCursor; // cursor < registry.breachCount here (checked in _next)
        }
        emit BreachSkipped(bountyId, sessionId);
    }

    /// @notice What happens next for a bounty: the state of the breach at its cursor.
    function nextBreach(uint256 bountyId) external view returns (Next state, uint256 sessionId) {
        Bounty storage b = bounties[bountyId];
        if (b.status != Status.Open) return (Next.None, 0);
        (state, sessionId,) = _next(bountyId, b);
    }

    /// @notice Last second a breach recorded at `resultAt` can be claimed. A breach recorded during
    ///         the most recent pause gets a full window after that pause ends.
    function claimDeadline(uint256 resultAt) public view returns (uint256) {
        uint256 unpause = lastUnpausedAt();
        uint256 start = lastPauseStart;
        if (unpause != 0 && resultAt >= start && resultAt < unpause) return unpause + CLAIM_WINDOW;
        return resultAt + CLAIM_WINDOW;
    }

    // ---------------------------------------------------------------- withdrawals

    /// @notice Step 1: the robot owner asks for the bounty back, signed with their ML-DSA key.
    ///         The bounty stays winnable by sessions starting up to START_GRACE later. Asking again
    ///         replaces the destination and restarts the delay. Allowed while paused.
    function requestWithdraw(uint256 bountyId, address to, uint256 deadline, bytes calldata ownerSig) external validDeadline(deadline) {
        if (to == address(0)) revert ZeroAddress();
        Bounty storage b = bounties[bountyId];
        if (b.status != Status.Open) revert BountyNotOpen();

        address owner = b.owner;
        _useUserSig(owner, ACTION_WITHDRAW, withdrawDigest(bountyId, to, nonces[owner], deadline), ownerSig);

        b.withdrawRequestedAt = uint64(block.timestamp);
        b.withdrawTo = to;
        emit WithdrawRequested(bountyId, to, block.timestamp + WITHDRAW_DELAY);
    }

    /// @notice Step 2: after WITHDRAW_DELAY, pay the bounty to the address the owner signed for.
    ///         Anyone may call. Refused while any recorded breach on this bounty is still claimable
    ///         or waiting (skip the ones that can never be paid first).
    function finalizeWithdraw(uint256 bountyId) external whenNotPaused nonReentrant {
        Bounty storage b = bounties[bountyId];
        if (b.status != Status.Open) revert BountyNotOpen();
        uint256 requestedAt = b.withdrawRequestedAt;
        if (requestedAt == 0) revert WithdrawNotRequested();
        if (block.timestamp < requestedAt + WITHDRAW_DELAY) revert WithdrawLocked();
        if (block.timestamp > requestedAt + WITHDRAW_DELAY + WITHDRAW_EXPIRY) revert WithdrawExpired();
        uint256 lastUnpause = lastUnpausedAt();
        if (lastUnpause != 0 && block.timestamp < lastUnpause + UNPAUSE_GRACE) revert WithdrawLocked();
        (Next state,,) = _next(bountyId, b);
        if (state != Next.None) revert WinPending();

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

    /// @dev Classify the breach at the bounty's cursor. Storage fields are read once each.
    function _next(uint256 bountyId, Bounty storage b) internal view returns (Next, uint256 sessionId, RobotRegistryV4.Session memory s) {
        uint256 robotId = b.robotId;
        uint256 cursor = b.breachCursor;
        if (cursor >= registry.breachCount(robotId)) return (Next.None, 0, s);
        sessionId = registry.breachAt(robotId, cursor);
        s = registry.getSession(sessionId);
        if (s.startedAt < b.depositedAt) return (Next.Skippable, sessionId, s);
        // One prize per player, and (if oncePerBrain) one per brain version.
        if (hasWon[bountyId][s.player] || s.brainVersion < b.minBrainVersion) return (Next.Skippable, sessionId, s);
        // A withdrawal request is live from the request until WITHDRAW_EXPIRY after it unlocks.
        uint256 r = b.withdrawRequestedAt;
        bool withdrawLive = r != 0 && block.timestamp <= r + WITHDRAW_DELAY + WITHDRAW_EXPIRY;
        if (withdrawLive && s.startedAt > r + START_GRACE) return (Next.Skippable, sessionId, s);
        if (isPaused() && s.resultAt >= pausedAt) return (Next.Waiting, sessionId, s);
        if (block.timestamp > claimDeadline(s.resultAt)) return (Next.Skippable, sessionId, s);
        return (Next.Claimable, sessionId, s);
    }

    /// @dev Sends native QOR without copying return data (a payee cannot grief with a huge
    ///      return payload) and reverts the whole transaction if the transfer fails, so a bounty is
    ///      never marked paid without the money arriving.
    function _send(address to, uint256 amount) internal {
        bool success;
        assembly ("memory-safe") {
            success := call(gas(), to, amount, 0, 0, 0, 0)
        }
        require(success, TransferFailed(to, amount));
    }

    /// @dev Plain transfers are refused so every QOR in the vault belongs to a tracked bounty.
    receive() external payable {
        revert DirectTransferRefused();
    }
}
