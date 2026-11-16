/** HTTP API. Built as a factory so tests can inject requests without a network. */
import cors from "@fastify/cors";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { keccak256, type Address } from "viem";
import type { Arena } from "./arena.js";
import { describeArena } from "./arena.js";
import { PROVIDERS } from "./brains/keys.js";
import { brainHash, validateConfig, type BrainRegistry } from "./brains/registry.js";
import { Game, GameError, attemptMessage, MAX_INSTRUCTION } from "./game.js";
import type { RobotView } from "./chain.js";
import type { RefereeKey } from "./signer.js";
import type { Store } from "./store.js";

export type AppDeps = {
  game: Game;
  arena: Arena;
  brains: BrainRegistry;
  store: Store;
  key: RefereeKey;
  chainId: number;
  registry: Address;
  vault: Address;
  builtInBrains: Record<string, string>;
  relayer?: { address: Address; cosmos: string } | null;
  prize?: { minUqor: bigint; payTo: string } | null;
  readRobots(): Promise<RobotView[]>;
  readRobot(id: number): Promise<RobotView | null>;
  corsOrigin?: string;
  /** Requests per minute per IP for routes that call the brain. */
  brainRateLimit?: number;
};

/** Tiny fixed-window limiter, per IP and route group. */
function limiter(perMinute: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: FastifyRequest, reply: FastifyReply, group: string): boolean => {
    const now = Date.now();
    const k = `${group}:${req.ip}`;
    const h = hits.get(k);
    if (!h || h.reset < now) {
      hits.set(k, { n: 1, reset: now + 60_000 });
      if (hits.size > 10_000) for (const [key, v] of hits) if (v.reset < now) hits.delete(key);
      return true;
    }
    if (++h.n <= perMinute) return true;
    reply.code(429).send({ error: "too many requests, slow down" });
    return false;
  };
}

