/**
 * fund-pools.ts - add bounties to the demo robots (owned by the admin account), the same way a
 * maker does it on the "Build a robot" page:
 *
 *   1. a hybrid-signed native transfer from the admin to the relayer, with the terms in the memo
 *      ("RedZone bounty #<id> prize 1 open" = 1 QOR to every new winner; "RedZone bounty #<id>" = one big prize)
 *   2. POST /owner/bounty on the running server, which checks the payment and locks it in EscrowVaultV4
 *
 *   npx tsx --env-file=.env scripts/fund-pools.ts --plan "1:10:1:open,2:10:1:open,4:10:1:open,3:30"            (dry run)
 *   npx tsx --env-file=.env scripts/fund-pools.ts --plan "..." --go
 *
 * Plan entries are robotId:poolQor[:prizeQor[:open]]. No prize = the whole pool is one prize.
 * Keys come from ../contracts/.env (admin) and backend/.env (relayer) and are never printed.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { StargateClient } from "@cosmjs/stargate";
import { EthNativeSigner, deriveUnifiedAccount, getNetwork, isValidRecoveryCode, msg as qoreMsg, unifiedAccountFromSeed, type UnifiedAccount } from "@qorechain/sdk";
import { REST_URL, readRobots } from "../src/chain.js";
import { bountyMemo, parseBountyMemo } from "../src/game.js";
import { ChainRelayer } from "../src/relayer.js";
import { REGISTRY, VAULT } from "../src/chain.js";

const { values: opt } = parseArgs({ options: { plan: { type: "string" }, go: { type: "boolean", default: false }, server: { type: "string", default: "http://localhost:8787" } } });
const FEE = { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" };
const uqor = (q: string) => {
  if (!/^\d+(\.\d{1,6})?$/.test(q)) throw new Error(`bad amount: ${q}`);
  const [i, f = ""] = q.split(".");
  return BigInt(i!) * 1_000_000n + BigInt(f.padEnd(6, "0"));
};
const qor = (u: bigint) => `${u / 1_000_000n}.${(u % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "") || "0"}`.replace(/\.0$/, "");

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

const plan = (opt.plan ?? "").split(",").filter(Boolean).map((e) => {
  const [id, pool, prize, open] = e.split(":");
  return { robotId: Number(id), pool: uqor(pool!), memo: prize ? `${bountyMemo(Number(id))} prize ${prize}${open === "open" ? " open" : ""}` : bountyMemo(Number(id)) };
});
if (!plan.length) throw new Error("--plan is empty");

const admin = await adminAccount();
const relayer = ChainRelayer.fromEnv(process.env, [REGISTRY, VAULT]);
if (!relayer) throw new Error("relayer keys missing in backend/.env");
const robots = await readRobots();
const balance = async () => {
  const r = (await (await fetch(`${REST_URL}/cosmos/bank/v1beta1/balances/${admin.cosmos}/by_denom?denom=uqor`)).json()) as { balance?: { amount?: string } };
  return BigInt(r.balance?.amount ?? "0");
};
const have = await balance();
const need = plan.reduce((s, p) => s + p.pool + 100_000n, 0n);
console.log(`admin ${admin.evm} balance ${qor(have)} QOR; plan needs ${qor(need)} QOR (incl. fees)`);
for (const p of plan) {
  const r = robots.find((x) => x.id === p.robotId);
  if (!r) throw new Error(`robot #${p.robotId} not found`);
  if (r.owner.toLowerCase() !== admin.evm.toLowerCase()) throw new Error(`robot #${p.robotId} is not owned by the admin`);
  if (!parseBountyMemo(p.memo, p.robotId)) throw new Error(`bad memo ${p.memo}`);
  console.log(`  #${p.robotId} ${r.name}: ${qor(p.pool)} QOR, memo "${p.memo}"`);
}
if (need > have) throw new Error("not enough QOR");
if (!opt.go) process.exit(0);

const net = getNetwork("testnet");
for (const p of plan) {
  const acct = (await (await fetch(`${REST_URL}/cosmos/auth/v1beta1/accounts/${admin.cosmos}`)).json()) as { account?: Record<string, unknown> };
  const a = (acct.account?.base_account ?? acct.account ?? {}) as Record<string, string>;
  const transport = await StargateClient.connect(net.endpoints.rpc);
  let hash: string;
  try {
    const r = await new EthNativeSigner(admin, { signMode: "hybrid", rest: REST_URL }).signAndBroadcast(transport, {
      chainId: net.chainId,
      accountNumber: BigInt(a.account_number ?? "0"),
      sequence: BigInt(a.sequence ?? "0"),
      fee: FEE,
      memo: p.memo,
      messages: [qoreMsg.bank.send({ fromAddress: admin.cosmos, toAddress: relayer.cosmosAddress, amount: [{ denom: "uqor", amount: p.pool.toString() }] })],
    });
    if (r.code !== 0) throw new Error(`payment refused: code ${r.code} ${r.rawLog ?? ""}`);
    hash = r.transactionHash;
  } finally {
    transport.disconnect();
  }
  console.log(`#${p.robotId}: paid ${qor(p.pool)} QOR (${hash})`);
  // the server locks it; the chain index lags a few seconds, so retry
  for (let i = 0; ; i++) {
    await new Promise((ok) => setTimeout(ok, 4000));
    const res = await fetch(`${opt.server}/owner/bounty`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ robotId: p.robotId, owner: admin.evm, txHash: hash }),
    });
    const body = (await res.json()) as { depositTx?: string | null; bountyIds?: number[]; error?: string };
    if (res.ok) {
      console.log(`#${p.robotId}: locked, bounties ${body.bountyIds?.join(", ")} (deposit ${body.depositTx})`);
      break;
    }
    if (i >= 15 || res.status !== 404) throw new Error(`#${p.robotId}: ${res.status} ${body.error}`);
  }
}
console.log(`admin balance now ${qor(await balance())} QOR`);
