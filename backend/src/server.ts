/** Entry point: npm start (reads .env). */
import { resolve } from "node:path";
import { buildApp } from "./app.js";
import { FACILITY } from "./arena.js";
import { KeyVault } from "./brains/keys.js";
import { BrainRegistry, LEGACY_DEMO_HASH, RULE_BRAIN, brainHash } from "./brains/registry.js";
import type { BrainConfig } from "./brains/types.js";
import {
  CHAIN_ID,
  NATIVE_CHAIN_ID,
  REGISTRY,
  REGISTRY_DEPLOY_BLOCK,
  REST_URL,
  VAULT,
  VAULT_DEPLOY_BLOCK,
  client,
  openBounties,
  readBounty,
  readDeposit,
  readNextBreach,
  readNativeTransfer,
  readNextRobotId,
  readPlayer,
  readPqcKey,
  readRobot,
  readRobots,
  readRules,
  readSession,
  readTryPrice,
  readVaultNonce,
} from "./chain.js";
import { ChainLedger } from "./ledger.js";
import { ChainRelayer } from "./relayer.js";
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
// Owners who bring their own AI key: keys are encrypted with BRAIN_KEY_SECRET (64 hex chars).
const keys = env.BRAIN_KEY_SECRET ? new KeyVault(dataDir, env.BRAIN_KEY_SECRET) : null;
const brains = new BrainRegistry(dataDir, endpoint, builtIns, fallbacks, keys);
const store = new Store(dataDir);

// Relayer for QoreX players (separate account, window scoped to our two contracts).
const relayer = ChainRelayer.fromEnv(env, [REGISTRY, VAULT]);
const prize = relayer ? { minUqor: BigInt(env.PRIZE_MIN_UQOR ?? "1000000"), payTo: relayer.cosmosAddress } : null;

// Rules come from the contract; history comes from chain events and the tx index.
const rules = await readRules();
if (rules.utilityTasks !== FACILITY.utilityTasks.length) throw new Error(`arena has ${FACILITY.utilityTasks.length} tasks, contract expects ${rules.utilityTasks}`);
const ledger = new ChainLedger(client, REGISTRY, REGISTRY_DEPLOY_BLOCK, VAULT, VAULT_DEPLOY_BLOCK, REST_URL);
await ledger.sync();

// One-time sign-up fee, paid to the relayer so it funds gas (0 turns sign-up off).
const signupFee = BigInt(env.SIGNUP_FEE_UQOR ?? "100000");
const signup = relayer && signupFee > 0n ? { feeUqor: signupFee, payTo: relayer.cosmosAddress } : null;

const game = new Game({
  arena: FACILITY,
  brains,
  store,
  key,
  chain: {
    readSession,
    readRobot,
    openBounties,
    readPqcKey,
    readPlayer,
    readNativeTransfer: (h) => readNativeTransfer(h),
    readBounty,
    readNextBreach,
    readVaultNonce,
    readNextRobotId,
    readDeposit,
    readTryPrice,
  },
  ledger,
  relayer,
  // Prizes are paid to the relayer from QoreX and locked in the vault by it (PRIZE_MIN_UQOR, default 1 QOR).
  prize,
  signup,
  chainId: CHAIN_ID,
  registry: REGISTRY,
  vault: VAULT,
  sessionTtl: rules.sessionTtl,
  resultGrace: rules.resultGrace,
  withdrawDelay: rules.withdrawDelay,
  // Bounty and paid-try payments count only from the current contracts' deployment.
  paymentsFromHeight: Number(REGISTRY_DEPLOY_BLOCK),
  passTtl: rules.passTtl,
  maxPassRounds: rules.maxPassRounds,
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
  relayer: relayer ? { address: relayer.address, cosmos: relayer.cosmosAddress } : null,
  prize,
  rules,
  nativeChainId: NATIVE_CHAIN_ID,
  signupFeeUqor: signup?.feeUqor ?? null,
  explorerUrl: env.EXPLORER_URL?.trim() || null,
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
console.log(`  relayer: ${relayer ? `${relayer.address} (${relayer.cosmosAddress})` : "none (players relay their own transactions)"}`);
console.log(`  own AI keys: ${keys ? "on" : "off (set BRAIN_KEY_SECRET)"}`);
console.log(`  fallbacks: ${fallbacks.length ? fallbacks.map((f) => `${f.model} at ${new URL(f.endpoint.baseUrl).host}`).join(" -> ") : "none"}`);
