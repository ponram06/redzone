// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PQGuard} from "./PQGuard.sol";

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
