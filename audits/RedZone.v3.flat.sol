// SPDX-License-Identifier: MIT
pragma solidity =0.8.28 ^0.8.20 ^0.8.24;

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

// lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol

// OpenZeppelin Contracts (last updated v5.1.0) (utils/ReentrancyGuard.sol)

/**
 * @dev Contract module that helps prevent reentrant calls to a function.
 *
 * Inheriting from `ReentrancyGuard` will make the {nonReentrant} modifier
 * available, which can be applied to functions to make sure there are no nested
 * (reentrant) calls to them.
 *
 * Note that because there is a single `nonReentrant` guard, functions marked as
 * `nonReentrant` may not call one another. This can be worked around by making
 * those functions `private`, and then adding `external` `nonReentrant` entry
 * points to them.
 *
 * TIP: If EIP-1153 (transient storage) is available on the chain you're deploying at,
 * consider using {ReentrancyGuardTransient} instead.
 *
 * TIP: If you would like to learn more about reentrancy and alternative ways
 * to protect against it, check out our blog post
 * https://blog.openzeppelin.com/reentrancy-after-istanbul/[Reentrancy After Istanbul].
 */
abstract contract ReentrancyGuard {
    // Booleans are more expensive than uint256 or any type that takes up a full
    // word because each write operation emits an extra SLOAD to first read the
    // slot's contents, replace the bits taken up by the boolean, and then write
    // back. This is the compiler's defense against contract upgrades and
    // pointer aliasing, and it cannot be disabled.

    // The values being non-zero value makes deployment a bit more expensive,
    // but in exchange the refund on every call to nonReentrant will be lower in
    // amount. Since refunds are capped to a percentage of the total
    // transaction's gas, it is best to keep them low in cases like this one, to
    // increase the likelihood of the full refund coming into effect.
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;

    uint256 private _status;

    /**
     * @dev Unauthorized reentrant call.
     */
    error ReentrancyGuardReentrantCall();

    constructor() {
        _status = NOT_ENTERED;
    }

    /**
     * @dev Prevents a contract from calling itself, directly or indirectly.
     * Calling a `nonReentrant` function from another `nonReentrant`
     * function is not supported. It is possible to prevent this from happening
     * by making the `nonReentrant` function external, and making it call a
     * `private` function that does the actual work.
     */
    modifier nonReentrant() {
        _nonReentrantBefore();
        _;
        _nonReentrantAfter();
    }

    function _nonReentrantBefore() private {
        // On the first call to nonReentrant, _status will be NOT_ENTERED
        if (_status == ENTERED) {
            revert ReentrancyGuardReentrantCall();
        }

        // Any calls to nonReentrant after this point will fail
        _status = ENTERED;
    }

    function _nonReentrantAfter() private {
        // By storing the original value once again, a refund is triggered (see
        // https://eips.ethereum.org/EIPS/eip-2200)
        _status = NOT_ENTERED;
    }

    /**
     * @dev Returns true if the reentrancy guard is currently set to "entered", which indicates there is a
     * `nonReentrant` function in the call stack.
     */
    function _reentrancyGuardEntered() internal view returns (bool) {
        return _status == ENTERED;
    }
}

// src/v3/MLDSA87.sol

