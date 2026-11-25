/**
 * Check a round's verdict and payout without trusting the RedZone server.
 *
 * Everything that decides the result is read from the chain through QoreChain's public RPC,
 * and every check runs in this browser:
 *   1. the round (robot, player, outcome, replay hash) from RobotRegistryV4.getSession;
 *   2. the referee's recordResult transaction (found by the round's result time) and the
 *      ML-DSA-87 public key and signature in its input;
 *   3. keccak256(public key) == the refereeKeyHash the registry stores;
 *   4. the signed digest, rebuilt here exactly as the contract builds it (and compared with the
 *      contract's own resultDigest view);
 *   5. ML-DSA-87 verification of the signature (FIPS 204, @noble/post-quantum);
 *   6. the replay: the only thing fetched from the RedZone server, and accepted only if its
 *      canonical JSON hashes to the replay hash the referee signed;
 *   7. the payout: BountyClaimed logs for this round in the vaults paired with this registry.
 *
 * Addresses are those in deployments/testnet.json. The digest code mirrors backend/src/signer.ts
 * (RobotRegistryV4.resultDigest).
 */
import { ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";
import {
  createPublicClient,
  decodeFunctionData,
  encodeAbiParameters,
  encodePacked,
  hexToBytes,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
  stringToBytes,
  type Address,
  type Hex,
} from "viem";
import { API_URL } from "./api";

export const CHAIN = {
  rpc: "https://evm-testnet.qore.host",
  chainId: 9800,
  registry: "0xef521a3a178a344a5cdd6854271e1fca466fa115" as Address,
  registryFrom: 10358747n,
  domain: "RedZone.RobotRegistry.v4",
  /** Every vault that has paid prizes for this registry's rounds, oldest first. */
  vaults: [
    { name: "EscrowVaultV3", address: "0xf436fde024c90bf70e2c179391931f8a2c352bc2" as Address, from: 10358789n },
    { name: "EscrowVaultV4", address: "0xb0a270a8fe9a54ba2600b582830f324c94fdece8" as Address, from: 10361652n },
    { name: "EscrowVaultV5", address: "0x241767f1d799149060d133001cf4728d85ac41b7" as Address, from: 10446877n },
  ],
};
/** The RPC refuses log searches over more blocks than this. */
const LOG_SPAN = 9_999n;

const abi = parseAbi([
  "struct Session { uint256 robotId; address player; uint64 startedAt; uint64 resultAt; uint32 brainVersion; uint8 outcome; bytes32 replayHash; }",
  "function getSession(uint256 sessionId) view returns (Session)",
  "function refereeKeyHash() view returns (bytes32)",
  "function resultDigest(uint256 sessionId, uint256 robotId, address player, bool breached, bytes32 replayHash, uint256 deadline) view returns (bytes32)",
  "function recordResult(uint256 sessionId, bool breached, bytes32 replayHash, uint256 deadline, bytes refereePubkey, bytes refereeSig)",
]);
const resultEvents = [
  parseAbiItem("event Breached(uint256 indexed sessionId, uint256 indexed robotId, address indexed player, bytes32 replayHash)"),
  parseAbiItem("event Defended(uint256 indexed sessionId, uint256 indexed robotId, address indexed player, bytes32 replayHash)"),
];
const claimedEvent = parseAbiItem(
  "event BountyClaimed(uint256 indexed bountyId, uint256 indexed sessionId, address indexed player, bytes32 replayHash, uint256 amount)",
);

const RESULT_TYPEHASH = keccak256(
  stringToBytes("RedZone.Result(uint256 sessionId,uint256 robotId,address player,bool breached,bytes32 replayHash,uint256 deadline)"),
);

/** RobotRegistryV4.resultDigest, computed here. */
export function resultDigest(sessionId: bigint, robotId: bigint, player: Address, breached: boolean, replayHash: Hex, deadline: bigint): Hex {
  const data = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "bool" }, { type: "bytes32" }, { type: "uint256" }],
    [RESULT_TYPEHASH, sessionId, robotId, player, breached, replayHash, deadline],
  );
  return keccak256(
    encodePacked(
      ["bytes32", "uint256", "address", "bytes32"],
      [keccak256(stringToBytes(CHAIN.domain)), BigInt(CHAIN.chainId), CHAIN.registry, keccak256(data)],
    ),
  );
}

export function mldsaVerify(publicKey: Hex, digest: Hex, signature: Hex): boolean {
  try {
    return ml_dsa87.verify(hexToBytes(signature), hexToBytes(digest), hexToBytes(publicKey)) === true;
  } catch {
    return false;
  }
}

