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

export type ResultEvent = { sessionId: number; robotId: number; player: Address; breached: boolean; tx: Hex; block: bigint };
export type DepositEvent = { bountyId: number; robotKey: Hex; owner: Address; amountWei: bigint; tx: Hex };
export type ClaimEvent = { bountyId: number; claimer: Address; amountWei: bigint; tx: Hex };
export type Transfer = NativeTransfer & { txHash: string };

const EV = {
  breached: parseAbiItem("event Breached(uint256 indexed sessionId, uint256 indexed robotId, address indexed player, bytes32 replayHash)"),
  defended: parseAbiItem("event Defended(uint256 indexed sessionId, uint256 indexed robotId, address indexed player, bytes32 replayHash)"),
  deposited: parseAbiItem("event BountyDeposited(uint256 indexed bountyId, bytes32 indexed robotId, address indexed owner, uint256 amount)"),
  claimed: parseAbiItem("event BountyClaimed(uint256 indexed bountyId, address indexed claimer, bytes32 replayHash, uint256 amount)"),
};

/** What the game needs from the chain's history. Tests supply an in-memory version. */
export interface LedgerReader {
  sync(): Promise<void>;
  results(): ResultEvent[];
  deposits(): DepositEvent[];
  claims(): ClaimEvent[];
  /** Successful native transfers from `from` to `to`, newest first. */
  transfers(from: string, to: string): Promise<Transfer[]>;
}

export class ChainLedger implements LedgerReader {
  private readonly res: ResultEvent[] = [];
  private readonly dep: DepositEvent[] = [];
  private readonly clm: ClaimEvent[] = [];
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
  deposits() {
    return this.dep;
  }
  claims() {
    return this.clm;
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
      const [b, d] = await Promise.all([
        this.client.getLogs({ address: this.registry, event: EV.breached, fromBlock: this.regFrom, toBlock: to }),
        this.client.getLogs({ address: this.registry, event: EV.defended, fromBlock: this.regFrom, toBlock: to }),
      ]);
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
        this.dep.push({ bountyId: Number(l.args.bountyId), robotKey: l.args.robotId!, owner: l.args.owner!, amountWei: l.args.amount!, tx: l.transactionHash! });
      }
      for (const l of clm) {
        this.clm.push({ bountyId: Number(l.args.bountyId), claimer: l.args.claimer!, amountWei: l.args.amount!, tx: l.transactionHash! });
      }
      this.vaultFrom = to + 1n;
    }
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
