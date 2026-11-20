/** HTTP API. Built as a factory so tests can inject requests without a network. */
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
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
  /** The live vault contract's name (EscrowVaultV4 or EscrowVaultV5), for the website's texts. */
  vaultName?: string;
  builtInBrains: Record<string, string>;
  relayer?: { address: Address; cosmos: string } | null;
  prize?: { minUqor: bigint; payTo: string } | null;
  /** Game rules read from the contract. */
  rules?: { attemptsPerDay: number; sessionTtl: number; resultGrace: number; utilityTasks: number; maxNameLength: number; passTtl?: number; maxPassRounds?: number };
  nativeChainId?: string;
  /** One-time sign-up fee in uqor (null when sign-up is off). */
  signupFeeUqor?: bigint | null;
  /** Block explorer base URL, if the network has one (QoreChain testnet has none yet). */
  explorerUrl?: string | null;
  readRobots(): Promise<RobotView[]>;
  readRobot(id: number): Promise<RobotView | null>;
  /** What a breach would pay this player on this robot now (optional: tests may leave it out). */
  prizeFor?(robotId: number, player: `0x${string}`): Promise<{ wei: string; wonAll: boolean; bounties: { id: number; wei: string; won: boolean }[] }>;
  /** A RedZone transaction as the chain reports it (optional: tests may leave it out). */
  readTxSummary?(hash: `0x${string}`): Promise<unknown | null>;
  corsOrigin?: string;
  /** Requests per minute per IP for routes that call the brain. */
  brainRateLimit?: number;
  /** Skills tests per minute per IP (default 2: each is 10 AI calls and a transaction). */
  utilityRateLimit?: number;
  /** Requests per minute per IP for signed requests and payment checks (default 30). */
  sessionRateLimit?: number;
  /** Fastify trustProxy: true, a list of proxy addresses, or a test per hop. Off by default. */
  trustProxy?: boolean | string | ((address: string, hop: number) => boolean);
  /** Built website folder (web/dist) to serve from the same address as the API, so one server runs everything. */
  webDist?: string;
};