/** Same as backend/src/canonical.ts: JSON with sorted keys, so a value has one hash. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) out[k] = sort(x);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}
export const hashReplay = (replay: unknown): Hex => keccak256(stringToBytes(canonicalJson(replay)));

export type StepId = "round" | "tx" | "key" | "digest" | "signature" | "replay" | "payout";
export type StepState = { status: "running" | "ok" | "fail" | "none"; text: string };
export type Payout = { vault: string; bountyId: number; amountWei: bigint; player: Address; tx: Hex };
export type Replay = { instruction?: string; verdict?: string; sessionId?: number; player?: string; robotId?: number; trace?: { zone?: string } };

/** What the checks found; the page uses it for the tamper tests. */
export type Evidence = {
  sessionId: bigint;
  robotId: bigint;
  player: Address;
  breached: boolean;
  replayHash: Hex;
  deadline: bigint;
  publicKey: Hex;
  signature: Hex;
  digest: Hex;
  resultTx: Hex;
  resultBlock: bigint;
  resultAt: number;
  verifyMs: number;
  replay: Replay | null;
  payouts: Payout[];
};

const client = createPublicClient({ transport: http(CHAIN.rpc) });

/**
 * A block range of at most LOG_SPAN blocks that holds the first block at or after `ts`.
 * Interpolates on block times, so it takes a handful of RPC calls rather than a full scan.
 */
async function windowFor(ts: bigint, lo: bigint, hi: bigint): Promise<[bigint, bigint]> {
  const time = async (n: bigint) => (await client.getBlock({ blockNumber: n })).timestamp;
  let tlo = await time(lo);
  let thi = await time(hi);
  for (let i = 0; i < 16 && hi - lo > LOG_SPAN - 1_000n; i++) {
    let g = thi > tlo ? lo + ((hi - lo) * (ts - tlo)) / (thi - tlo) : (lo + hi) / 2n;
    if (g <= lo) g = lo + 1n;
    if (g >= hi) g = hi - 1n;
    const tg = await time(g);
    if (tg < ts) [lo, tlo] = [g, tg];
    else [hi, thi] = [g, tg];
    // Step a little past the guess too, so both ends close in even if block times vary.
    const probe = tg < ts ? (g + 4_000n < hi ? g + 4_000n : null) : g - 4_000n > lo ? g - 4_000n : null;
    if (probe !== null) {
      const tp = await time(probe);
      if (tp < ts) [lo, tlo] = [probe, tp];
      else [hi, thi] = [probe, tp];
    }
  }
  return [lo, hi];
}

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

