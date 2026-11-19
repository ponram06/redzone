/**
 * Ledger: history read straight from the chain, so nothing the website shows depends on files on
 * this server.
 *
 * - Contract events (results, bounty deposits, claims, withdrawals) are scanned from the deploy
 *   blocks in 10,000-block chunks (the public RPC refuses bigger ranges) and kept in memory. Each
 *   call to sync() reads only the new blocks.
 * - Native transfers (sign-up fees, bounty payments) are found with the chain's tx search.
 */
import { parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import type { NativeTransfer } from "./chain.js";

const CHUNK = 10_000n;

export type ResultEvent = { sessionId: number; robotId: number; player: Address; breached: boolean; replayHash: Hex; tx: Hex; block: bigint };
export type SessionEvent = { sessionId: number; robotId: number; player: Address; expiresAt: number };
export type DepositEvent = { bountyId: number; robotId: number; owner: Address; funder: Address; amountWei: bigint; tx: Hex };
export type ClaimEvent = { bountyId: number; sessionId: number; player: Address; amountWei: bigint; replayHash: Hex; tx: Hex };
export type TriesEvent = { player: Address; payer: Address; count: number; paidWei: bigint; tx: Hex };
export type Transfer = NativeTransfer & { txHash: string };
/** A native transfer in someone's wallet history, with its block time. */
export type WalletTx = Transfer & { time: string | null };

const EV = {
  breached: parseAbiItem("event Breached(uint256 indexed sessionId, uint256 indexed robotId, address indexed player, bytes32 replayHash)"),
  started: parseAbiItem("event SessionStarted(uint256 indexed sessionId, uint256 indexed robotId, address indexed player, uint256 expiresAt)"),
  tries: parseAbiItem("event TriesBought(address indexed player, address indexed payer, uint256 count, uint256 paid)"),
  defended: parseAbiItem("event Defended(uint256 indexed sessionId, uint256 indexed robotId, address indexed player, bytes32 replayHash)"),
  deposited: parseAbiItem(
    "event BountyDeposited(uint256 indexed bountyId, uint256 indexed robotId, address indexed owner, address funder, uint256 amount, uint256 prizePerWin, bool oncePerBrain)",
  ),
  claimed: parseAbiItem("event BountyClaimed(uint256 indexed bountyId, uint256 indexed sessionId, address indexed player, bytes32 replayHash, uint256 amount)"),
};

/** What the game needs from the chain's history. Tests supply an in-memory version. */
export interface LedgerReader {
  sync(): Promise<void>;
  results(): ResultEvent[];
  sessions(): SessionEvent[];
  deposits(): DepositEvent[];
  claims(): ClaimEvent[];
  /** Paid tries bought on the registry (RobotRegistryV4.TriesBought). */
  tries(): TriesEvent[];
  /** Successful native transfers from `from` to `to`, newest first. */
  transfers(from: string, to: string): Promise<Transfer[]>;
  /** The account's native QOR balance in uqor (optional: tests may leave it out). */
  balance?(qor: string): Promise<bigint>;
  /** The account's latest native transfers, sent and received, newest first. */
  wallet?(qor: string, limit?: number): Promise<WalletTx[]>;
}

export class ChainLedger implements LedgerReader {
  private readonly res: ResultEvent[] = [];
  private readonly ses: SessionEvent[] = [];
  private readonly dep: DepositEvent[] = [];
  private readonly clm: ClaimEvent[] = [];
  private readonly tri: TriesEvent[] = [];
  private regFrom: bigint;
  private vaultFrom: bigint;
  private syncing: Promise<void> | null = null;

  constructor(
    private readonly client: PublicClient,
    private readonly registry: Address,
    registryDeployBlock: bigint,
    private readonly vault: Address,
    vaultDeployBlock: bigint,
    private readonly rest: string,
  ) {
    this.regFrom = registryDeployBlock;
    this.vaultFrom = vaultDeployBlock;
  }

  results() {
    return this.res;
  }
  sessions() {
    return this.ses;
  }
  deposits() {
    return this.dep;
  }
  claims() {
    return this.clm;
  }
  tries() {
    return this.tri;
  }

  /** Read new blocks. Concurrent callers share one scan. */
  sync(): Promise<void> {
    this.syncing ??= this.scan().finally(() => (this.syncing = null));
    return this.syncing;
  }

  private async scan(): Promise<void> {
    const latest = await this.client.getBlockNumber();
    while (this.regFrom <= latest) {
      const to = minB(this.regFrom + CHUNK - 1n, latest);
      const [b, d, st, tb] = await Promise.all([
        this.client.getLogs({ address: this.registry, event: EV.breached, fromBlock: this.regFrom, toBlock: to }),
        this.client.getLogs({ address: this.registry, event: EV.defended, fromBlock: this.regFrom, toBlock: to }),
        this.client.getLogs({ address: this.registry, event: EV.started, fromBlock: this.regFrom, toBlock: to }),
        this.client.getLogs({ address: this.registry, event: EV.tries, fromBlock: this.regFrom, toBlock: to }),
      ]);
      for (const l of tb) {
        this.tri.push({ player: l.args.player!, payer: l.args.payer!, count: Number(l.args.count), paidWei: l.args.paid!, tx: l.transactionHash! });
      }
      for (const l of st) {
        this.ses.push({ sessionId: Number(l.args.sessionId), robotId: Number(l.args.robotId), player: l.args.player!, expiresAt: Number(l.args.expiresAt) });
      }
      for (const [logs, breached] of [
        [b, true],
        [d, false],
      ] as const) {
        for (const l of logs) {
          this.res.push({
            sessionId: Number(l.args.sessionId),
            robotId: Number(l.args.robotId),
            player: l.args.player!,
            breached,
            replayHash: l.args.replayHash!,
            tx: l.transactionHash!,
            block: l.blockNumber!,
          });
        }
      }
      this.regFrom = to + 1n;
    }
    while (this.vaultFrom <= latest) {
      const to = minB(this.vaultFrom + CHUNK - 1n, latest);
      const [dep, clm] = await Promise.all([
        this.client.getLogs({ address: this.vault, event: EV.deposited, fromBlock: this.vaultFrom, toBlock: to }),
        this.client.getLogs({ address: this.vault, event: EV.claimed, fromBlock: this.vaultFrom, toBlock: to }),
      ]);
      for (const l of dep) {
        this.dep.push({
          bountyId: Number(l.args.bountyId),
          robotId: Number(l.args.robotId),
          owner: l.args.owner!,
          funder: l.args.funder!,
          amountWei: l.args.amount!,
          tx: l.transactionHash!,
        });
      }
      for (const l of clm) {
        this.clm.push({
          bountyId: Number(l.args.bountyId),
          sessionId: Number(l.args.sessionId),
          player: l.args.player!,
          amountWei: l.args.amount!,
          replayHash: l.args.replayHash!,
          tx: l.transactionHash!,
        });
      }
      this.vaultFrom = to + 1n;
    }
  }

  async balance(qor: string): Promise<bigint> {
    const res = await fetch(`${this.rest}/cosmos/bank/v1beta1/balances/${qor}/by_denom?denom=uqor`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`balance lookup failed: HTTP ${res.status}`);
    const body = (await res.json()) as { balance?: { amount?: string } };
    return BigInt(body.balance?.amount ?? "0");
  }

  async wallet(qor: string, limit = 40): Promise<WalletTx[]> {
    const search = async (query: string) => {
      const q = encodeURIComponent(query);
      const res = await fetch(`${this.rest}/cosmos/tx/v1beta1/txs?query=${q}&order_by=ORDER_BY_DESC&page=1&limit=${limit}`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`tx search failed: HTTP ${res.status}`);
      const body = (await res.json()) as { txs?: RawTx[]; tx_responses?: (RawResp & { timestamp?: string })[] };
      const out: WalletTx[] = [];
      (body.txs ?? []).forEach((tx, i) => {
        const r = body.tx_responses?.[i];
        const t = parseTransfer(tx, r);
        if (t && r?.txhash) out.push({ ...t, txHash: r.txhash.toUpperCase(), time: r.timestamp ?? null });
      });
      return out;
    };
    const [sent, received] = await Promise.all([search(`transfer.sender='${qor}'`), search(`transfer.recipient='${qor}'`)]);
    const seen = new Set<string>();
    return [...sent, ...received]
      .filter((t) => (seen.has(t.txHash) ? false : (seen.add(t.txHash), true)))
      .sort((a, b) => b.height - a.height)
      .slice(0, limit);
  }

  async transfers(from: string, to: string): Promise<Transfer[]> {
    const q = encodeURIComponent(`transfer.sender='${from}' AND transfer.recipient='${to}'`);
    const out: Transfer[] = [];
    for (let page = 1; page <= 20; page++) {
      const res = await fetch(`${this.rest}/cosmos/tx/v1beta1/txs?query=${q}&order_by=ORDER_BY_DESC&page=${page}&limit=50`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`tx search failed: HTTP ${res.status}`);
      const body = (await res.json()) as { txs?: RawTx[]; tx_responses?: RawResp[]; total?: string };
      const txs = body.txs ?? [];
      txs.forEach((tx, i) => {
        const r = body.tx_responses?.[i];
        const t = parseTransfer(tx, r);
        if (t && r?.txhash && t.code === 0 && t.from === from && t.to === to) out.push({ ...t, txHash: r.txhash.toUpperCase() });
      });
      if (txs.length < 50) break;
    }
    return out;
  }
}

type RawTx = { body?: { memo?: string; messages?: { "@type"?: string; from_address?: string; to_address?: string; amount?: { denom: string; amount: string }[] }[] } };
type RawResp = { code?: number; height?: string; txhash?: string };

/** The first MsgSend of a transaction, as a NativeTransfer. */
export function parseTransfer(tx: RawTx | undefined, r: RawResp | undefined): NativeTransfer | null {
  const send = tx?.body?.messages?.find((m) => m["@type"] === "/cosmos.bank.v1beta1.MsgSend");
  if (!send) return null;
  return {
    code: r?.code ?? 0,
    from: send.from_address ?? "",
    to: send.to_address ?? "",
    uqor: (send.amount ?? []).filter((c) => c.denom === "uqor").reduce((s, c) => s + BigInt(c.amount), 0n),
    memo: tx?.body?.memo ?? "",
    height: Number(r?.height ?? 0),
  };
}

const minB = (a: bigint, b: bigint) => (a < b ? a : b);