/** Tiny fixed-window limiter, per IP and route group. Each group has its own budget per minute. */
function limiter(budgets: Record<string, number>, fallback: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: FastifyRequest, reply: FastifyReply, group: string): boolean => {
    const perMinute = budgets[group] ?? fallback;
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
  // Behind a reverse proxy (any host), req.ip is the proxy unless we trust its X-Forwarded-For;
  // without that, every visitor would share one rate-limit bucket.
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, trustProxy: d.trustProxy ?? false });
  await app.register(cors, { origin: d.corsOrigin ?? true });
  if (d.webDist) {
    // Exact routes for the built files only (no wildcard), so they never shadow an API route.
    // Hashed assets are cached for a year; index.html is always re-checked so new builds show at once.
    await app.register(fastifyStatic, {
      root: d.webDist,
      wildcard: false,
      cacheControl: false,
      setHeaders: (res, path) =>
        res.setHeader("Cache-Control", /[\\/]assets[\\/]/.test(path) ? "public, max-age=31536000, immutable" : "no-cache"),
    });
  }
  const brainBudget = d.brainRateLimit ?? 6;
  // brain: routes that call an AI. utility: a skills test (10 AI calls and a transaction).
  // session: signed requests and payment checks; a maker's bounty step alone retries several times.
  const allow = limiter({ brain: brainBudget, utility: d.utilityRateLimit ?? 2, session: d.sessionRateLimit ?? 30 }, brainBudget);

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
    vaultName: d.vaultName ?? "EscrowVaultV4",
    arena: d.arena.id,
    refereePubkeyHash: keccak256(d.key.publicKey),
    builtInBrains: d.builtInBrains,
    relayer: d.relayer ?? null,
    nativeChainId: d.nativeChainId ?? null,
    signupFeeUqor: d.signupFeeUqor != null ? d.signupFeeUqor.toString() : null,
    rules: d.rules ?? null,
    explorerUrl: d.explorerUrl ?? null,
    prize: d.prize ? { minUqor: d.prize.minUqor.toString(), payTo: d.prize.payTo } : null,
    ownKeys: {
      enabled: d.brains.keysEnabled,
      providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.name })),
    },
  }));

  /** Prizes: the maker pays in QoreX, then posts the payment here; the relayer locks it in the vault. */
  app.post<{ Body: { robotId?: unknown; owner?: unknown; txHash?: unknown } }>("/owner/bounty", async (req, reply) => {
    if (!allow(req, reply, "session")) return reply;
    return d.game.addBounty({ robotId: req.body?.robotId, owner: req.body?.owner, txHash: req.body?.txHash });
  });

  app.get<{ Params: { owner: string } }>("/owner/:owner/bounties", async (req) => ({ bounties: await d.game.ownerBounties(req.params.owner) }));

  app.get<{ Querystring: { bountyId?: string; owner?: string } }>("/owner/bounty/back/request", async (req) =>
    d.game.bountyBackRequest({ bountyId: req.query.bountyId, owner: req.query.owner }),
  );

  app.post<{ Body: { bountyId?: unknown; owner?: unknown; deadline?: unknown; pqSignature?: unknown } }>("/owner/bounty/back", async (req, reply) => {
    if (!allow(req, reply, "session")) return reply;
    const b = req.body ?? {};
    return d.game.takeBountyBack({ bountyId: b.bountyId, owner: b.owner, deadline: b.deadline, pqSignature: b.pqSignature });
  });

  /** Step 2 of a take-back, after the vault's delay: anyone may trigger the payout to the signed address. */
  app.post<{ Body: { bountyId?: unknown } }>("/owner/bounty/back/finish", async (req, reply) => {
    if (!allow(req, reply, "session")) return reply;
    return d.game.finishBountyBack({ bountyId: req.body?.bountyId });
  });

  /** Top players, from the referee's own finished verdicts. */
  app.get("/leaderboard", async () => ({ players: await d.game.leaderboard() }));

  app.get("/activity", async () => ({ rounds: await d.game.activity() }));

  app.get("/arena", async () => ({ ...d.arena, description: describeArena(d.arena), maxInstruction: MAX_INSTRUCTION }));

  /** The signed, off-chain label of a robot: its job and its look (type and colour). */
  const labelOf = (id: number) => {
    const p = d.store.getProfile(id);
    return { job: p?.job ?? null, look: p?.kind && p.color ? { kind: p.kind, color: p.color } : null };
  };

  // aiLimitSince: when this robot's AI last refused because its free usage limit is reached (unix s, last 15 min), else null.
  // frozen: set while a robot waits for its owner's fix after a paid breach (see Game.freezeOf).
  app.get("/robots", async () => ({
    robots: await Promise.all(
      (await d.readRobots()).map(async (r) => ({ ...r, ...labelOf(r.id), aiLimitSince: d.game.aiLimitSince(r.brainHash), frozen: await d.game.freezeOf(r) })),
    ),
  }));

  /** A RedZone transaction as the chain reports it (the testnet has no block explorer yet). */
  app.get<{ Params: { hash: string } }>("/tx/:hash", async (req) => {
    const hash = req.params.hash;
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new GameError(400, "bad transaction hash");
    if (!d.readTxSummary) throw new GameError(503, "transaction lookup is not available");
    const tx = await d.readTxSummary(hash as `0x${string}`);
    if (!tx) throw new GameError(404, "no RedZone transaction with this hash");
    return tx;
  });

  /** What a breach in a round started now would pay this player on this robot (pools they won are skipped). */
  app.get<{ Params: { id: string }; Querystring: { player?: string } }>("/robots/:id/prize", async (req) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) throw new GameError(400, "bad robot id");
    const player = req.query.player ?? "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(player)) throw new GameError(400, "bad player address");
    if (!d.prizeFor) throw new GameError(503, "prize lookup is not available");
    return d.prizeFor(id, player as `0x${string}`);
  });

  app.get<{ Params: { id: string } }>("/robots/:id/record", async (req) => {
    const rec = await d.game.robotRecord(req.params.id);
    const r = await d.readRobot(rec.robotId);
    if (!r) throw new GameError(404, "robot not found");
    const c = d.brains.config(r.brainHash);
    // Which AI runs it (never its rules: those are the robot's defences).
    const brain = c ? (c.kind === "llm" ? { kind: "llm", models: c.models, provider: "provider" in c ? c.provider : null } : { kind: c.kind }) : null;
    return { ...rec, brain };
  });

  app.get<{ Querystring: { robotId?: string; owner?: string; job?: string; kind?: string; color?: string } }>("/owner/profile/request", async (req) =>
    d.game.profileRequest({ robotId: req.query.robotId, owner: req.query.owner, job: req.query.job, kind: req.query.kind, color: req.query.color }),
  );
  app.post<{ Body: { robotId?: unknown; owner?: unknown; job?: unknown; kind?: unknown; color?: unknown; deadline?: unknown; pqSignature?: unknown } }>("/owner/profile", async (req) =>
    d.game.saveProfile(req.body ?? {}),
  );

  app.get<{ Params: { id: string } }>("/robots/:id", async (req) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) throw new GameError(400, "bad robot id");
    const r = await d.readRobot(id);
    if (!r) throw new GameError(404, "robot not found");
    const c = d.brains.config(r.brainHash);
    return { ...r, ...labelOf(id), aiLimitSince: d.game.aiLimitSince(r.brainHash), frozen: await d.game.freezeOf(r), brain: c ? { kind: c.kind, models: c.kind === "llm" ? c.models : undefined, known: true } : { known: false } };
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
  app.get<{ Params: { address: string } }>("/player/:address/profile", async (req) => d.game.playerProfile(req.params.address));
  /** Nicknames players chose (everyone else gets a generated name in the web app). */
  app.get("/players/names", async () => ({ names: d.store.playerNames(), players: d.store.playerProfiles() }));
  app.get<{ Querystring: { player?: string; name?: string; avatar?: string } }>("/player/name/request", async (req) =>
    d.game.nameRequest({ player: req.query.player, name: req.query.name, avatar: req.query.avatar }),
  );
  app.post<{ Body: { player?: unknown; name?: unknown; avatar?: unknown; deadline?: unknown; pqSignature?: unknown } }>("/player/name", async (req) =>
    d.game.saveName(req.body ?? {}),
  );

  /** One-time sign-up: the player sends the fee from QoreX, then posts the transaction hash here. */
  app.post<{ Body: { address?: unknown; txHash?: unknown } }>("/player/register", async (req, reply) => {
    if (!allow(req, reply, "session")) return reply;
    return d.game.registerPlayer({ address: req.body?.address, txHash: req.body?.txHash });
  });

  /** What the QoreX wallet signs to start a session (relayed by the referee). */
  app.get<{ Querystring: { robotId?: string; player?: string } }>("/session/request", async (req) => {
    return d.game.sessionRequest({ robotId: req.query.robotId, player: req.query.player });
  });

  app.post<{ Body: { robotId?: unknown; player?: unknown; deadline?: unknown; pqSignature?: unknown; roundKeyHash?: unknown } }>("/session/start", async (req, reply) => {
    if (!allow(req, reply, "session")) return reply;
    const b = req.body ?? {};
    return d.game.startSession({ robotId: b.robotId, player: b.player, deadline: b.deadline, pqSignature: b.pqSignature, roundKeyHash: b.roundKeyHash });
  });

  /** Play pass: one QoreX approval, then rounds start with no wallet prompt for PASS_TTL. */
  app.get<{ Querystring: { player?: string } }>("/pass/request", async (req) => d.game.passRequest({ player: req.query.player }));
  app.post<{ Body: { player?: unknown; validUntil?: unknown; maxRounds?: unknown; deadline?: unknown; pqSignature?: unknown; passKeyHash?: unknown } }>(
    "/pass/open",
    async (req, reply) => {
      if (!allow(req, reply, "session")) return reply;
      const b = req.body ?? {};
      return d.game.openPass({ player: b.player, validUntil: b.validUntil, maxRounds: b.maxRounds, deadline: b.deadline, pqSignature: b.pqSignature, passKeyHash: b.passKeyHash });
    },
  );
  app.post<{ Body: { robotId?: unknown; player?: unknown; passKey?: unknown; roundKeyHash?: unknown } }>("/session/start-pass", async (req, reply) => {
    if (!allow(req, reply, "session")) return reply;
    const b = req.body ?? {};
    return d.game.startWithPass({ robotId: b.robotId, player: b.player, passKey: b.passKey, roundKeyHash: b.roundKeyHash });
  });

  /** Paid tries: the player pays the relayer from QoreX, then posts the payment here. */
  app.post<{ Body: { player?: unknown; txHash?: unknown } }>("/tries/buy", async (req, reply) => {
    if (!allow(req, reply, "session")) return reply;
    return d.game.buyTries({ player: req.body?.player, txHash: req.body?.txHash });
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

  app.post<{ Body: { sessionId?: unknown; instruction?: unknown; signature?: unknown; pqSignature?: unknown; roundKey?: unknown } }>("/attempt", async (req, reply) => {
    if (!allow(req, reply, "brain")) return reply;
    return d.game.attempt({
      sessionId: req.body?.sessionId,
      instruction: req.body?.instruction,
      signature: req.body?.signature,
      pqSignature: req.body?.pqSignature,
      roundKey: req.body?.roundKey,
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
