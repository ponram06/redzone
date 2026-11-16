// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// src/PQGuard.sol

/// @title PQGuard
/// @notice Thin wrapper around QoreChain's post-quantum precompiles (IQorePQC).
/// @dev Addresses and ABI from @qorechain/evm 0.14.0 (PRECOMPILE_ADDRESSES, IQORE_PQC_ABI):
///        pqcVerify(bytes pubkey, bytes signature, bytes message) view returns (bool valid)     @ 0x0A01
///        pqcKeyStatus(address account) view returns (bool registered, uint8 algorithmId, bytes pubkey) @ 0x0A02
///      Both are active on testnet qorechain-diana (/cosmos/evm/vm/v1/params).
///      Precompiles have no bytecode, so a high-level interface call would revert on the
///      extcodesize check. We use low-level staticcall and decode the result ourselves.
library PQGuard {
    address internal constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address internal constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;

    bytes4 internal constant PQC_VERIFY_SELECTOR = bytes4(keccak256("pqcVerify(bytes,bytes,bytes)"));
    bytes4 internal constant PQC_KEY_STATUS_SELECTOR = bytes4(keccak256("pqcKeyStatus(address)"));

    error PQCPrecompileUnavailable();
    error PQCKeyNotRegistered(address account);
    error PQCSignatureInvalid();

    /// @notice Verifies a post-quantum signature with the 0x0A01 precompile.
    function verify(bytes memory pubkey, bytes memory signature, bytes memory message) internal view returns (bool) {
        (bool ok, bytes memory ret) =
            PQC_VERIFY.staticcall(abi.encodeWithSelector(PQC_VERIFY_SELECTOR, pubkey, signature, message));
        if (!ok || ret.length < 32) revert PQCPrecompileUnavailable();
        return abi.decode(ret, (bool));
    }

    /// @notice Reads an account's registered PQ key from the 0x0A02 precompile.
    function keyStatus(address account)
        internal
        view
        returns (bool registered, uint8 algorithmId, bytes memory pubkey)
    {
        (bool ok, bytes memory ret) =
            PQC_KEY_STATUS.staticcall(abi.encodeWithSelector(PQC_KEY_STATUS_SELECTOR, account));
        if (!ok || ret.length < 96) revert PQCPrecompileUnavailable();
        return abi.decode(ret, (bool, uint8, bytes));
    }

    /// @notice True when `account` has a registered PQ key on chain.
    function hasPQKey(address account) internal view returns (bool registered) {
        (registered,,) = keyStatus(account);
    }

    /// @notice Reverts unless `signature` over `digest` is valid for `account`'s registered PQ key.
    /// @dev The key is read live from chain state, so a key rotation (itself hybrid-signed) is honoured
    ///      and a leaked ECDSA key alone can never produce a passing signature.
    function requireAccountSig(address account, bytes32 digest, bytes memory signature) internal view {
        (bool registered,, bytes memory pubkey) = keyStatus(account);
        if (!registered) revert PQCKeyNotRegistered(account);
        if (!verify(pubkey, signature, abi.encodePacked(digest))) revert PQCSignatureInvalid();
    }

    /// @notice Reverts unless `signature` over the raw `message` bytes is valid for `account`'s
    ///         registered PQ key. Used for wallet-style messages (e.g. QoreX signArbitrary).
    function requireAccountMessageSig(address account, bytes memory message, bytes memory signature) internal view {
        (bool registered,, bytes memory pubkey) = keyStatus(account);
        if (!registered) revert PQCKeyNotRegistered(account);
        if (!verify(pubkey, signature, message)) revert PQCSignatureInvalid();
    }

    /// @notice Reverts unless `signature` over `digest` is valid for a fixed `pubkey` (e.g. the referee).
    function requirePubkeySig(bytes memory pubkey, bytes32 digest, bytes memory signature) internal view {
        if (!verify(pubkey, signature, abi.encodePacked(digest))) revert PQCSignatureInvalid();
    }
}

// src/QoreXMessage.sol

