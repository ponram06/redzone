/**
 * Q-Day Lab: a live, always-on version of the 18 Nov Q-Day Drill.
 *
 * The bait account holds real testnet QOR and its classical ECDSA private key is published on the site,
 * as if a quantum computer had already cracked it. Every hour this bot uses that key, and only that key,
 * to try to take the QOR, and logs what the chain answered. Anyone can try the same with the published key.
 *
 * The bait's ML-DSA-87 key comes from an independent recovery code that stays off this server, so the
 * server is exactly as powerful as any attacker. The bot refuses to run unless the chain shows that
 * ML-DSA-87 key registered: before that, the ECDSA key alone really could move the QOR.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner,
  buildRegisterPqcKeyMsg,
  msg,
  openEvmWindowMsg,
  signProofOfPossession,
  unifiedAccountFromSeed,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { client, qorechain } from "./chain.js";

const REST = "https://api-testnet.qore.host";
const RPC = "https://rpc-testnet.qore.host";
const CHAIN_ID = "qorechain-diana";
const FEE = { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" };
const KEEP_RUNS = 200;

export type LabAttempt = { attack: string; blocked: boolean; detail: string };
export type LabRun = { at: number; balanceBefore: string; balanceAfter: string; attempts: LabAttempt[]; skipped?: string };
export type LabState = {
  cosmos: string;
  evm: Address;
  /** The leaked classical key, published on purpose. */
  ecdsaPrivateKey: Hex;
  attacker: string;
  balanceUqor: string;
  pqcRegistered: boolean;
  everyMinutes: number;
  nextAt: number | null;
  runs: LabRun[];
  totals: { runs: number; attempts: number; blocked: number };
};

type Leaked = { cosmos: string; evm: Address; ecdsaPrivateKey: Hex };

export class QdayLab {
  private readonly file: string;
  private runs: LabRun[] = [];
  private nextAt: number | null = null;
  private running = false;
  private readonly attackerKey: Hex;
  /** The attacker's own account: the leaked key plus an ML-DSA key the attacker made up (address = the bait's). */
  private readonly forged: UnifiedAccount;
  private readonly sink: UnifiedAccount;

