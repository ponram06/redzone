/**
 * take-back-v3.ts - take the admin's unwon demo bounty back from the previous vault (EscrowVaultV3),
 * the same two-step way any maker does, so it can fund a prize pool in EscrowVaultV4.
 *
 *   npx tsx --env-file=.env scripts/take-back-v3.ts request    owner's ML-DSA-87 signature, sent by the relayer
 *   npx tsx --env-file=.env scripts/take-back-v3.ts finalize   after the 3-hour delay: pays the bounty back
 *
 * The admin's ML-DSA key signs the vault's own QoreX-format message (walletMessage), checked here
 * against the key registered on chain before any gas is spent. Keys are never printed.
 */
import { readFileSync } from "node:fs";
import { deriveUnifiedAccount, isValidRecoveryCode, pqcSign, pqcVerify, unifiedAccountFromSeed, type UnifiedAccount } from "@qorechain/sdk";
import { encodeFunctionData, hexToBytes, parseAbi, toHex, type Address } from "viem";
import { REGISTRY, VAULT, client, readPqcKey } from "../src/chain.js";
import { ChainRelayer } from "../src/relayer.js";

const d = JSON.parse(readFileSync(new URL("../../deployments/testnet.json", import.meta.url), "utf8")) as {
  deployer: { evm: string };
  contracts: { EscrowVaultV3: { address: Address } };
};
const OLD_VAULT = d.contracts.EscrowVaultV3.address;
const abi = parseAbi([
  "function nextBountyId() view returns (uint256)",
  "function bounties(uint256) view returns (uint256 robotId, uint256 amount, uint256 breachCursor, address owner, uint64 depositedAt, uint8 status, uint64 withdrawRequestedAt, address withdrawTo)",
  "function nonces(address) view returns (uint256)",
  "function withdrawDigest(uint256 bountyId, address to, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function walletMessage(string action, bytes32 digest) view returns (bytes)",
  "function requestWithdraw(uint256 bountyId, address to, uint256 deadline, bytes ownerSig)",
  "function finalizeWithdraw(uint256 bountyId)",
  "function WITHDRAW_DELAY() view returns (uint256)",
]);

function readEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

function adminAccount(): UnifiedAccount {
  const env = readEnv(new URL("../../contracts/.env", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  if (env.QORE_MNEMONIC?.trim()) return deriveUnifiedAccount(env.QORE_MNEMONIC.trim(), 0);
  const key = env.PRIVATE_KEY?.trim() ?? "";
  const code = env.QORE_PQC_RECOVERY_CODE?.trim() ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(key) || !isValidRecoveryCode(code)) throw new Error("admin key missing in contracts/.env");
  return unifiedAccountFromSeed(Uint8Array.from(Buffer.from(key.slice(2), "hex")), { recoveryCode: code });
}

const admin = adminAccount();
if (admin.evm.toLowerCase() !== d.deployer.evm.toLowerCase()) throw new Error("contracts/.env is not the admin account");
const owner = admin.evm as Address;
// Cover the server's targets too, so its relayer keeps working with the same window.
const relayer = ChainRelayer.fromEnv(process.env, [REGISTRY, VAULT, OLD_VAULT]);
if (!relayer) throw new Error("relayer keys missing in backend/.env");

// The admin's open bounties in the old vault.
const next = Number(await client.readContract({ address: OLD_VAULT, abi, functionName: "nextBountyId" }));
const mine: { id: number; amount: bigint; requestedAt: number }[] = [];
for (let i = 1; i < next; i++) {
  const b = await client.readContract({ address: OLD_VAULT, abi, functionName: "bounties", args: [BigInt(i)] });
  if (b[3].toLowerCase() === owner.toLowerCase() && b[5] === 1) mine.push({ id: i, amount: b[1], requestedAt: Number(b[6]) });
}
if (!mine.length) {
  console.log("No open bounties of the admin in the old vault.");
  process.exit(0);
}
const cmd = process.argv[2];
for (const b of mine) {
  if (cmd === "request") {
    const nonce = await client.readContract({ address: OLD_VAULT, abi, functionName: "nonces", args: [owner] });
    const deadline = (await client.getBlock()).timestamp + 600n;
    const digest = await client.readContract({ address: OLD_VAULT, abi, functionName: "withdrawDigest", args: [BigInt(b.id), owner, nonce, deadline] });
    const message = await client.readContract({ address: OLD_VAULT, abi, functionName: "walletMessage", args: ["WithdrawBounty", digest] });
    const sig = pqcSign(admin.pqc.secretKey, hexToBytes(message));
    const onChain = await readPqcKey(owner);
    if (!onChain.registered || !pqcVerify(hexToBytes(onChain.pubkey), hexToBytes(message), sig)) throw new Error("admin ML-DSA key does not match the chain");
    const r = await relayer.send(OLD_VAULT, encodeFunctionData({ abi, functionName: "requestWithdraw", args: [BigInt(b.id), owner, deadline, toHex(sig)] }));
    if (r.status !== "success") throw new Error(`requestWithdraw reverted (${r.hash})`);
    const delay = Number(await client.readContract({ address: OLD_VAULT, abi, functionName: "WITHDRAW_DELAY" }));
    console.log(`bounty #${b.id} (${Number(b.amount) / 1e18} QOR): take-back requested ${r.hash}; collect after ${new Date((Date.now() / 1000 + delay) * 1000).toISOString()}`);
  } else if (cmd === "finalize") {
    const r = await relayer.send(OLD_VAULT, encodeFunctionData({ abi, functionName: "finalizeWithdraw", args: [BigInt(b.id)] }));
    if (r.status !== "success") throw new Error(`finalizeWithdraw reverted (${r.hash}): too early, or a win is pending`);
    console.log(`bounty #${b.id}: ${Number(b.amount) / 1e18} QOR paid back to the admin: ${r.hash}`);
  } else {
    console.log(`bounty #${b.id}: ${Number(b.amount) / 1e18} QOR, take-back requested at ${b.requestedAt || "never"}. Use "request" or "finalize".`);
  }
}
