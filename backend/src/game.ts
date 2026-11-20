/**
 * Game logic: judge an attack session, score utility, run practice rounds.
 * Chain reads are injected so tests run offline.
 */
import { decodeEventLog, encodeFunctionData, verifyMessage, type Address, type Hex } from "viem";
import type { Arena } from "./arena.js";
import { createHash } from "node:crypto";
import { actionsToWaypoints } from "./brains/actions.js";
import { brainHash, type BrainRegistry } from "./brains/registry.js";
import { RuleBrain } from "./brains/rule.js";
import type { BrainOutput, BrainUnavailableError } from "./brains/types.js";
import { NEXT, registryAbi, vaultAbi, type BountyView, type OpenBounty, type NativeTransfer, type PlayerState, type RobotView, type SessionView } from "./chain.js";
import type { LedgerReader, Transfer } from "./ledger.js";
import { SIGNUP_MEMO, decodePqSignature, toEvmAddress, toQorAddress, verifyWalletSignature, walletText } from "./qorex.js";
import { simulate, taskPassed, type Trace } from "./referee.js";
import type { Relayer } from "./relayer.js";
import { openPassDigest, registerRobotDigest, resultDigest, signDigest, startSessionDigest, updateBrainDigest, utilityDigest, withdrawDigest, type RefereeKey } from "./signer.js";
import type { Store } from "./store.js";

/** A signed owner request is valid for this long (the contracts allow at most 1 hour). */
export const REQUEST_TTL = 15 * 60;
/** A signed StartSession request must reach the chain within MAX_START_TTL (10 minutes); keep a margin. */
export const START_TTL = 8 * 60;

export const MAX_INSTRUCTION = 500;
export const UTILITY_WINDOW = 24 * 3600;
/** Parts of a nickname reserved for the site itself (compared without spaces or punctuation). */
const RESERVED_NAMES = ["admin", "redzone", "qorechain", "qorex", "moderator", "official", "support", "referee", "relayer"];
/** Most vault calls made to settle one bounty (skips of unpayable breaches plus the claim). */
const MAX_SETTLE_STEPS = 10;
/** brainHash value for free practice against the training robot (no safety rules). */
export const TRAINING_BRAIN = "training";
/** How long the list of brains guarding robots in the arena is cached. */
const ARENA_BRAINS_TTL = 60;

/**
 * Round key: when the website starts a round through the relayer it sends sha256(key) for a
 * random key it keeps. Sending that key with the instruction then authorises it, so a round needs
 * one QoreX approval (the on-chain StartSession), not two. The key only works for that session.
 */
export const roundKeyHash = (key: string) => "0x" + createHash("sha256").update(key.toLowerCase()).digest("hex");
const ROUND_KEY = /^0x[0-9a-fA-F]{64}$/;

/**
 * A robot that was breached on its current brain version while it has a once-per-brain prize pool:
 * paid rounds are refused until the owner fixes it (updates the brain), which reopens it.
 */
export type Freeze = {
  sessionId: number;
  player: Address;
  /** When the breach was recorded (unix s). */
  at: number;
  replayHash: Hex;
  /** The message that broke it and the red zone it drove into (from the replay, when this server has it). */
  instruction: string | null;
  zone: string | null;
};

/** How long a robot is shown as "free AI limit reached" after its AI last refused (an answer clears it). */
const AI_LIMIT_SHOWN_S = 15 * 60;

export class GameError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type ChainReader = {
  readSession(id: number): Promise<SessionView | null>;
  readRobot(id: number): Promise<RobotView | null>;
  openBounties(robotId: number): Promise<OpenBounty[]>;
  readPqcKey(account: Address): Promise<{ registered: boolean; algorithmId: number; pubkey: Hex }>;
  readPlayer(player: Address): Promise<PlayerState>;
  /** RobotRegistryV4.tryPrice / treasury. */
  readTryPrice(): Promise<{ priceWei: bigint; treasury: Address }>;
  readNativeTransfer(txHash: string): Promise<NativeTransfer | null>;
  readBounty(id: number): Promise<BountyView>;
  /** EscrowVaultV2.nextBreach: state of the breach at the bounty's cursor (see NEXT). */
  readNextBreach(bountyId: number): Promise<{ state: number; sessionId: number }>;
  readVaultNonce(account: Address): Promise<bigint>;
  readNextRobotId(): Promise<number>;
  /** A deposit we sent: pending (not mined or not found), success with its BountyDeposited, or reverted. */
  readDeposit(hash: Hex): Promise<{ status: "pending" | "success" | "reverted"; bountyId?: number; amountWei: bigint }>;
};

/** Makers pay bounties to the relayer (QoreX can't call contracts yet); the relayer locks them in the vault, owned by the robot's owner. */
export type PrizeConfig = { minUqor: bigint; payTo: string };
export const bountyMemo = (robotId: number) => `RedZone bounty #${robotId}`;

/**
 * The maker's choice travels in the QoreX payment memo, which only the maker can sign:
 *   "RedZone bounty #3"                 one prize: the first winner takes it all (v3 behaviour)
 *   "RedZone bounty #3 prize 150"       150 QOR per win; pays again only after a brain update
 *   "RedZone bounty #3 prize 150 open"  150 QOR per win, every new winner (still one per player)
 * Returns null when the memo is not a bounty payment for this robot.
 */
export function parseBountyMemo(memo: string, robotId: number): { prizeUqor: bigint | null; oncePerBrain: boolean } | null {
  const m = memo.trim();
  const base = bountyMemo(robotId);
  if (m === base) return { prizeUqor: null, oncePerBrain: true };
  const r = /^prize (\d{1,7}(?:\.\d{1,6})?)( open)?$/.exec(m.slice(base.length + 1));
  if (!m.startsWith(base + " ") || !r) return null;
  const [whole, frac = ""] = r[1]!.split(".");
  return { prizeUqor: BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, "0")), oncePerBrain: !r[2] };
}

/** Smallest prize per win the vault accepts (EscrowVaultV4.MIN_PRIZE, 0.1 QOR). */
/** Robot bodies an owner can choose (same ids as web/src/robotLook.ts; never rename one). */
export const ROBOT_KINDS = ["hauler", "dog", "waiter", "guard", "courier", "titan"];
export type RobotLook = { kind: string; color: string };

export const MIN_PRIZE_UQOR = 100_000n;
/** Memo of a QoreX payment for extra tries (paid to the relayer, which buys them on chain). */
export const TRIES_MEMO = "RedZone tries";
/** 10,000 QOR: a sanity cap on a single bounty payment. */
const MAX_BOUNTY_UQOR = 10_000n * 1_000_000n;
const WEI_PER_UQOR = 10n ** 12n;
/** EscrowVaultV2.WITHDRAW_EXPIRY: a take-back request lapses this long after it unlocks. */
const WITHDRAW_EXPIRY = 7 * 24 * 3600;

/** One-time sign-up: the player pays `feeUqor` once, with a QoreX (hybrid-signed) transfer to `payTo`. */
export type SignupConfig = { feeUqor: bigint; payTo: string };
/** Cache of a sign-up found on chain (the chain is the source of truth; this file only saves a lookup). */
type PlayerRecord = { evm: Address; qor: string; txHash: string; paidUqor: string; height: number; at: number };

export type GameDeps = {
  arena: Arena;
  brains: BrainRegistry;
  store: Store;
  key: RefereeKey;
  chain: ChainReader;
  /** Chain history: contract events and native transfers. */
  ledger: LedgerReader;
  chainId: number;
  registry: Address;
  vault: Address;
  sessionTtl: number;
  resultGrace: number;
  /** EscrowVaultV2.WITHDRAW_DELAY: time between a take-back request and its payout. */
  withdrawDelay: number;
  /** Chain height the current contracts were deployed at: bounty and paid-try payments made
   *  before it belonged to older contracts and never count again. Sign-ups have no such limit. */
  paymentsFromHeight?: number;
  /** Bounty payments count only from this height (the current vault's deployment): a payment
   *  already locked in an older vault must never be locked again. Defaults to paymentsFromHeight. */
  bountiesFromHeight?: number;
  /** RobotRegistryV4.PASS_TTL and MAX_PASS_ROUNDS (play pass). */
  passTtl?: number;
  maxPassRounds?: number;
  /** Sends startSessionFor / recordResult / claimBounty for players. Optional: without it, players relay. */
  relayer?: Relayer | null;
  /** When set, players pay a small one-time fee before their first session. */
  signup?: SignupConfig | null;
  /** When set (with a relayer), makers can add prizes paid from QoreX. */
  prize?: PrizeConfig | null;
  now?: () => number;
};

export type RelayStatus = { resultTx?: Hex; claimTxs?: { bountyId: number; tx: Hex }[]; error?: string };

/** Contract enum EscrowVaultV2.Next, as names for errors. */
const NEXT_NAMES = ["none", "claimable", "skippable", "waiting"];

export type AttemptVerdict = {
  sessionId: number;
  robotId: number;
  player: Address;
  breached: boolean;
  say: string;
  trace: Trace;
  replayHash: Hex;
  /** Arguments for RobotRegistryV3.recordResult (anyone may relay, with the referee's public key). */
  result: { deadline: string; refereeSig: Hex };
  /** Bounties open on the robot at the verdict. On a breach, EscrowVaultV2.claimBounty(bountyId)
   *  (anyone may call) pays each one to the robot's earliest unpaid breach. */
  claims: { bountyId: number; amountWei: string }[];
  /** What the relayer sent on chain for this verdict, when a relayer is configured. */
  relay?: RelayStatus;
};

export type UtilityVerdict = {
  robotId: number;
  brainHash: Hex;
  utilityNonce: number;
  tasksPassed: number;
  tasks: { id: string; passed: boolean }[];
  replayHash: Hex;
  deadline: string;
  refereeSig: Hex;
  /** Set when the referee's relayer sent recordUtility. */
  relay?: { tx?: Hex; error?: string };
};

/** The exact text a player signs (personal_sign) to submit an instruction for their session. */
export function attemptMessage(chainId: number, registry: Address, sessionId: number, instruction: string): string {
  return `RedZone attempt\nchain: ${chainId}\nregistry: ${registry.toLowerCase()}\nsession: ${sessionId}\ninstruction: ${instruction}`;
}

function cleanInstruction(raw: unknown): string {
  if (typeof raw !== "string") throw new GameError(400, "instruction must be a string");
  const s = raw.replace(/\r\n?/g, "\n").trim();
  if (!s) throw new GameError(400, "instruction is empty");
  if (s.length > MAX_INSTRUCTION) throw new GameError(400, `instruction is longer than ${MAX_INSTRUCTION} characters`);
  return s;
}

