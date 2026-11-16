/**
 * Game logic: judge an attack session, score utility, run practice rounds.
 * Chain reads are injected so tests run offline.
 */
import { decodeEventLog, encodeAbiParameters, encodeFunctionData, keccak256, verifyMessage, type Address, type Hex } from "viem";
import type { Arena } from "./arena.js";
import { actionsToWaypoints } from "./brains/actions.js";
import type { BrainRegistry } from "./brains/registry.js";
import type { BrainOutput } from "./brains/types.js";
import { registryAbi, robotKey, vaultAbi, type BountyView, type NativeTransfer, type RobotView, type SessionView } from "./chain.js";
import type { LedgerReader, Transfer } from "./ledger.js";
import { SIGNUP_MEMO, decodePqSignature, toEvmAddress, toQorAddress, verifyWalletSignature, walletText } from "./qorex.js";
import { simulate, taskPassed, type Trace } from "./referee.js";
import type { Relayer } from "./relayer.js";
import { claimDigest, registerRobotDigest, resultDigest, signDigest, startSessionDigest, updateBrainDigest, utilityDigest, withdrawDigest, type RefereeKey } from "./signer.js";
import type { Store } from "./store.js";

/** A signed StartSession request is valid for this long (the contract allows at most 1 hour). */
export const REQUEST_TTL = 15 * 60;

export const MAX_INSTRUCTION = 500;
export const CLAIM_WINDOW = 7 * 24 * 3600;
export const UTILITY_WINDOW = 24 * 3600;

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
  openBounties(robotId: number): Promise<{ id: number; amountWei: string }[]>;
  readPqcKey(account: Address): Promise<{ registered: boolean; algorithmId: number; pubkey: Hex }>;
  readPlayer(player: Address): Promise<{ nonce: bigint; attemptsLeft: number }>;
  readNativeTransfer(txHash: string): Promise<NativeTransfer | null>;
  readBounty(id: number): Promise<BountyView>;
  readVaultNonce(account: Address): Promise<bigint>;
  readNextRobotId(): Promise<number>;
  /** A deposit we sent: pending (not mined or not found), success with its BountyDeposited, or reverted. */
  readDeposit(hash: Hex): Promise<{ status: "pending" | "success" | "reverted"; bountyId?: number; amountWei: bigint }>;
};

/** Makers pay bounties to the relayer (QoreX can't call contracts yet); the relayer locks them in the vault. */
export type PrizeConfig = { minUqor: bigint; payTo: string };
export const bountyMemo = (robotId: number) => `RedZone bounty #${robotId}`;
/** 10,000 QOR: a sanity cap on a single bounty payment. */
const MAX_BOUNTY_UQOR = 10_000n * 1_000_000n;
const WEI_PER_UQOR = 10n ** 12n;

/** What the maker signs (checked by the referee) to take a bounty back. */
export function bountyBackDigest(chainId: number, vault: Address, bountyId: number, owner: Address, deadline: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }],
      ["RedZone.TakeBountyBack", BigInt(chainId), vault, BigInt(bountyId), owner, BigInt(deadline)],
    ),
  );
}

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
  /** Sends startSessionFor / recordResult / claimBounty for players. Optional: without it, players relay. */
  relayer?: Relayer | null;
  /** When set, players pay a small one-time fee before their first session. */
  signup?: SignupConfig | null;
  /** When set (with a relayer), makers can add prizes paid from QoreX. */
  prize?: PrizeConfig | null;
  now?: () => number;
};

export type RelayStatus = { resultTx?: Hex; claimTxs?: { bountyId: number; tx: Hex }[]; error?: string };

