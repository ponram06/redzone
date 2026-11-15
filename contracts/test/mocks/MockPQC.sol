// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test stand-in for QoreChain's IQorePQC precompiles. The same bytecode is etched at
///         0x0A01 (pqcVerify) and 0x0A02 (pqcKeyStatus); each address only uses its own function.
/// @dev Fake scheme for tests: a "signature" is valid iff sig == keccak256(abi.encode(pubkey, message)).
///      Key registry lives in the 0x0A02 copy's storage.
contract MockPQC {
    mapping(address => bytes) internal keys;

    function setKey(address account, bytes calldata pubkey) external {
        keys[account] = pubkey;
    }

    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external
        pure
        returns (bool)
    {
        return keccak256(signature) == keccak256(abi.encodePacked(sign(pubkey, message)));
    }

    function pqcKeyStatus(address account) external view returns (bool registered, uint8 algorithmId, bytes memory pubkey) {
        pubkey = keys[account];
        registered = pubkey.length != 0;
        algorithmId = registered ? 1 : 0;
    }

    function sign(bytes calldata pubkey, bytes calldata message) public pure returns (bytes32) {
        return keccak256(abi.encode(pubkey, message));
    }
}
