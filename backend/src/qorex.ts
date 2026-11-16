/**
 * QoreX wallet signatures, mirrored from contracts/src/QoreXMessage.sol.
 *
 * QoreX `signArbitrary` signs, with the account's ML-DSA-87 key:
 *     "qorechain-msg-v1|" + nativeChainId + "|" + data
 * (confirmed against a real wallet signature and the live pqcVerify precompile).
 */
import { pqcVerify } from "@qorechain/sdk";
import { bech32 } from "@scure/base";
import { bytesToHex, concat, getAddress, hexToBytes, stringToBytes, type Address, type Hex } from "viem";

export const NATIVE_CHAIN_ID = "qorechain-diana";
const DOMAIN = "qorechain-msg-v1|";

/** The text RedZone asks the wallet to sign for an on-chain action (same as walletText in the contract). */
export function walletText(action: string, digest: Hex): string {
  return `RedZone authorisation\naction: ${action}\ndigest: ${digest.toLowerCase()}`;
}

/** The exact bytes the wallet's ML-DSA key signs for `data`. */
export function walletMessage(data: string, chainId = NATIVE_CHAIN_ID): Uint8Array {
  return concat([stringToBytes(`${DOMAIN}${chainId}|`), stringToBytes(data)]);
}

/** Accept the ML-DSA part of a QoreX signature as base64 (what the wallet returns) or 0x-hex. */
export function decodePqSignature(sig: unknown): Hex | null {
  if (typeof sig !== "string" || sig.length < 100 || sig.length > 20_000) return null;
  if (/^0x[0-9a-fA-F]+$/.test(sig)) return sig as Hex;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(sig)) return null;
  return bytesToHex(Uint8Array.from(Buffer.from(sig, "base64")));
}

export function verifyWalletSignature(pubkey: Hex, data: string, signature: Hex): boolean {
  try {
    return pqcVerify(hexToBytes(pubkey), walletMessage(data), hexToBytes(signature));
  } catch {
    return false;
  }
}

/** qor1… → 0x… (same 20 bytes); 0x… is checksummed. Null when neither form is valid. */
export function toEvmAddress(account: unknown): Address | null {
  if (typeof account !== "string") return null;
  try {
    if (/^0x[0-9a-fA-F]{40}$/.test(account)) return getAddress(account);
    const { prefix, words } = bech32.decode(account as `${string}1${string}`);
    if (prefix !== "qor") return null;
    const bytes = Uint8Array.from(bech32.fromWords(words));
    return bytes.length === 20 ? getAddress(bytesToHex(bytes)) : null;
  } catch {
    return null;
  }
}