/// @title QoreXMessage
/// @notice Rebuilds the exact bytes the QoreX wallet's ML-DSA-87 key signs for `signArbitrary`, so a
///         contract can verify a wallet signature with the pqcVerify precompile.
/// @dev QoreX 0.4.x signs, with the account's ML-DSA-87 key:
///          "qorechain-msg-v1|" ‖ nativeChainId ‖ "|" ‖ data
///      (checked against a real QoreX signature on qorechain-diana). The data RedZone asks the
///      wallet to sign is a short readable text that ends with the action's 32-byte digest:
///          "RedZone authorisation\naction: <Action>\ndigest: 0x<64 lower-case hex>"
///      The digest is domain-separated (contract, chain id, nonce, deadline), so the text cannot be
///      reused anywhere else, and the action name is shown to the user in the wallet.
library QoreXMessage {
    bytes internal constant DOMAIN = "qorechain-msg-v1|";

    error BadNativeChainId();

    /// @notice Same rule as QoreX: non-empty, only [A-Za-z0-9._-], so a wallet can sign for it.
    function checkChainId(bytes memory chainId) internal pure {
        if (chainId.length == 0 || chainId.length > 64) revert BadNativeChainId();
        for (uint256 i = 0; i < chainId.length; i++) {
            bytes1 c = chainId[i];
            bool ok = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c == "." || c == "_"
                || c == "-";
            if (!ok) revert BadNativeChainId();
        }
    }

    /// @notice The text shown in the wallet.
    function text(string memory action, bytes32 digest) internal pure returns (bytes memory) {
        return abi.encodePacked("RedZone authorisation\naction: ", action, "\ndigest: 0x", toHex(digest));
    }

    /// @notice The exact bytes the wallet's ML-DSA key signs.
    function message(bytes memory chainId, string memory action, bytes32 digest) internal pure returns (bytes memory) {
        return abi.encodePacked(DOMAIN, chainId, "|", text(action, digest));
    }

    function toHex(bytes32 value) internal pure returns (bytes memory out) {
        bytes16 alphabet = "0123456789abcdef";
        out = new bytes(64);
        for (uint256 i = 0; i < 32; i++) {
            uint8 b = uint8(value[i]);
            out[2 * i] = alphabet[b >> 4];
            out[2 * i + 1] = alphabet[b & 0x0f];
        }
    }
}

// src/PQAdmin.sol

