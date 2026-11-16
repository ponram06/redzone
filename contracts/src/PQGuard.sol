// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

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
