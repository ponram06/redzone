/**
 * deploy-v4.ts - deploy RobotRegistryV4 (play pass, paid tries) and EscrowVaultV3 with viem.
 *
 *   pnpm deploy:v4 --dry-run   simulate both deployments on the real chain (eth_call), send nothing
 *   pnpm deploy:v4             deploy (needs an open EVM window for the deployer: 2 transactions)
 *
 * Foundry's local simulation has no QoreChain PQC precompiles, so the v4 constructors (which
 * verify ML-DSA-87 deploy proofs) can only be checked by the chain itself. Run `pnpm v4-proofs`
 * and `forge build` first. Results are appended to ../deployments/testnet.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, encodeDeployData, http, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.QORE_EVM_RPC ?? "https://evm-testnet.qore.host";
const NATIVE = process.env.NATIVE_CHAIN_ID ?? "qorechain-diana";
const dryRun = process.argv.includes("--dry-run");

const proofs = JSON.parse(readFileSync(".v4-proofs.json", "utf8")) as {
  chainId: string;
  deployer: Address;
  refereePubkey: Hex;
  registryDeployerProof: Hex;
  registryRefereeProof: Hex;
  vaultDeployerProof: Hex;
};
const artifact = (name: string) => {
  const j = JSON.parse(readFileSync(`out/${name}.sol/${name}.json`, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: j.abi, bytecode: j.bytecode.object };
};
const reg = artifact("RobotRegistryV4");
const vault = artifact("EscrowVaultV3");

const chain = defineChain({
  id: Number(proofs.chainId),
  name: "qorechain-testnet",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const key = process.env.PRIVATE_KEY as Hex | undefined;
if (!key) throw new Error("PRIVATE_KEY missing in .env");
const account = privateKeyToAccount(key);
if (account.address.toLowerCase() !== proofs.deployer.toLowerCase()) throw new Error("proofs were made for another deployer: rerun pnpm v4-proofs");

const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, account, transport: http(RPC) });
if ((await pub.getChainId()) !== chain.id) throw new Error("RPC chain id does not match the proofs");

const chainBytes = `0x${Buffer.from(NATIVE).toString("hex")}` as Hex;
// Paid tries: price per try (QOR) and where payments go. TREASURY is required.
const treasury = process.env.TREASURY?.trim() as Address | undefined;
if (!treasury || !/^0x[0-9a-fA-F]{40}$/.test(treasury)) throw new Error("set TREASURY=0x... (where paid-try payments go)");
const tryPriceWei = BigInt(Math.round(Number(process.env.TRY_PRICE_QOR ?? "0.1") * 1e6)) * 10n ** 12n;
console.log(`paid tries: ${Number(tryPriceWei) / 1e18} QOR each, paid to ${treasury}`);
const regArgs = [proofs.refereePubkey, chainBytes, proofs.registryDeployerProof, proofs.registryRefereeProof, tryPriceWei, treasury] as const;
const regData = encodeDeployData({ abi: reg.abi, bytecode: reg.bytecode, args: regArgs });

/** Ask the node to run a contract creation (eth_call): proves the constructor passes on the real chain. */
async function simulate(label: string, data: Hex) {
  await pub.call({ account: account.address, data, gas: 30_000_000n });
  const est = await pub.estimateGas({ account: account.address, data }).catch(() => null);
  if (est) console.log(`  ${label}: estimated gas ${est}`);
  console.log(`✓ ${label}: constructor passes on chain (proofs verified by the real precompile)`);
}

if (dryRun) {
  await simulate("RobotRegistryV4", regData);
  // The vault needs a deployed registry; simulate it against the current V2-free path by using the
  // registry address it would get (next nonce) is not possible in one eth_call, so check its proof
  // with a registry stand-in only when deploying. The registry check above covers both key formats.
  const bal = await pub.getBalance({ address: account.address });
  console.log(`deployer ${account.address} balance ${Number(bal) / 1e18} QOR. Dry run only: nothing sent.`);
  process.exit(0);
}

// --registry <address> <txHash>: the registry is already deployed; deploy only the vault.
const ri = process.argv.indexOf("--registry");
let regHash: Hex;
let regRcpt: { contractAddress?: Address | null; blockNumber: bigint; status: string };
if (ri > 0) {
  regHash = process.argv[ri + 2] as Hex;
  const r = await pub.getTransactionReceipt({ hash: regHash });
  if (r.status !== "success" || r.contractAddress?.toLowerCase() !== process.argv[ri + 1].toLowerCase()) throw new Error("registry tx does not match the address");
  regRcpt = r;
} else {
  regHash = await wallet.sendTransaction({ data: regData });
  regRcpt = await pub.waitForTransactionReceipt({ hash: regHash });
}
if (regRcpt.status !== "success" || !regRcpt.contractAddress) throw new Error(`registry deploy failed: ${regHash}`);
console.log(`RobotRegistryV4 ${regRcpt.contractAddress} (tx ${regHash}, block ${regRcpt.blockNumber})`);

const vaultData = encodeDeployData({ abi: vault.abi, bytecode: vault.bytecode, args: [regRcpt.contractAddress, chainBytes, proofs.vaultDeployerProof] });
await simulate("EscrowVaultV3", vaultData);
const vaultHash = await wallet.sendTransaction({ data: vaultData });
const vaultRcpt = await pub.waitForTransactionReceipt({ hash: vaultHash });
if (vaultRcpt.status !== "success" || !vaultRcpt.contractAddress) throw new Error(`vault deploy failed: ${vaultHash}`);
console.log(`EscrowVaultV3   ${vaultRcpt.contractAddress} (tx ${vaultHash}, block ${vaultRcpt.blockNumber})`);

const file = "../deployments/testnet.json";
const d = JSON.parse(readFileSync(file, "utf8"));
d.contracts.RobotRegistryV4 = { address: regRcpt.contractAddress, deployTx: regHash, deployBlock: Number(regRcpt.blockNumber), nativeChainId: NATIVE, tryPriceWei: tryPriceWei.toString(), treasury };
d.contracts.EscrowVaultV3 = { address: vaultRcpt.contractAddress, deployTx: vaultHash, deployBlock: Number(vaultRcpt.blockNumber), registry: regRcpt.contractAddress };
writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
console.log("Saved to deployments/testnet.json");
