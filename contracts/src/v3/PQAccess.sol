// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PQGuard} from "../PQGuard.sol";
import {QoreXMessage} from "../QoreXMessage.sol";
import {MLDSA87} from "./MLDSA87.sol";

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