export async function checkRound(id: number, step: (s: StepId, state: StepState) => void): Promise<Evidence | null> {
  const sessionId = BigInt(id);
  const fail = (s: StepId, text: string) => {
    step(s, { status: "fail", text });
    return null;
  };

  // 1. The round, from the registry.
  step("round", { status: "running", text: "Reading the round from the registry…" });
  const [s, keyHash, head] = await Promise.all([
    client.readContract({ address: CHAIN.registry, abi, functionName: "getSession", args: [sessionId] }),
    client.readContract({ address: CHAIN.registry, abi, functionName: "refereeKeyHash" }),
    client.getBlockNumber(),
  ]);
  if (s.player === "0x0000000000000000000000000000000000000000") return fail("round", `The registry has no round #${id}.`);
  if (s.outcome === 0) return fail("round", `Round #${id} has no verdict on chain yet (it may still be running, or it expired unjudged).`);
  const breached = s.outcome === 2;
  step("round", {
    status: "ok",
    text: `Round #${id}: robot #${s.robotId}, player ${short(s.player)}, recorded as ${breached ? "BREACHED" : "DEFENDED"}.`,
  });

  // 2. The referee's transaction that recorded it.
  step("tx", { status: "running", text: "Finding the transaction that recorded the verdict…" });
  const [from, to] = await windowFor(s.resultAt, CHAIN.registryFrom, head);
  const logs = await Promise.all(
    resultEvents.map((event) => client.getLogs({ address: CHAIN.registry, event, args: { sessionId }, fromBlock: from, toBlock: to })),
  );
  const log = logs.flat()[0];
  if (!log?.transactionHash) return fail("tx", "No Breached or Defended event for this round was found near its result time.");
  const tx = await client.getTransaction({ hash: log.transactionHash });
  if (tx.to?.toLowerCase() !== CHAIN.registry.toLowerCase()) return fail("tx", "The event's transaction was not sent to the registry.");
  let args;
  try {
    const d = decodeFunctionData({ abi, data: tx.input });
    if (d.functionName !== "recordResult") throw new Error();
    args = d.args;
  } catch {
    return fail("tx", "The transaction is not a recordResult call.");
  }
  const [txSession, txBreached, replayHash, deadline, publicKey, signature] = args;
  if (txSession !== sessionId || txBreached !== breached || replayHash !== s.replayHash) {
    return fail("tx", "The transaction's verdict does not match what the registry stores.");
  }
  step("tx", {
    status: "ok",
    text: `recordResult in block ${log.blockNumber} carries a ${(publicKey.length - 2) / 2}-byte public key and a ${(signature.length - 2) / 2}-byte signature.`,
  });

  // 3. It is the referee's key.
  const keyOk = keccak256(publicKey) === keyHash;
  if (!keyOk) return fail("key", `keccak256 of the key is ${short(keccak256(publicKey))}, but the registry's referee key hash is ${short(keyHash)}.`);
  step("key", { status: "ok", text: `keccak256(public key) = ${short(keyHash)}, the referee key hash stored in the registry.` });

  // 4. The digest, rebuilt here.
  const digest = resultDigest(sessionId, s.robotId, s.player, breached, replayHash, deadline);
  const onChain = await client.readContract({
    address: CHAIN.registry,
    abi,
    functionName: "resultDigest",
    args: [sessionId, s.robotId, s.player, breached, replayHash, deadline],
  });
  if (digest !== onChain) return fail("digest", `Rebuilt ${short(digest)} but the contract computes ${short(onChain)}.`);
  step("digest", {
    status: "ok",
    text: `${short(digest)}: binds round, robot, player, verdict, replay and deadline to this registry on chain ${CHAIN.chainId}. Same as the contract's resultDigest.`,
  });

  // 5. ML-DSA-87, in this browser.
  step("signature", { status: "running", text: "Verifying ML-DSA-87…" });
  await new Promise((r) => setTimeout(r, 30)); // let the page paint before the CPU work
  const t0 = performance.now();
  const sigOk = mldsaVerify(publicKey, digest, signature);
  const verifyMs = performance.now() - t0;
  if (!sigOk) return fail("signature", "The ML-DSA-87 signature does not verify.");
  step("signature", { status: "ok", text: `Valid ML-DSA-87 (FIPS 204) signature, checked in this browser in ${verifyMs.toFixed(0)} ms.` });

  // 6. The replay: fetched from RedZone, accepted only if it hashes to what was signed.
  step("replay", { status: "running", text: "Fetching the replay…" });
  let replay: Replay | null = null;
  try {
    const res = await fetch(`${API_URL}/replay/${replayHash}`);
    if (res.ok) replay = (await res.json()) as Replay;
  } catch {
    /* reported below */
  }
  if (!replay) step("replay", { status: "fail", text: "The RedZone server did not return the replay, so its contents can't be shown. The checks above still hold." });
  else if (hashReplay(replay) !== replayHash) {
    step("replay", { status: "fail", text: "The replay the server returned does NOT hash to the signed replay hash." });
    replay = null;
  } else {
    step("replay", { status: "ok", text: `The replay hashes to ${short(replayHash)}, the value the referee signed, so the instruction and path below are exactly what was judged.` });
  }

  // 7. The payout.
  let payouts: Payout[] = [];
  if (!breached) step("payout", { status: "none", text: "Defended rounds pay nothing." });
  else {
    step("payout", { status: "running", text: "Looking for the vault's payment…" });
    const end = log.blockNumber! + LOG_SPAN > head ? head : log.blockNumber! + LOG_SPAN;
    const found = await Promise.all(
      CHAIN.vaults
        .filter((v) => v.from <= end)
        .map(async (v) =>
          (await client.getLogs({ address: v.address, event: claimedEvent, args: { sessionId }, fromBlock: log.blockNumber!, toBlock: end })).map((l) => ({
            vault: v.name,
            bountyId: Number(l.args.bountyId),
            amountWei: l.args.amount!,
            player: l.args.player!,
            tx: l.transactionHash!,
          })),
        ),
    );
    payouts = found.flat();
    const wrong = payouts.find((p) => p.player.toLowerCase() !== s.player.toLowerCase());
    if (wrong) step("payout", { status: "fail", text: `Bounty #${wrong.bountyId} was paid to ${short(wrong.player)}, not the round's player.` });
    else if (payouts.length) {
      const total = payouts.reduce((a, p) => a + p.amountWei, 0n);
      step("payout", { status: "ok", text: `${formatWei(total)} QOR paid to the round's player by ${payouts.map((p) => `${p.vault} (bounty #${p.bountyId})`).join(", ")}.` });
    } else {
      step("payout", { status: "none", text: "No bounty paid for this round (the robot had no open bounty, or this brain's pool was already won)." });
    }
  }

  return { sessionId, robotId: s.robotId, player: s.player, breached, replayHash, deadline, publicKey, signature, digest, resultTx: log.transactionHash, resultBlock: log.blockNumber!, resultAt: Number(s.resultAt), verifyMs, replay, payouts };
}

export function formatWei(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "").slice(0, 4);
  return frac ? `${whole}.${frac}` : `${whole}`;
}