  constructor(
    private readonly leaked: Leaked,
    dataDir: string,
    private readonly everyMs = 3_600_000,
  ) {
    const dir = join(dataDir, "qday-lab");
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "runs.json");
    if (existsSync(this.file)) this.runs = JSON.parse(readFileSync(this.file, "utf8")) as LabRun[];
    // Where the stolen QOR would go: an account the bot creates for itself, as a real attacker would.
    const kf = join(dir, "attacker.json");
    if (!existsSync(kf)) writeFileSync(kf, JSON.stringify({ privateKey: generatePrivateKey() }), { mode: 0o600 });
    this.attackerKey = (JSON.parse(readFileSync(kf, "utf8")) as { privateKey: Hex }).privateKey;
    const seed = Buffer.from(leaked.ecdsaPrivateKey.slice(2), "hex");
    this.forged = unifiedAccountFromSeed(seed, { pqcSecret: randomBytes(32) });
    this.sink = unifiedAccountFromSeed(Buffer.from(this.attackerKey.slice(2), "hex"), { pqcSecret: randomBytes(32) });
    if (this.forged.cosmos !== leaked.cosmos) throw new Error(`Q-Day lab: key file is for ${leaked.cosmos}, the key gives ${this.forged.cosmos}`);
  }

  static fromEnv(env: NodeJS.ProcessEnv, dataDir: string): QdayLab | null {
    const f = env.QDAY_LAB_KEY_FILE?.trim();
    if (!f || !existsSync(f) || !statSync(f).isFile()) return null;
    return new QdayLab(JSON.parse(readFileSync(f, "utf8")) as Leaked, dataDir, Number(env.QDAY_LAB_EVERY_MS ?? 3_600_000));
  }

  start(): void {
    const tick = () => {
      this.nextAt = Date.now() + this.everyMs;
      this.runOnce().catch((e: Error) => console.error(`Q-Day lab: ${e.message.slice(0, 200)}`));
    };
    // First run a minute after start (the chain connection settles), then hourly.
    this.nextAt = Date.now() + 60_000;
    setTimeout(() => {
      tick();
      setInterval(tick, this.everyMs).unref();
    }, 60_000).unref();
  }

  private async balance(): Promise<bigint> {
    const r = (await (await fetch(`${REST}/cosmos/bank/v1beta1/balances/${this.leaked.cosmos}`)).json()) as { balances?: { denom: string; amount: string }[] };
    return BigInt(r.balances?.find((b) => b.denom === "uqor")?.amount ?? "0");
  }

  private async pqcRegistered(): Promise<boolean> {
    const r = await fetch(`${REST}/qorechain/pqc/v1/account/${this.leaked.cosmos}`);
    return r.ok && (await r.text()).includes("public_key");
  }

  private async state0(): Promise<{ balance: bigint; pqc: boolean }> {
    const [balance, pqc] = await Promise.all([this.balance(), this.pqcRegistered()]);
    return { balance, pqc };
  }

  private async native(mode: "classical" | "hybrid", messages: Parameters<EthNativeSigner["sign"]>[0]["messages"]): Promise<string> {
    const body = (await (await fetch(`${REST}/cosmos/auth/v1beta1/accounts/${this.leaked.cosmos}`)).json()) as { account?: Record<string, unknown> };
    const a = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
    const signer = new EthNativeSigner(this.forged, { signMode: mode, rest: REST });
    const transport = await StargateClient.connect(RPC);
    try {
      const r = await signer.signAndBroadcast(transport, {
        chainId: CHAIN_ID,
        accountNumber: BigInt(a.account_number ?? "0"),
        sequence: BigInt(a.sequence ?? "0"),
        fee: FEE,
        messages,
      });
      if (r.code !== 0) throw new Error(`chain refused it (code ${r.code}): ${r.rawLog ?? ""}`);
      return `ACCEPTED: tx ${r.transactionHash}`;
    } finally {
      transport.disconnect();
    }
  }

  private async attempt(attack: string, fn: () => Promise<string>): Promise<LabAttempt> {
    try {
      return { attack, blocked: false, detail: await fn() };
    } catch (e) {
      const m = (e as Error).message.replace(/\s+/g, " ");
      return { attack, blocked: true, detail: (m.match(/(chain refused[^]*|Details:[^]*|reason:[^]*)/)?.[0] ?? m).slice(0, 220) };
    }
  }

  /** One round of attacks with the leaked ECDSA key. */
  async runOnce(): Promise<LabRun> {
    if (this.running) throw new Error("already running");
    this.running = true;
    try {
      const before = await this.state0();
      const run: LabRun = { at: Math.floor(Date.now() / 1000), balanceBefore: before.balance.toString(), balanceAfter: before.balance.toString(), attempts: [] };
      if (!before.pqc) {
        run.skipped = "waiting: the bait's ML-DSA-87 key is not registered yet";
      } else if (before.balance === 0n) {
        run.skipped = "the bait account is empty";
      } else {
        const all = (before.balance - 100_000n).toString(); // leave the fee
        const to = this.sink.cosmos;
        const steal = () => [msg.bank.send({ fromAddress: this.leaked.cosmos, toAddress: to, amount: [{ denom: "uqor", amount: all }] })];
        run.attempts.push(await this.attempt("Send all the QOR, signed with the leaked ECDSA key", () => this.native("classical", steal())));
        run.attempts.push(await this.attempt("Send all the QOR, hybrid-signed with the leaked key and a made-up ML-DSA key", () => this.native("hybrid", steal())));
        run.attempts.push(
          await this.attempt("Replace the account's ML-DSA key with the attacker's own", () => {
            const pop = signProofOfPossession({ chainId: CHAIN_ID, account: this.leaked.cosmos, keypair: this.forged.pqc });
            return this.native("classical", [buildRegisterPqcKeyMsg(this.leaked.cosmos, { pqcKeypair: this.forged.pqc, proofOfPossession: pop })]);
          }),
        );
        run.attempts.push(
          await this.attempt("Open an EVM window, to spend through the EVM side instead", () =>
            this.native("classical", [openEvmWindowMsg({ sender: this.leaked.cosmos, blocks: 100n, maxTxs: 2n, maxValue: before.balance * 1_000_000_000_000n })]),
          ),
        );
        run.attempts.push(
          await this.attempt("Send 1 QOR as a plain EVM transaction signed with the leaked key", async () => {
            const wallet = createWalletClient({ chain: qorechain, account: privateKeyToAccount(this.leaked.ecdsaPrivateKey), transport: http() });
            const h = await wallet.sendTransaction({ to: privateKeyToAccount(this.attackerKey).address, value: 1_000_000_000_000_000_000n, gas: 21_000n });
            const r = await client.waitForTransactionReceipt({ hash: h, timeout: 60_000 });
            if (r.status !== "success") throw new Error(`chain refused it: reverted ${h}`);
            return `ACCEPTED: tx ${h}`;
          }),
        );
        await new Promise((r) => setTimeout(r, 7000));
        run.balanceAfter = (await this.balance()).toString();
      }
      this.runs = [run, ...this.runs].slice(0, KEEP_RUNS);
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.runs));
      renameSync(tmp, this.file);
      const ok = run.attempts.filter((a) => a.blocked).length;
      console.log(`Q-Day lab: ${run.skipped ?? `${ok}/${run.attempts.length} blocked, balance ${run.balanceBefore} -> ${run.balanceAfter} uqor`}`);
      return run;
    } finally {
      this.running = false;
    }
  }

  async state(): Promise<LabState> {
    const s = await this.state0().catch(() => ({ balance: BigInt(this.runs[0]?.balanceAfter ?? "0"), pqc: false }));
    const done = this.runs.filter((r) => !r.skipped);
    const attempts = done.flatMap((r) => r.attempts);
    return {
      cosmos: this.leaked.cosmos,
      evm: this.leaked.evm,
      ecdsaPrivateKey: this.leaked.ecdsaPrivateKey,
      attacker: this.sink.cosmos,
      balanceUqor: s.balance.toString(),
      pqcRegistered: s.pqc,
      everyMinutes: Math.round(this.everyMs / 60_000),
      nextAt: this.nextAt,
      runs: this.runs.slice(0, 48),
      totals: { runs: done.length, attempts: attempts.length, blocked: attempts.filter((a) => a.blocked).length },
    };
  }
}