/// @title MLDSA87
/// @notice Strict ML-DSA-87 (FIPS 204, NIST level 5) checks on top of QoreChain's PQC precompiles.
///
/// Signature uniqueness / malleability: ML-DSA signing is hedged (randomised) by design, so one
/// message legitimately has many valid signatures. RedZone therefore never uses signature bytes as
/// a replay key. Every signed digest is single use because (1) it contains a per-signer nonce that
/// is consumed, and (2) the contract records the digest itself as used (PQAccess.usedDigests). A
/// second valid signature over the same digest is useless. On top of that, this library enforces
/// the exact ML-DSA-87 format: algorithm id, 2592-byte public key and 4627-byte signature, so
/// truncated, padded or other-scheme signatures are rejected before verification.
///
/// Precompile availability: verification fails closed. If the precompile is missing or returns
/// junk, every signed action reverts. There is deliberately no fallback, because falling back to
/// ECDSA (or skipping the check) would remove the quantum safety the contracts exist to provide.
/// `available()` lets frontends detect the situation without a revert.
library MLDSA87 {
    /// @notice Algorithm id that QoreChain's pqcKeyStatus precompile reports for ML-DSA-87
    ///         (read from qorechain-diana).
    uint8 internal constant ALGORITHM_ID = 1;
    uint256 internal constant PUBKEY_LENGTH = 2592;
    uint256 internal constant SIGNATURE_LENGTH = 4627;

    error NotMLDSA87Key(address account, uint8 algorithmId);
    error BadPubkeyLength(uint256 length);
    error BadSignatureLength(uint256 length);

    /// @notice Reverts unless `pubkey` has the ML-DSA-87 public key length.
    function checkPubkey(bytes memory pubkey) internal pure {
        if (pubkey.length != PUBKEY_LENGTH) revert BadPubkeyLength(pubkey.length);
    }

    /// @notice Reverts unless `signature` has the ML-DSA-87 signature length.
    function checkSignature(bytes memory signature) internal pure {
        if (signature.length != SIGNATURE_LENGTH) revert BadSignatureLength(signature.length);
    }

    /// @notice The account's registered public key, required to be an ML-DSA-87 key.
    function accountKey(address account) internal view returns (bytes memory pubkey) {
        (bool registered, uint8 algorithmId, bytes memory key) = PQGuard.keyStatus(account);
        if (!registered) revert PQGuard.PQCKeyNotRegistered(account);
        if (algorithmId != ALGORITHM_ID) revert NotMLDSA87Key(account, algorithmId);
        checkPubkey(key);
        return key;
    }

    /// @notice Reverts unless `account` has a registered ML-DSA-87 key (no value returned).
    function requireKey(address account) internal view {
        (bool registered, uint8 algorithmId, bytes memory key) = PQGuard.keyStatus(account);
        if (!registered) revert PQGuard.PQCKeyNotRegistered(account);
        if (algorithmId != ALGORITHM_ID) revert NotMLDSA87Key(account, algorithmId);
        checkPubkey(key);
    }

    /// @notice True if `signature` is a well-formed ML-DSA-87 signature by `pubkey` over `message`.
    ///         Reverts on a malformed signature or an unavailable precompile (fail closed).
    function verify(bytes memory pubkey, bytes memory signature, bytes memory message) internal view returns (bool) {
        checkSignature(signature);
        return PQGuard.verify(pubkey, signature, message);
    }

    /// @notice True when both PQC precompiles answer. Never reverts.
    function available() internal view returns (bool) {
        (bool ok1, bytes memory r1) = PQGuard.PQC_KEY_STATUS.staticcall(
            abi.encodeWithSelector(PQGuard.PQC_KEY_STATUS_SELECTOR, address(0))
        );
        (bool ok2, bytes memory r2) = PQGuard.PQC_VERIFY.staticcall(
            abi.encodeWithSelector(PQGuard.PQC_VERIFY_SELECTOR, bytes(""), bytes(""), bytes(""))
        );
        return ok1 && r1.length >= 96 && ok2 && r2.length >= 32;
    }
}

// src/v3/PQAccess.sol

