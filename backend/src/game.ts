/**
 * Game logic: judge an attack session, score utility, run practice rounds.
 * Chain reads are injected so tests run offline.
 */
import { decodeEventLog, encodeFunctionData, verifyMessage, type Address, type Hex } from "viem";
import type { Arena } from "./arena.js";
import { actionsToWaypoints } from "./brains/actions.js";
import type { BrainRegistry } from "./brains/registry.js";
import type { BrainOutput } from "./brains/types.js";
import { registryAbi, vaultAbi, type NativeTransfer, type RobotView, type SessionView } from "./chain.js";
import { SIGNUP_MEMO, decodePqSignature, toEvmAddress, toQorAddress, verifyWalletSignature, walletText } from "./qorex.js";
import { simulate, taskPassed, type Trace } from "./referee.js";
import type { Relayer } from "./relayer.js";
import { claimDigest, resultDigest, signDigest, startSessionDigest, utilityDigest, type RefereeKey } from "./signer.js";
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
};

/** One-time sign-up: the player pays `feeUqor` once, with a QoreX (hybrid-signed) transfer to `payTo`. */
export type SignupConfig = { feeUqor: bigint; payTo: string };
type PlayerRecord = { evm: Address; qor: string; txHash: string; paidUqor: string; height: number; at: number };

export type GameDeps = {
  arena: Arena;
  brains: BrainRegistry;
  store: Store;
  key: RefereeKey;
  chain: ChainReader;
  chainId: number;
  registry: Address;
  vault: Address;
  sessionTtl: number;
  resultGrace: number;
  /** Sends startSessionFor / recordResult / claimBounty for players. Optional: without it, players relay. */
  relayer?: Relayer | null;
  /** When set, players pay a small one-time fee before their first session. */
  signup?: SignupConfig | null;
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

  private isSignedUp(evm: Address): boolean {
    return !this.d.signup || this.d.store.getVerdict<PlayerRecord>(this.playerKey(evm)) !== null;
  }

  /** Everything the website needs to know about a player before they play. */
  async playerStatus(addressRaw: unknown) {
    const evm = toEvmAddress(addressRaw);
    if (!evm) throw new GameError(400, "address must be a qor1… or 0x… address");
    const [key, state] = await Promise.all([this.d.chain.readPqcKey(evm), this.d.chain.readPlayer(evm)]);
    const record = this.d.store.getVerdict<PlayerRecord>(this.playerKey(evm));
    return {
      evm,
      qor: toQorAddress(evm),
      pqKeyRegistered: key.registered,
      signedUp: this.isSignedUp(evm),
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

    return this.once(`signup-${txHash}`, async () => {
      const existing = this.d.store.getVerdict<PlayerRecord>(this.playerKey(evm));
      if (existing) return { signedUp: true, txHash: existing.txHash };
      if (this.d.store.getVerdict(`signuptx-${txHash}`)) throw new GameError(409, "this payment was already used to sign up");

      const tx = await this.d.chain.readNativeTransfer(txHash);
      if (!tx) throw new GameError(404, "payment not found on chain yet: wait a few seconds and try again");
      if (tx.code !== 0) throw new GameError(400, "that transaction failed on chain");
      if (tx.from !== qor) throw new GameError(400, "the payment was not sent from this account");
      if (tx.to !== this.d.signup!.payTo) throw new GameError(400, "the payment went to the wrong address");
      if (tx.uqor < this.d.signup!.feeUqor) throw new GameError(400, "the payment is smaller than the sign-up fee");
      if (tx.memo.trim() !== SIGNUP_MEMO) throw new GameError(400, `the payment memo must be "${SIGNUP_MEMO}"`);

      const record: PlayerRecord = { evm, qor, txHash, paidUqor: tx.uqor.toString(), height: tx.height, at: this.now() };
      this.d.store.saveVerdict(`signuptx-${txHash}`, { evm });
      this.d.store.saveVerdict(this.playerKey(evm), record);
      return { signedUp: true, txHash };
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
    if (!this.isSignedUp(player)) throw new GameError(402, "sign up first: a one-time payment verifies your account");
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
    if (!this.isSignedUp(player)) throw new GameError(402, "sign up first: a one-time payment verifies your account");
    if (!Number.isSafeInteger(deadline) || deadline < this.now() || deadline > this.now() + 3600) {
      throw new GameError(400, "deadline expired or too far away: request a new one");
    }

    return this.once(`start-${player.toLowerCase()}`, async () => {
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

  /** Run the 10 normal tasks and sign the score. Cached per robot, brain and utilityNonce. */
  async utility(robotIdRaw: unknown): Promise<UtilityVerdict> {
    const robotId = Number(robotIdRaw);
    if (!Number.isSafeInteger(robotId) || robotId < 1) throw new GameError(400, "bad robotId");
    const robot = await this.d.chain.readRobot(robotId);
    if (!robot) throw new GameError(404, "robot not found");
    const key = `utility-${robotId}-${robot.utilityNonce}-${robot.brainHash.slice(2, 18)}`;

    return this.once(key, async () => {
      const done = this.d.store.getVerdict<UtilityVerdict>(key);
      if (done) return done;
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
      return verdict;
    });
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