export async function buildApp(d: AppDeps) {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  await app.register(cors, { origin: d.corsOrigin ?? true });
  const allow = limiter(d.brainRateLimit ?? 6);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof GameError) return reply.code(err.status).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    console.error(err);
    return reply.code(500).send({ error: "internal error" });
  });

  app.get("/health", async () => ({
    ok: true,
    chainId: d.chainId,
    registry: d.registry,
    vault: d.vault,
    arena: d.arena.id,
    refereePubkeyHash: keccak256(d.key.publicKey),
    builtInBrains: d.builtInBrains,
    relayer: d.relayer ?? null,
    prize: d.prize ? { minUqor: d.prize.minUqor.toString(), payTo: d.prize.payTo } : null,
    ownKeys: {
      enabled: d.brains.keysEnabled,
      providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.name })),
    },
  }));

  /** Prizes: the maker pays in QoreX, then posts the payment here; the relayer locks it in the vault. */
  app.post<{ Body: { robotId?: unknown; owner?: unknown; txHash?: unknown } }>("/owner/prize", async (req, reply) => {
    if (!allow(req, reply, "session")) return reply;
    const r = await d.game.addPrize({ robotId: req.body?.robotId, owner: req.body?.owner, txHash: req.body?.txHash });
    return { robotId: r.robotId, bountyId: r.bountyId, uqor: r.uqor, depositTx: r.depositTx ?? null };
  });

  app.get<{ Params: { owner: string } }>("/owner/:owner/prizes", async (req) => ({ prizes: await d.game.ownerPrizes(req.params.owner) }));

  app.get<{ Querystring: { bountyId?: string; owner?: string } }>("/owner/prize/back/request", async (req) =>
    d.game.prizeBackRequest({ bountyId: req.query.bountyId, owner: req.query.owner }),
  );

  app.post<{ Body: { bountyId?: unknown; owner?: unknown; deadline?: unknown; pqSignature?: unknown } }>("/owner/prize/back", async (req, reply) => {
    if (!allow(req, reply, "session")) return reply;
    const b = req.body ?? {};
    return d.game.takePrizeBack({ bountyId: b.bountyId, owner: b.owner, deadline: b.deadline, pqSignature: b.pqSignature });
  });

  /** Top players, from the referee's own finished verdicts. */
  app.get("/leaderboard", async () => ({ players: d.game.leaderboard() }));

  app.get("/arena", async () => ({ ...d.arena, description: describeArena(d.arena), maxInstruction: MAX_INSTRUCTION }));

  app.get("/robots", async () => ({ robots: await d.readRobots() }));

  app.get<{ Params: { id: string } }>("/robots/:id", async (req) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) throw new GameError(400, "bad robot id");
    const r = await d.readRobot(id);
    if (!r) throw new GameError(404, "robot not found");
    const c = d.brains.config(r.brainHash);
    return { ...r, brain: c ? { kind: c.kind, models: c.kind === "llm" ? c.models : undefined, known: true } : { known: false } };
  });

  /** Owners publish a brain config here, then register the robot on chain with the returned hash. */
  app.post<{ Body: { config?: unknown; apiKey?: unknown } }>("/brains", async (req, reply) => {
    // "Bring your own AI": { config: { provider, model, systemPrompt }, apiKey }. The key is stored
    // encrypted and never returned; the reply is the public config (provider + keyId, no key).
    if (req.body?.apiKey !== undefined) {
      if (!allow(req, reply, "brain")) return reply;
      const c = (req.body.config ?? {}) as Record<string, unknown>;
      try {
        return await d.brains.publishKeyed({ provider: c.provider, model: c.model, systemPrompt: c.systemPrompt }, req.body.apiKey, d.arena);
      } catch (e) {
        throw new GameError(400, (e as Error).message);
      }
    }
    let config;
    try {
      config = validateConfig(req.body?.config);
    } catch (e) {
      throw new GameError(400, (e as Error).message);
    }
    d.brains.save(config);
    return { brainHash: brainHash(config), config };
  });

  app.get<{ Params: { hash: string } }>("/brains/:hash", async (req) => {
    const c = d.brains.config(req.params.hash);
    if (!c) throw new GameError(404, "unknown brain");
    return { brainHash: req.params.hash.toLowerCase(), config: c };
  });

  /** The exact text the player's wallet must sign for POST /attempt. */
  app.get<{ Querystring: { sessionId?: string; instruction?: string } }>("/attempt/message", async (req) => {
    const sessionId = Number(req.query.sessionId);
    if (!Number.isSafeInteger(sessionId) || sessionId < 1) throw new GameError(400, "bad sessionId");
    const instruction = (req.query.instruction ?? "").replace(/\r\n?/g, "\n").trim();
    return { message: attemptMessage(d.chainId, d.registry, sessionId, instruction) };
  });

  app.get<{ Params: { address: string } }>("/player/:address", async (req) => d.game.playerStatus(req.params.address));

  /** One-time sign-up: the player sends the fee from QoreX, then posts the transaction hash here. */
  app.post<{ Body: { address?: unknown; txHash?: unknown } }>("/player/register", async (req, reply) => {
    if (!allow(req, reply, "session")) return reply;
    return d.game.registerPlayer({ address: req.body?.address, txHash: req.body?.txHash });
  });

  /** What the QoreX wallet signs to start a session (relayed by the referee). */
  app.get<{ Querystring: { robotId?: string; player?: string } }>("/session/request", async (req) => {
    return d.game.sessionRequest({ robotId: req.query.robotId, player: req.query.player });
  });

  app.post<{ Body: { robotId?: unknown; player?: unknown; deadline?: unknown; pqSignature?: unknown } }>("/session/start", async (req, reply) => {
    if (!allow(req, reply, "session")) return reply;
    return d.game.startSession({ robotId: req.body?.robotId, player: req.body?.player, deadline: req.body?.deadline, pqSignature: req.body?.pqSignature });
  });

  /** Owners: what QoreX signs to register a robot, then the relayed registration. */
  app.get<{ Querystring: { owner?: string; name?: string; brainHash?: string } }>("/owner/robot/request", async (req) => {
    return d.game.robotRequest({ owner: req.query.owner, name: req.query.name, brainHash: req.query.brainHash });
  });

  app.post<{ Body: { owner?: unknown; name?: unknown; brainHash?: unknown; deadline?: unknown; pqSignature?: unknown } }>(
    "/owner/robot",
    async (req, reply) => {
      if (!allow(req, reply, "session")) return reply;
      const b = req.body ?? {};
      return d.game.registerRobot({ owner: b.owner, name: b.name, brainHash: b.brainHash, deadline: b.deadline, pqSignature: b.pqSignature });
    },
  );

  /** Owners: give a robot a new brain (resets its record). */
  app.get<{ Querystring: { robotId?: string; owner?: string; brainHash?: string } }>("/owner/brain/request", async (req) => {
    return d.game.brainUpdateRequest({ robotId: req.query.robotId, owner: req.query.owner, brainHash: req.query.brainHash });
  });

  app.post<{ Body: { robotId?: unknown; owner?: unknown; brainHash?: unknown; deadline?: unknown; pqSignature?: unknown } }>(
    "/owner/brain",
    async (req, reply) => {
      if (!allow(req, reply, "session")) return reply;
      const b = req.body ?? {};
      return d.game.updateBrain({ robotId: b.robotId, owner: b.owner, brainHash: b.brainHash, deadline: b.deadline, pqSignature: b.pqSignature });
    },
  );

  app.post<{ Params: { sessionId: string } }>("/attempt/:sessionId/relay", async (req, reply) => {
    if (!allow(req, reply, "session")) return reply;
    return d.game.relayAgain(req.params.sessionId);
  });

  app.post<{ Body: { sessionId?: unknown; instruction?: unknown; signature?: unknown; pqSignature?: unknown } }>("/attempt", async (req, reply) => {
    if (!allow(req, reply, "brain")) return reply;
    return d.game.attempt({
      sessionId: req.body?.sessionId,
      instruction: req.body?.instruction,
      signature: req.body?.signature,
      pqSignature: req.body?.pqSignature,
    });
  });

  app.post<{ Params: { robotId: string } }>("/utility/:robotId", async (req, reply) => {
    if (!allow(req, reply, "utility")) return reply;
    return d.game.utility(req.params.robotId);
  });

  app.post<{ Body: { brainHash?: unknown; instruction?: unknown } }>("/practice", async (req, reply) => {
    if (!allow(req, reply, "brain")) return reply;
    return d.game.practice({ brainHash: req.body?.brainHash, instruction: req.body?.instruction });
  });

  app.get<{ Params: { hash: string } }>("/replay/:hash", async (req) => {
    const r = d.store.getReplay(req.params.hash);
    if (!r) throw new GameError(404, "replay not found");
    return r;
  });

  return app;
}