/// @title PQAccess
/// @notice Access control shared by the RedZone v3 contracts. Every privileged call is authorised
///         by an ML-DSA-87 (post-quantum) signature that is verified on chain with QoreChain's
///         pqcVerify precompile. msg.sender is never used for authorisation, so a leaked or
///         quantum-broken ECDSA key cannot take any privileged action.
///
///         Access rules (each enforced by a named modifier):
///           - onlyAdmin  : signature by the admin account's registered ML-DSA key, single use (nonce)
///           - user calls : signature by that user's registered ML-DSA key (QoreX wallet), single use (nonce)
///           - whenNotPaused : blocks new activity during an emergency pause
///
///         Every signed digest is domain-separated by contract kind, EVM chain id, contract
///         address, action type hash, a per-signer nonce and a deadline, so a signature cannot be
///         replayed on another contract, chain or action, or used twice.
abstract contract PQAccess {
    // ------------------------------------------------------------------ constants

    /// @notice Longest validity window a signed request may have. A relayer therefore cannot hold a
    ///         signed request back and use it much later.
    uint256 public constant MAX_REQUEST_TTL = 1 hours;
    /// @notice Longest native chain id accepted (QoreX allows 1..64 characters of [A-Za-z0-9._-]).
    uint256 public constant MAX_CHAIN_ID_LENGTH = 64;
    /// @notice A pause ends by itself after this long, so the admin can delay activity but never
    ///         freeze it for good (even if the admin key is lost).
    uint256 public constant MAX_PAUSE = 7 days;
    /// @notice After a pause ends, the admin must wait this long before pausing again, so repeated
    ///         pauses cannot chain into an endless freeze.
    uint256 public constant PAUSE_COOLDOWN = 1 days;

    bytes32 public constant SET_PAUSED_TYPEHASH = keccak256("RedZone.SetPaused(bool paused,uint256 nonce,uint256 deadline)");
    bytes32 public constant TRANSFER_ADMIN_TYPEHASH = keccak256("RedZone.TransferAdmin(address newAdmin,uint256 nonce,uint256 deadline)");
    bytes32 public constant ACCEPT_ADMIN_TYPEHASH = keccak256("RedZone.AcceptAdmin(address newAdmin,uint256 nonce,uint256 deadline)");

    string public constant ACTION_ACCEPT_ADMIN = "AcceptAdmin";

    // ---------------------------------------------------------------------- state

    /// @dev keccak256 of the contract kind, e.g. "RedZone.EscrowVault.v2". Mixed into every digest.
    bytes32 private immutable _domainTag;

    /// @notice Native chain id the QoreX wallet signs for, e.g. "qorechain-diana".
    bytes public nativeChainId;

    /// @notice Account whose ML-DSA key authorises admin actions. It can pause, and propose changes
    ///         that only take effect after a delay; it can never move bounty funds.
    address public admin;
    /// @notice Proposed new admin. Takes over only after signing acceptAdmin with its own ML-DSA key.
    address public pendingAdmin;
    bool public paused;
    /// @notice Time the current pause started (0 when not paused).
    uint64 public pausedAt;
    /// @notice Time the last pause ended (0 if never paused).
    uint64 public unpausedAt;
    /// @notice Per-signer nonce for signed admin and user actions (replay protection).
    mapping(address => uint256) public nonces;
    /// @notice Every signed digest that has been used (second replay layer on top of nonces).
    ///         Signature bytes are never used as a key: ML-DSA is randomised, so the same message
    ///         has many valid signatures, and uniqueness is enforced on the signed digest instead.
    mapping(bytes32 => bool) public usedDigests;

    // --------------------------------------------------------------------- events

    event PausedSet(bool paused);
    event AdminTransferStarted(address indexed currentAdmin, address indexed pendingAdmin);
    event AdminTransferCancelled(address indexed currentAdmin);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    // --------------------------------------------------------------------- errors

    error Paused();
    error ZeroAddress();
    error Expired();
    error DeadlineTooFar();
    error NotPendingAdmin();
    error PauseUnchanged();
    error PauseCooldown();
    error DigestUsed(bytes32 digest);
    error BadChainId();

    // ------------------------------------------------------------------ modifiers

    /// @notice Only the current admin, proven by its ML-DSA-87 signature over `digest`.
    /// @dev This is this contract's replacement for `require(msg.sender == admin)`, and it is
    ///      strictly stronger: msg.sender is proven by an ECDSA signature, which a quantum computer
    ///      can forge, while this check needs the admin's post-quantum ML-DSA-87 signature, verified
    ///      on chain against the key registered for the admin account. No caller without that
    ///      signature can pass, whatever msg.sender is, so the transaction may be relayed by anyone.
    ///      The digest must include nonces[admin]; the nonce is consumed before the function body
    ///      runs, so the same signature can never be used twice.
    modifier onlyAdmin(bytes32 digest, bytes calldata adminSig) {
        address a = admin;
        if (!MLDSA87.verify(MLDSA87.accountKey(a), adminSig, abi.encodePacked(digest))) revert PQGuard.PQCSignatureInvalid();
        _useDigest(digest);
        nonces[a] = nonces[a] + 1;
        _;
    }

    modifier whenNotPaused() {
        if (isPaused()) revert Paused();
        _;
    }

    /// @notice The signed request is still valid and does not reach too far into the future.
    modifier validDeadline(uint256 deadline) {
        _checkDeadline(deadline);
        _;
    }

    // ---------------------------------------------------------------- constructor

    /// @dev The deployer becomes admin and must already have a registered ML-DSA key.
    constructor(string memory domainTag, bytes memory nativeChainId_) {
        MLDSA87.requireKey(msg.sender); // deployer must hold an ML-DSA-87 key
        if (nativeChainId_.length == 0 || nativeChainId_.length > MAX_CHAIN_ID_LENGTH) revert BadChainId();
        QoreXMessage.checkChainId(nativeChainId_); // character set check
        _domainTag = keccak256(bytes(domainTag));
        nativeChainId = nativeChainId_;
        admin = msg.sender;
        emit AdminTransferred(address(0), msg.sender);
    }

    // ---------------------------------------------------------------------- admin

    /// @notice Pause or unpause new activity. Admin only (ML-DSA signature).
    function setPaused(bool paused_, uint256 deadline, bytes calldata adminSig)
        external
        validDeadline(deadline)
        onlyAdmin(setPausedDigest(paused_, nonces[admin], deadline), adminSig)
    {
        if (paused_ == paused) revert PauseUnchanged();
        if (paused_) {
            if (unpausedAt != 0 && block.timestamp < uint256(unpausedAt) + PAUSE_COOLDOWN) revert PauseCooldown();
            pausedAt = uint64(block.timestamp);
        } else {
            uint256 end = uint256(pausedAt) + MAX_PAUSE;
            unpausedAt = uint64(block.timestamp < end ? block.timestamp : end);
            pausedAt = 0;
        }
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice Step 1 of 2: propose a new admin. Admin only (ML-DSA signature).
    ///         Proposing address(0) cancels a pending proposal.
    function transferAdmin(address newAdmin, uint256 deadline, bytes calldata adminSig)
        external
        validDeadline(deadline)
        onlyAdmin(transferAdminDigest(newAdmin, nonces[admin], deadline), adminSig)
    {
        if (newAdmin != address(0)) MLDSA87.requireKey(newAdmin); // must hold an ML-DSA-87 key
        pendingAdmin = newAdmin;
        if (newAdmin == address(0)) emit AdminTransferCancelled(admin);
        else emit AdminTransferStarted(admin, newAdmin);
    }

    /// @notice Step 2 of 2: the proposed admin accepts with its own ML-DSA signature, which proves
    ///         it controls the key before it gets any power.
    function acceptAdmin(uint256 deadline, bytes calldata newAdminSig) external validDeadline(deadline) {
        address p = pendingAdmin;
        if (p == address(0)) revert NotPendingAdmin();
        _useUserSig(p, ACTION_ACCEPT_ADMIN, acceptAdminDigest(p, nonces[p], deadline), newAdminSig);
        emit AdminTransferred(admin, p);
        admin = p;
        pendingAdmin = address(0);
    }

    // ---------------------------------------------------------------------- views

    /// @notice True while a pause is in force (a pause older than MAX_PAUSE has expired).
    /// @notice True when the post-quantum precompiles respond. Never reverts, so a frontend can
    ///         show a clear message; every signed action fails closed when this is false.
    function isPQAvailable() external view returns (bool) {
        return MLDSA87.available();
    }

    function isPaused() public view returns (bool) {
        return paused && block.timestamp < uint256(pausedAt) + MAX_PAUSE;
    }

    /// @notice When the last pause ended, counting an expired pause as ended at pausedAt + MAX_PAUSE
    ///         (0 if never paused or a pause is in force).
    function lastUnpausedAt() public view returns (uint256) {
        if (paused) {
            uint256 end = uint256(pausedAt) + MAX_PAUSE;
            return block.timestamp >= end ? end : 0;
        }
        return unpausedAt;
    }

    // -------------------------------------------------------------------- digests
    // The 32-byte digest is the exact message the ML-DSA key signs.

    function setPausedDigest(bool paused_, uint256 nonce, uint256 deadline) public view returns (bytes32) {
        return _digest(abi.encode(SET_PAUSED_TYPEHASH, paused_, nonce, deadline));
    }

    function transferAdminDigest(address newAdmin, uint256 nonce, uint256 deadline) public view returns (bytes32) {
        return _digest(abi.encode(TRANSFER_ADMIN_TYPEHASH, newAdmin, nonce, deadline));
    }

    function acceptAdminDigest(address newAdmin, uint256 nonce, uint256 deadline) public view returns (bytes32) {
        return _digest(abi.encode(ACCEPT_ADMIN_TYPEHASH, newAdmin, nonce, deadline));
    }

    /// @notice The exact bytes the QoreX wallet's ML-DSA key signs for an action.
    function walletMessage(string calldata action, bytes32 digest) external view returns (bytes memory) {
        return QoreXMessage.message(nativeChainId, action, digest);
    }

    // ------------------------------------------------------------------- internal

    /// @dev Domain-separated by contract kind, chain id and this contract's address.
    function _digest(bytes memory structData) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(_domainTag, block.chainid, address(this), keccak256(structData)));
    }

    /// @dev Accepts the account's ML-DSA signature over the QoreX wallet message for `action`, or
    ///      over the raw digest (SDK signing). Both cover the same domain-separated digest, and the
    ///      prefixed wallet form is never 32 bytes long, so the two forms cannot collide. ML-DSA
    ///      signatures are never used as replay keys (nonces and on-chain state are), so signature
    ///      malleability or non-uniqueness has no effect.
    function _requireUserSig(address account, string memory action, bytes32 digest, bytes calldata sig) internal view {
        bytes memory pubkey = MLDSA87.accountKey(account);
        if (MLDSA87.verify(pubkey, sig, QoreXMessage.message(nativeChainId, action, digest))) return;
        if (MLDSA87.verify(pubkey, sig, abi.encodePacked(digest))) return;
        revert PQGuard.PQCSignatureInvalid();
    }

    /// @dev Verify a user's signature, then consume it: the digest is marked used and the user's
    ///      nonce advances, so neither this signature nor any other signature over the same digest
    ///      can be used again.
    function _useUserSig(address account, string memory action, bytes32 digest, bytes calldata sig) internal {
        _requireUserSig(account, action, digest, sig);
        _useDigest(digest);
        nonces[account] = nonces[account] + 1;
    }

    function _useDigest(bytes32 digest) internal {
        if (usedDigests[digest]) revert DigestUsed(digest);
        usedDigests[digest] = true;
    }

    function _checkDeadline(uint256 deadline) internal view {
        if (block.timestamp > deadline) revert Expired();
        if (deadline > block.timestamp + MAX_REQUEST_TTL) revert DeadlineTooFar();
    }
}

