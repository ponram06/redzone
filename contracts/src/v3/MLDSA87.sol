// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PQGuard} from "../PQGuard.sol";

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
