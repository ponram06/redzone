/**
 * bait.ts - set up the bait account for the live Q-Day lab.
 *
 * The bait account is a funded account whose classical ECDSA key is published on the site, as if a quantum
 * computer had cracked it. Its ML-DSA-87 key comes from an independent recovery code that never leaves this
 * computer, so the leaked key alone cannot move its QOR. The server's hourly bot only ever gets the ECDSA key.
 *
 *   npx tsx scripts/bait.ts create   # make .bait.json (git-ignored) and print the address to fund
 *   npx tsx scripts/bait.ts setup    # once funded: register the ML-DSA-87 key (one time)
 *   npx tsx scripts/bait.ts status   # balance, PQC key, EVM window
 *   npx tsx scripts/bait.ts export   # print the leaked-key file for the server (ECDSA key only)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner,
  buildRegisterPqcKeyMsg,
  generatePqcRecoveryCode,
  signProofOfPossession,
  unifiedAccountFromSeed,
} from "@qorechain/sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const REST = "https://api-testnet.qore.host";
const RPC = "https://rpc-testnet.qore.host";
const CHAIN_ID = "qorechain-diana";
const FEE = { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" };
const FILE = ".bait.json";

const cmd = process.argv[2] ?? "status";
if (cmd === "create") {
  if (existsSync(FILE)) console.log(`${FILE} already exists: keeping it`);
  else writeFileSync(FILE, JSON.stringify({ privateKey: generatePrivateKey(), recoveryCode: generatePqcRecoveryCode() }, null, 2), { mode: 0o600 });
}
if (!existsSync(FILE)) throw new Error(`no ${FILE}: run "create" first`);
const bait = JSON.parse(readFileSync(FILE, "utf8")) as { privateKey: Hex; recoveryCode: string };
const acc = unifiedAccountFromSeed(Buffer.from(bait.privateKey.slice(2), "hex"), { recoveryCode: bait.recoveryCode });
const evm = privateKeyToAccount(bait.privateKey).address;

const getJson = async (path: string) => (await fetch(REST + path)).json().catch(() => ({})) as Promise<Record<string, unknown>>;
async function status() {
  const bal = (await getJson(`/cosmos/bank/v1beta1/balances/${acc.cosmos}`)) as { balances?: { denom: string; amount: string }[] };
  const uqor = BigInt(bal.balances?.find((b) => b.denom === "uqor")?.amount ?? "0");
  const pqc = JSON.stringify(await getJson(`/qorechain/pqc/v1/account/${acc.cosmos}`));
  return { uqor, pqcRegistered: pqc.includes("public_key"), pqc };
}

console.log(`bait account  ${acc.cosmos}\nEVM address   ${evm}`);
if (cmd === "export") {
  // Only the classical key: this is what gets published, and all the server's bot ever holds.
  console.log(JSON.stringify({ cosmos: acc.cosmos, evm, ecdsaPrivateKey: bait.privateKey }));
} else if (cmd === "setup") {
  const s = await status();
  if (s.pqcRegistered) console.log("ML-DSA-87 key already registered");
  else {
    if (s.uqor < 200_000n) throw new Error(`fund ${acc.cosmos} first (balance ${s.uqor} uqor)`);
    const body = (await getJson(`/cosmos/auth/v1beta1/accounts/${acc.cosmos}`)) as { account?: Record<string, unknown> };
    const a = ((body.account?.base_account ?? body.account ?? {}) as Record<string, string>);
    const pop = signProofOfPossession({ chainId: CHAIN_ID, account: acc.cosmos, keypair: acc.pqc });
    const signer = new EthNativeSigner(acc, { signMode: "classical", rest: REST });
    const transport = await StargateClient.connect(RPC);
    try {
      const r = await signer.signAndBroadcast(transport, {
        chainId: CHAIN_ID,
        accountNumber: BigInt(a.account_number ?? "0"),
        sequence: BigInt(a.sequence ?? "0"),
        fee: FEE,
        messages: [buildRegisterPqcKeyMsg(acc.cosmos, { pqcKeypair: acc.pqc, proofOfPossession: pop })],
      });
      if (r.code !== 0) throw new Error(`code ${r.code}: ${r.rawLog ?? ""}`);
      console.log(`ML-DSA-87 key registered: ${r.transactionHash}`);
    } finally {
      transport.disconnect();
    }
  }
} else {
  const s = await status();
  console.log(`balance       ${Number(s.uqor) / 1e6} QOR\nML-DSA-87 key ${s.pqcRegistered ? "registered" : "not registered yet"}`);
}