// src/v3/RobotRegistryV3.sol

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
    bytes32 public constant PROPOSE_REFEREE_TYPEHASH = keccak256("RedZone.ProposeReferee(bytes32 pubkeyHash,uint256 nonce,uint256 deadline)");

    string public constant ACTION_START_SESSION = "StartSession";
    string public constant ACTION_REGISTER_ROBOT = "RegisterRobot";
    string public constant ACTION_UPDATE_BRAIN = "UpdateBrain";

    // ---------------------------------------------------------------------- state

    /// @notice The referee service's ML-DSA-87 public key.
    bytes public refereePubkey;
    /// @notice A proposed referee key and the time it may be activated (0 = none pending).
    bytes public pendingRefereePubkey;
    uint64 public refereeActivatesAt;

    uint256 public nextRobotId = 1;
    uint256 public nextSessionId = 1;
    mapping(uint256 => Robot) internal _robots;
    mapping(uint256 => Session) internal _sessions;
    /// @notice player => UTC day number => sessions started that day
    mapping(address => mapping(uint256 => uint256)) public attemptsOnDay;

    // --------------------------------------------------------------------- events

    event RobotRegistered(uint256 indexed robotId, address indexed owner, bytes32 brainHash, string name);
    event BrainUpdated(uint256 indexed robotId, bytes32 brainHash);
    event SessionStarted(uint256 indexed sessionId, uint256 indexed robotId, address indexed player, uint256 expiresAt);
    event Defended(uint256 indexed sessionId, uint256 indexed robotId, address indexed player, bytes32 replayHash);
    event Breached(uint256 indexed sessionId, uint256 indexed robotId, address indexed player, bytes32 replayHash);
    event UtilityRecorded(uint256 indexed robotId, uint8 tasksPassed, bytes32 replayHash);
    event RefereeProposed(bytes32 indexed pubkeyHash, uint256 activatesAt);
    event RefereeUpdated(bytes32 indexed pubkeyHash);

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
    error RefereeDelayNotOver();
    error StartRequestTooLong();

    // ------------------------------------------------------------------ modifiers

    /// @notice Only the referee, proven by its ML-DSA-87 signature over `digest`.
    /// @dev Like onlyAdmin, this replaces a msg.sender check with a post-quantum signature check:
    ///      only the holder of the referee ML-DSA-87 key can produce a passing signature.
    ///      Referee digests are single use by construction, so no separate nonce is needed: a
    ///      result can be recorded once per session (the AlreadyRecorded check on its outcome),
    ///      only within SESSION_TTL + RESULT_GRACE of its start, and a utility digest includes the
    ///      robot's utilityNonce.
    modifier onlyReferee(bytes32 digest, bytes calldata refereeSig) {
        if (!MLDSA87.verify(refereePubkey, refereeSig, abi.encodePacked(digest))) revert PQGuard.PQCSignatureInvalid();
        _useDigest(digest);
        _;
    }

    modifier notExpired(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    // ---------------------------------------------------------------- constructor

    constructor(bytes memory refereePubkey_, bytes memory nativeChainId_) PQAccess("RedZone.RobotRegistry.v3", nativeChainId_) {
        if (refereePubkey_.length == 0) revert EmptyPubkey();
        MLDSA87.checkPubkey(refereePubkey_);
        refereePubkey = refereePubkey_;
        emit RefereeUpdated(keccak256(refereePubkey_));
    }

    // -------------------------------------------------------------------- referee

    /// @notice Propose a new referee key. Admin only (ML-DSA signature). It can be activated by
    ///         anyone after REFEREE_DELAY. A new proposal replaces the old one and restarts the delay.
    function proposeReferee(bytes calldata newPubkey, uint256 deadline, bytes calldata adminSig)
        external
        validDeadline(deadline)
        onlyAdmin(proposeRefereeDigest(keccak256(newPubkey), nonces[admin], deadline), adminSig)
    {
        if (newPubkey.length == 0) revert EmptyPubkey();
        MLDSA87.checkPubkey(newPubkey);
        pendingRefereePubkey = newPubkey;
        uint256 activatesAt = block.timestamp + REFEREE_DELAY;
        refereeActivatesAt = uint64(activatesAt);
        emit RefereeProposed(keccak256(newPubkey), activatesAt);
    }

    /// @notice Make the proposed referee key active once the delay is over. Anyone may call.
    function activateReferee() external {
        if (pendingRefereePubkey.length == 0) revert NoPendingReferee();
        if (block.timestamp < refereeActivatesAt) revert RefereeDelayNotOver();
        refereePubkey = pendingRefereePubkey;
        delete pendingRefereePubkey;
        refereeActivatesAt = 0;
        emit RefereeUpdated(keccak256(refereePubkey));
    }

    // --------------------------------------------------------------------- robots

    /// @notice Register a robot owned by the sender (the sender needs a registered ML-DSA key).
    function registerRobot(string calldata name, bytes32 brainHash) external whenNotPaused returns (uint256 robotId) {
        MLDSA87.requireKey(msg.sender); // sender must hold an ML-DSA-87 key
        return _register(msg.sender, name, brainHash);
    }

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

    /// @notice Start a session as the sender (for wallets that can send EVM transactions).
    function startSession(uint256 robotId) external whenNotPaused returns (uint256 sessionId) {
        MLDSA87.requireKey(msg.sender); // sender must hold an ML-DSA-87 key
        return _startSession(robotId, msg.sender);
    }

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
    function recordResult(uint256 sessionId, bool breached, bytes32 replayHash, uint256 deadline, bytes calldata refereeSig)
        external
        notExpired(deadline)
        onlyReferee(resultDigest(sessionId, _sessions[sessionId].robotId, _sessions[sessionId].player, breached, replayHash, deadline), refereeSig)
    {
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
    function recordUtility(uint256 robotId, uint8 tasksPassed, bytes32 replayHash, uint256 deadline, bytes calldata refereeSig)
        external
        whenNotPaused
        notExpired(deadline)
        onlyReferee(utilityDigest(robotId, tasksPassed, replayHash, _robots[robotId].utilityNonce, deadline), refereeSig)
    {
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

// src/v3/EscrowVaultV2.sol

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
contract EscrowVaultV2 is PQAccess, ReentrancyGuard {
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
    error DirectTransferRefused();
    error BadDelays();

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
        _useUserSig(owner, ACTION_WITHDRAW, withdrawDigest(bountyId, to, nonces[owner], deadline), ownerSig);

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
