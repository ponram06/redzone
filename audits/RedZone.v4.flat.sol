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
    bytes32 public constant ACCEPT_ADMIN_TYPEHASH = keccak256("RedZone.AcceptAdmin(address newAdmin,uint256 proposalId,uint256 nonce,uint256 deadline)");

    bytes32 public constant DEPLOY_TYPEHASH = keccak256("RedZone.Deploy(bytes32 domainTag,uint256 chainId,address deployer)");

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
    /// @notice Start time of the most recent pause (kept after it ends).
    uint64 public lastPauseStart;
    /// @notice Increases with every admin proposal; an acceptance signature is bound to one proposal,
    ///         so a cancelled proposal's signature can never be reused for a later one.
    uint256 public adminProposalId;
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

    /// @dev The deployer becomes admin and must already have a registered ML-DSA-87 key.
    ///      `deployerProof` is the deployer's ML-DSA-87 signature over deployDigest(...). Verifying
    ///      it here, against the live precompile, proves that the key and signature formats this
    ///      contract enforces really match the chain. If they did not, the deployment itself fails,
    ///      before any QOR can be deposited, instead of locking funds later.
    constructor(string memory domainTag, bytes memory nativeChainId_, bytes memory deployerProof) {
        bytes32 tag = keccak256(bytes(domainTag));
        bytes32 proofDigest = keccak256(abi.encode(DEPLOY_TYPEHASH, tag, block.chainid, msg.sender));
        if (!MLDSA87.verify(MLDSA87.accountKey(msg.sender), deployerProof, abi.encodePacked(proofDigest))) {
            revert PQGuard.PQCSignatureInvalid();
        }
        if (nativeChainId_.length == 0 || nativeChainId_.length > MAX_CHAIN_ID_LENGTH) revert BadChainId();
        QoreXMessage.checkChainId(nativeChainId_); // character set check
        _domainTag = tag;
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
            lastPauseStart = uint64(block.timestamp);
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
        adminProposalId = adminProposalId + 1;
        if (newAdmin == address(0)) emit AdminTransferCancelled(admin);
        else emit AdminTransferStarted(admin, newAdmin);
    }

    /// @notice Step 2 of 2: the proposed admin accepts with its own ML-DSA signature, which proves
    ///         it controls the key before it gets any power.
    function acceptAdmin(uint256 deadline, bytes calldata newAdminSig) external validDeadline(deadline) {
        address p = pendingAdmin;
        if (p == address(0)) revert NotPendingAdmin();
        _useUserSig(p, ACTION_ACCEPT_ADMIN, acceptAdminDigest(p, adminProposalId, nonces[p], deadline), newAdminSig);
        emit AdminTransferred(admin, p);
        admin = p;
        pendingAdmin = address(0);
    }

    // ---------------------------------------------------------------------- views

    /// @notice True when the post-quantum precompiles respond. Never reverts, so a frontend can
    ///         show a clear message; every signed action fails closed when this is false.
    function isPQAvailable() external view returns (bool) {
        return MLDSA87.available();
    }

    /// @notice True while a pause is in force (a pause older than MAX_PAUSE has expired).
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

    /// @notice What the deployer (and, for the registry, the referee) signs at deployment.
    ///         Computable before deployment: it does not depend on the contract address.
    function deployDigest(string calldata domainTag, address deployer) external view returns (bytes32) {
        return keccak256(abi.encode(DEPLOY_TYPEHASH, keccak256(bytes(domainTag)), block.chainid, deployer));
    }

    function setPausedDigest(bool paused_, uint256 nonce, uint256 deadline) public view returns (bytes32) {
        return _digest(abi.encode(SET_PAUSED_TYPEHASH, paused_, nonce, deadline));
    }

    function transferAdminDigest(address newAdmin, uint256 nonce, uint256 deadline) public view returns (bytes32) {
        return _digest(abi.encode(TRANSFER_ADMIN_TYPEHASH, newAdmin, nonce, deadline));
    }

    function acceptAdminDigest(address newAdmin, uint256 proposalId, uint256 nonce, uint256 deadline) public view returns (bytes32) {
        return _digest(abi.encode(ACCEPT_ADMIN_TYPEHASH, newAdmin, proposalId, nonce, deadline));
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

// src/v4/RobotRegistryV4.sol

/// @title RobotRegistryV4
/// @notice Public record of RedZone robots, attack sessions and safety ratings.
///
///   v4 = v3 plus two player features (everything else is unchanged from the audited v3):
///   - Play pass: one ML-DSA signature lets a named relayer start up to `maxRounds` rounds for the
///     player during the next PASS_TTL (10 minutes), so the wallet is not asked for every round.
///   - Paid tries: after the free MAX_ATTEMPTS_PER_DAY, a player can use tries bought with
///     buyTries. The payment goes straight to the treasury in the same transaction.
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
contract RobotRegistryV4 is PQAccess {
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

    bytes32 internal constant RESULT_TYPEHASH =
        keccak256("RedZone.Result(uint256 sessionId,uint256 robotId,address player,bool breached,bytes32 replayHash,uint256 deadline)");
    bytes32 internal constant UTILITY_TYPEHASH =
        keccak256("RedZone.Utility(uint256 robotId,uint8 tasksPassed,bytes32 replayHash,uint256 nonce,uint256 deadline)");
    bytes32 internal constant UPDATE_BRAIN_TYPEHASH = keccak256("RedZone.UpdateBrain(uint256 robotId,bytes32 brainHash,uint256 nonce,uint256 deadline)");
    bytes32 internal constant START_SESSION_TYPEHASH = keccak256("RedZone.StartSession(uint256 robotId,address player,uint256 nonce,uint256 deadline)");
    bytes32 internal constant REGISTER_ROBOT_TYPEHASH =
        keccak256("RedZone.RegisterRobot(address owner,bytes32 nameHash,bytes32 brainHash,uint256 nonce,uint256 deadline)");
    bytes32 internal constant CANCEL_REFEREE_TYPEHASH = keccak256("RedZone.CancelReferee(bytes32 pubkeyHash,uint256 nonce,uint256 deadline)");
    bytes32 internal constant PROPOSE_REFEREE_TYPEHASH = keccak256("RedZone.ProposeReferee(bytes32 pubkeyHash,uint256 nonce,uint256 deadline)");

    /// @notice A play pass lasts at most this long.
    uint256 public constant PASS_TTL = 10 minutes;
    /// @notice Most rounds one play pass can start.
    uint256 public constant MAX_PASS_ROUNDS = 20;
    /// @notice Highest price per paid try the admin can set (sanity bound).
    uint256 internal constant MAX_TRY_PRICE = 10 ether;
    /// @notice Most tries bought in one call.
    uint256 internal constant MAX_TRIES_PER_PURCHASE = 1000;
    bytes32 internal constant OPEN_PASS_TYPEHASH = keccak256(
        "RedZone.OpenPass(address player,address operator,uint256 validUntil,uint256 maxRounds,uint256 nonce,uint256 deadline)"
    );
    bytes32 internal constant SET_TRY_PRICE_TYPEHASH = keccak256("RedZone.SetTryPrice(uint256 price,address treasury,uint256 nonce,uint256 deadline)");

    string internal constant ACTION_START_SESSION = "StartSession";
    string internal constant ACTION_OPEN_PASS = "OpenPass";
    string internal constant ACTION_REGISTER_ROBOT = "RegisterRobot";
    string internal constant ACTION_UPDATE_BRAIN = "UpdateBrain";

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

    /// @notice A play pass: `operator` may start up to `roundsLeft` rounds for the player until `validUntil`.
    struct Pass {
        address operator;
        uint64 validUntil;
        uint32 roundsLeft;
    }

    mapping(address => Pass) public passes;
    /// @notice Paid tries a player has left (used only after the free daily tries; they don't expire).
    mapping(address => uint256) public extraTries;
    /// @notice Price of one paid try, in wei (0 = paid tries switched off).
    uint256 public tryPrice;
    /// @notice Where paid-try payments go.
    address public treasury;

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
    event PassOpened(address indexed player, address indexed operator, uint256 validUntil, uint256 maxRounds);
    event TriesBought(address indexed player, address indexed payer, uint256 count, uint256 paid);
    event ExtraTryUsed(address indexed player, uint256 left);
    event TryPriceSet(uint256 price, address indexed treasury);

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
    error BadPass();
    error NotPassOperator();
    error PassExpired();
    error PassUsedUp();
    error TriesNotForSale();
    error BadTryCount();
    error WrongPayment(uint256 expected, uint256 sent);
    error BadTryPrice();
    error PaymentFailed();

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

    /// @param deployerProof Deployer's ML-DSA-87 signature over deployDigest("RedZone.RobotRegistry.v4", deployer).
    /// @param refereeProof  Referee key's ML-DSA-87 signature over the same digest, proving the
    ///                      referee key works with the live precompile before any game starts.
    constructor(
        bytes memory refereePubkey_,
        bytes memory nativeChainId_,
        bytes memory deployerProof,
        bytes memory refereeProof,
        uint256 tryPrice_,
        address treasury_
    ) PQAccess("RedZone.RobotRegistry.v4", nativeChainId_, deployerProof) {
        _setTryPrice(tryPrice_, treasury_);
        if (refereePubkey_.length == 0) revert EmptyPubkey();
        MLDSA87.checkPubkey(refereePubkey_);
        bytes32 proofDigest = keccak256(abi.encode(DEPLOY_TYPEHASH, keccak256("RedZone.RobotRegistry.v4"), block.chainid, msg.sender));
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
        onlyAdmin(_proposeRefereeDigest(keccak256(newPubkey), nonces[admin], deadline), adminSig)
    {
        // The admin signature (checked above) consumed nonce n; the new key signs the same digest.
        _setPendingReferee(newPubkey, _proposeRefereeDigest(keccak256(newPubkey), nonces[admin] - 1, deadline), newRefereeSig);
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

    // ------------------------------------------------------------------ play pass

    /// @notice Open a play pass for `player`, authorised by the player's ML-DSA signature (QoreX).
    ///         Until `validUntil` (at most PASS_TTL ahead), `operator` may start up to `maxRounds`
    ///         rounds for the player with startSessionWithPass, with no further signature.
    ///         A new pass replaces the old one.
    /// @dev Trust note: during the pass, the operator (the RedZone relayer) is identified by
    ///      msg.sender. The worst a stolen operator ECDSA key can do is start up to `maxRounds` of
    ///      this player's rounds within those minutes; it can never move funds, record results or
    ///      act after the pass ends. Every round still has a single player, who alone can win it.
    function openPassFor(address player, address operator, uint256 validUntil, uint256 maxRounds, uint256 deadline, bytes calldata playerSig)
        external
        whenNotPaused
        validDeadline(deadline)
    {
        if (operator == address(0) || validUntil <= block.timestamp || validUntil > block.timestamp + PASS_TTL) revert BadPass();
        if (maxRounds == 0 || maxRounds > MAX_PASS_ROUNDS) revert BadPass();
        _useUserSig(player, ACTION_OPEN_PASS, _passDigestFor(player, operator, validUntil, maxRounds, deadline), playerSig);
        passes[player] = Pass({operator: operator, validUntil: uint64(validUntil), roundsLeft: uint32(maxRounds)});
        emit PassOpened(player, operator, validUntil, maxRounds);
    }

    /// @dev Split out to keep openPassFor's stack small.
    function _passDigestFor(address player, address operator, uint256 validUntil, uint256 maxRounds, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        return openPassDigest(player, operator, validUntil, maxRounds, nonces[player], deadline);
    }

    /// @notice Start a round for `player` under their play pass. Only the pass's operator.
    function startSessionWithPass(uint256 robotId, address player) external whenNotPaused returns (uint256 sessionId) {
        Pass storage p = passes[player];
        if (msg.sender != p.operator) revert NotPassOperator();
        if (block.timestamp > p.validUntil) revert PassExpired();
        uint32 left = p.roundsLeft;
        if (left == 0) revert PassUsedUp();
        p.roundsLeft = left - 1;
        return _startSession(robotId, player);
    }

    // ------------------------------------------------------------------ paid tries

    /// @notice Buy `count` extra tries for `player` at tryPrice each. Anyone may pay (the relayer
    ///         pays for QoreX users, who can't call contracts yet). The payment is forwarded to
    ///         the treasury in the same transaction; nothing is kept here.
    function buyTries(address player, uint256 count) external payable whenNotPaused {
        if (player == address(0)) revert ZeroAddress();
        uint256 price = tryPrice;
        if (price == 0) revert TriesNotForSale();
        if (count == 0 || count > MAX_TRIES_PER_PURCHASE) revert BadTryCount();
        uint256 cost = price * count;
        if (msg.value != cost) revert WrongPayment(cost, msg.value);
        extraTries[player] += count;
        emit TriesBought(player, msg.sender, count, cost);
        (bool ok,) = treasury.call{value: cost}("");
        if (!ok) revert PaymentFailed();
    }

    /// @notice Set the price of a paid try and the treasury. Admin only (ML-DSA signature).
    ///         Buyers send the exact price, so a change can never make anyone pay more than they meant to.
    function setTryPrice(uint256 price, address treasury_, uint256 deadline, bytes calldata adminSig)
        external
        validDeadline(deadline)
        onlyAdmin(_setTryPriceDigest(price, treasury_, nonces[admin], deadline), adminSig)
    {
        _setTryPrice(price, treasury_);
    }

    function _setTryPrice(uint256 price, address treasury_) internal {
        if (price > MAX_TRY_PRICE) revert BadTryPrice();
        if (price != 0 && treasury_ == address(0)) revert ZeroAddress();
        tryPrice = price;
        treasury = treasury_;
        emit TryPriceSet(price, treasury_);
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
        if (block.timestamp > _resultDeadline(sessionId)) revert ResultTooLate();

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
    function _sessionExpiresAt(uint256 sessionId) internal view returns (uint256) {
        Session storage s = _sessions[sessionId];
        if (s.player == address(0)) revert UnknownSession();
        return uint256(s.startedAt) + SESSION_TTL;
    }

    /// @notice Last second (inclusive) the referee's verdict can be recorded (expiry + RESULT_GRACE).
    function _resultDeadline(uint256 sessionId) internal view returns (uint256) {
        return _sessionExpiresAt(sessionId) + RESULT_GRACE;
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

    /// @notice Rounds the player can still start: free tries left today plus paid tries.
    function attemptsLeftToday(address player) external view returns (uint256) {
        return _freeAttemptsLeftToday(player) + extraTries[player];
    }

    function _freeAttemptsLeftToday(address player) internal view returns (uint256) {
        uint256 used = attemptsOnDay[player][block.timestamp / 1 days];
        return used >= MAX_ATTEMPTS_PER_DAY ? 0 : MAX_ATTEMPTS_PER_DAY - used;
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

    function _proposeRefereeDigest(bytes32 pubkeyHash, uint256 nonce, uint256 deadline) internal view returns (bytes32) {
        return _digest(abi.encode(PROPOSE_REFEREE_TYPEHASH, pubkeyHash, nonce, deadline));
    }

    function openPassDigest(address player, address operator, uint256 validUntil, uint256 maxRounds, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _digest(abi.encode(OPEN_PASS_TYPEHASH, player, operator, validUntil, maxRounds, nonce, deadline));
    }

    function _setTryPriceDigest(uint256 price, address treasury_, uint256 nonce, uint256 deadline) internal view returns (bytes32) {
        return _digest(abi.encode(SET_TRY_PRICE_TYPEHASH, price, treasury_, nonce, deadline));
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
        if (used < MAX_ATTEMPTS_PER_DAY) {
            attemptsOnDay[player][day] = used + 1;
        } else {
            // Free tries used up: spend a paid try.
            uint256 extra = extraTries[player];
            if (extra == 0) revert DailyLimitReached();
            extraTries[player] = extra - 1;
            emit ExtraTryUsed(player, extra - 1);
        }

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
        emit SessionStarted(sessionId, robotId, player, _sessionExpiresAt(sessionId));
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

// src/v4/EscrowVaultV3.sol

/// @title EscrowVaultV3
/// @notice Holds RedZone bounties in native QOR.
///
/// Who wins a bounty: the EARLIEST eligible breach. The registry keeps every robot's breaches in
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
contract EscrowVaultV3 is PQAccess, ReentrancyGuard {
    enum Status {
        None,
        Open,
        Claimed,
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
        uint256 amount; // full uint256: no down-casting of msg.value anywhere
        uint256 breachCursor; // index into the registry's breach list for this robot
        // Packed: owner, depositedAt and status share one slot; the withdrawal fields share another
        // that stays zero until requestWithdraw, so a deposit writes 4 slots instead of 5.
        address owner; // robot owner at deposit time (robots cannot change owner)
        uint64 depositedAt;
        Status status;
        uint64 withdrawRequestedAt; // 0 = no withdrawal requested
        address withdrawTo;
    }

    // ------------------------------------------------------------------ constants

    /// @notice Smallest bounty (1 QOR). Keeps dust bounties from making claims expensive.
    uint256 public constant MIN_BOUNTY = 1 ether;
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

    // --------------------------------------------------------------------- events

    event BountyDeposited(uint256 indexed bountyId, uint256 indexed robotId, address indexed owner, address funder, uint256 amount);
    event BountyClaimed(uint256 indexed bountyId, uint256 indexed sessionId, address indexed player, bytes32 replayHash, uint256 amount);
    event BreachSkipped(uint256 indexed bountyId, uint256 indexed sessionId);
    event WithdrawRequested(uint256 indexed bountyId, address indexed to, uint256 unlocksAt);
    event BountyWithdrawn(uint256 indexed bountyId, address indexed to, uint256 amount);

    // --------------------------------------------------------------------- errors

    error AmountTooSmall();
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

    /// @param deployerProof Deployer's ML-DSA-87 signature over deployDigest("RedZone.EscrowVault.v3", deployer).
    constructor(RobotRegistryV4 registry_, bytes memory nativeChainId_, bytes memory deployerProof)
        PQAccess("RedZone.EscrowVault.v3", nativeChainId_, deployerProof)
    {
        if (address(registry_) == address(0)) revert ZeroAddress();
        if (START_GRACE < registry_.MAX_START_TTL()) revert BadDelays();
        if (WITHDRAW_DELAY < START_GRACE + registry_.SESSION_TTL() + registry_.RESULT_GRACE() + MIN_CLAIM_WINDOW) revert BadDelays();
        if (CLAIM_WINDOW < MIN_CLAIM_WINDOW) revert BadDelays();
        registry = registry_;
    }

    // ------------------------------------------------------------------- deposits

    /// @notice Lock native QOR as a bounty on a registered robot. The robot's owner owns the
    ///         bounty, whoever sends the QOR. Only breaches recorded after this deposit can win it.
    function depositBounty(uint256 robotId) external payable whenNotPaused nonReentrant returns (uint256 bountyId) {
        if (msg.value < MIN_BOUNTY) revert AmountTooSmall();
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
        totalLocked += msg.value;
        emit BountyDeposited(bountyId, robotId, owner, msg.sender, msg.value);
    }

    // --------------------------------------------------------------------- claims

    /// @notice Pay the bounty to the earliest eligible breach (the one at the cursor). Anyone may
    ///         call; the payee is always that session's player.
    /// @dev Effects happen before the single value transfer, under ReentrancyGuard.
    function claimBounty(uint256 bountyId) external nonReentrant {
        Bounty storage b = bounties[bountyId];
        if (b.status != Status.Open) revert BountyNotOpen();
        (Next state, uint256 sessionId, RobotRegistryV4.Session memory s) = _next(b);
        if (state != Next.Claimable) revert NothingToClaim(state);

        uint256 amount = b.amount;
        b.status = Status.Claimed;
        b.amount = 0;
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
        (Next state, uint256 sessionId,) = _next(b);
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
        (state, sessionId,) = _next(b);
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
        (Next state,,) = _next(b);
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
    function _next(Bounty storage b) internal view returns (Next, uint256 sessionId, RobotRegistryV4.Session memory s) {
        uint256 robotId = b.robotId;
        uint256 cursor = b.breachCursor;
        if (cursor >= registry.breachCount(robotId)) return (Next.None, 0, s);
        sessionId = registry.breachAt(robotId, cursor);
        s = registry.getSession(sessionId);
        if (s.startedAt < b.depositedAt) return (Next.Skippable, sessionId, s);
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