export class Game {
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Breached sessions: session id -> brain version and result time (immutable once recorded). */
  private readonly breachInfo = new Map<number, { version: number; at: number }>();
  private ledgerSyncedAt = 0;
  /** Brains whose AI providers last refused with a usage limit: brain hash -> when (unix s). Cleared on an answer. */
  private readonly aiLimited = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly d: GameDeps) {
    this.now = d.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** One run at a time per key; a second caller waits and then gets the stored result. */
  private async once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    while (this.locks.has(key)) await this.locks.get(key)!.catch(() => {});
    const p = fn();
    this.locks.set(key, p);
    try {
      return await p;
    } finally {
      this.locks.delete(key);
    }
  }

  private brainFor(robot: RobotView) {
    const brain = this.d.brains.brain(robot.brainHash);
    if (!brain) throw new GameError(503, `this robot's brain (${robot.brainHash}) is not available on this referee`);
    return brain;
  }

  private async think(robotBrain: ReturnType<Game["brainFor"]>, instruction: string, hash?: string): Promise<BrainOutput> {
    const key = hash?.toLowerCase();
    try {
      const out = await robotBrain.plan(this.d.arena, instruction);
      if (key) this.aiLimited.delete(key);
      return out;
    } catch (e) {
      if ((e as Error).name === "BrainUnavailableError") {
        if ((e as BrainUnavailableError).limit) {
          if (key) this.aiLimited.set(key, this.now());
          throw new GameError(
            503,
            "This robot's free AI limit is used up for now: its AI provider is refusing more requests on the free plan. Your try is not lost: the round stays open, so you can send again, or come back later. Sentinel-01 needs no AI and always answers.",
          );
        }
        throw new GameError(503, `the robot's brain is busy, try again in a minute (${(e as Error).message})`);
      }
      throw e;
    }
  }

  /**
   * Is this robot frozen? It is when it has a once-per-brain prize pool and its latest breach was
   * against its current brain version: the prize for this version is won, so paid rounds wait for
   * the owner's fix. The rule-based demo robot never freezes. Read from chain events.
   */
  async freezeOf(robot: RobotView): Promise<Freeze | null> {
    if (!robot.bounty.open.some((b) => b.oncePerBrain)) return null;
    // The rule-based practice robot is the always-open demo: every new player can see a payout.
    if (this.d.brains.config(robot.brainHash)?.kind === "rule") return null;
    if (Date.now() - this.ledgerSyncedAt > 5_000) {
      await this.d.ledger.sync();
      this.ledgerSyncedAt = Date.now();
    }
    let last: { sessionId: number; player: Address; replayHash: Hex } | null = null;
    for (const r of this.d.ledger.results()) {
      if (r.breached && r.robotId === robot.id && (!last || r.sessionId > last.sessionId)) last = r;
    }
    if (!last) return null;
    let info = this.breachInfo.get(last.sessionId);
    if (!info) {
      const s = await this.d.chain.readSession(last.sessionId);
      if (!s || s.brainVersion === undefined) return null;
      info = { version: s.brainVersion, at: s.resultAt };
      this.breachInfo.set(last.sessionId, info);
    }
    if (info.version !== robot.brainVersion) return null;
    const replay = this.d.store.getReplay(last.replayHash) as { instruction?: string; trace?: { zone?: string } } | null;
    const zoneId = replay?.trace?.zone ?? null;
    return {
      sessionId: last.sessionId,
      player: last.player,
      at: info.at,
      replayHash: last.replayHash,
      instruction: replay?.instruction ?? null,
      zone: zoneId ? (this.d.arena.redZones.find((z) => z.id === zoneId)?.name ?? zoneId) : null,
    };
  }

  /** Refuse a paid round on a frozen robot, before any signature or gas. */
  private async assertOpen(robot: RobotView): Promise<void> {
    if (await this.freezeOf(robot)) {
      throw new GameError(423, "This robot is frozen: someone broke it and was paid, so it pays again only after its owner fixes it. Try another robot.");
    }
  }

  /** When this brain's AI last hit a usage limit (unix seconds), if within the last 15 minutes. */
  aiLimitSince(brainHash: string): number | null {
    const at = this.aiLimited.get(brainHash.toLowerCase());
    if (at === undefined) return null;
    if (this.now() - at > AI_LIMIT_SHOWN_S) {
      this.aiLimited.delete(brainHash.toLowerCase());
      return null;
    }
    return at;
  }

  /**
   * Judge one session. The player authorises the instruction with either:
   *   - `pqSignature`: the ML-DSA-87 part of a QoreX signArbitrary over attemptMessage (base64 or hex),
   *     checked against the player's key registered on chain; or
   *   - `signature`: an EVM personal_sign (0x) over attemptMessage, for EVM wallets.
   */
  async attempt(input: { sessionId: unknown; instruction: unknown; signature?: unknown; pqSignature?: unknown; roundKey?: unknown }): Promise<AttemptVerdict> {
    const sessionId = Number(input.sessionId);
    if (!Number.isSafeInteger(sessionId) || sessionId < 1) throw new GameError(400, "bad sessionId");
    const instruction = cleanInstruction(input.instruction);
    const pqSignature = input.pqSignature === undefined ? null : decodePqSignature(input.pqSignature);
    if (input.pqSignature !== undefined && !pqSignature) throw new GameError(400, "pqSignature is not a valid signature encoding");
    const ecdsa = typeof input.signature === "string" && /^0x[0-9a-fA-F]{130}$/.test(input.signature) ? (input.signature as Hex) : null;
    const roundKey = typeof input.roundKey === "string" && ROUND_KEY.test(input.roundKey) ? input.roundKey : null;
    if (!pqSignature && !ecdsa && !roundKey) throw new GameError(400, "signature missing");
    const signature = pqSignature ?? ecdsa ?? `round-key:${roundKeyHash(roundKey!)}`;

    return this.once(`session-${sessionId}`, async () => {
      const done = this.d.store.getVerdict<AttemptVerdict>(`session-${sessionId}`);
      if (done) return done; // one verdict per session, no re-rolls

      const session = await this.d.chain.readSession(sessionId);
      if (!session) throw new GameError(404, "session not found on chain");
      if (session.outcome !== 0) throw new GameError(409, "session already has a result on chain");
      if (this.now() > session.startedAt + this.d.sessionTtl) throw new GameError(410, "session expired (10 minutes)");

      const message = attemptMessage(this.d.chainId, this.d.registry, sessionId, instruction);
      let ok = false;
      if (!pqSignature && !ecdsa) {
        // The round key set when this session was started through the relayer, after the
        // player's ML-DSA StartSession signature was checked on chain.
        const expected = this.d.store.getVerdict<string>(`roundkey-${sessionId}`);
        ok = !!expected && expected === roundKeyHash(roundKey!);
      } else if (pqSignature) {
        const key = await this.d.chain.readPqcKey(session.player);
        ok = key.registered && verifyWalletSignature(key.pubkey, message, pqSignature);
      } else {
        ok = await verifyMessage({ address: session.player, message, signature: ecdsa! }).catch(() => false);
      }
      if (!ok) throw new GameError(401, "signature is not from the session's player");

      const robot = await this.d.chain.readRobot(session.robotId);
      if (!robot) throw new GameError(404, "robot not found");
      const out = await this.think(this.brainFor(robot), instruction, robot.brainHash);
      const waypoints = actionsToWaypoints(this.d.arena, out.actions);
      const trace = simulate(this.d.arena, waypoints);

      const replay = {
        v: 1,
        kind: "attack",
        chainId: this.d.chainId,
        registry: this.d.registry.toLowerCase(),
        arena: this.d.arena.id,
        sessionId,
        robotId: session.robotId,
        player: session.player.toLowerCase(),
        brainHash: robot.brainHash,
        instruction,
        playerSignature: signature,
        brain: { say: out.say, actions: out.actions, model: out.model, raw: out.raw },
        waypoints,
        trace,
        verdict: trace.breached ? "breached" : "defended",
        judgedAt: this.now(),
      };
      const replayHash = this.d.store.saveReplay(replay);

      const resultDeadline = BigInt(session.startedAt + this.d.sessionTtl + this.d.resultGrace);
      const result = {
        deadline: resultDeadline.toString(),
        refereeSig: signDigest(
          this.d.key,
          resultDigest(this.d.chainId, this.d.registry, BigInt(sessionId), BigInt(session.robotId), session.player, trace.breached, replayHash, resultDeadline),
        ),
      };

      const claims: AttemptVerdict["claims"] = trace.breached
        ? (await this.d.chain.openBounties(session.robotId)).map((b) => ({
            bountyId: b.id,
            // What this win can pay: one prize, or what is left of the pool.
            amountWei: (BigInt(b.prizeWei) < BigInt(b.amountWei) ? b.prizeWei : b.amountWei).toString(),
          }))
        : [];

      const verdict: AttemptVerdict = {
        sessionId,
        robotId: session.robotId,
        player: session.player,
        breached: trace.breached,
        say: out.say,
        trace,
        replayHash,
        result,
        claims,
      };
      this.d.store.saveVerdict(`session-${sessionId}`, verdict);
      if (this.d.relayer) {
        verdict.relay = await this.relayVerdict(verdict);
        this.d.store.saveVerdict(`session-${sessionId}`, verdict);
      }
      return verdict;
    });
  }

  /** Put a verdict on chain: recordResult, then settle each open bounty on a breach. */
  private async relayVerdict(v: AttemptVerdict): Promise<RelayStatus> {
    const relayer = this.d.relayer!;
    const status: RelayStatus = {};
    try {
      const r = await relayer.send(
        this.d.registry,
        encodeFunctionData({
          abi: registryAbi,
          functionName: "recordResult",
          args: [BigInt(v.sessionId), v.breached, v.replayHash, BigInt(v.result.deadline), this.d.key.publicKey, v.result.refereeSig],
        }),
      );
      if (r.status !== "success") throw new Error(`recordResult reverted (${r.hash})`);
      status.resultTx = r.hash;
      for (const c of v.claims) {
        const tx = await this.settleBounty(c.bountyId);
        if (tx) (status.claimTxs ??= []).push({ bountyId: c.bountyId, tx });
      }
    } catch (e) {
      status.error = (e as Error).message.slice(0, 300);
    }
    return status;
  }

  /**
   * Pay a bounty to its robot's earliest unpaid breach. The vault decides who is paid: we skip
   * breaches it reports as never payable, then claim. Returns the claim tx, or null when the bounty
   * is already closed or has no breach to pay.
   */
  private async settleBounty(bountyId: number): Promise<Hex | null> {
    const relayer = this.d.relayer!;
    for (let step = 0; step < MAX_SETTLE_STEPS; step++) {
      const b = await this.d.chain.readBounty(bountyId);
      if (b.status !== 1) return null;
      const next = await this.d.chain.readNextBreach(bountyId);
      if (next.state === NEXT.None) return null;
      if (next.state === NEXT.Waiting) throw new Error(`bounty ${bountyId}: vault is paused, the win is paid after the pause`);
      const fn = next.state === NEXT.Claimable ? "claimBounty" : "skipBreach";
      const r = await relayer.send(this.d.vault, encodeFunctionData({ abi: vaultAbi, functionName: fn, args: [BigInt(bountyId)] }));
      if (r.status !== "success") throw new Error(`${fn} ${bountyId} reverted (${r.hash})`);
      if (fn === "claimBounty") return r.hash;
    }
    throw new Error(`bounty ${bountyId}: too many unpayable breaches (${NEXT_NAMES[NEXT.Skippable]}), try again`);
  }

  /** Retry relaying a stored verdict whose relay failed or was incomplete. */
  async relayAgain(sessionIdRaw: unknown): Promise<AttemptVerdict> {
    const sessionId = Number(sessionIdRaw);
    if (!Number.isSafeInteger(sessionId) || sessionId < 1) throw new GameError(400, "bad sessionId");
    if (!this.d.relayer) throw new GameError(503, "no relayer configured");
    return this.once(`session-${sessionId}`, async () => {
      const v = this.d.store.getVerdict<AttemptVerdict>(`session-${sessionId}`);
      if (!v) throw new GameError(404, "no verdict for this session");
      if (v.relay && !v.relay.error) return v;
      const session = await this.d.chain.readSession(sessionId);
      const pending: AttemptVerdict = { ...v };
      if (session && session.outcome !== 0 && v.relay?.resultTx) {
        // Result already on chain: only the claims are left.
        pending.relay = { resultTx: v.relay.resultTx };
        const done = new Set((v.relay.claimTxs ?? []).map((c) => c.bountyId));
        const claimsLeft = v.claims.filter((c) => !done.has(c.bountyId));
        const rest = await this.relayVerdict({ ...v, claims: claimsLeft, result: v.result });
        pending.relay = { resultTx: v.relay.resultTx, claimTxs: [...(v.relay.claimTxs ?? []), ...(rest.claimTxs ?? [])], error: rest.error };
      } else {
        pending.relay = await this.relayVerdict(v);
      }
      this.d.store.saveVerdict(`session-${sessionId}`, pending);
      return pending;
    });
  }

  // ------------------------------------------------------------------ players

  private playerKey(evm: Address): string {
    return `player-${evm.slice(2).toLowerCase()}`;
  }

  /**
   * The player's sign-up payment, from the chain: a successful transfer of at least the fee from
   * this account to the fee address with the sign-up memo. Found once, then cached.
   */
  private async signupFor(evm: Address): Promise<PlayerRecord | null> {
    if (!this.d.signup) return null;
    const cached = this.d.store.getVerdict<PlayerRecord>(this.playerKey(evm));
    if (cached) return cached;
    const qor = toQorAddress(evm);
    const tx = (await this.d.ledger.transfers(qor, this.d.signup.payTo)).find((t) => t.memo.trim() === SIGNUP_MEMO && t.uqor >= this.d.signup!.feeUqor);
    if (!tx) return null;
    const record: PlayerRecord = { evm, qor, txHash: tx.txHash, paidUqor: tx.uqor.toString(), height: tx.height, at: this.now() };
    this.d.store.saveVerdict(this.playerKey(evm), record);
    return record;
  }

  private async isSignedUp(evm: Address): Promise<boolean> {
    return !this.d.signup || (await this.signupFor(evm)) !== null;
  }

  /** Everything the website needs to know about a player before they play. */
  async playerStatus(addressRaw: unknown) {
    const evm = toEvmAddress(addressRaw);
    if (!evm) throw new GameError(400, "address must be a qor1… or 0x… address");
    const [key, state, record, price] = await Promise.all([
      this.d.chain.readPqcKey(evm),
      this.d.chain.readPlayer(evm),
      this.signupFor(evm),
      this.d.chain.readTryPrice(),
    ]);
    const relayer = this.d.relayer?.address.toLowerCase();
    const passLive = !!relayer && state.pass.operator.toLowerCase() === relayer && state.pass.validUntil > this.now() && state.pass.roundsLeft > 0;
    return {
      extraTries: state.extraTries,
      pass: passLive ? { validUntil: state.pass.validUntil, roundsLeft: state.pass.roundsLeft } : null,
      tries:
        this.d.relayer && price.priceWei > 0n ? { priceUqor: (price.priceWei / WEI_PER_UQOR).toString(), payTo: this.d.prize?.payTo ?? null, memo: TRIES_MEMO } : null,
      evm,
      qor: toQorAddress(evm),
      pqKeyRegistered: key.registered,
      signedUp: !this.d.signup || record !== null,
      signupTx: record?.txHash ?? null,
      attemptsLeft: state.attemptsLeft,
      signup: this.d.signup ? { feeUqor: this.d.signup.feeUqor.toString(), payTo: this.d.signup.payTo, memo: SIGNUP_MEMO } : null,
    };
  }

  /**
   * Record a one-time sign-up payment. The transaction must be on chain, successful, a transfer
   * of at least the fee from this player to the fee address, carrying the sign-up memo. Native
   * transfers from an account with a PQC key are hybrid-signed, so the payment itself proves the
   * player controls the account's ML-DSA-87 key. A transaction can sign up only one player.
   */
  async registerPlayer(input: { address: unknown; txHash: unknown }) {
    if (!this.d.signup) throw new GameError(409, "sign-up is not required on this referee");
    const evm = toEvmAddress(input.address);
    if (!evm) throw new GameError(400, "bad address");
    if (typeof input.txHash !== "string" || !/^(0x)?[0-9a-fA-F]{64}$/.test(input.txHash)) throw new GameError(400, "bad txHash");
    const txHash = input.txHash.replace(/^0x/, "").toUpperCase();
    const qor = toQorAddress(evm);

    return this.once(`signup-${evm.toLowerCase()}`, async () => {
      const existing = await this.signupFor(evm);
      if (existing) return { signedUp: true, txHash: existing.txHash };

      const tx = await this.d.chain.readNativeTransfer(txHash);
      if (!tx) throw new GameError(404, "payment not found on chain yet: wait a few seconds and try again");
      if (tx.code !== 0) throw new GameError(400, "that transaction failed on chain");
      if (tx.from !== qor) throw new GameError(400, "the payment was not sent from this account");
      if (tx.to !== this.d.signup!.payTo) throw new GameError(400, "the payment went to the wrong address");
      if (tx.uqor < this.d.signup!.feeUqor) throw new GameError(400, "the payment is smaller than the sign-up fee");
      if (tx.memo.trim() !== SIGNUP_MEMO) throw new GameError(400, `the payment memo must be "${SIGNUP_MEMO}"`);

      // The payment is valid; the chain's tx search may need a few seconds to index it.
      const found = await this.signupFor(evm);
      if (!found) throw new GameError(404, "payment not indexed on chain yet: wait a few seconds and try again");
      return { signedUp: true, txHash: found.txHash };
    });
  }

  // ---------------------------------------------------------- sessions (QoreX + relayer)

  /** What the player's wallet must sign to start a session on `robotId`. */
  async sessionRequest(input: { robotId: unknown; player: unknown }) {
    const robotId = Number(input.robotId);
    if (!Number.isSafeInteger(robotId) || robotId < 1) throw new GameError(400, "bad robotId");
    const player = toEvmAddress(input.player);
    if (!player) throw new GameError(400, "player must be a qor1… or 0x… address");
    const [robot, key, state] = await Promise.all([
      this.d.chain.readRobot(robotId),
      this.d.chain.readPqcKey(player),
      this.d.chain.readPlayer(player),
    ]);
    if (!robot) throw new GameError(404, "robot not found");
    if (robot.owner.toLowerCase() === player.toLowerCase()) throw new GameError(409, "owners cannot attack their own robot");
    await this.assertOpen(robot);
    if (!key.registered) throw new GameError(409, "this account has no ML-DSA-87 key registered yet (register it in QoreX first)");
    if (!(await this.isSignedUp(player))) throw new GameError(402, "sign up first: a one-time payment verifies your account");
    if (state.attemptsLeft < 1) throw new GameError(429, "no attempts left today (5 per UTC day)");
    const deadline = this.now() + START_TTL;
    const digest = startSessionDigest(this.d.chainId, this.d.registry, BigInt(robotId), player, state.nonce, BigInt(deadline));
    return { robotId, player, nonce: state.nonce.toString(), deadline, digest, text: walletText("StartSession", digest), attemptsLeft: state.attemptsLeft };
  }

  /** Relay a QoreX-signed StartSession request. The signature is checked here first so bad ones cost no gas. */
  async startSession(input: { robotId: unknown; player: unknown; deadline: unknown; pqSignature: unknown; roundKeyHash?: unknown }) {
    if (!this.d.relayer) throw new GameError(503, "no relayer configured: start the session from an EVM wallet instead");
    const robotId = Number(input.robotId);
    const deadline = Number(input.deadline);
    const player = toEvmAddress(input.player);
    const sig = decodePqSignature(input.pqSignature);
    if (!Number.isSafeInteger(robotId) || robotId < 1) throw new GameError(400, "bad robotId");
    if (!player) throw new GameError(400, "bad player address");
    if (!sig) throw new GameError(400, "pqSignature missing or malformed");
    const keyHash = input.roundKeyHash;
    if (keyHash !== undefined && (typeof keyHash !== "string" || !ROUND_KEY.test(keyHash))) throw new GameError(400, "bad roundKeyHash");
    if (!(await this.isSignedUp(player))) throw new GameError(402, "sign up first: a one-time payment verifies your account");
    if (!Number.isSafeInteger(deadline) || deadline < this.now() || deadline > this.now() + 600) {
      throw new GameError(400, "deadline expired or too far away: request a new one");
    }

    return this.once(`nonce-${player.toLowerCase()}`, async () => {
      const [key, state, robot] = await Promise.all([this.d.chain.readPqcKey(player), this.d.chain.readPlayer(player), this.d.chain.readRobot(robotId)]);
      if (robot) await this.assertOpen(robot);
      if (!key.registered) throw new GameError(409, "no ML-DSA-87 key registered for this account");
      if (state.attemptsLeft < 1) throw new GameError(429, "no attempts left today");
      const digest = startSessionDigest(this.d.chainId, this.d.registry, BigInt(robotId), player, state.nonce, BigInt(deadline));
      if (!verifyWalletSignature(key.pubkey, walletText("StartSession", digest), sig)) {
        throw new GameError(401, "signature does not match this request (it may be used already: request a new one)");
      }
      const r = await this.d.relayer!.send(
        this.d.registry,
        encodeFunctionData({ abi: registryAbi, functionName: "startSessionFor", args: [BigInt(robotId), player, BigInt(deadline), sig] }),
      );
      if (r.status !== "success") throw new GameError(502, `startSessionFor reverted on chain (${r.hash})`);
      for (const log of r.logs) {
        try {
          const ev = decodeEventLog({ abi: registryAbi, data: log.data, topics: log.topics });
          if (ev.eventName === "SessionStarted") {
            const sessionId = Number(ev.args.sessionId);
            if (keyHash) this.d.store.saveVerdict(`roundkey-${sessionId}`, (keyHash as string).toLowerCase());
            return { sessionId, tx: r.hash, expiresAt: Number(ev.args.expiresAt), player };
          }
        } catch {
          // not our event
        }
      }
      throw new GameError(502, `session started but no SessionStarted event found (${r.hash})`);
    });
  }

  // ---------------------------------------------------------- play pass (one QoreX approval for many rounds)
  //
  // The player signs OpenPass once in QoreX: for PASS_TTL (10 minutes) the relayer may start up to
  // maxRounds rounds for them with startSessionWithPass, so the wallet is not asked every round.
  // The website also sends sha256(passKey) for a random passKey only it knows; starting a round under
  // the pass needs that key, so nobody else can spend the player's tries through this server.

  private passMaxRounds(attemptsLeft: number): number {
    return Math.max(1, Math.min(attemptsLeft, this.d.maxPassRounds ?? 20));
  }

  /** What the player's wallet signs to open a play pass. */
  async passRequest(input: { player: unknown }) {
    if (!this.d.relayer) throw new GameError(503, "no relayer configured");
    const player = toEvmAddress(input.player);
    if (!player) throw new GameError(400, "player must be a qor1… or 0x… address");
    const [key, state] = await Promise.all([this.d.chain.readPqcKey(player), this.d.chain.readPlayer(player)]);
    if (!key.registered) throw new GameError(409, "this account has no ML-DSA-87 key registered yet (register it in QoreX first)");
    if (!(await this.isSignedUp(player))) throw new GameError(402, "sign up first: a one-time payment verifies your account");
    if (state.attemptsLeft < 1) throw new GameError(429, "no tries left today: buy more tries or come back tomorrow");
    // A small margin, so the pass is still within PASS_TTL of the block that opens it.
    const validUntil = this.now() + (this.d.passTtl ?? 600) - 20;
    const maxRounds = this.passMaxRounds(state.attemptsLeft);
    const deadline = this.now() + START_TTL;
    const digest = openPassDigest(this.d.chainId, this.d.registry, player, this.d.relayer.address, BigInt(validUntil), BigInt(maxRounds), state.nonce, BigInt(deadline));
    return { player, validUntil, maxRounds, deadline, digest, text: walletText("OpenPass", digest) };
  }

  /** Relay a QoreX-signed OpenPass. The signature is checked here first so bad ones cost no gas. */
  async openPass(input: { player: unknown; validUntil: unknown; maxRounds: unknown; deadline: unknown; pqSignature: unknown; passKeyHash: unknown }) {
    if (!this.d.relayer) throw new GameError(503, "no relayer configured");
    const player = toEvmAddress(input.player);
    const validUntil = Number(input.validUntil);
    const maxRounds = Number(input.maxRounds);
    const deadline = this.checkDeadline(input.deadline);
    const sig = decodePqSignature(input.pqSignature);
    if (!player) throw new GameError(400, "bad player address");
    if (!sig) throw new GameError(400, "pqSignature missing or malformed");
    if (typeof input.passKeyHash !== "string" || !ROUND_KEY.test(input.passKeyHash)) throw new GameError(400, "bad passKeyHash");
    if (!Number.isSafeInteger(validUntil) || validUntil <= this.now() || validUntil > this.now() + (this.d.passTtl ?? 600)) {
      throw new GameError(400, "pass time expired or too long: request a new one");
    }
    if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > (this.d.maxPassRounds ?? 20)) throw new GameError(400, "bad maxRounds");
    const passKeyHash = input.passKeyHash.toLowerCase();

    return this.once(`nonce-${player.toLowerCase()}`, async () => {
      const [key, state] = await Promise.all([this.d.chain.readPqcKey(player), this.d.chain.readPlayer(player)]);
      if (!key.registered) throw new GameError(409, "no ML-DSA-87 key registered for this account");
      const digest = openPassDigest(this.d.chainId, this.d.registry, player, this.d.relayer!.address, BigInt(validUntil), BigInt(maxRounds), state.nonce, BigInt(deadline));
      if (!verifyWalletSignature(key.pubkey, walletText("OpenPass", digest), sig)) {
        throw new GameError(401, "signature does not match this request (it may be used already: request a new one)");
      }
      const r = await this.d.relayer!.send(
        this.d.registry,
        encodeFunctionData({ abi: registryAbi, functionName: "openPassFor", args: [player, this.d.relayer!.address, BigInt(validUntil), BigInt(maxRounds), BigInt(deadline), sig] }),
      );
      if (r.status !== "success") throw new GameError(502, `openPassFor reverted on chain (${r.hash})`);
      this.d.store.saveVerdict(this.passKeyName(player), { keyHash: passKeyHash, validUntil });
      return { validUntil, roundsLeft: maxRounds, tx: r.hash };
    });
  }

  private passKeyName(player: Address): string {
    return `pass-${player.slice(2).toLowerCase()}`;
  }

  /** Start a round under the player's play pass: no wallet prompt. Needs the pass key from openPass. */
  async startWithPass(input: { robotId: unknown; player: unknown; passKey: unknown; roundKeyHash?: unknown }) {
    if (!this.d.relayer) throw new GameError(503, "no relayer configured");
    const robotId = Number(input.robotId);
    const player = toEvmAddress(input.player);
    if (!Number.isSafeInteger(robotId) || robotId < 1) throw new GameError(400, "bad robotId");
    if (!player) throw new GameError(400, "bad player address");
    if (typeof input.passKey !== "string" || !ROUND_KEY.test(input.passKey)) throw new GameError(400, "bad passKey");
    const keyHash = input.roundKeyHash;
    if (keyHash !== undefined && (typeof keyHash !== "string" || !ROUND_KEY.test(keyHash))) throw new GameError(400, "bad roundKeyHash");
    const passKey = input.passKey;

    return this.once(`nonce-${player.toLowerCase()}`, async () => {
      const saved = this.d.store.getVerdict<{ keyHash: string; validUntil: number }>(this.passKeyName(player));
      if (!saved || saved.keyHash !== roundKeyHash(passKey)) throw new GameError(401, "this browser has no play pass for this account: approve a new one");
      if (this.now() >= saved.validUntil) throw new GameError(410, "your play pass has ended: approve a new one");
      const [robot, state] = await Promise.all([this.d.chain.readRobot(robotId), this.d.chain.readPlayer(player)]);
      if (!robot) throw new GameError(404, "robot not found");
      if (robot.owner.toLowerCase() === player.toLowerCase()) throw new GameError(409, "owners cannot attack their own robot");
      await this.assertOpen(robot);
      if (state.pass.operator.toLowerCase() !== this.d.relayer!.address.toLowerCase() || state.pass.validUntil <= this.now() || state.pass.roundsLeft < 1) {
        throw new GameError(410, "your play pass has ended: approve a new one");
      }
      if (state.attemptsLeft < 1) throw new GameError(429, "no tries left: buy more tries or come back tomorrow");
      const r = await this.d.relayer!.send(
        this.d.registry,
        encodeFunctionData({ abi: registryAbi, functionName: "startSessionWithPass", args: [BigInt(robotId), player] }),
      );
      if (r.status !== "success") throw new GameError(502, `startSessionWithPass reverted on chain (${r.hash})`);
      for (const log of r.logs) {
        try {
          const ev = decodeEventLog({ abi: registryAbi, data: log.data, topics: log.topics });
          if (ev.eventName === "SessionStarted") {
            const sessionId = Number(ev.args.sessionId);
            if (keyHash) this.d.store.saveVerdict(`roundkey-${sessionId}`, (keyHash as string).toLowerCase());
            return { sessionId, tx: r.hash, expiresAt: Number(ev.args.expiresAt), player, passRoundsLeft: state.pass.roundsLeft - 1 };
          }
        } catch {
          // not our event
        }
      }
      throw new GameError(502, `session started but no SessionStarted event found (${r.hash})`);
    });
  }

  // ---------------------------------------------------------- paid tries (paid in QoreX, bought by the relayer)
  //
  // The player pays n x tryPrice to the relayer from QoreX with memo "RedZone tries"; the relayer
  // calls buyTries(player, n) with exactly that value, and the registry forwards it to the treasury.
  // Like bounties, everything is worked out from the chain: paid (the player's transfers with the
  // memo) minus bought (TriesBought events the relayer paid for this player). Retries never double-buy.

  async buyTries(input: { player: unknown; txHash: unknown }) {
    if (!this.d.relayer || !this.d.prize) throw new GameError(503, "tries can't be bought on this referee");
    const player = toEvmAddress(input.player);
    if (!player) throw new GameError(400, "bad player address");
    if (typeof input.txHash !== "string" || !/^(0x)?[0-9a-fA-F]{64}$/.test(input.txHash)) throw new GameError(400, "bad txHash");
    const txHash = input.txHash.replace(/^0x/, "").toUpperCase();
    const qor = toQorAddress(player);

    return this.once(`tries-${player.toLowerCase()}`, async () => {
      const { priceWei } = await this.d.chain.readTryPrice();
      if (priceWei === 0n) throw new GameError(409, "extra tries are not for sale right now");
      const priceUqor = priceWei / WEI_PER_UQOR;
      const tx = await this.d.chain.readNativeTransfer(txHash);
      if (!tx) throw new GameError(404, "payment not found on chain yet: wait a few seconds and try again");
      if (tx.code !== 0) throw new GameError(400, "that transaction failed on chain");
      if (tx.from !== qor) throw new GameError(400, "the payment was not sent from this account");
      if (tx.to !== this.d.prize!.payTo) throw new GameError(400, "the payment went to the wrong address");
      if (tx.memo.trim() !== TRIES_MEMO) throw new GameError(400, `the payment memo must be "${TRIES_MEMO}"`);
      if (tx.height < (this.d.paymentsFromHeight ?? 0)) throw new GameError(400, "that payment was for RedZone's previous contracts");
      if (tx.uqor < priceUqor) throw new GameError(400, "the payment is smaller than the price of one try");

      const from = this.d.paymentsFromHeight ?? 0;
      const paidTxs = (await this.d.ledger.transfers(qor, this.d.prize!.payTo)).filter((t) => t.height >= from && t.memo.trim() === TRIES_MEMO && t.uqor <= MAX_BOUNTY_UQOR);
      if (!paidTxs.some((t) => t.txHash === txHash)) throw new GameError(404, "payment not indexed on chain yet: wait a few seconds and try again");
      const paidUqor = paidTxs.reduce((s, t) => s + t.uqor, 0n);
      await this.d.ledger.sync();
      const relayer = this.d.relayer!.address.toLowerCase();
      let boughtUqor = this.d.ledger
        .tries()
        .filter((e) => e.player.toLowerCase() === player.toLowerCase() && e.payer.toLowerCase() === relayer)
        .reduce((s, e) => s + e.paidWei / WEI_PER_UQOR, 0n);
      // A purchase we sent may not be visible to getLogs yet.
      const pendingKey = `tries-sent-${player.slice(2).toLowerCase()}`;
      // Only recent ones count: after 10 minutes a send that never showed up did not happen.
      const sent = (this.d.store.getVerdict<{ tx: string; uqor: string; at?: number }[]>(pendingKey) ?? []).filter((x) => (x.at ?? 0) > this.now() - 600);
      const seen = new Set(this.d.ledger.tries().map((e) => e.tx.toLowerCase()));
      for (const s of sent) if (!seen.has(s.tx.toLowerCase())) boughtUqor += BigInt(s.uqor);
      const count = (paidUqor - boughtUqor) / priceUqor;
      const state = await this.d.chain.readPlayer(player);
      if (count <= 0n) return { player, bought: 0, extraTries: state.extraTries, tx: null };

      const value = count * priceUqor * WEI_PER_UQOR;
      const r = await this.d.relayer!.send(
        this.d.registry,
        encodeFunctionData({ abi: registryAbi, functionName: "buyTries", args: [player, count] }),
        value,
        (hash) => this.d.store.saveVerdict(pendingKey, [...sent, { tx: hash, uqor: (count * priceUqor).toString(), at: this.now() }]),
      ).catch((e: Error) => {
        throw new GameError(502, `your payment arrived, but adding the tries failed (${e.message.slice(0, 120)}). Try again in a minute: you won't pay twice`);
      });
      if (r.status !== "success") throw new GameError(502, `adding the tries failed on chain (${r.hash}). Try again: you won't pay twice`);
      return { player, bought: Number(count), extraTries: state.extraTries + Number(count), tx: r.hash };
    });
  }

  // ---------------------------------------------------------- bounties (paid in QoreX, locked by the relayer)
  //
  // QoreX can't call contracts yet, so a maker can't call EscrowVaultV2.depositBounty themselves.
  // They pay the bounty to the relayer with a normal QoreX transfer (hybrid-signed), memo
  // "RedZone bounty #<robotId>", and the relayer deposits it into the vault for that robot. The
  // vault makes the robot's owner the bounty's owner, so the relayer never owns the money.
  //
  // Everything here is worked out from the chain, not from files on this server:
  //   paid      = the robot owner's successful transfers to the relayer with that memo
  //   deposited = the vault's BountyDeposited events funded by the relayer for that robot
  // The relayer deposits only paid - deposited, so retries, restarts or a lost database can never
  // lock a payment twice. Only the owner's own ML-DSA signature can withdraw (requestWithdraw).

  /** Sum of valid bounty payments for a robot, from the chain. */
  private async paidFor(robotId: number, owner: Address): Promise<{ total: bigint; txs: Transfer[] }> {
    const all = await this.d.ledger.transfers(toQorAddress(owner), this.d.prize!.payTo);
    const from = this.d.bountiesFromHeight ?? this.d.paymentsFromHeight ?? 0;
    const valid = (memo: string) => {
      const terms = parseBountyMemo(memo, robotId);
      return terms !== null && (terms.prizeUqor === null || terms.prizeUqor >= MIN_PRIZE_UQOR);
    };
    const txs = all.filter((t) => t.height >= from && valid(t.memo) && t.uqor >= this.d.prize!.minUqor && t.uqor <= MAX_BOUNTY_UQOR);
    return { total: txs.reduce((s, t) => s + t.uqor, 0n), txs };
  }

  /** Bounties the relayer deposited for a robot: chain events plus our own sends still being indexed. */
  private async depositedFor(robotId: number): Promise<{ total: bigint; ids: number[]; txs: Set<string> }> {
    await this.d.ledger.sync();
    const relayer = this.d.relayer!.address.toLowerCase();
    const mine = this.d.ledger.deposits().filter((e) => e.robotId === robotId && e.funder.toLowerCase() === relayer);
    const txs = new Set(mine.map((e) => e.tx.toLowerCase()));
    let total = mine.reduce((s, e) => s + e.amountWei / WEI_PER_UQOR, 0n);
    const ids = mine.map((e) => e.bountyId);
    // A deposit we sent may not be visible to getLogs yet: count it from its receipt.
    for (const h of this.d.store.getVerdict<string[]>(`deposits-${robotId}`) ?? []) {
      if (txs.has(h.toLowerCase())) continue;
      const r = await this.d.chain.readDeposit(h as Hex);
      if (r.status === "pending") throw new GameError(409, "your last bounty deposit is still confirming: try again in a minute");
      if (r.status === "success" && r.bountyId) {
        total += r.amountWei / WEI_PER_UQOR;
        ids.push(r.bountyId);
        txs.add(h.toLowerCase());
      }
    }
    return { total, ids, txs };
  }

  /** Lock the maker's paid-but-not-yet-locked bounty for this robot. Safe to call any number of times. */
  async addBounty(input: { robotId: unknown; owner: unknown; txHash: unknown }) {
    if (!this.d.prize || !this.d.relayer) throw new GameError(503, "bounties can't be added on this referee");
    const robotId = Number(input.robotId);
    if (!Number.isSafeInteger(robotId) || robotId < 1) throw new GameError(400, "bad robotId");
    const owner = toEvmAddress(input.owner);
    if (!owner) throw new GameError(400, "bad owner address");
    if (typeof input.txHash !== "string" || !/^(0x)?[0-9a-fA-F]{64}$/.test(input.txHash)) throw new GameError(400, "bad txHash");
    const txHash = input.txHash.replace(/^0x/, "").toUpperCase();

    return this.once(`bounty-robot-${robotId}`, async () => {
      const robot = await this.d.chain.readRobot(robotId);
      if (!robot) throw new GameError(404, "robot not found");
      if (robot.owner.toLowerCase() !== owner.toLowerCase()) throw new GameError(403, "only the robot's owner can add its bounty");

      // Clear errors for the payment the maker just made.
      const tx = await this.d.chain.readNativeTransfer(txHash);
      if (!tx) throw new GameError(404, "payment not found on chain yet: wait a few seconds and try again");
      if (tx.code !== 0) throw new GameError(400, "that transaction failed on chain");
      if (tx.from !== toQorAddress(owner)) throw new GameError(400, "the payment was not sent from this account");
      if (tx.to !== this.d.prize!.payTo) throw new GameError(400, "the payment went to the wrong address");
      const terms = parseBountyMemo(tx.memo, robotId);
      if (!terms) throw new GameError(400, `the payment memo must start with "${bountyMemo(robotId)}"`);
      if (terms.prizeUqor !== null && terms.prizeUqor < MIN_PRIZE_UQOR) throw new GameError(400, "the prize per win must be at least 0.1 QOR");
      if (tx.height < (this.d.bountiesFromHeight ?? this.d.paymentsFromHeight ?? 0)) throw new GameError(400, "that payment was for RedZone's previous contracts");
      if (tx.uqor < this.d.prize!.minUqor) throw new GameError(400, "the bounty is smaller than the minimum");
      if (tx.uqor > MAX_BOUNTY_UQOR) throw new GameError(400, "the bounty is too large");

      const paid = await this.paidFor(robotId, owner);
      // The chain's tx index can lag a few seconds behind the tx itself.
      if (!paid.txs.some((t) => t.txHash === txHash)) throw new GameError(404, "payment not indexed on chain yet: wait a few seconds and try again");
      const dep = await this.depositedFor(robotId);
      const missing = paid.total - dep.total;
      if (missing <= 0n) return { robotId, bountyIds: dep.ids, lockedUqor: dep.total.toString(), depositTx: null };

      const pendingKey = `deposits-${robotId}`;
      // The terms the maker signed in this payment's memo. A prize can't exceed the pool.
      const prizeUqor = terms.prizeUqor === null ? null : terms.prizeUqor < missing ? terms.prizeUqor : missing;
      // Maker robots freeze after a paid breach until they are fixed, so their pools pay once per
      // brain version. Open pools (every new player wins once, no freeze) are only for the
      // rule-based practice robot; an "open" memo for any other robot is locked once-per-brain.
      const oncePerBrain = terms.oncePerBrain || this.d.brains.config(robot.brainHash)?.kind !== "rule";
      const data =
        prizeUqor === null
          ? encodeFunctionData({ abi: vaultAbi, functionName: "depositBounty", args: [BigInt(robotId)] })
          : encodeFunctionData({ abi: vaultAbi, functionName: "depositPool", args: [BigInt(robotId), prizeUqor * WEI_PER_UQOR, oncePerBrain] });
      const r = await this.d.relayer!.send(
        this.d.vault,
        data,
        missing * WEI_PER_UQOR,
        (hash) => this.d.store.saveVerdict(pendingKey, [...(this.d.store.getVerdict<string[]>(pendingKey) ?? []), hash]),
      ).catch((e: Error) => {
        throw new GameError(502, `your payment arrived, but locking the bounty failed (${e.message.slice(0, 120)}). Try again in a minute: you won't pay twice`);
      });
      if (r.status !== "success") throw new GameError(502, `locking the bounty failed on chain (${r.hash}). Try again: you won't pay twice`);
      let bountyId: number | undefined;
      for (const log of r.logs) {
        try {
          const ev = decodeEventLog({ abi: vaultAbi, data: log.data, topics: log.topics });
          if (ev.eventName === "BountyDeposited") bountyId = Number(ev.args.bountyId);
        } catch {
          // not our event
        }
      }
      return { robotId, bountyIds: [...dep.ids, ...(bountyId ? [bountyId] : [])], lockedUqor: (dep.total + missing).toString(), depositTx: r.hash };
    });
  }

  /** The owner's bounties still in the vault, read from the chain, with any withdrawal in progress. */
  async ownerBounties(ownerRaw: unknown) {
    const owner = toEvmAddress(ownerRaw);
    if (!owner) throw new GameError(400, "bad owner address");
    await this.d.ledger.sync();
    const out: { robotId: number; bountyId: number; uqor: string; withdraw: { requestedAt: number; unlocksAt: number } | null }[] = [];
    for (const e of this.d.ledger.deposits()) {
      if (e.owner.toLowerCase() !== owner.toLowerCase()) continue;
      const b = await this.d.chain.readBounty(e.bountyId);
      if (b.status !== 1) continue;
      out.push({ robotId: b.robotId, bountyId: b.id, uqor: (b.amountWei / WEI_PER_UQOR).toString(), withdraw: this.withdrawState(b) });
    }
    return out;
  }

  /** A live withdrawal request (one that has not lapsed), or null. */
  private withdrawState(b: BountyView): { requestedAt: number; unlocksAt: number } | null {
    if (!b.withdrawRequestedAt) return null;
    const unlocksAt = b.withdrawRequestedAt + this.d.withdrawDelay;
    if (this.now() > unlocksAt + WITHDRAW_EXPIRY) return null;
    return { requestedAt: b.withdrawRequestedAt, unlocksAt };
  }

  /** The bounty, checked to be open and owned (on chain) by `owner`. */
  private async bountyForOwner(bountyId: number, owner: Address) {
    if (!this.d.relayer) throw new GameError(503, "no relayer configured");
    const b = await this.d.chain.readBounty(bountyId);
    if (b.status === 0) throw new GameError(404, "bounty not found");
    if (b.owner.toLowerCase() !== owner.toLowerCase()) throw new GameError(403, "only the robot's owner can take its bounty back");
    if (b.status !== 1) throw new GameError(409, b.status === 2 ? "a player already won this bounty" : "this bounty is no longer in the vault");
    return b;
  }

  /**
   * Step 1 of taking a bounty back: what the owner's wallet signs (EscrowVaultV2.requestWithdraw).
   * The money stays winnable during WITHDRAW_DELAY; any win recorded first is paid first.
   */
  async bountyBackRequest(input: { bountyId: unknown; owner: unknown }) {
    const bountyId = Number(input.bountyId);
    const owner = toEvmAddress(input.owner);
    if (!Number.isSafeInteger(bountyId) || bountyId < 1 || !owner) throw new GameError(400, "bad request");
    await this.bountyForOwner(bountyId, owner);
    const nonce = await this.d.chain.readVaultNonce(owner);
    const deadline = this.now() + REQUEST_TTL;
    const digest = withdrawDigest(this.d.chainId, this.d.vault, BigInt(bountyId), owner, nonce, BigInt(deadline));
    return { bountyId, owner, nonce: nonce.toString(), deadline, digest, text: walletText("WithdrawBounty", digest) };
  }

  /** Relay the owner's QoreX-signed requestWithdraw. The signature is checked here first so bad ones cost no gas. */
  async takeBountyBack(input: { bountyId: unknown; owner: unknown; deadline: unknown; pqSignature: unknown }) {
    const bountyId = Number(input.bountyId);
    const owner = toEvmAddress(input.owner);
    const deadline = this.checkDeadline(input.deadline);
    const sig = decodePqSignature(input.pqSignature);
    if (!Number.isSafeInteger(bountyId) || bountyId < 1 || !owner) throw new GameError(400, "bad request");
    if (!sig) throw new GameError(400, "pqSignature missing or malformed");

    return this.once(`bounty-${bountyId}`, async () => {
      const b = await this.bountyForOwner(bountyId, owner);
      const [key, nonce] = await Promise.all([this.d.chain.readPqcKey(owner), this.d.chain.readVaultNonce(owner)]);
      if (!key.registered) throw new GameError(409, "no ML-DSA-87 key registered for this account");
      const digest = withdrawDigest(this.d.chainId, this.d.vault, BigInt(bountyId), owner, nonce, BigInt(deadline));
      if (!verifyWalletSignature(key.pubkey, walletText("WithdrawBounty", digest), sig)) {
        throw new GameError(401, "signature does not match this request (it may be used already: request a new one)");
      }
      const r = await this.d.relayer!.send(
        this.d.vault,
        encodeFunctionData({ abi: vaultAbi, functionName: "requestWithdraw", args: [BigInt(bountyId), owner, BigInt(deadline), sig] }),
      );
      if (r.status !== "success") throw new GameError(502, `requestWithdraw reverted (${r.hash})`);
      return { bountyId, tx: r.hash, uqor: (b.amountWei / WEI_PER_UQOR).toString(), unlocksAt: this.now() + this.d.withdrawDelay };
    });
  }

  /**
   * Step 2: once WITHDRAW_DELAY has passed, pay the bounty to the address the owner signed for.
   * Anyone may call finalizeWithdraw; the vault refuses while a win is still payable.
   */
  async finishBountyBack(input: { bountyId: unknown }) {
    const bountyId = Number(input.bountyId);
    if (!Number.isSafeInteger(bountyId) || bountyId < 1) throw new GameError(400, "bad bountyId");
    if (!this.d.relayer) throw new GameError(503, "no relayer configured");
    return this.once(`bounty-${bountyId}`, async () => {
      const b = await this.d.chain.readBounty(bountyId);
      if (b.status !== 1) throw new GameError(409, b.status === 2 ? "a player already won this bounty" : "this bounty is no longer in the vault");
      const w = this.withdrawState(b);
      if (!w) throw new GameError(409, "no take-back request for this bounty (or it lapsed): ask again");
      if (this.now() < w.unlocksAt) throw new GameError(425, `the bounty unlocks at ${new Date(w.unlocksAt * 1000).toISOString()}`);
      // A payable win beats the owner: pay it (or skip breaches that can never be paid) first.
      const claimTx = await this.settleBounty(bountyId).catch((e: Error) => {
        throw new GameError(502, e.message.slice(0, 200));
      });
      if (claimTx) throw new GameError(409, `a player beat this robot first and was paid the bounty (${claimTx})`);
      const r = await this.d.relayer!.send(this.d.vault, encodeFunctionData({ abi: vaultAbi, functionName: "finalizeWithdraw", args: [BigInt(bountyId)] }));
      if (r.status !== "success") throw new GameError(502, `finalizeWithdraw reverted (${r.hash})`);
      return { bountyId, tx: r.hash, to: b.withdrawTo, uqor: (b.amountWei / WEI_PER_UQOR).toString() };
    });
  }

  // ---------------------------------------------------------- leaderboard

  /**
   * Players ranked by robots tricked, then bounty won, then fewest rounds. Built only from the
   * contracts' events: Breached / Defended (RobotRegistryV3) and BountyClaimed (EscrowVaultV2).
   */
  /** The latest judged rounds, newest first, all from chain events: for the live feed. */
  async activity(limit = 12) {
    await this.d.ledger.sync();
    const started = new Map(this.d.ledger.sessions().map((s) => [s.sessionId, s.expiresAt - this.d.sessionTtl]));
    const won = new Map<number, bigint>();
    for (const c of this.d.ledger.claims()) won.set(c.sessionId, (won.get(c.sessionId) ?? 0n) + c.amountWei);
    const latest = [...this.d.ledger.results()].sort((a, b) => (b.block > a.block ? 1 : b.block < a.block ? -1 : b.sessionId - a.sessionId)).slice(0, limit);
    const names = new Map<number, string>();
    await Promise.all(
      [...new Set(latest.map((r) => r.robotId))].map(async (id) => names.set(id, (await this.d.chain.readRobot(id))?.name ?? `Robot #${id}`)),
    );
    return latest.map((r) => ({
      sessionId: r.sessionId,
      robotId: r.robotId,
      robot: names.get(r.robotId)!,
      player: r.player,
      breached: r.breached,
      wonWei: (won.get(r.sessionId) ?? 0n).toString(),
      at: started.get(r.sessionId) ?? null,
    }));
  }

  /** A robot's public record: its rounds (newest first), what they paid, its profile. */
  async robotRecord(robotIdRaw: unknown, limit = 25) {
    const robotId = Number(robotIdRaw);
    if (!Number.isSafeInteger(robotId) || robotId < 1) throw new GameError(400, "bad robot id");
    await this.d.ledger.sync();
    const started = new Map(this.d.ledger.sessions().map((s) => [s.sessionId, s.expiresAt - this.d.sessionTtl]));
    const won = new Map<number, bigint>();
    let paidWei = 0n;
    for (const c of this.d.ledger.claims()) {
      won.set(c.sessionId, (won.get(c.sessionId) ?? 0n) + c.amountWei);
    }
    const mine = this.d.ledger.results().filter((r) => r.robotId === robotId);
    for (const r of mine) paidWei += won.get(r.sessionId) ?? 0n;
    const rounds = [...mine]
      .sort((a, b) => (b.block > a.block ? 1 : b.block < a.block ? -1 : b.sessionId - a.sessionId))
      .slice(0, limit)
      .map((r) => ({
        sessionId: r.sessionId,
        player: r.player,
        breached: r.breached,
        wonWei: (won.get(r.sessionId) ?? 0n).toString(),
        at: started.get(r.sessionId) ?? null,
      }));
    return { robotId, rounds, totalRounds: mine.length, breaches: mine.filter((r) => r.breached).length, paidWei: paidWei.toString(), profile: this.d.store.getProfile(robotId) };
  }

  /** What the owner signs to set the robot's public profile (job, and its look when chosen). */
  private profileText(robotId: number, owner: Address, job: string, deadline: number, look: RobotLook | null) {
    const lookLines = look ? `\nbody: ${look.kind}\ncolor: ${look.color}` : "";
    return `RedZone robot profile\nrobot: ${robotId}\nowner: ${owner.toLowerCase()}\njob: ${job}${lookLines}\ndeadline: ${deadline}`;
  }

  /** The robot's body and colour: both or neither (older clients send neither). */
  private cleanLook(kind: unknown, color: unknown): RobotLook | null {
    if ((kind === undefined || kind === "") && (color === undefined || color === "")) return null;
    if (typeof kind !== "string" || !ROBOT_KINDS.includes(kind)) throw new GameError(400, `body must be one of: ${ROBOT_KINDS.join(", ")}`);
    if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) throw new GameError(400, "color must look like #36c5ff");
    return { kind, color: color.toLowerCase() };
  }

  private cleanJob(raw: unknown): string {
    if (typeof raw !== "string") throw new GameError(400, "job must be text");
    const job = raw.replace(/\s+/g, " ").trim();
    if (job.length < 3 || job.length > 280) throw new GameError(400, "describe the robot's job in 3 to 280 characters");
    return job;
  }

  async profileRequest(input: { robotId: unknown; owner: unknown; job: unknown; kind?: unknown; color?: unknown }) {
    const robotId = Number(input.robotId);
    if (!Number.isSafeInteger(robotId) || robotId < 1) throw new GameError(400, "bad robot id");
    const job = this.cleanJob(input.job);
    const look = this.cleanLook(input.kind, input.color);
    const owner = toEvmAddress(input.owner);
    if (!owner) throw new GameError(400, "bad owner address");
    const robot = await this.d.chain.readRobot(robotId);
    if (!robot) throw new GameError(404, "robot not found");
    if (robot.owner.toLowerCase() !== owner.toLowerCase()) throw new GameError(403, "only the robot's owner can describe it");
    const deadline = this.now() + REQUEST_TTL;
    return { robotId, owner, job, ...look, deadline, text: this.profileText(robotId, owner, job, deadline, look) };
  }

  /** Save a QoreX-signed job description (off chain: it is a label, not part of the game). */
  async saveProfile(input: { robotId?: unknown; owner?: unknown; job?: unknown; kind?: unknown; color?: unknown; deadline?: unknown; pqSignature?: unknown }) {
    const robotId = Number(input.robotId);
    if (!Number.isSafeInteger(robotId) || robotId < 1) throw new GameError(400, "bad robot id");
    const job = this.cleanJob(input.job);
    const look = this.cleanLook(input.kind, input.color);
    const deadline = this.checkDeadline(input.deadline);
    const sig = decodePqSignature(input.pqSignature);
    if (!sig) throw new GameError(400, "pqSignature missing or malformed");
    const owner = toEvmAddress(input.owner);
    if (!owner) throw new GameError(400, "bad owner address");
    const robot = await this.d.chain.readRobot(robotId);
    if (!robot) throw new GameError(404, "robot not found");
    if (robot.owner.toLowerCase() !== owner.toLowerCase()) throw new GameError(403, "only the robot's owner can describe it");
    const key = await this.d.chain.readPqcKey(owner);
    if (!key.registered || !verifyWalletSignature(key.pubkey, this.profileText(robotId, owner, job, deadline, look), sig)) {
      throw new GameError(401, "signature does not match this request");
    }
    const profile = { job, ...look, owner: owner.toLowerCase(), updatedAt: this.now() };
    this.d.store.saveProfile(robotId, profile);
    return profile;
  }

  /** A player's chosen nickname: 3-20 letters, digits, spaces, dots, dashes or underscores. */
  private cleanName20(raw: unknown): string {
    if (typeof raw !== "string") throw new GameError(400, "name must be text");
    const name = raw.replace(/\s+/g, " ").trim();
    if (!/^[\p{L}\p{N} ._-]{3,20}$/u.test(name)) throw new GameError(400, "use 3 to 20 letters, numbers, spaces, dots, dashes or underscores");
    // Names that would let a player pass as the site's staff in feeds and leaderboards.
    const plain = name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    if (RESERVED_NAMES.some((r) => plain.includes(r))) throw new GameError(400, "that name is reserved, try another");
    return name;
  }

  /** The picture is one of the site's preset icons (by id), or empty for the generated pixel one. */
  private cleanAvatar(raw: unknown): string {
    if (raw === undefined || raw === null || raw === "") return "";
    if (typeof raw !== "string" || !/^[a-z0-9-]{1,24}$/.test(raw)) throw new GameError(400, "unknown picture");
    return raw;
  }

  /** Name optional (empty keeps the generated one), picture optional. */
  private cleanNameOpt(raw: unknown): string {
    if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) return "";
    return this.cleanName20(raw);
  }

  private nameText(evm: Address, name: string, avatar: string, deadline: number) {
    return `RedZone player profile\nplayer: ${evm.toLowerCase()}\nname: ${name}\npicture: ${avatar || "generated"}\ndeadline: ${deadline}`;
  }

  private nameTaken(evm: Address, name: string): boolean {
    const want = name.toLowerCase();
    return Object.entries(this.d.store.playerNames()).some(([a, n]) => a !== evm.toLowerCase() && n.toLowerCase() === want);
  }

  /** What the player signs in QoreX to set their nickname. */
  nameRequest(input: { player: unknown; name: unknown; avatar?: unknown }) {
    const evm = toEvmAddress(input.player);
    if (!evm) throw new GameError(400, "bad address");
    const name = this.cleanNameOpt(input.name);
    const avatar = this.cleanAvatar(input.avatar);
    if (name && this.nameTaken(evm, name)) throw new GameError(409, "that name is taken, try another");
    const deadline = this.now() + REQUEST_TTL;
    return { name, avatar, deadline, text: this.nameText(evm, name, avatar, deadline) };
  }

  async saveName(input: { player?: unknown; name?: unknown; avatar?: unknown; deadline?: unknown; pqSignature?: unknown }) {
    const evm = toEvmAddress(input.player);
    if (!evm) throw new GameError(400, "bad address");
    const name = this.cleanNameOpt(input.name);
    const avatar = this.cleanAvatar(input.avatar);
    const deadline = this.checkDeadline(input.deadline);
    const sig = decodePqSignature(input.pqSignature);
    if (!sig) throw new GameError(400, "pqSignature missing or malformed");
    const key = await this.d.chain.readPqcKey(evm);
    if (!key.registered || !verifyWalletSignature(key.pubkey, this.nameText(evm, name, avatar, deadline), sig)) {
      throw new GameError(401, "signature does not match this request");
    }
    return this.once(`name-${(name || evm).toLowerCase()}`, async () => {
      if (name && this.nameTaken(evm, name)) throw new GameError(409, "that name is taken, try another");
      this.d.store.savePlayer(evm, { name, avatar });
      this.profiles.delete(evm.toLowerCase());
      return { name, avatar };
    });
  }

  private profiles = new Map<string, { at: number; value: Promise<unknown> }>();

  /**
   * Everything a player's profile page shows: wallet balance and payments (read from the chain),
   * rounds played, prizes won with their proofs, tries bought and leaderboard rank. Cached 15 s.
   */
  async playerProfile(addressRaw: unknown) {
    const evm = toEvmAddress(addressRaw);
    if (!evm) throw new GameError(400, "address must be a qor1… or 0x… address");
    const key = evm.toLowerCase();
    const hit = this.profiles.get(key);
    if (hit && Date.now() - hit.at < 15_000) return hit.value;
    const value = this.buildProfile(evm);
    this.profiles.set(key, { at: Date.now(), value });
    value.catch(() => this.profiles.delete(key));
    return value;
  }

  private async buildProfile(evm: Address) {
    const me = evm.toLowerCase();
    const qor = toQorAddress(evm);
    await this.d.ledger.sync();
    const started = new Map(this.d.ledger.sessions().map((s) => [s.sessionId, s.expiresAt - this.d.sessionTtl]));
    const mine = this.d.ledger
      .results()
      .filter((r) => r.player.toLowerCase() === me)
      .sort((a, b) => (b.block > a.block ? 1 : b.block < a.block ? -1 : b.sessionId - a.sessionId));
    const bySession = new Map(mine.map((r) => [r.sessionId, r]));
    const claims = this.d.ledger.claims().filter((c) => c.player.toLowerCase() === me);
    const wonBySession = new Map<number, bigint>();
    for (const c of claims) wonBySession.set(c.sessionId, (wonBySession.get(c.sessionId) ?? 0n) + c.amountWei);

    const robotIds = [...new Set(mine.map((r) => r.robotId))];
    const names = new Map<number, string>();
    await Promise.all(robotIds.map(async (id) => names.set(id, (await this.d.chain.readRobot(id))?.name ?? `Robot #${id}`)));

    const rounds = mine.slice(0, 50).map((r) => ({
      sessionId: r.sessionId,
      robotId: r.robotId,
      robot: names.get(r.robotId)!,
      breached: r.breached,
      wonWei: (wonBySession.get(r.sessionId) ?? 0n).toString(),
      at: started.get(r.sessionId) ?? null,
      tx: r.tx,
      replayHash: r.replayHash,
    }));
    const prizes = claims.map((c) => {
      const r = bySession.get(c.sessionId);
      return {
        bountyId: c.bountyId,
        sessionId: c.sessionId,
        robotId: r?.robotId ?? null,
        robot: r ? names.get(r.robotId)! : null,
        amountWei: c.amountWei.toString(),
        tx: c.tx,
        resultTx: r?.tx ?? null,
        replayHash: c.replayHash,
        at: started.get(c.sessionId) ?? null,
      };
    });
    const tries = this.d.ledger
      .tries()
      .filter((t) => t.player.toLowerCase() === me)
      .map((t) => ({ count: t.count, paidWei: t.paidWei.toString(), tx: t.tx }));

    const board = await this.leaderboard(1000);
    const row = board.find((b) => b.player.toLowerCase() === me);

    // Wallet: native QOR balance and recent transfers, labelled when they're RedZone payments.
    const ours = new Set([this.d.signup?.payTo, this.d.prize?.payTo].filter(Boolean) as string[]);
    const [balance, txs] = await Promise.all([
      this.d.ledger.balance ? this.d.ledger.balance(qor).catch(() => null) : Promise.resolve(null),
      this.d.ledger.wallet ? this.d.ledger.wallet(qor).catch(() => null) : Promise.resolve(null),
    ]);
    // Only RedZone payments: to or from RedZone, or carrying a RedZone memo. Private transfers stay out.
    const wallet = (txs ?? [])
      .filter((t) => t.uqor > 0n && (ours.has(t.from === qor ? t.to : t.from) || /^RedZone /.test(t.memo.trim())))
      .map((t) => {
      const out = t.from === qor;
      const other = out ? t.to : t.from;
      const memo = t.memo.trim();
      const bounty = /^RedZone bounty #(\d+)/.exec(memo);
      const [kind, label] =
        memo === SIGNUP_MEMO
          ? ["signup", "Account verification"]
          : memo.startsWith(TRIES_MEMO)
            ? ["tries", "Bought extra tries"]
            : bounty
              ? ["bounty", `Bounty for robot #${bounty[1]}`]
              : out
                ? ours.has(other)
                  ? ["sent", "Paid to RedZone"]
                  : ["sent", "Sent QOR"]
                : ours.has(other)
                  ? ["received", "From RedZone"]
                  : ["received", "Received QOR"];
      return {
        txHash: t.txHash,
        time: t.time,
        height: t.height,
        direction: out ? "out" : "in",
        uqor: t.uqor.toString(),
        memo,
        kind,
        label,
        counterparty: other,
        redzone: ours.has(other),
        ok: t.code === 0,
      };
    });

    const earnedWei = claims.reduce((s, c) => s + c.amountWei, 0n);
    const wins = mine.filter((r) => r.breached).length;
    const beaten = new Map<string, number>();
    for (const r of mine) if (r.breached) beaten.set(names.get(r.robotId)!, (beaten.get(names.get(r.robotId)!) ?? 0) + 1);

    return {
      evm,
      qor,
      balanceUqor: balance === null ? null : balance.toString(),
      stats: {
        rounds: mine.length,
        wins,
        defended: mine.length - wins,
        earnedWei: earnedWei.toString(),
        rank: row?.rank ?? null,
        players: board.length,
        triesBought: tries.reduce((s, t) => s + t.count, 0),
        robotsFaced: robotIds.length,
        firstRoundAt: mine.length ? (started.get(mine[mine.length - 1]!.sessionId) ?? null) : null,
        beaten: [...beaten.entries()].map(([robot, n]) => ({ robot, n })),
      },
      rounds,
      prizes,
      tries,
      wallet,
      walletAvailable: txs !== null,
    };
  }

  async leaderboard(limit = 50) {
    await this.d.ledger.sync();
    const by = new Map<string, { player: Address; attempts: number; wins: number; wonWei: bigint }>();
    const row = (p: Address) => {
      const k = p.toLowerCase();
      let r = by.get(k);
      if (!r) by.set(k, (r = { player: p, attempts: 0, wins: 0, wonWei: 0n }));
      return r;
    };
    for (const e of this.d.ledger.results()) {
      const r = row(e.player);
      r.attempts++;
      if (e.breached) r.wins++;
    }
    for (const c of this.d.ledger.claims()) row(c.player).wonWei += c.amountWei;
    return [...by.values()]
      .sort((a, b) => b.wins - a.wins || (b.wonWei > a.wonWei ? 1 : b.wonWei < a.wonWei ? -1 : 0) || a.attempts - b.attempts)
      .slice(0, limit)
      .map((r, i) => ({ rank: i + 1, player: r.player, qor: toQorAddress(r.player), attempts: r.attempts, wins: r.wins, wonWei: r.wonWei.toString() }));
  }

  // ---------------------------------------------------------- owners (QoreX + relayer)

  /** Names the contract accepts: printable ASCII, no leading/trailing space, 1 to 64 bytes. */
  private cleanName(raw: unknown): string {
    if (typeof raw !== "string") throw new GameError(400, "name is required");
    const name = raw.trim();
    if (!name || name.length > 64 || !/^[\x20-\x7e]+$/.test(name)) {
      throw new GameError(400, "robot name must be 1 to 64 plain characters (letters, numbers, spaces, punctuation)");
    }
    return name;
  }

  private knownBrain(raw: unknown): Hex {
    if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new GameError(400, "bad brainHash");
    const hash = raw.toLowerCase() as Hex;
    if (!this.d.brains.config(hash)) throw new GameError(404, "unknown brain: publish it first (POST /brains)");
    return hash;
  }

  /** A brain with an owner's API key can only go on robots of the owner who first used it. */
  private checkBrainOwner(brain: Hex, owner: Address): void {
    if (!this.d.brains.canUse(brain, owner)) throw new GameError(403, "this brain uses someone else's API key: create your own brain");
  }

  /** Checks shared by every owner request: valid address, PQ key, signed up. */
  private async ownerReady(raw: unknown): Promise<{ owner: Address; nonce: bigint; pubkey: Hex }> {
    const owner = toEvmAddress(raw);
    if (!owner) throw new GameError(400, "owner must be a qor1… or 0x… address");
    const [key, state] = await Promise.all([this.d.chain.readPqcKey(owner), this.d.chain.readPlayer(owner)]);
    if (!key.registered) throw new GameError(409, "this account has no ML-DSA-87 key registered yet (register it in QoreX first)");
    if (!(await this.isSignedUp(owner))) throw new GameError(402, "sign up first: a one-time payment verifies your account");
    return { owner, nonce: state.nonce, pubkey: key.pubkey };
  }

  private checkDeadline(raw: unknown): number {
    const deadline = Number(raw);
    if (!Number.isSafeInteger(deadline) || deadline < this.now() || deadline > this.now() + 3600) {
      throw new GameError(400, "deadline expired or too far away: request a new one");
    }
    return deadline;
  }

  private async relayRegistry(data: Hex, event: "RobotRegistered" | "BrainUpdated") {
    const r = await this.d.relayer!.send(this.d.registry, data);
    if (r.status !== "success") throw new GameError(502, `transaction reverted on chain (${r.hash})`);
    for (const log of r.logs) {
      try {
        const ev = decodeEventLog({ abi: registryAbi, data: log.data, topics: log.topics });
        if (ev.eventName === event) return { robotId: Number((ev.args as { robotId: bigint }).robotId), tx: r.hash };
      } catch {
        // not our event
      }
    }
    throw new GameError(502, `sent, but no ${event} event found (${r.hash})`);
  }

  /** What the owner's wallet must sign to register a robot. */
  async robotRequest(input: { owner: unknown; name: unknown; brainHash: unknown }) {
    const name = this.cleanName(input.name);
    const brain = this.knownBrain(input.brainHash);
    const { owner, nonce } = await this.ownerReady(input.owner);
    this.checkBrainOwner(brain, owner);
    const deadline = this.now() + REQUEST_TTL;
    const digest = registerRobotDigest(this.d.chainId, this.d.registry, owner, name, brain, nonce, BigInt(deadline));
    return { owner, name, brainHash: brain, nonce: nonce.toString(), deadline, digest, text: walletText("RegisterRobot", digest) };
  }

  /** Relay a QoreX-signed RegisterRobot request. The signature is checked here first so bad ones cost no gas. */
  async registerRobot(input: { owner: unknown; name: unknown; brainHash: unknown; deadline: unknown; pqSignature: unknown }) {
    if (!this.d.relayer) throw new GameError(503, "no relayer configured");
    const name = this.cleanName(input.name);
    const brain = this.knownBrain(input.brainHash);
    const deadline = this.checkDeadline(input.deadline);
    const sig = decodePqSignature(input.pqSignature);
    if (!sig) throw new GameError(400, "pqSignature missing or malformed");
    const pre = toEvmAddress(input.owner);
    if (!pre) throw new GameError(400, "bad owner address");
    return this.once(`nonce-${pre.toLowerCase()}`, async () => {
      const { owner, nonce, pubkey } = await this.ownerReady(pre);
      this.checkBrainOwner(brain, owner);
      const digest = registerRobotDigest(this.d.chainId, this.d.registry, owner, name, brain, nonce, BigInt(deadline));
      if (!verifyWalletSignature(pubkey, walletText("RegisterRobot", digest), sig)) {
        throw new GameError(401, "signature does not match this request (it may be used already: request a new one)");
      }
      const data = encodeFunctionData({ abi: registryAbi, functionName: "registerRobotFor", args: [owner, name, brain, BigInt(deadline), sig] });
      const out = await this.relayRegistry(data, "RobotRegistered");
      this.d.brains.bindOwner(brain, owner);
      return { ...out, owner, name, brainHash: brain };
    });
  }

  /** What the owner's wallet must sign to give a robot a new brain (this resets its stats). */
  async brainUpdateRequest(input: { robotId: unknown; owner: unknown; brainHash: unknown }) {
    const robotId = Number(input.robotId);
    if (!Number.isSafeInteger(robotId) || robotId < 1) throw new GameError(400, "bad robotId");
    const brain = this.knownBrain(input.brainHash);
    const { owner, nonce } = await this.ownerReady(input.owner);
    const robot = await this.d.chain.readRobot(robotId);
    if (!robot) throw new GameError(404, "robot not found");
    if (robot.owner.toLowerCase() !== owner.toLowerCase()) throw new GameError(403, "only the robot's owner can change its brain");
    if (robot.brainHash.toLowerCase() === brain) throw new GameError(409, "the robot already uses this brain");
    this.checkBrainOwner(brain, owner);
    const deadline = this.now() + REQUEST_TTL;
    const digest = updateBrainDigest(this.d.chainId, this.d.registry, BigInt(robotId), brain, nonce, BigInt(deadline));
    return { robotId, owner, brainHash: brain, nonce: nonce.toString(), deadline, digest, text: walletText("UpdateBrain", digest) };
  }

  /** Relay a QoreX-signed UpdateBrain request. */
  async updateBrain(input: { robotId: unknown; owner: unknown; brainHash: unknown; deadline: unknown; pqSignature: unknown }) {
    if (!this.d.relayer) throw new GameError(503, "no relayer configured");
    const robotId = Number(input.robotId);
    if (!Number.isSafeInteger(robotId) || robotId < 1) throw new GameError(400, "bad robotId");
    const brain = this.knownBrain(input.brainHash);
    const deadline = this.checkDeadline(input.deadline);
    const sig = decodePqSignature(input.pqSignature);
    if (!sig) throw new GameError(400, "pqSignature missing or malformed");
    const pre = toEvmAddress(input.owner);
    if (!pre) throw new GameError(400, "bad owner address");
    return this.once(`nonce-${pre.toLowerCase()}`, async () => {
      const { owner, nonce, pubkey } = await this.ownerReady(pre);
      const robot = await this.d.chain.readRobot(robotId);
      if (!robot) throw new GameError(404, "robot not found");
      if (robot.owner.toLowerCase() !== owner.toLowerCase()) throw new GameError(403, "only the robot's owner can change its brain");
      this.checkBrainOwner(brain, owner);
      const digest = updateBrainDigest(this.d.chainId, this.d.registry, BigInt(robotId), brain, nonce, BigInt(deadline));
      if (!verifyWalletSignature(pubkey, walletText("UpdateBrain", digest), sig)) {
        throw new GameError(401, "signature does not match this request (it may be used already: request a new one)");
      }
      const data = encodeFunctionData({ abi: registryAbi, functionName: "updateBrain", args: [BigInt(robotId), brain, BigInt(deadline), sig] });
      const out = await this.relayRegistry(data, "BrainUpdated");
      this.d.brains.bindOwner(brain, owner);
      return { ...out, brainHash: brain };
    });
  }

  /** Run the 10 normal tasks and sign the score. Cached per robot, brain and utilityNonce. */
  async utility(robotIdRaw: unknown): Promise<UtilityVerdict> {
    const robotId = Number(robotIdRaw);
    if (!Number.isSafeInteger(robotId) || robotId < 1) throw new GameError(400, "bad robotId");
    const robot = await this.d.chain.readRobot(robotId);
    if (!robot) throw new GameError(404, "robot not found");
    // Once per brain version: anyone may ask for the skills test, but each run costs AI calls and a
    // relayed transaction, and recording a score unlocks the next nonce. A new run needs a new brain,
    // which only the owner can set (ML-DSA signed updateBrain).
    const doneKey = `utility-done-${robotId}-v${robot.brainVersion}`;
    const done = this.d.store.getVerdict<UtilityVerdict>(doneKey);
    if (done) return done;
    if (robot.utilityScore > 0) throw new GameError(409, "this robot's skills are already tested for its current brain");
    const key = `utility-${robotId}-${robot.utilityNonce}-${robot.brainHash.slice(2, 18)}`;

    return this.once(key, async () => {
      const done = this.d.store.getVerdict<UtilityVerdict>(key);
      if (done) return done.relay?.error ? this.relayUtility(key, done) : done;
      const brain = this.brainFor(robot);
      const tasks = [];
      for (const t of this.d.arena.utilityTasks) {
        const out = await this.think(brain, t.instruction, robot.brainHash);
        const waypoints = actionsToWaypoints(this.d.arena, out.actions);
        const trace = simulate(this.d.arena, waypoints);
        tasks.push({ id: t.id, instruction: t.instruction, target: t.target, brain: { say: out.say, actions: out.actions, model: out.model }, waypoints, trace, passed: taskPassed(this.d.arena, trace, t.target) });
      }
      const tasksPassed = tasks.filter((t) => t.passed).length;
      const replayHash = this.d.store.saveReplay({
        v: 1,
        kind: "utility",
        chainId: this.d.chainId,
        registry: this.d.registry.toLowerCase(),
        arena: this.d.arena.id,
        robotId,
        brainHash: robot.brainHash,
        utilityNonce: robot.utilityNonce,
        tasks,
        tasksPassed,
        judgedAt: this.now(),
      });
      const deadline = BigInt(this.now() + UTILITY_WINDOW);
      const digest = utilityDigest(this.d.chainId, this.d.registry, BigInt(robotId), tasksPassed, replayHash, BigInt(robot.utilityNonce), deadline);
      const verdict: UtilityVerdict = {
        robotId,
        brainHash: robot.brainHash,
        utilityNonce: robot.utilityNonce,
        tasksPassed,
        tasks: tasks.map((t) => ({ id: t.id, passed: t.passed })),
        replayHash,
        deadline: deadline.toString(),
        refereeSig: signDigest(this.d.key, digest),
      };
      this.d.store.saveVerdict(key, verdict);
      return this.relayUtility(key, verdict);
    });
  }

  /** Record the skills score on chain through the relayer (if there is one). Errors are kept so a later call retries. */
  private async relayUtility(key: string, v: UtilityVerdict): Promise<UtilityVerdict> {
    if (!this.d.relayer) return v;
    let relay: UtilityVerdict["relay"];
    try {
      const r = await this.d.relayer.send(
        this.d.registry,
        encodeFunctionData({
          abi: registryAbi,
          functionName: "recordUtility",
          args: [BigInt(v.robotId), v.tasksPassed, v.replayHash, BigInt(v.deadline), this.d.key.publicKey, v.refereeSig],
        }),
      );
      relay = r.status === "success" ? { tx: r.hash } : { error: `recordUtility reverted (${r.hash})` };
      if (r.status === "success") {
        const robot = await this.d.chain.readRobot(v.robotId).catch(() => null);
        // Brain version at the time of the score (the score is reset by updateBrain, so it is this one).
        if (robot) this.d.store.saveVerdict(`utility-done-${v.robotId}-v${robot.brainVersion}`, { ...v, relay: { tx: r.hash } });
      }
    } catch (e) {
      relay = { error: (e as Error).message.slice(0, 300) };
    }
    const out = { ...v, relay };
    this.d.store.saveVerdict(key, out);
    return out;
  }

  private arenaBrainCache: { at: number; hashes: Set<string> } | null = null;

  /** brainHashes currently guarding a robot on chain (cached briefly). */
  private async arenaBrains(): Promise<Set<string>> {
    if (this.arenaBrainCache && this.now() - this.arenaBrainCache.at < ARENA_BRAINS_TTL) return this.arenaBrainCache.hashes;
    const next = await this.d.chain.readNextRobotId();
    const hashes = new Set<string>();
    for (let i = 1; i < next; i++) {
      const r = await this.d.chain.readRobot(i);
      if (!r) continue;
      hashes.add(r.brainHash.toLowerCase());
      // A legacy alias maps to a real config: block that config's own hash too.
      const config = this.d.brains.config(r.brainHash);
      if (config) hashes.add(brainHash(config).toLowerCase());
    }
    this.arenaBrainCache = { at: this.now(), hashes };
    return hashes;
  }

  /**
   * Off-chain practice: nothing is signed or stored. Players practise on the training robot
   * (TRAINING_BRAIN). Owners can test a brain before they put it on a robot, but no brain that
   * already guards a robot in the arena can be practised, so a winning message can't be found
   * for free and replayed for the bounty.
   */
  async practice(input: { brainHash: unknown; instruction: unknown }) {
    const instruction = cleanInstruction(input.instruction);
    if (typeof input.brainHash !== "string") throw new GameError(400, "brainHash missing");
    let brain: ReturnType<BrainRegistry["brain"]>;
    if (input.brainHash === TRAINING_BRAIN) {
      brain = new RuleBrain(false);
    } else {
      brain = this.d.brains.brain(input.brainHash);
      if (!brain) throw new GameError(404, "unknown brain");
      const config = this.d.brains.config(input.brainHash);
      const arena = await this.arenaBrains();
      const guarding = [input.brainHash, config ? brainHash(config) : null].some((h) => h && arena.has(h.toLowerCase()));
      if (guarding) throw new GameError(403, "this brain guards a robot in the arena, so it can only be challenged in a bounty round");
    }
    const out = await this.think(brain, instruction, input.brainHash === TRAINING_BRAIN ? undefined : input.brainHash);
    const waypoints = actionsToWaypoints(this.d.arena, out.actions);
    const trace = simulate(this.d.arena, waypoints);
    return { practice: true, breached: trace.breached, say: out.say, actions: out.actions, model: out.model, waypoints, trace };
  }
}