/// @title PQAdmin
/// @notice Shared base for RedZone contracts: an admin, the referee's ML-DSA-87 public key and a
///         pause switch, all changed only with the admin's ML-DSA signature. msg.sender never
///         authorises anything here, so a leaked ECDSA key cannot take control.
abstract contract PQAdmin {
    bytes32 public constant SET_REFEREE_TYPEHASH = keccak256("RedZone.SetReferee(bytes32 pubkeyHash,uint256 nonce,uint256 deadline)");
    bytes32 public constant SET_PAUSED_TYPEHASH = keccak256("RedZone.SetPaused(bool paused,uint256 nonce,uint256 deadline)");
    bytes32 public constant TRANSFER_ADMIN_TYPEHASH = keccak256("RedZone.TransferAdmin(address newAdmin,uint256 nonce,uint256 deadline)");

    /// @dev Domain tag mixed into every digest, e.g. "RedZone.EscrowVault.v1".
    bytes32 private immutable _domainTag;

    address public admin;
    bytes public refereePubkey;
    bool public paused;
    /// @notice Per-signer nonce for signed owner / admin actions (replay protection).
    mapping(address => uint256) public nonces;

    event RefereeUpdated(bytes32 indexed pubkeyHash);
    event PausedSet(bool paused);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    error Paused();
    error ZeroAddress();
    error EmptyPubkey();
    error Expired();

    modifier notExpired(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    /// @dev The deployer becomes admin and must already have a registered PQ key.
    constructor(string memory domainTag, bytes memory refereePubkey_) {
        if (refereePubkey_.length == 0) revert EmptyPubkey();
        if (!PQGuard.hasPQKey(msg.sender)) revert PQGuard.PQCKeyNotRegistered(msg.sender);
        _domainTag = keccak256(bytes(domainTag));
        admin = msg.sender;
        refereePubkey = refereePubkey_;
        emit AdminTransferred(address(0), msg.sender);
        emit RefereeUpdated(keccak256(refereePubkey_));
    }

    // ----------------------------------------------------------------- admin

    function setReferee(bytes calldata newPubkey, uint256 deadline, bytes calldata adminSig)
        external
        notExpired(deadline)
    {
        if (newPubkey.length == 0) revert EmptyPubkey();
        bytes32 h = keccak256(newPubkey);
        _requireAdminSig(setRefereeDigest(h, nonces[admin], deadline), adminSig);
        refereePubkey = newPubkey;
        emit RefereeUpdated(h);
    }

    function setPaused(bool paused_, uint256 deadline, bytes calldata adminSig) external notExpired(deadline) {
        _requireAdminSig(setPausedDigest(paused_, nonces[admin], deadline), adminSig);
        paused = paused_;
        emit PausedSet(paused_);
    }

    function transferAdmin(address newAdmin, uint256 deadline, bytes calldata adminSig) external notExpired(deadline) {
        if (newAdmin == address(0)) revert ZeroAddress();
        if (!PQGuard.hasPQKey(newAdmin)) revert PQGuard.PQCKeyNotRegistered(newAdmin);
        _requireAdminSig(transferAdminDigest(newAdmin, nonces[admin], deadline), adminSig);
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    // --------------------------------------------------------------- digests
    // The 32-byte digest is the exact message the ML-DSA key signs (passed to pqcVerify as bytes).

    function setRefereeDigest(bytes32 pubkeyHash, uint256 nonce, uint256 deadline) public view returns (bytes32) {
        return _digest(abi.encode(SET_REFEREE_TYPEHASH, pubkeyHash, nonce, deadline));
    }

    function setPausedDigest(bool paused_, uint256 nonce, uint256 deadline) public view returns (bytes32) {
        return _digest(abi.encode(SET_PAUSED_TYPEHASH, paused_, nonce, deadline));
    }

    function transferAdminDigest(address newAdmin, uint256 nonce, uint256 deadline) public view returns (bytes32) {
        return _digest(abi.encode(TRANSFER_ADMIN_TYPEHASH, newAdmin, nonce, deadline));
    }

    // -------------------------------------------------------------- internal

    /// @dev Domain-separated by contract kind, chain id and this contract's address, so a
    ///      signature for one contract or chain is useless anywhere else.
    function _digest(bytes memory structData) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(_domainTag, block.chainid, address(this), keccak256(structData)));
    }

    function _requireAdminSig(bytes32 digest, bytes calldata adminSig) internal {
        address a = admin;
        PQGuard.requireAccountSig(a, digest, adminSig);
        nonces[a]++;
    }

    function _requireRefereeSig(bytes32 digest, bytes calldata refereeSig) internal view {
        PQGuard.requirePubkeySig(refereePubkey, digest, refereeSig);
    }
}

// src/EscrowVault.sol

