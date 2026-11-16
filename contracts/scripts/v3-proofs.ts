/**
 * v3-proofs.ts - make the deploy-time ML-DSA-87 proofs the v3 constructors check.
 *
 *   pnpm v3-proofs
 *
 * Signs deployDigest(domainTag, deployer) = keccak256(abi.encode(DEPLOY_TYPEHASH,
 * keccak256(domainTag), chainId, deployer)) with:
 *   - the deployer's ML-DSA-87 key (same account loading as window.ts), for the registry and the vault
 *   - the referee key (.referee-key.json), for the registry
 * and writes them to .v3-proofs.json for script/DeployV3.s.sol. Signatures are public data; no
 * secret is printed or written.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  deriveUnifiedAccount,
  isValidRecoveryCode,
  pqcSign,
  pqcVerify,
  unifiedAccountFromSeed,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { encodeAbiParameters, hexToBytes, keccak256, stringToBytes, toHex, type Address, type Hex } from "viem";

const CHAIN_ID = BigInt(process.env.EVM_CHAIN_ID ?? "9800");
const DEPLOY_TYPEHASH = keccak256(stringToBytes("RedZone.Deploy(bytes32 domainTag,uint256 chainId,address deployer)"));

function account(): UnifiedAccount {
  const mnemonic = process.env.QORE_MNEMONIC?.trim();
  if (mnemonic) return deriveUnifiedAccount(mnemonic, 0);
  const key = process.env.PRIVATE_KEY?.trim();
  const code = process.env.QORE_PQC_RECOVERY_CODE?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("Set QORE_MNEMONIC or PRIVATE_KEY in .env");
  if (!code || !isValidRecoveryCode(code)) throw new Error("Set a valid QORE_PQC_RECOVERY_CODE in .env");
  return unifiedAccountFromSeed(Uint8Array.from(Buffer.from(key.slice(2), "hex")), { recoveryCode: code });
}

function deployDigest(tag: string, deployer: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [DEPLOY_TYPEHASH, keccak256(stringToBytes(tag)), CHAIN_ID, deployer],
    ),
  );
}

function signChecked(secret: Uint8Array, pub: Uint8Array, digest: Hex, who: string): Hex {
  const msg = hexToBytes(digest);
  const sig = pqcSign(secret, msg);
  if (!pqcVerify(pub, msg, sig)) throw new Error(`${who} signature failed its own check`);
  if (pub.length !== 2592 || sig.length !== 4627) throw new Error(`${who}: unexpected sizes pubkey ${pub.length} sig ${sig.length}`);
  return toHex(sig);
}

const acc = account();
const deployer = acc.evm as Address;
const ref = JSON.parse(readFileSync(".referee-key.json", "utf8")) as { algorithm?: string; publicKey: Hex; secretKey: Hex };
if (ref.algorithm && ref.algorithm !== "ML-DSA-87") throw new Error(`referee key is ${ref.algorithm}`);

const regDigest = deployDigest("RedZone.RobotRegistry.v3", deployer);
const vaultDigest = deployDigest("RedZone.EscrowVault.v2", deployer);
const out = {
  chainId: CHAIN_ID.toString(),
  deployer,
  refereePubkey: ref.publicKey,
  registryDeployerProof: signChecked(acc.pqc.secretKey, acc.pqc.publicKey, regDigest, "deployer"),
  registryRefereeProof: signChecked(hexToBytes(ref.secretKey), hexToBytes(ref.publicKey), regDigest, "referee"),
  vaultDeployerProof: signChecked(acc.pqc.secretKey, acc.pqc.publicKey, vaultDigest, "deployer"),
};
writeFileSync(".v3-proofs.json", JSON.stringify(out, null, 2) + "\n");
console.log(`deployer ${deployer}, chain ${CHAIN_ID}: proofs written to .v3-proofs.json (signatures 4627 bytes, keys 2592 bytes)`);
