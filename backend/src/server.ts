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

// Backup models (other free providers, local Ollama), tried in order 1..9 when every
// configured model fails: FALLBACK_<n>_BASE_URL, _MODEL, _API_KEY, _EXTRA_BODY, _TIMEOUT_MS.
const fallbacks = [];
for (let n = 1; n <= 9; n++) {
  const baseUrl = env[`FALLBACK_${n}_BASE_URL`];
  const model = env[`FALLBACK_${n}_MODEL`];
  if (!baseUrl || !model) continue;
  const extra = env[`FALLBACK_${n}_EXTRA_BODY`];
  fallbacks.push({
    model,
    endpoint: {
      baseUrl,
      apiKey: env[`FALLBACK_${n}_API_KEY`] ?? "",
      timeoutMs: Number(env[`FALLBACK_${n}_TIMEOUT_MS`] ?? 120_000),
      extraBody: extra ? (JSON.parse(extra) as Record<string, unknown>) : undefined,
    },
  });
}

const builtIns: BrainConfig[] = [];
if (endpoint && models.length) builtIns.push({ kind: "llm", version: 1, models, systemPrompt: DEFAULT_LLM_PROMPT });
const brains = new BrainRegistry(dataDir, endpoint, builtIns, fallbacks);
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
console.log(`  fallbacks: ${fallbacks.length ? fallbacks.map((f) => `${f.model} at ${new URL(f.endpoint.baseUrl).host}`).join(" -> ") : "none"}`);