/// @title EscrowVault
/// @notice Holds RedZone bounties in native QOR. Every action that moves money or changes
///         who can move money is authorised by an ML-DSA-87 signature verified on chain:
///           - claimBounty    : the referee's ML-DSA verdict (breach confirmed, pays the bound claimer)
///           - withdrawBounty : the bounty owner's ML-DSA signature
///           - setReferee / setPaused / transferAdmin : the admin's ML-DSA signature (PQAdmin)
///         msg.sender is never trusted for authorisation. Anyone may relay a signed message,
///         so a leaked or quantum-broken ECDSA key cannot move funds or change settings.
contract EscrowVault is PQAdmin {
    enum Status {
        None,
        Open,
        Claimed,
        Withdrawn
    }

    struct Bounty {
        address owner;
        bytes32 robotId;
        uint128 amount;
        Status status;
    }

    bytes32 public constant CLAIM_TYPEHASH = keccak256("RedZone.Claim(uint256 bountyId,address claimer,bytes32 replayHash,uint256 deadline)");
    bytes32 public constant WITHDRAW_TYPEHASH = keccak256("RedZone.Withdraw(uint256 bountyId,address to,uint256 nonce,uint256 deadline)");

    uint256 public nextBountyId = 1;
    uint256 public totalLocked;
    mapping(uint256 => Bounty) public bounties;

    uint256 private _lock = 1;

    event BountyDeposited(uint256 indexed bountyId, bytes32 indexed robotId, address indexed owner, uint256 amount);
    event BountyClaimed(uint256 indexed bountyId, address indexed claimer, bytes32 replayHash, uint256 amount);
    event BountyWithdrawn(uint256 indexed bountyId, address indexed to, uint256 amount);

    error ZeroAmount();
    error AmountTooLarge();
    error BountyNotOpen();
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @param refereePubkey_ The referee service's ML-DSA-87 public key.
    constructor(bytes memory refereePubkey_) PQAdmin("RedZone.EscrowVault.v1", refereePubkey_) {}

    /// @notice Lock native QOR as a bounty on a robot. The sender becomes the bounty owner and
    ///         must have a registered PQ key, because only that key can withdraw it later.
    function depositBounty(bytes32 robotId) external payable whenNotPaused returns (uint256 bountyId) {
        if (msg.value == 0) revert ZeroAmount();
        if (msg.value > type(uint128).max) revert AmountTooLarge();
        if (!PQGuard.hasPQKey(msg.sender)) revert PQGuard.PQCKeyNotRegistered(msg.sender);

        bountyId = nextBountyId++;
        bounties[bountyId] = Bounty({owner: msg.sender, robotId: robotId, amount: uint128(msg.value), status: Status.Open});
        totalLocked += msg.value;
        emit BountyDeposited(bountyId, robotId, msg.sender, msg.value);
    }

    /// @notice Pay a bounty to the player who breached the robot.
    /// @dev The referee's ML-DSA verdict binds bountyId, claimer and replayHash, and the payment
    ///      always goes to `claimer`, so whoever relays the transaction cannot redirect funds.
    ///      The bounty closes on success, so a verdict cannot be replayed.
    function claimBounty(
        uint256 bountyId,
        address claimer,
        bytes32 replayHash,
        uint256 deadline,
        bytes calldata refereeSig
    ) external nonReentrant whenNotPaused notExpired(deadline) {
        if (claimer == address(0)) revert ZeroAddress();
        Bounty storage b = bounties[bountyId];
        if (b.status != Status.Open) revert BountyNotOpen();

        _requireRefereeSig(claimDigest(bountyId, claimer, replayHash, deadline), refereeSig);

        uint256 amount = b.amount;
        b.status = Status.Claimed;
        b.amount = 0;
        totalLocked -= amount;
        emit BountyClaimed(bountyId, claimer, replayHash, amount);
        _send(claimer, amount);
    }

    /// @notice Owner pulls an open bounty back. Needs the owner's ML-DSA signature.
    /// @dev Not blocked by pause, so owners can always recover funds.
    function withdrawBounty(uint256 bountyId, address to, uint256 deadline, bytes calldata ownerSig)
        external
        nonReentrant
        notExpired(deadline)
    {
        if (to == address(0)) revert ZeroAddress();
        Bounty storage b = bounties[bountyId];
        if (b.status != Status.Open) revert BountyNotOpen();
        address owner = b.owner;

        PQGuard.requireAccountSig(owner, withdrawDigest(bountyId, to, nonces[owner], deadline), ownerSig);
        nonces[owner]++;

        uint256 amount = b.amount;
        b.status = Status.Withdrawn;
        b.amount = 0;
        totalLocked -= amount;
        emit BountyWithdrawn(bountyId, to, amount);
        _send(to, amount);
    }

    function claimDigest(uint256 bountyId, address claimer, bytes32 replayHash, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _digest(abi.encode(CLAIM_TYPEHASH, bountyId, claimer, replayHash, deadline));
    }

    function withdrawDigest(uint256 bountyId, address to, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _digest(abi.encode(WITHDRAW_TYPEHASH, bountyId, to, nonce, deadline));
    }

    function _send(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @dev Plain transfers are rejected so every QOR in the vault belongs to a tracked bounty.
    receive() external payable {
        revert();
    }
}

// src/RobotRegistryV2.sol

/// @title RobotRegistryV2
/// @notice Public record of RedZone robots, attack sessions and safety ratings.
///
/// What is new in v2: players and owners never need to send an EVM transaction themselves.
/// They sign a request with their ML-DSA-87 key in the QoreX wallet, anyone relays it, and the
/// contract checks the signature on chain with the pqcVerify precompile against the account's
/// registered key (pqcKeyStatus). The relayer can neither forge, alter nor replay a request.
///
///   - Owners register a robot with a hash of its brain config (model + system prompt + policy).
///   - Players with a registered PQ key start attack sessions: 5 per player per UTC day, each
///     playable for 10 minutes. Owners cannot attack their own robot.
///   - Only the referee's ML-DSA-87 verdict can record a session result or a utility score.
///   - Rating = defended / attacks x utility / 10, in basis points (0..10000).
///   - Changing the brain needs the owner's ML-DSA signature and resets the stats.
///
/// User signatures are accepted in two forms, both over the same domain-separated digest:
///   1. QoreX signArbitrary: "qorechain-msg-v1|<chain>|RedZone authorisation\naction: X\ndigest: 0x..."
///   2. Raw: the 32-byte digest itself (e.g. signed with the QoreChain SDK pqcSign).
contract RobotRegistryV2 is PQAdmin {
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
        uint8 utilityScore; // normal tasks passed, 0..10
        uint32 attacks; // sessions with a recorded result
        uint32 defended;
        uint32 breached;
        uint32 utilityNonce;
        bytes32 brainHash;
        string name;
    }

    struct Session {
        uint256 robotId;
        address player;
        uint64 startedAt;
        Outcome outcome;
        bytes32 replayHash;
    }

    uint256 public constant MAX_ATTEMPTS_PER_DAY = 5;
    uint256 public constant SESSION_TTL = 10 minutes;
    /// @dev Extra time after a session ends for the referee's verdict to be relayed on chain.
    uint256 public constant RESULT_GRACE = 1 hours;
    /// @dev A signed user request must be used within this time, so a relayer cannot hold it back
    ///      and burn the player's attempt at a moment the player is not there to play.
    uint256 public constant MAX_REQUEST_TTL = 1 hours;
    uint8 public constant UTILITY_TASKS = 10;
    uint256 public constant MAX_NAME_LENGTH = 64;

    bytes32 public constant RESULT_TYPEHASH = keccak256("RedZone.Result(uint256 sessionId,bool breached,bytes32 replayHash,uint256 deadline)");
    bytes32 public constant UTILITY_TYPEHASH = keccak256("RedZone.Utility(uint256 robotId,uint8 tasksPassed,bytes32 replayHash,uint256 nonce,uint256 deadline)");
    bytes32 public constant UPDATE_BRAIN_TYPEHASH = keccak256("RedZone.UpdateBrain(uint256 robotId,bytes32 brainHash,uint256 nonce,uint256 deadline)");
    bytes32 public constant START_SESSION_TYPEHASH = keccak256("RedZone.StartSession(uint256 robotId,address player,uint256 nonce,uint256 deadline)");
    bytes32 public constant REGISTER_ROBOT_TYPEHASH = keccak256("RedZone.RegisterRobot(address owner,bytes32 nameHash,bytes32 brainHash,uint256 nonce,uint256 deadline)");

    string public constant ACTION_START_SESSION = "StartSession";
    string public constant ACTION_REGISTER_ROBOT = "RegisterRobot";
    string public constant ACTION_UPDATE_BRAIN = "UpdateBrain";

    /// @notice Native chain id the wallet signs for, e.g. "qorechain-diana".
    bytes public nativeChainId;

    uint256 public nextRobotId = 1;
    uint256 public nextSessionId = 1;
    mapping(uint256 => Robot) internal _robots;
    mapping(uint256 => Session) public sessions;
    /// @dev player => UTC day number => sessions started that day
    mapping(address => mapping(uint256 => uint256)) public attemptsOnDay;

    event RobotRegistered(uint256 indexed robotId, address indexed owner, bytes32 brainHash, string name);
    event BrainUpdated(uint256 indexed robotId, bytes32 brainHash);
    event SessionStarted(uint256 indexed sessionId, uint256 indexed robotId, address indexed player, uint256 expiresAt);
    event Defended(uint256 indexed sessionId, uint256 indexed robotId, address indexed player, bytes32 replayHash);
    event Breached(uint256 indexed sessionId, uint256 indexed robotId, address indexed player, bytes32 replayHash);
    event UtilityRecorded(uint256 indexed robotId, uint8 tasksPassed, bytes32 replayHash);

    error UnknownRobot();
    error UnknownSession();
    error BadName();
    error OwnRobot();
    error DailyLimitReached();
    error AlreadyRecorded();
    error ResultTooLate();
    error BadUtility();
    error DeadlineTooFar();

    constructor(bytes memory refereePubkey_, bytes memory nativeChainId_)
        PQAdmin("RedZone.RobotRegistry.v2", refereePubkey_)
    {
        QoreXMessage.checkChainId(nativeChainId_);
        nativeChainId = nativeChainId_;
    }

    // ---------------------------------------------------------------- robots

    /// @notice Register a robot owned by the sender (sender needs a registered PQ key).
    function registerRobot(string calldata name, bytes32 brainHash) external whenNotPaused returns (uint256 robotId) {
        if (!PQGuard.hasPQKey(msg.sender)) revert PQGuard.PQCKeyNotRegistered(msg.sender);
        return _register(msg.sender, name, brainHash);
    }

    /// @notice Register a robot for `owner`, authorised by the owner's ML-DSA signature. Anyone may relay.
    function registerRobotFor(address owner, string calldata name, bytes32 brainHash, uint256 deadline, bytes calldata ownerSig)
        external
        whenNotPaused
        returns (uint256 robotId)
    {
        _checkRequestDeadline(deadline);
        bytes32 digest = registerRobotDigest(owner, keccak256(bytes(name)), brainHash, nonces[owner], deadline);
        _requireUserSig(owner, ACTION_REGISTER_ROBOT, digest, ownerSig);
        nonces[owner]++;
        return _register(owner, name, brainHash);
    }

    /// @notice Swap the robot's brain. Needs the owner's ML-DSA signature; resets all stats.
    function updateBrain(uint256 robotId, bytes32 brainHash, uint256 deadline, bytes calldata ownerSig) external {
        _checkRequestDeadline(deadline);
        Robot storage r = _robot(robotId);
        address owner = r.owner;
        _requireUserSig(owner, ACTION_UPDATE_BRAIN, updateBrainDigest(robotId, brainHash, nonces[owner], deadline), ownerSig);
        nonces[owner]++;

        r.brainHash = brainHash;
        r.attacks = 0;
        r.defended = 0;
        r.breached = 0;
        r.utilityScore = 0;
        r.utilityNonce++;
        emit BrainUpdated(robotId, brainHash);
    }

    // -------------------------------------------------------------- sessions

    /// @notice Start a session as the sender (for wallets that can send EVM transactions).
    function startSession(uint256 robotId) external whenNotPaused returns (uint256 sessionId) {
        if (!PQGuard.hasPQKey(msg.sender)) revert PQGuard.PQCKeyNotRegistered(msg.sender);
        return _startSession(robotId, msg.sender);
    }

    /// @notice Start a session for `player`, authorised by the player's ML-DSA signature (QoreX).
    ///         Anyone may relay; the session always belongs to `player`.
    function startSessionFor(uint256 robotId, address player, uint256 deadline, bytes calldata playerSig)
        external
        whenNotPaused
        returns (uint256 sessionId)
    {
        _checkRequestDeadline(deadline);
        _requireUserSig(player, ACTION_START_SESSION, startSessionDigest(robotId, player, nonces[player], deadline), playerSig);
        nonces[player]++;
        return _startSession(robotId, player);
    }

    /// @notice Record the referee's verdict for a session. Anyone may relay it.
    function recordResult(
        uint256 sessionId,
        bool breached,
        bytes32 replayHash,
        uint256 deadline,
        bytes calldata refereeSig
    ) external whenNotPaused notExpired(deadline) {
        Session storage s = sessions[sessionId];
        if (s.player == address(0)) revert UnknownSession();
        if (s.outcome != Outcome.None) revert AlreadyRecorded();
        if (block.timestamp > uint256(s.startedAt) + SESSION_TTL + RESULT_GRACE) revert ResultTooLate();

        _requireRefereeSig(resultDigest(sessionId, breached, replayHash, deadline), refereeSig);

        s.replayHash = replayHash;
        Robot storage r = _robots[s.robotId];
        r.attacks++;
        if (breached) {
            s.outcome = Outcome.Breached;
            r.breached++;
            emit Breached(sessionId, s.robotId, s.player, replayHash);
        } else {
            s.outcome = Outcome.Defended;
            r.defended++;
            emit Defended(sessionId, s.robotId, s.player, replayHash);
        }
    }

    /// @notice Record how many of the 10 normal (non-attack) tasks the robot completed.
    /// @dev The robot's utilityNonce is in the signed digest, so an old score can't be replayed.
    function recordUtility(
        uint256 robotId,
        uint8 tasksPassed,
        bytes32 replayHash,
        uint256 deadline,
        bytes calldata refereeSig
    ) external whenNotPaused notExpired(deadline) {
        if (tasksPassed > UTILITY_TASKS) revert BadUtility();
        Robot storage r = _robot(robotId);
        _requireRefereeSig(utilityDigest(robotId, tasksPassed, replayHash, r.utilityNonce, deadline), refereeSig);
        r.utilityNonce++;
        r.utilityScore = tasksPassed;
        emit UtilityRecorded(robotId, tasksPassed, replayHash);
    }

    // ----------------------------------------------------------------- views

    function getRobot(uint256 robotId) external view returns (Robot memory) {
        return _robots[robotId];
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

    /// @notice The exact bytes the wallet's ML-DSA key signs for an action.
    function walletMessage(string calldata action, bytes32 digest) external view returns (bytes memory) {
        return QoreXMessage.message(nativeChainId, action, digest);
    }

    // --------------------------------------------------------------- digests

    function resultDigest(uint256 sessionId, bool breached, bytes32 replayHash, uint256 deadline) public view returns (bytes32) {
        return _digest(abi.encode(RESULT_TYPEHASH, sessionId, breached, replayHash, deadline));
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

    // -------------------------------------------------------------- internal

    function _register(address owner, string calldata name, bytes32 brainHash) internal returns (uint256 robotId) {
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
        sessions[sessionId] =
            Session({robotId: robotId, player: player, startedAt: uint64(block.timestamp), outcome: Outcome.None, replayHash: 0});
        emit SessionStarted(sessionId, robotId, player, block.timestamp + SESSION_TTL);
    }

    /// @dev Accept the account's ML-DSA signature over the QoreX wallet message, or over the raw digest.
    function _requireUserSig(address account, string memory action, bytes32 digest, bytes calldata sig) internal view {
        (bool registered,, bytes memory pubkey) = PQGuard.keyStatus(account);
        if (!registered) revert PQGuard.PQCKeyNotRegistered(account);
        if (PQGuard.verify(pubkey, sig, QoreXMessage.message(nativeChainId, action, digest))) return;
        if (PQGuard.verify(pubkey, sig, abi.encodePacked(digest))) return;
        revert PQGuard.PQCSignatureInvalid();
    }

    function _checkRequestDeadline(uint256 deadline) internal view {
        if (block.timestamp > deadline) revert Expired();
        if (deadline > block.timestamp + MAX_REQUEST_TTL) revert DeadlineTooFar();
    }

    /// @dev Printable ASCII only: no control characters, no look-alike or right-to-left tricks.
    function _checkName(string calldata name) internal pure {
        bytes calldata b = bytes(name);
        if (b.length == 0 || b.length > MAX_NAME_LENGTH) revert BadName();
        if (b[0] == " " || b[b.length - 1] == " ") revert BadName();
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] < 0x20 || b[i] > 0x7e) revert BadName();
        }
    }

    function _robot(uint256 robotId) internal view returns (Robot storage r) {
        r = _robots[robotId];
        if (r.owner == address(0)) revert UnknownRobot();
    }
}

