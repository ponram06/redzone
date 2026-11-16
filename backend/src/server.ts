/** Entry point: npm start (reads .env). */
import { resolve } from "node:path";
import { buildApp } from "./app.js";
import { FACILITY } from "./arena.js";
import { BrainRegistry, LEGACY_DEMO_HASH, RULE_BRAIN, brainHash } from "./brains/registry.js";
import type { BrainConfig } from "./brains/types.js";
import { CHAIN_ID, REGISTRY, RESULT_GRACE, SESSION_TTL, VAULT, openBounties, readRobot, readRobots, readSession } from "./chain.js";
import { Game } from "./game.js";
import { DEFAULT_LLM_PROMPT } from "./prompt.js";
import { loadRefereeKey } from "./signer.js";
import { Store } from "./store.js";

const env = process.env;
const dataDir = resolve(env.DATA_DIR ?? "./data");
const key = loadRefereeKey(resolve(env.REFEREE_KEY_FILE ?? "../contracts/.referee-key.json"));

const models = (env.BRAIN_MODEL ?? "")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const endpoint = env.BRAIN_BASE_URL ? { baseUrl: env.BRAIN_BASE_URL, apiKey: env.BRAIN_API_KEY ?? "" } : null;

// Backup model run by the operator (e.g. Ollama), used when every configured model fails.
const fallback =
  env.FALLBACK_BASE_URL && env.FALLBACK_MODEL
    ? {
        model: env.FALLBACK_MODEL,
        endpoint: {
          baseUrl: env.FALLBACK_BASE_URL,
          apiKey: env.FALLBACK_API_KEY ?? "",
          timeoutMs: Number(env.FALLBACK_TIMEOUT_MS ?? 180_000),
          extraBody: env.FALLBACK_EXTRA_BODY ? (JSON.parse(env.FALLBACK_EXTRA_BODY) as Record<string, unknown>) : undefined,
        },
      }
    : null;

const builtIns: BrainConfig[] = [];
if (endpoint && models.length) builtIns.push({ kind: "llm", version: 1, models, systemPrompt: DEFAULT_LLM_PROMPT });
const brains = new BrainRegistry(dataDir, endpoint, builtIns, fallback);
const store = new Store(dataDir);

const game = new Game({
  arena: FACILITY,
  brains,
  store,
  key,
  chain: { readSession, readRobot, openBounties },
  chainId: CHAIN_ID,
  registry: REGISTRY,
  vault: VAULT,
  sessionTtl: SESSION_TTL,
  resultGrace: RESULT_GRACE,
});

const builtInBrains: Record<string, string> = { rule: brainHash(RULE_BRAIN), "demo-legacy (robot 1)": LEGACY_DEMO_HASH };
if (builtIns[0]) builtInBrains["llm-sentinel"] = brainHash(builtIns[0]);

const app = await buildApp({
  game,
  arena: FACILITY,
  brains,
  store,
  key,
  chainId: CHAIN_ID,
  registry: REGISTRY,
  vault: VAULT,
  builtInBrains,
  readRobots,
  readRobot,
  corsOrigin: env.CORS_ORIGIN || undefined,
  brainRateLimit: Number(env.BRAIN_RATE_LIMIT ?? 6),
});

const port = Number(env.PORT ?? 8787);
await app.listen({ port, host: env.HOST ?? "127.0.0.1" });
console.log(`RedZone referee on http://${env.HOST ?? "127.0.0.1"}:${port}`);
console.log(`  brains: ${Object.entries(builtInBrains).map(([k, v]) => `${k}=${v.slice(0, 10)}…`).join(", ")}`);
console.log(`  llm: ${endpoint ? `${endpoint.baseUrl} (${models.length} model(s))` : "off (rule brain only)"}`);
console.log(`  fallback: ${fallback ? `${fallback.model} at ${fallback.endpoint.baseUrl}` : "none"}`);
