// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test stand-in for QoreChain's PQC precompiles with real ML-DSA-87 sizes, for the v3
///         contracts. Etched at 0x0A01 (pqcVerify) and 0x0A02 (pqcKeyStatus).
/// @dev Fake scheme: a signature is 4627 bytes whose first 32 bytes equal
///      keccak256(abi.encode(pubkey, message)); the rest is padding. Keys are registered with an
///      algorithm id (1 = ML-DSA-87, as on qorechain-diana).
contract MockPQC87 {
    mapping(address => bytes) internal keys;
    mapping(address => uint8) internal algs;

    function setKey(address account, bytes calldata pubkey) external {
        keys[account] = pubkey;
        algs[account] = 1;
    }

    function setKeyWithAlgorithm(address account, bytes calldata pubkey, uint8 algorithmId) external {
        keys[account] = pubkey;
        algs[account] = algorithmId;
    }

    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message) external pure returns (bool) {
        if (signature.length < 32) return false;
        return bytes32(signature[:32]) == keccak256(abi.encode(pubkey, message));
    }

    function pqcKeyStatus(address account) external view returns (bool registered, uint8 algorithmId, bytes memory pubkey) {
        pubkey = keys[account];
        registered = pubkey.length != 0;
        algorithmId = registered ? algs[account] : 0;
    }
}