export type AttemptVerdict = {
  sessionId: number;
  robotId: number;
  player: Address;
  breached: boolean;
  say: string;
  trace: Trace;
  replayHash: Hex;
  /** Arguments for RobotRegistry.recordResult (anyone may relay). */
  result: { deadline: string; refereeSig: Hex };
  /** Arguments for EscrowVault.claimBounty, one per open bounty, paid to the player. */
  claims: { bountyId: number; amountWei: string; deadline: string; refereeSig: Hex }[];
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

  private async think(robotBrain: ReturnType<Game["brainFor"]>, instruction: string): Promise<BrainOutput> {
    try {
      return await robotBrain.plan(this.d.arena, instruction);
    } catch (e) {
      if ((e as Error).name === "BrainUnavailableError") {
        throw new GameError(503, `the robot's brain is busy, try again in a minute (${(e as Error).message})`);
      }
      throw e;
    }
  }

  /**
   * Judge one session. The player authorises the instruction with either:
   *   - `pqSignature`: the ML-DSA-87 part of a QoreX signArbitrary over attemptMessage (base64 or hex),
   *     checked against the player's key registered on chain; or
   *   - `signature`: an EVM personal_sign (0x) over attemptMessage, for EVM wallets.
   */
  async attempt(input: { sessionId: unknown; instruction: unknown; signature?: unknown; pqSignature?: unknown }): Promise<AttemptVerdict> {
    const sessionId = Number(input.sessionId);
    if (!Number.isSafeInteger(sessionId) || sessionId < 1) throw new GameError(400, "bad sessionId");
    const instruction = cleanInstruction(input.instruction);
    const pqSignature = input.pqSignature === undefined ? null : decodePqSignature(input.pqSignature);
    if (input.pqSignature !== undefined && !pqSignature) throw new GameError(400, "pqSignature is not a valid signature encoding");
    const ecdsa = typeof input.signature === "string" && /^0x[0-9a-fA-F]{130}$/.test(input.signature) ? (input.signature as Hex) : null;
    if (!pqSignature && !ecdsa) throw new GameError(400, "signature missing");
    const signature = (pqSignature ?? ecdsa)!;

    return this.once(`session-${sessionId}`, async () => {
      const done = this.d.store.getVerdict<AttemptVerdict>(`session-${sessionId}`);
      if (done) return done; // one verdict per session, no re-rolls

      const session = await this.d.chain.readSession(sessionId);
      if (!session) throw new GameError(404, "session not found on chain");
      if (session.outcome !== 0) throw new GameError(409, "session already has a result on chain");
      if (this.now() > session.startedAt + this.d.sessionTtl) throw new GameError(410, "session expired (10 minutes)");

      const message = attemptMessage(this.d.chainId, this.d.registry, sessionId, instruction);
      let ok = false;
      if (pqSignature) {
        const key = await this.d.chain.readPqcKey(session.player);
        ok = key.registered && verifyWalletSignature(key.pubkey, message, pqSignature);
      } else {
        ok = await verifyMessage({ address: session.player, message, signature: ecdsa! }).catch(() => false);
      }
      if (!ok) throw new GameError(401, "signature is not from the session's player");

      const robot = await this.d.chain.readRobot(session.robotId);
      if (!robot) throw new GameError(404, "robot not found");
      const out = await this.think(this.brainFor(robot), instruction);
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
        refereeSig: signDigest(this.d.key, resultDigest(this.d.chainId, this.d.registry, BigInt(sessionId), trace.breached, replayHash, resultDeadline)),
      };

      const claims: AttemptVerdict["claims"] = [];
      if (trace.breached) {
        const claimDeadline = BigInt(this.now() + CLAIM_WINDOW);
        for (const b of await this.d.chain.openBounties(session.robotId)) {
          const digest = claimDigest(this.d.chainId, this.d.vault, BigInt(b.id), session.player, replayHash, claimDeadline);
          claims.push({ bountyId: b.id, amountWei: b.amountWei, deadline: claimDeadline.toString(), refereeSig: signDigest(this.d.key, digest) });
        }
      }

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

  /** Put a verdict on chain: recordResult, then claimBounty for each open bounty on a breach. */
  private async relayVerdict(v: AttemptVerdict): Promise<RelayStatus> {
    const relayer = this.d.relayer!;
    const status: RelayStatus = {};
    try {
      const r = await relayer.send(
        this.d.registry,
        encodeFunctionData({
          abi: registryAbi,
          functionName: "recordResult",
          args: [BigInt(v.sessionId), v.breached, v.replayHash, BigInt(v.result.deadline), v.result.refereeSig],
        }),
      );
      if (r.status !== "success") throw new Error(`recordResult reverted (${r.hash})`);
      status.resultTx = r.hash;
      for (const c of v.claims) {
        const cr = await relayer.send(
          this.d.vault,
          encodeFunctionData({
            abi: vaultAbi,
            functionName: "claimBounty",
            args: [BigInt(c.bountyId), v.player, v.replayHash, BigInt(c.deadline), c.refereeSig],
          }),
        );
        if (cr.status !== "success") throw new Error(`claimBounty ${c.bountyId} reverted (${cr.hash})`);
        (status.claimTxs ??= []).push({ bountyId: c.bountyId, tx: cr.hash });
      }
    } catch (e) {
      status.error = (e as Error).message.slice(0, 300);
    }
    return status;
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
    const [key, state, record] = await Promise.all([this.d.chain.readPqcKey(evm), this.d.chain.readPlayer(evm), this.signupFor(evm)]);
    return {
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
    if (!key.registered) throw new GameError(409, "this account has no ML-DSA-87 key registered yet (register it in QoreX first)");
    if (!(await this.isSignedUp(player))) throw new GameError(402, "sign up first: a one-time payment verifies your account");
    if (state.attemptsLeft < 1) throw new GameError(429, "no attempts left today (5 per UTC day)");
    const deadline = this.now() + REQUEST_TTL;
    const digest = startSessionDigest(this.d.chainId, this.d.registry, BigInt(robotId), player, state.nonce, BigInt(deadline));
    return { robotId, player, nonce: state.nonce.toString(), deadline, digest, text: walletText("StartSession", digest), attemptsLeft: state.attemptsLeft };
  }

  /** Relay a QoreX-signed StartSession request. The signature is checked here first so bad ones cost no gas. */
  async startSession(input: { robotId: unknown; player: unknown; deadline: unknown; pqSignature: unknown }) {
    if (!this.d.relayer) throw new GameError(503, "no relayer configured: start the session from an EVM wallet instead");
    const robotId = Number(input.robotId);
    const deadline = Number(input.deadline);
    const player = toEvmAddress(input.player);
    const sig = decodePqSignature(input.pqSignature);
    if (!Number.isSafeInteger(robotId) || robotId < 1) throw new GameError(400, "bad robotId");
    if (!player) throw new GameError(400, "bad player address");
    if (!sig) throw new GameError(400, "pqSignature missing or malformed");
    if (!(await this.isSignedUp(player))) throw new GameError(402, "sign up first: a one-time payment verifies your account");
    if (!Number.isSafeInteger(deadline) || deadline < this.now() || deadline > this.now() + 3600) {
      throw new GameError(400, "deadline expired or too far away: request a new one");
    }

    return this.once(`nonce-${player.toLowerCase()}`, async () => {
      const [key, state] = await Promise.all([this.d.chain.readPqcKey(player), this.d.chain.readPlayer(player)]);
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
            return { sessionId: Number(ev.args.sessionId), tx: r.hash, expiresAt: Number(ev.args.expiresAt), player };
          }
        } catch {
          // not our event
        }
      }
      throw new GameError(502, `session started but no SessionStarted event found (${r.hash})`);
    });
  }

  // ---------------------------------------------------------- bounties (paid in QoreX, locked by the relayer)
  //
  // QoreX can't call contracts yet, so a maker can't call EscrowVault.depositBounty themselves.
  // They pay the bounty to the relayer with a normal QoreX transfer (hybrid-signed), memo
  // "RedZone bounty #<robotId>", and the relayer deposits it into the vault for that robot.
  //
  // Everything here is worked out from the chain, not from files on this server:
  //   paid      = the robot owner's successful transfers to the relayer with that memo
  //   deposited = the vault's BountyDeposited events by the relayer for that robot
  // The relayer deposits only paid - deposited, so retries, restarts or a lost database can never
  // lock a payment twice. Withdrawals go only to the robot's on-chain owner.

  /** Sum of valid bounty payments for a robot, from the chain. */
  private async paidFor(robotId: number, owner: Address): Promise<{ total: bigint; txs: Transfer[] }> {
    const all = await this.d.ledger.transfers(toQorAddress(owner), this.d.prize!.payTo);
    const txs = all.filter((t) => t.memo.trim() === bountyMemo(robotId) && t.uqor >= this.d.prize!.minUqor && t.uqor <= MAX_BOUNTY_UQOR);
    return { total: txs.reduce((s, t) => s + t.uqor, 0n), txs };
  }

  /** Bounties the relayer deposited for a robot: chain events plus our own sends still being indexed. */
  private async depositedFor(robotId: number): Promise<{ total: bigint; ids: number[]; txs: Set<string> }> {
    await this.d.ledger.sync();
    const rk = robotKey(robotId).toLowerCase();
    const relayer = this.d.relayer!.address.toLowerCase();
    const mine = this.d.ledger.deposits().filter((e) => e.robotKey.toLowerCase() === rk && e.owner.toLowerCase() === relayer);
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
      if (tx.memo.trim() !== bountyMemo(robotId)) throw new GameError(400, `the payment memo must be "${bountyMemo(robotId)}"`);
      if (tx.uqor < this.d.prize!.minUqor) throw new GameError(400, "the bounty is smaller than the minimum");
      if (tx.uqor > MAX_BOUNTY_UQOR) throw new GameError(400, "the bounty is too large");

      const paid = await this.paidFor(robotId, owner);
      // The chain's tx index can lag a few seconds behind the tx itself.
      if (!paid.txs.some((t) => t.txHash === txHash)) throw new GameError(404, "payment not indexed on chain yet: wait a few seconds and try again");
      const dep = await this.depositedFor(robotId);
      const missing = paid.total - dep.total;
      if (missing <= 0n) return { robotId, bountyIds: dep.ids, lockedUqor: dep.total.toString(), depositTx: null };

      const pendingKey = `deposits-${robotId}`;
      const r = await this.d.relayer!.send(
        this.d.vault,
        encodeFunctionData({ abi: vaultAbi, functionName: "depositBounty", args: [robotKey(robotId)] }),
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

  /** robotKey -> robot id, for every robot on chain. */
  private async robotIdsByKey(): Promise<Map<string, number>> {
    const next = await this.d.chain.readNextRobotId();
    const m = new Map<string, number>();
    for (let i = 1; i < next; i++) m.set(robotKey(i).toLowerCase(), i);
    return m;
  }

  /** The maker's bounties still in the vault, read from the chain. */
  async ownerBounties(ownerRaw: unknown) {
    const owner = toEvmAddress(ownerRaw);
    if (!owner) throw new GameError(400, "bad owner address");
    if (!this.d.relayer) return [];
    await this.d.ledger.sync();
    const ids = await this.robotIdsByKey();
    const relayer = this.d.relayer.address.toLowerCase();
    const out: { robotId: number; bountyId: number; uqor: string }[] = [];
    for (const e of this.d.ledger.deposits()) {
      if (e.owner.toLowerCase() !== relayer) continue;
      const robotId = ids.get(e.robotKey.toLowerCase());
      if (!robotId) continue;
      const robot = await this.d.chain.readRobot(robotId);
      if (robot?.owner.toLowerCase() !== owner.toLowerCase()) continue;
      const b = await this.d.chain.readBounty(e.bountyId);
      if (b.status === 1) out.push({ robotId, bountyId: e.bountyId, uqor: (b.amountWei / WEI_PER_UQOR).toString() });
    }
    return out;
  }

  /** Checks shared by the take-back request and the take-back itself, all against the chain. */
  private async bountyForOwner(bountyId: number, owner: Address) {
    if (!this.d.relayer?.pqSign) throw new GameError(503, "no relayer configured");
    const b = await this.d.chain.readBounty(bountyId);
    if (b.owner.toLowerCase() !== this.d.relayer.address.toLowerCase()) throw new GameError(403, "this bounty wasn't added through RedZone");
    const robotId = (await this.robotIdsByKey()).get(b.robotKey.toLowerCase());
    const robot = robotId ? await this.d.chain.readRobot(robotId) : null;
    if (!robot || robot.owner.toLowerCase() !== owner.toLowerCase()) throw new GameError(403, "only the robot's owner can take its bounty back");
    if (b.status !== 1) throw new GameError(409, b.status === 2 ? "a player already won this bounty" : "this bounty is no longer in the vault");
    await this.checkNoPendingWin(robotId!);
    return { b, robotId: robotId! };
  }

  /**
   * A bounty can't be taken back while a player may still win it: a round against the robot is
   * running (or its result can still be recorded), or a recorded win has not been paid yet. This
   * closes the race where an owner withdraws between a breach verdict and its payout.
   */
  private async checkNoPendingWin(robotId: number): Promise<void> {
    await this.d.ledger.sync();
    const now = this.now();
    const results = this.d.ledger.results();
    const recorded = new Set(results.map((r) => r.sessionId));
    const live = this.d.ledger.sessions().some((s) => s.robotId === robotId && !recorded.has(s.sessionId) && s.expiresAt + this.d.resultGrace > now);
    if (live) throw new GameError(409, "a player is in a round against this robot right now: try again when it ends");
    const paid = new Set(this.d.ledger.claims().map((c) => c.replayHash.toLowerCase()));
    const expiry = new Map(this.d.ledger.sessions().map((s) => [s.sessionId, s.expiresAt]));
    const unpaid = results.some(
      (r) => r.robotId === robotId && r.breached && !paid.has(r.replayHash.toLowerCase()) && (expiry.get(r.sessionId) ?? now) + CLAIM_WINDOW > now,
    );
    if (unpaid) throw new GameError(409, "a player beat this robot and their bounty is being paid: it can't be taken back");
  }

  /** What the maker's wallet signs to take a bounty back. */
  async bountyBackRequest(input: { bountyId: unknown; owner: unknown }) {
    const bountyId = Number(input.bountyId);
    const owner = toEvmAddress(input.owner);
    if (!Number.isSafeInteger(bountyId) || bountyId < 1 || !owner) throw new GameError(400, "bad request");
    await this.bountyForOwner(bountyId, owner);
    const deadline = this.now() + REQUEST_TTL;
    const digest = bountyBackDigest(this.d.chainId, this.d.vault, bountyId, owner, deadline);
    return { bountyId, owner, deadline, digest, text: walletText("TakeBountyBack", digest) };
  }

  /** Withdraw a bounty to the robot's owner, after checking their QoreX ML-DSA signature. */
  async takeBountyBack(input: { bountyId: unknown; owner: unknown; deadline: unknown; pqSignature: unknown }) {
    const bountyId = Number(input.bountyId);
    const owner = toEvmAddress(input.owner);
    const deadline = this.checkDeadline(input.deadline);
    const sig = decodePqSignature(input.pqSignature);
    if (!Number.isSafeInteger(bountyId) || bountyId < 1 || !owner) throw new GameError(400, "bad request");
    if (!sig) throw new GameError(400, "pqSignature missing or malformed");

    return this.once(`bounty-${bountyId}`, async () => {
      const key = await this.d.chain.readPqcKey(owner);
      if (!key.registered) throw new GameError(409, "no ML-DSA-87 key registered for this account");
      if (!verifyWalletSignature(key.pubkey, walletText("TakeBountyBack", bountyBackDigest(this.d.chainId, this.d.vault, bountyId, owner, deadline)), sig)) {
        throw new GameError(401, "signature does not match this request");
      }
      const { b } = await this.bountyForOwner(bountyId, owner);
      const vaultDeadline = BigInt(this.now() + 600);
      const nonce = await this.d.chain.readVaultNonce(this.d.relayer!.address);
      const relayerSig = this.d.relayer!.pqSign!(withdrawDigest(this.d.chainId, this.d.vault, BigInt(bountyId), owner, nonce, vaultDeadline));
      const r = await this.d.relayer!.send(
        this.d.vault,
        encodeFunctionData({ abi: vaultAbi, functionName: "withdrawBounty", args: [BigInt(bountyId), owner, vaultDeadline, relayerSig] }),
      );
      if (r.status !== "success") throw new GameError(502, `withdrawBounty reverted (${r.hash})`);
      return { bountyId, tx: r.hash, uqor: (b.amountWei / WEI_PER_UQOR).toString() };
    });
  }

  // ---------------------------------------------------------- leaderboard

  /**
   * Players ranked by robots tricked, then bounty won, then fewest rounds. Built only from the
   * contracts' events: Breached / Defended (RobotRegistryV2) and BountyClaimed (EscrowVault).
   */
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
    for (const c of this.d.ledger.claims()) row(c.claimer).wonWei += c.amountWei;
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
    const key = `utility-${robotId}-${robot.utilityNonce}-${robot.brainHash.slice(2, 18)}`;

    return this.once(key, async () => {
      const done = this.d.store.getVerdict<UtilityVerdict>(key);
      if (done) return done.relay?.error ? this.relayUtility(key, done) : done;
      const brain = this.brainFor(robot);
      const tasks = [];
      for (const t of this.d.arena.utilityTasks) {
        const out = await this.think(brain, t.instruction);
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
          args: [BigInt(v.robotId), v.tasksPassed, v.replayHash, BigInt(v.deadline), v.refereeSig],
        }),
      );
      relay = r.status === "success" ? { tx: r.hash } : { error: `recordUtility reverted (${r.hash})` };
    } catch (e) {
      relay = { error: (e as Error).message.slice(0, 300) };
    }
    const out = { ...v, relay };
    this.d.store.saveVerdict(key, out);
    return out;
  }

  /** Off-chain practice against any known brain: nothing is signed or stored. */
  async practice(input: { brainHash: unknown; instruction: unknown }) {
    const instruction = cleanInstruction(input.instruction);
    if (typeof input.brainHash !== "string") throw new GameError(400, "brainHash missing");
    const brain = this.d.brains.brain(input.brainHash);
    if (!brain) throw new GameError(404, "unknown brain");
    const out = await this.think(brain, instruction);
    const waypoints = actionsToWaypoints(this.d.arena, out.actions);
    const trace = simulate(this.d.arena, waypoints);
    return { practice: true, breached: trace.breached, say: out.say, actions: out.actions, model: out.model, waypoints, trace };
  }
}
