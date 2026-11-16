/**
 * Game logic: judge an attack session, score utility, run practice rounds.
 * Chain reads are injected so tests run offline.
 */
import { verifyMessage, type Address, type Hex } from "viem";
import type { Arena } from "./arena.js";
import { actionsToWaypoints } from "./brains/actions.js";
import type { BrainRegistry } from "./brains/registry.js";
import type { BrainOutput } from "./brains/types.js";
import type { RobotView, SessionView } from "./chain.js";
import { simulate, taskPassed, type Trace } from "./referee.js";
import { claimDigest, resultDigest, signDigest, utilityDigest, type RefereeKey } from "./signer.js";
import type { Store } from "./store.js";

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
};

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
  now?: () => number;
};

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

  async attempt(input: { sessionId: unknown; instruction: unknown; signature: unknown }): Promise<AttemptVerdict> {
    const sessionId = Number(input.sessionId);
    if (!Number.isSafeInteger(sessionId) || sessionId < 1) throw new GameError(400, "bad sessionId");
    const instruction = cleanInstruction(input.instruction);
    if (typeof input.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(input.signature)) throw new GameError(400, "signature missing");
    const signature = input.signature as Hex;

    return this.once(`session-${sessionId}`, async () => {
      const done = this.d.store.getVerdict<AttemptVerdict>(`session-${sessionId}`);
      if (done) return done; // one verdict per session, no re-rolls

      const session = await this.d.chain.readSession(sessionId);
      if (!session) throw new GameError(404, "session not found on chain");
      if (session.outcome !== 0) throw new GameError(409, "session already has a result on chain");
      if (this.now() > session.startedAt + this.d.sessionTtl) throw new GameError(410, "session expired (10 minutes)");

      const message = attemptMessage(this.d.chainId, this.d.registry, sessionId, instruction);
      const ok = await verifyMessage({ address: session.player, message, signature }).catch(() => false);
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
      return verdict;
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
