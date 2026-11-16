// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PQGuard} from "../PQGuard.sol";
import {QoreXMessage} from "../QoreXMessage.sol";
import {PQAccess} from "./PQAccess.sol";
import {MLDSA87} from "./MLDSA87.sol";

/// @title RobotRegistryV3
/// @notice Public record of RedZone robots, attack sessions and safety ratings.
///
///   - Owners register a robot with a hash of its brain config (model + system prompt + policy).
///   - Players start attack sessions (5 per player per UTC day, 10 minutes each). Owners cannot
///     attack their own robot.
///   - Only the referee's ML-DSA-87 verdict can record a session result or a utility score.
///   - Players and owners never send EVM transactions: they sign with their ML-DSA key in the QoreX
///     wallet and anyone relays. The relayer cannot forge, alter or replay a request.
///
/// Access control:
///   - onlyReferee : referee's ML-DSA signature (recordResult, recordUtility)
///   - onlyAdmin   : admin's ML-DSA signature (pause, admin transfer, referee change proposal)
///   - user actions: the user's own ML-DSA signature with a per-user nonce
///   - Changing the referee key is time-locked (REFEREE_DELAY), so robot owners and players see a
///     change coming and bounty owners can withdraw before it takes effect.
contract RobotRegistryV3 is PQAccess {
    enum Outcome {
        None,
        Defended,
        Breached
    }

    enum Tier {
        Rookie,
        Guard,
        Sentinel
    }

    struct Robot {
        address owner;
        uint64 registeredAt;
        uint8 utilityScore; // everyday tasks passed, 0..UTILITY_TASKS
        uint32 attacks; // sessions with a recorded result
        uint32 defended;
        uint32 breached;
        uint32 utilityNonce;
        uint32 brainVersion; // +1 on every brain change
        bytes32 brainHash;
        string name;
    }

    struct Session {
        uint256 robotId;
        address player;
        uint64 startedAt;
        uint64 resultAt; // 0 until the referee's verdict is recorded
        uint32 brainVersion; // robot's brain version when the session started
        Outcome outcome;
        bytes32 replayHash;
    }

    // ------------------------------------------------------------------ constants

    uint256 public constant MAX_ATTEMPTS_PER_DAY = 5;
    uint256 public constant SESSION_TTL = 10 minutes;
    /// @notice Extra time after a session ends for the referee's verdict to reach the chain.
    uint256 public constant RESULT_GRACE = 1 hours;
    uint8 public constant UTILITY_TASKS = 10;
    /// @notice Robot names are 1..64 printable ASCII characters (also bounds the check loop).
    uint256 public constant MAX_NAME_LENGTH = 64;
    /// @notice A new referee key takes effect only this long after the admin proposes it.
    uint256 public constant REFEREE_DELAY = 2 days;
    /// @notice A player's signed start request must reach the chain within this time, so a relayer
    ///         cannot hold it back and start the round when the player is not there.
    uint256 public constant MAX_START_TTL = 10 minutes;

    bytes32 public constant RESULT_TYPEHASH =
        keccak256("RedZone.Result(uint256 sessionId,uint256 robotId,address player,bool breached,bytes32 replayHash,uint256 deadline)");
    bytes32 public constant UTILITY_TYPEHASH =
        keccak256("RedZone.Utility(uint256 robotId,uint8 tasksPassed,bytes32 replayHash,uint256 nonce,uint256 deadline)");
    bytes32 public constant UPDATE_BRAIN_TYPEHASH = keccak256("RedZone.UpdateBrain(uint256 robotId,bytes32 brainHash,uint256 nonce,uint256 deadline)");
    bytes32 public constant START_SESSION_TYPEHASH = keccak256("RedZone.StartSession(uint256 robotId,address player,uint256 nonce,uint256 deadline)");
    bytes32 public constant REGISTER_ROBOT_TYPEHASH =
        keccak256("RedZone.RegisterRobot(address owner,bytes32 nameHash,bytes32 brainHash,uint256 nonce,uint256 deadline)");
    bytes32 public constant CANCEL_REFEREE_TYPEHASH = keccak256("RedZone.CancelReferee(bytes32 pubkeyHash,uint256 nonce,uint256 deadline)");
    bytes32 public constant PROPOSE_REFEREE_TYPEHASH = keccak256("RedZone.ProposeReferee(bytes32 pubkeyHash,uint256 nonce,uint256 deadline)");

    string public constant ACTION_START_SESSION = "StartSession";
    string public constant ACTION_REGISTER_ROBOT = "RegisterRobot";
    string public constant ACTION_UPDATE_BRAIN = "UpdateBrain";

    // ---------------------------------------------------------------------- state

    /// @notice keccak256 of the referee service's ML-DSA-87 public key. Only the 32-byte hash is
    ///         stored (QoreChain limits how much state a deployment may write); the referee passes
    ///         its 2592-byte key with each verdict and the contract checks it against this hash.
    ///         The key is published in the RefereeProposed event and on the project's deployment record.
    bytes32 public refereeKeyHash;
    /// @notice Hash of a proposed referee key, and the time it may be activated (0 = none pending).
    bytes32 public pendingRefereeKeyHash;
    uint64 public refereeActivatesAt;

    uint256 public nextRobotId = 1;
    uint256 public nextSessionId = 1;
    mapping(uint256 => Robot) internal _robots;
    mapping(uint256 => Session) internal _sessions;
    /// @dev robotId => Breached session ids in the order they were recorded (the vault pays the
    ///      earliest eligible one, so nobody can choose which breach wins a bounty).
    mapping(uint256 => uint256[]) internal _breaches;
    /// @notice player => UTC day number => sessions started that day
    mapping(address => mapping(uint256 => uint256)) public attemptsOnDay;

    // --------------------------------------------------------------------- events

    event RobotRegistered(uint256 indexed robotId, address indexed owner, bytes32 brainHash, string name);
    event BrainUpdated(uint256 indexed robotId, bytes32 brainHash);
    event SessionStarted(uint256 indexed sessionId, uint256 indexed robotId, address indexed player, uint256 expiresAt);
    event Defended(uint256 indexed sessionId, uint256 indexed robotId, address indexed player, bytes32 replayHash);
    event Breached(uint256 indexed sessionId, uint256 indexed robotId, address indexed player, bytes32 replayHash);
    event UtilityRecorded(uint256 indexed robotId, uint8 tasksPassed, bytes32 replayHash);
    event RefereeProposed(bytes32 indexed pubkeyHash, uint256 activatesAt, bytes pubkey);
    event RefereeUpdated(bytes32 indexed pubkeyHash);
    event RefereeCancelled(bytes32 indexed pubkeyHash);

    // --------------------------------------------------------------------- errors

    error UnknownRobot();
    error UnknownSession();
    error BadName();
    error OwnRobot();
    error DailyLimitReached();
    error AlreadyRecorded();
    error ResultTooLate();
    error BadUtility();
    error EmptyPubkey();
    error NoPendingReferee();
    error NotReferee();
    error RefereeDelayNotOver();
    error StartRequestTooLong();

    // ------------------------------------------------------------------ modifiers

    /// @notice Only the referee (onlyReferee check), proven by its ML-DSA-87 signature over `digest`.
    ///         Called first in every referee-only function, before any state is read or written.
    /// @dev Like onlyAdmin, this replaces a msg.sender check with a post-quantum signature check:
    ///      only the holder of the referee ML-DSA-87 key can produce a passing signature.
    ///      Referee digests are single use by construction, so no separate nonce is needed: a
    ///      result can be recorded once per session (the AlreadyRecorded check on its outcome),
    ///      only within SESSION_TTL + RESULT_GRACE of its start, and a utility digest includes the
    ///      robot's utilityNonce.
    function _onlyReferee(bytes32 digest, bytes calldata refereePubkey_, bytes calldata refereeSig) internal {
        if (keccak256(refereePubkey_) != refereeKeyHash) revert NotReferee();
        if (!MLDSA87.verify(refereePubkey_, refereeSig, abi.encodePacked(digest))) revert PQGuard.PQCSignatureInvalid();
        _useDigest(digest);
    }

    modifier notExpired(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    // ---------------------------------------------------------------- constructor

    /// @param deployerProof Deployer's ML-DSA-87 signature over deployDigest("RedZone.RobotRegistry.v3", deployer).
    /// @param refereeProof  Referee key's ML-DSA-87 signature over the same digest, proving the
    ///                      referee key works with the live precompile before any game starts.
    constructor(bytes memory refereePubkey_, bytes memory nativeChainId_, bytes memory deployerProof, bytes memory refereeProof)
        PQAccess("RedZone.RobotRegistry.v3", nativeChainId_, deployerProof)
    {
        if (refereePubkey_.length == 0) revert EmptyPubkey();
        MLDSA87.checkPubkey(refereePubkey_);
        bytes32 proofDigest = keccak256(abi.encode(DEPLOY_TYPEHASH, keccak256("RedZone.RobotRegistry.v3"), block.chainid, msg.sender));
        if (!MLDSA87.verify(refereePubkey_, refereeProof, abi.encodePacked(proofDigest))) revert PQGuard.PQCSignatureInvalid();
        refereeKeyHash = keccak256(refereePubkey_);
        emit RefereeUpdated(refereeKeyHash);
    }

    // -------------------------------------------------------------------- referee

    /// @notice Propose a new referee key. Admin only (ML-DSA signature). It can be activated by
    ///         anyone after REFEREE_DELAY. A new proposal replaces the old one and restarts the delay.
    ///         The new key must also sign the proposal (`newRefereeSig`), proving it is a working
    ///         ML-DSA-87 key before it can ever be activated.
    function proposeReferee(bytes calldata newPubkey, uint256 deadline, bytes calldata adminSig, bytes calldata newRefereeSig)
        external
        validDeadline(deadline)
        onlyAdmin(proposeRefereeDigest(keccak256(newPubkey), nonces[admin], deadline), adminSig)
    {
        // The admin signature (checked above) consumed nonce n; the new key signs the same digest.
        _setPendingReferee(newPubkey, proposeRefereeDigest(keccak256(newPubkey), nonces[admin] - 1, deadline), newRefereeSig);
    }

    function _setPendingReferee(bytes calldata newPubkey, bytes32 proposal, bytes calldata newRefereeSig) internal {
        if (newPubkey.length == 0) revert EmptyPubkey();
        MLDSA87.checkPubkey(newPubkey);
        if (!MLDSA87.verify(newPubkey, newRefereeSig, abi.encodePacked(proposal))) revert PQGuard.PQCSignatureInvalid();
        bytes32 h = keccak256(newPubkey);
        pendingRefereeKeyHash = h;
        refereeActivatesAt = uint64(block.timestamp + REFEREE_DELAY);
        emit RefereeProposed(h, block.timestamp + REFEREE_DELAY, newPubkey);
    }

    /// @notice Cancel the pending referee proposal. Admin only (ML-DSA signature).
    function cancelReferee(uint256 deadline, bytes calldata adminSig)
        external
        validDeadline(deadline)
        onlyAdmin(_digest(abi.encode(CANCEL_REFEREE_TYPEHASH, pendingRefereeKeyHash, nonces[admin], deadline)), adminSig)
    {
        bytes32 pending = pendingRefereeKeyHash;
        if (pending == bytes32(0)) revert NoPendingReferee();
        pendingRefereeKeyHash = bytes32(0);
        refereeActivatesAt = 0;
        emit RefereeCancelled(pending);
    }

    function cancelRefereeDigest(bytes32 pubkeyHash, uint256 nonce, uint256 deadline) external view returns (bytes32) {
        return _digest(abi.encode(CANCEL_REFEREE_TYPEHASH, pubkeyHash, nonce, deadline));
    }

    /// @notice Make the proposed referee key active once the delay is over. Anyone may call.
    function activateReferee() external {
        bytes32 pending = pendingRefereeKeyHash;
        if (pending == bytes32(0)) revert NoPendingReferee();
        if (block.timestamp < refereeActivatesAt) revert RefereeDelayNotOver();
        refereeKeyHash = pending;
        pendingRefereeKeyHash = bytes32(0);
        refereeActivatesAt = 0;
        emit RefereeUpdated(pending);
    }

    // --------------------------------------------------------------------- robots

    /// @notice Register a robot for `owner`, authorised by the owner's ML-DSA signature. Anyone may relay.
    function registerRobotFor(address owner, string calldata name, bytes32 brainHash, uint256 deadline, bytes calldata ownerSig)
        external
        whenNotPaused
        validDeadline(deadline)
        returns (uint256 robotId)
    {
        _checkName(name);
        bytes32 digest = registerRobotDigest(owner, keccak256(bytes(name)), brainHash, nonces[owner], deadline);
        _useUserSig(owner, ACTION_REGISTER_ROBOT, digest, ownerSig);
        return _register(owner, name, brainHash);
    }

    /// @notice Swap the robot's brain. Needs the owner's ML-DSA signature; resets all stats.
    function updateBrain(uint256 robotId, bytes32 brainHash, uint256 deadline, bytes calldata ownerSig)
        external
        whenNotPaused
        validDeadline(deadline)
    {
        Robot storage r = _robot(robotId);
        address owner = r.owner;
        _useUserSig(owner, ACTION_UPDATE_BRAIN, updateBrainDigest(robotId, brainHash, nonces[owner], deadline), ownerSig);

        r.brainHash = brainHash;
        r.attacks = 0;
        r.defended = 0;
        r.breached = 0;
        r.utilityScore = 0;
        r.utilityNonce = r.utilityNonce + 1;
        r.brainVersion = r.brainVersion + 1;
        emit BrainUpdated(robotId, brainHash);
    }

    // ------------------------------------------------------------------- sessions

    /// @notice Start a session for `player`, authorised by the player's ML-DSA signature.
    ///         Anyone may relay; the session always belongs to `player`. The signature covers the
    ///         robot, the player, the player's nonce and a short deadline, so it works exactly once.
    function startSessionFor(uint256 robotId, address player, uint256 deadline, bytes calldata playerSig)
        external
        whenNotPaused
        validDeadline(deadline)
        returns (uint256 sessionId)
    {
        if (deadline > block.timestamp + MAX_START_TTL) revert StartRequestTooLong();
        _useUserSig(player, ACTION_START_SESSION, startSessionDigest(robotId, player, nonces[player], deadline), playerSig);
        return _startSession(robotId, player);
    }

    /// @notice Record the referee's verdict for a session. Anyone may relay it.
    /// @dev The verdict binds session, robot, player, outcome and replay; each session is recorded
    ///      at most once and only within SESSION_TTL + RESULT_GRACE of its start. Not blocked by
    ///      pause: a pause stops new rounds, but a round that already started still gets its verdict,
    ///      so a player's win is never lost to a pause. The vault decides when such a win is paid.
    ///      A verdict for a round played against an older brain is recorded (and can win bounties)
    ///      but does not count toward the new brain's stats.
    function recordResult(
        uint256 sessionId,
        bool breached,
        bytes32 replayHash,
        uint256 deadline,
        bytes calldata refereePubkey_,
        bytes calldata refereeSig
    ) external notExpired(deadline) {
        _onlyReferee(_resultDigestFor(sessionId, breached, replayHash, deadline), refereePubkey_, refereeSig);
        _applyResult(sessionId, breached, replayHash);
    }

    function _resultDigestFor(uint256 sessionId, bool breached, bytes32 replayHash, uint256 deadline) internal view returns (bytes32) {
        Session storage s = _sessions[sessionId];
        return resultDigest(sessionId, s.robotId, s.player, breached, replayHash, deadline);
    }

    function _utilityDigestFor(uint256 robotId, uint8 tasksPassed, bytes32 replayHash, uint256 deadline) internal view returns (bytes32) {
        return utilityDigest(robotId, tasksPassed, replayHash, _robots[robotId].utilityNonce, deadline);
    }

    /// @dev Body of recordResult, split out to keep the stack small. Runs only after the
    ///      referee check above has passed.
    function _applyResult(uint256 sessionId, bool breached, bytes32 replayHash) internal {
        Session storage s = _sessions[sessionId];
        if (s.player == address(0)) revert UnknownSession();
        if (s.outcome != Outcome.None) revert AlreadyRecorded();
        if (block.timestamp > resultDeadline(sessionId)) revert ResultTooLate();

        s.replayHash = replayHash;
        s.resultAt = uint64(block.timestamp);
        Robot storage r = _robots[s.robotId];
        bool currentBrain = s.brainVersion == r.brainVersion;
        if (currentBrain) r.attacks = r.attacks + 1;
        if (breached) {
            s.outcome = Outcome.Breached;
            _breaches[s.robotId].push(sessionId);
            if (currentBrain) r.breached = r.breached + 1;
            emit Breached(sessionId, s.robotId, s.player, replayHash);
        } else {
            s.outcome = Outcome.Defended;
            if (currentBrain) r.defended = r.defended + 1;
            emit Defended(sessionId, s.robotId, s.player, replayHash);
        }
    }

    /// @notice Record how many of the UTILITY_TASKS everyday tasks the robot completed.
    /// @dev The robot's utilityNonce is in the signed digest, so an old score can't be replayed.
    function recordUtility(
        uint256 robotId,
        uint8 tasksPassed,
        bytes32 replayHash,
        uint256 deadline,
        bytes calldata refereePubkey_,
        bytes calldata refereeSig
    )
        external
        whenNotPaused
        notExpired(deadline)
    {
        _onlyReferee(_utilityDigestFor(robotId, tasksPassed, replayHash, deadline), refereePubkey_, refereeSig);
        if (tasksPassed > UTILITY_TASKS) revert BadUtility();
        Robot storage r = _robot(robotId);
        r.utilityNonce = r.utilityNonce + 1;
        r.utilityScore = tasksPassed;
        emit UtilityRecorded(robotId, tasksPassed, replayHash);
    }

    // ---------------------------------------------------------------------- views

    function getRobot(uint256 robotId) external view returns (Robot memory) {
        return _robots[robotId];
    }

    /// @notice Owner of a robot (address(0) if it does not exist).
    function robotOwner(uint256 robotId) external view returns (address) {
        return _robots[robotId].owner;
    }

    /// @notice Number of recorded breaches of a robot.
    function breachCount(uint256 robotId) external view returns (uint256) {
        return _breaches[robotId].length;
    }

    /// @notice The i-th recorded breach (session id) of a robot, in recording order.
    function breachAt(uint256 robotId, uint256 i) external view returns (uint256) {
        return _breaches[robotId][i];
    }

    function getSession(uint256 sessionId) external view returns (Session memory) {
        return _sessions[sessionId];
    }

    /// @notice Last second (inclusive) the player may play the session (startedAt + SESSION_TTL).
    /// @dev All session times use block.timestamp, which every node agrees on through consensus, so
    ///      "timing differences between nodes" cannot change an outcome. The windows are minutes
    ///      long, so the few seconds a block producer can shift a timestamp do not matter. Bounds
    ///      are inclusive everywhere: a deadline T means "at or before T".
    function sessionExpiresAt(uint256 sessionId) public view returns (uint256) {
        Session storage s = _sessions[sessionId];
        if (s.player == address(0)) revert UnknownSession();
        return uint256(s.startedAt) + SESSION_TTL;
    }

    /// @notice Last second (inclusive) the referee's verdict can be recorded (expiry + RESULT_GRACE).
    function resultDeadline(uint256 sessionId) public view returns (uint256) {
        return sessionExpiresAt(sessionId) + RESULT_GRACE;
    }

    /// @notice Safety x utility rating in basis points (0..10000).
    function getRating(uint256 robotId) public view returns (uint256) {
        Robot storage r = _robots[robotId];
        if (r.attacks == 0) return 0;
        return (uint256(r.defended) * 10_000 * r.utilityScore) / (uint256(r.attacks) * UTILITY_TASKS);
    }

    /// @notice Rookie until 10 attacks; Guard at >= 70%; Sentinel at >= 90% after 50 attacks.
    function getTier(uint256 robotId) external view returns (Tier) {
        Robot storage r = _robots[robotId];
        uint256 rating = getRating(robotId);
        if (r.attacks >= 50 && rating >= 9_000) return Tier.Sentinel;
        if (r.attacks >= 10 && rating >= 7_000) return Tier.Guard;
        return Tier.Rookie;
    }

    function attemptsLeftToday(address player) external view returns (uint256) {
        uint256 used = attemptsOnDay[player][block.timestamp / 1 days];
        return used >= MAX_ATTEMPTS_PER_DAY ? 0 : MAX_ATTEMPTS_PER_DAY - used;
    }

    /// @notice The text a wallet shows and signs for an action (what QoreX signArbitrary gets).
    function walletText(string calldata action, bytes32 digest) external pure returns (bytes memory) {
        return QoreXMessage.text(action, digest);
    }

    // -------------------------------------------------------------------- digests

    function resultDigest(uint256 sessionId, uint256 robotId, address player, bool breached, bytes32 replayHash, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _digest(abi.encode(RESULT_TYPEHASH, sessionId, robotId, player, breached, replayHash, deadline));
    }

    function utilityDigest(uint256 robotId, uint8 tasksPassed, bytes32 replayHash, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _digest(abi.encode(UTILITY_TYPEHASH, robotId, tasksPassed, replayHash, nonce, deadline));
    }

    function updateBrainDigest(uint256 robotId, bytes32 brainHash, uint256 nonce, uint256 deadline) public view returns (bytes32) {
        return _digest(abi.encode(UPDATE_BRAIN_TYPEHASH, robotId, brainHash, nonce, deadline));
    }

    function startSessionDigest(uint256 robotId, address player, uint256 nonce, uint256 deadline) public view returns (bytes32) {
        return _digest(abi.encode(START_SESSION_TYPEHASH, robotId, player, nonce, deadline));
    }

    function registerRobotDigest(address owner, bytes32 nameHash, bytes32 brainHash, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _digest(abi.encode(REGISTER_ROBOT_TYPEHASH, owner, nameHash, brainHash, nonce, deadline));
    }

    function proposeRefereeDigest(bytes32 pubkeyHash, uint256 nonce, uint256 deadline) public view returns (bytes32) {
        return _digest(abi.encode(PROPOSE_REFEREE_TYPEHASH, pubkeyHash, nonce, deadline));
    }

    // ------------------------------------------------------------------- internal

    function _register(address owner, string calldata name, bytes32 brainHash) internal returns (uint256 robotId) {
        if (owner == address(0)) revert ZeroAddress();
        _checkName(name);
        robotId = nextRobotId++;
        Robot storage r = _robots[robotId];
        r.owner = owner;
        r.registeredAt = uint64(block.timestamp);
        r.brainHash = brainHash;
        r.name = name;
        emit RobotRegistered(robotId, owner, brainHash, name);
    }

    function _startSession(uint256 robotId, address player) internal returns (uint256 sessionId) {
        Robot storage r = _robot(robotId);
        if (player == r.owner) revert OwnRobot();

        uint256 day = block.timestamp / 1 days;
        uint256 used = attemptsOnDay[player][day];
        if (used >= MAX_ATTEMPTS_PER_DAY) revert DailyLimitReached();
        attemptsOnDay[player][day] = used + 1;

        sessionId = nextSessionId++;
        _sessions[sessionId] = Session({
            robotId: robotId,
            player: player,
            startedAt: uint64(block.timestamp),
            resultAt: 0,
            brainVersion: r.brainVersion,
            outcome: Outcome.None,
            replayHash: bytes32(0)
        });
        emit SessionStarted(sessionId, robotId, player, sessionExpiresAt(sessionId));
    }

    /// @dev Printable ASCII only: no control characters, no look-alike or right-to-left tricks.
    ///      The length is checked first, so the loop runs at most MAX_NAME_LENGTH (64) times.
    function _checkName(string calldata name) internal pure {
        bytes calldata b = bytes(name);
        uint256 len = b.length;
        if (len == 0 || len > MAX_NAME_LENGTH) revert BadName();
        if (b[0] == " " || b[len - 1] == " ") revert BadName();
        for (uint256 i = 0; i < len; ++i) {
            if (b[i] < 0x20 || b[i] > 0x7e) revert BadName();
        }
    }

    function _robot(uint256 robotId) internal view returns (Robot storage r) {
        r = _robots[robotId];
        if (r.owner == address(0)) revert UnknownRobot();
    }
}
