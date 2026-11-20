/**
 * deploy-vault-v5.ts - deploy EscrowVaultV5 (prize pools; a fixed robot can pay an earlier winner again) next to the live RobotRegistryV4.
 *
 *   npx tsx --env-file=.env scripts/deploy-vault-v5.ts --dry-run   sign the deploy proof and simulate on the real chain, send nothing
 *   npx tsx --env-file=.env scripts/deploy-vault-v5.ts           deploy (needs an open EVM window for the deployer: 1 transaction)
 *
 * The constructor verifies the deployer's ML-DSA-87 signature over
 * deployDigest("RedZone.EscrowVault.v5", deployer) with the real precompile, so the proof is made
 * here from the deployer's key (same account loading as window.ts). No secret is printed.
 * The result is saved to ../deployments/testnet.json as EscrowVaultV5.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { deriveUnifiedAccount, isValidRecoveryCode, pqcSign, pqcVerify, unifiedAccountFromSeed, type UnifiedAccount } from "@qorechain/sdk";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  encodeDeployData,
  hexToBytes,
  http,
  keccak256,
  stringToBytes,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.QORE_EVM_RPC ?? "https://evm-testnet.qore.host";
const NATIVE = process.env.NATIVE_CHAIN_ID ?? "qorechain-diana";
const CHAIN_ID = Number(process.env.EVM_CHAIN_ID ?? "9800");
const TAG = "RedZone.EscrowVault.v5";
const dryRun = process.argv.includes("--dry-run");

// deriveUnifiedAccount is async since @qorechain/sdk 0.14.
async function pqAccount(): Promise<UnifiedAccount> {
  const mnemonic = process.env.QORE_MNEMONIC?.trim();
  if (mnemonic) return deriveUnifiedAccount(mnemonic, 0);
  const key = process.env.PRIVATE_KEY?.trim();
  const code = process.env.QORE_PQC_RECOVERY_CODE?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("Set QORE_MNEMONIC or PRIVATE_KEY in .env");
  if (!code || !isValidRecoveryCode(code)) throw new Error("Set a valid QORE_PQC_RECOVERY_CODE in .env");
  return unifiedAccountFromSeed(Uint8Array.from(Buffer.from(key.slice(2), "hex")), { recoveryCode: code });
}

const acc = await pqAccount();
const deployer = acc.evm as Address;
const key = process.env.PRIVATE_KEY as Hex | undefined;
if (!key) throw new Error("PRIVATE_KEY missing in .env");
const account = privateKeyToAccount(key);
if (account.address.toLowerCase() !== deployer.toLowerCase()) throw new Error("PRIVATE_KEY and the ML-DSA account are different accounts");

// Deploy proof: ML-DSA-87 over keccak256(abi.encode(DEPLOY_TYPEHASH, keccak256(tag), chainId, deployer)).
const DEPLOY_TYPEHASH = keccak256(stringToBytes("RedZone.Deploy(bytes32 domainTag,uint256 chainId,address deployer)"));
const digest = keccak256(
  encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
    [DEPLOY_TYPEHASH, keccak256(stringToBytes(TAG)), BigInt(CHAIN_ID), deployer],
  ),
);
const sig = pqcSign(acc.pqc.secretKey, hexToBytes(digest));
if (!pqcVerify(acc.pqc.publicKey, hexToBytes(digest), sig) || sig.length !== 4627) throw new Error("deploy proof failed its own check");
const proof = toHex(sig);

const file = "../deployments/testnet.json";
const d = JSON.parse(readFileSync(file, "utf8"));
const registry = d.contracts.RobotRegistryV4?.address as Address | undefined;
if (!registry) throw new Error("RobotRegistryV4 missing from deployments/testnet.json");

const j = JSON.parse(readFileSync("out/EscrowVaultV5.sol/EscrowVaultV5.json", "utf8")) as { abi: Abi; bytecode: { object: Hex } };
const chainBytes = `0x${Buffer.from(NATIVE).toString("hex")}` as Hex;
const data = encodeDeployData({ abi: j.abi, bytecode: j.bytecode.object, args: [registry, chainBytes, proof] });

const chain = defineChain({
  id: CHAIN_ID,
  name: "qorechain-testnet",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC) });
if ((await pub.getChainId()) !== CHAIN_ID) throw new Error("RPC chain id mismatch");

await pub.call({ account: deployer, data, gas: 30_000_000n });
const est = await pub.estimateGas({ account: deployer, data });
const bal = await pub.getBalance({ address: deployer });
console.log(`✓ EscrowVaultV5 constructor passes on chain (deploy proof verified by the real precompile); gas ${est}`);
console.log(`  registry ${registry}, deployer ${deployer}, balance ${Number(bal) / 1e18} QOR`);
if (dryRun) {
  console.log("Dry run only: nothing sent.");
  process.exit(0);
}

const wallet = createWalletClient({ chain, account, transport: http(RPC) });
const hash = await wallet.sendTransaction({ data, gas: (est * 12n) / 10n });
const rcpt = await pub.waitForTransactionReceipt({ hash });
if (rcpt.status !== "success" || !rcpt.contractAddress) throw new Error(`vault deploy failed: ${hash}`);
console.log(`EscrowVaultV5 ${rcpt.contractAddress} (tx ${hash}, block ${rcpt.blockNumber})`);
d.contracts.EscrowVaultV5 = { address: rcpt.contractAddress, deployTx: hash, deployBlock: Number(rcpt.blockNumber), registry };
writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
console.log("Saved to deployments/testnet.json");
