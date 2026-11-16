// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

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
