/**
 * take-back-v4.ts - take the admin's prize pools back from EscrowVaultV4 through the live server, the
 * same two-step way the Build a robot page does, so the money can be locked again in EscrowVaultV5.
 *
 *   npx tsx scripts/take-back-v4.ts list                     the admin's open pools and their state
 *   npx tsx scripts/take-back-v4.ts request  [server-url]    sign each take-back with the admin's ML-DSA key
 *   npx tsx scripts/take-back-v4.ts finalize [server-url]    after the 3-hour delay: pay each pool back
 *
 * Everything goes through the server's endpoints, so its relayer is the only one sending
 * transactions (two relayers on one key would race for nonces). Keys are never printed.
 */
import { readFileSync } from "node:fs";
import { deriveUnifiedAccount, isValidRecoveryCode, pqcSign, unifiedAccountFromSeed, type UnifiedAccount } from "@qorechain/sdk";
import { toHex } from "viem";
import { walletMessage } from "../src/qorex.js";

const cmd = process.argv[2] ?? "list";
const SERVER = (process.argv[3] ?? "https://redzone.malaysiawest.cloudapp.azure.com").replace(/\/$/, "");

function readEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

async function adminAccount(): Promise<UnifiedAccount> {
  const env = readEnv(new URL("../../contracts/.env", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  if (env.QORE_MNEMONIC?.trim()) return deriveUnifiedAccount(env.QORE_MNEMONIC.trim(), 0);
  const key = env.PRIVATE_KEY?.trim() ?? "";
  const code = env.QORE_PQC_RECOVERY_CODE?.trim() ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(key) || !isValidRecoveryCode(code)) throw new Error("admin key missing in contracts/.env");
  return unifiedAccountFromSeed(Uint8Array.from(Buffer.from(key.slice(2), "hex")), { recoveryCode: code });
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SERVER}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`${path}: ${j.error ?? res.status}`);
  return j;
}

type Pool = { id: number; amountWei: string; withdrawRequestedAt?: number };
const admin = await adminAccount();
const owner = admin.evm.toLowerCase();
const { robots } = await call<{ robots: { id: number; name: string; owner: string; bounty: { open: Pool[] } }[] }>("/robots");
const pools = robots.filter((r) => r.owner.toLowerCase() === owner).flatMap((r) => r.bounty.open.map((b) => ({ ...b, robot: `${r.name} (#${r.id})` })));
if (!pools.length) {
  console.log("The admin has no open pools in the vault.");
  process.exit(0);
}

for (const b of pools) {
  const qor = Number(BigInt(b.amountWei) / 10n ** 12n) / 1e6;
  if (cmd === "request") {
    if (b.withdrawRequestedAt) {
      console.log(`pool #${b.id} ${b.robot}: already requested`);
      continue;
    }
    const req = await call<{ text: string; deadline: number }>(`/owner/bounty/back/request?bountyId=${b.id}&owner=${admin.evm}`);
    const pqSignature = toHex(pqcSign(admin.pqc.secretKey, walletMessage(req.text)));
    const r = await call<{ tx: string; unlocksAt: number }>("/owner/bounty/back", { bountyId: b.id, owner: admin.evm, deadline: req.deadline, pqSignature });
    console.log(`pool #${b.id} ${b.robot}, ${qor} QOR: take-back requested (${r.tx}); collect after ${new Date(r.unlocksAt * 1000).toISOString()}`);
  } else if (cmd === "finalize") {
    const r = await call<{ tx: string; uqor: string }>("/owner/bounty/back/finish", { bountyId: b.id });
    console.log(`pool #${b.id} ${b.robot}: ${Number(r.uqor) / 1e6} QOR paid back to the admin (${r.tx})`);
  } else {
    const at = b.withdrawRequestedAt ? new Date(b.withdrawRequestedAt * 1000).toISOString() : "not requested";
    console.log(`pool #${b.id} ${b.robot}: ${qor} QOR, take-back ${at}`);
  }
}
