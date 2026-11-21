/** Entry point: npm start (reads .env). */
import { resolve } from "node:path";
import { buildApp } from "./app.js";
import { ARENAS, PLANT } from "./arena.js";
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
  PREVIOUS_VAULTS,
  VAULT_NAME,
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
  prizeFor,
  readTxSummary,
  readRules,
  readSession,
  readTryPrice,
  readVaultNonce,
  registryAbi,
  vaultAbi,
} from "./chain.js";
import { ChainLedger } from "./ledger.js";
import { ChainRelayer } from "./relayer.js";
import { Game } from "./game.js";
import { DEFAULT_LLM_PROMPT } from "./prompt.js";
import { lockDataDir } from "./lock.js";
import { loadRefereeKey, parseRefereeKey, resultDigest, startSessionDigest, vaultDomain, withdrawDigest } from "./signer.js";
import { Store } from "./store.js";

const env = process.env;
const dataDir = resolve(env.DATA_DIR ?? "./data");
lockDataDir(dataDir);
// The arena players see: the power plant (v2) by default; ARENA=facility-v1 brings back the small one.
const ARENA = ARENAS[env.ARENA ?? PLANT.id];
if (!ARENA) throw new Error(`unknown ARENA "${env.ARENA}" (use one of: ${Object.keys(ARENAS).join(", ")})`);
// On a host, REFEREE_KEY_JSON holds the key file's contents as a secret; locally it is read from a file.
const key = env.REFEREE_KEY_JSON?.trim()
  ? parseRefereeKey(env.REFEREE_KEY_JSON)
  : loadRefereeKey(resolve(env.REFEREE_KEY_FILE ?? "../contracts/.referee-key.json"));

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
if (rules.utilityTasks !== ARENA.utilityTasks.length) throw new Error(`arena has ${ARENA.utilityTasks.length} tasks, contract expects ${rules.utilityTasks}`);
const ledger = new ChainLedger(client, REGISTRY, REGISTRY_DEPLOY_BLOCK, VAULT, VAULT_DEPLOY_BLOCK, REST_URL, PREVIOUS_VAULTS);
await ledger.sync();

// One-time sign-up fee, paid to the relayer so it funds gas (0 turns sign-up off).
const signupFee = BigInt(env.SIGNUP_FEE_UQOR ?? "100000");
const signup = relayer && signupFee > 0n ? { feeUqor: signupFee, payTo: relayer.cosmosAddress } : null;

const game = new Game({
  arena: ARENA,
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
  vaultDomain: vaultDomain(VAULT_NAME),
  // Bounty and paid-try payments count only from the current contracts' deployment.
  paymentsFromHeight: Number(REGISTRY_DEPLOY_BLOCK),
  bountiesFromHeight: Number(VAULT_DEPLOY_BLOCK),
  passTtl: rules.passTtl,
  maxPassRounds: rules.maxPassRounds,
});

const builtInBrains: Record<string, string> = { rule: brainHash(RULE_BRAIN), "demo-legacy (robot 1)": LEGACY_DEMO_HASH };
if (builtIns[0]) builtInBrains["llm-sentinel"] = brainHash(builtIns[0]);

const app = await buildApp({
  game,
  arena: ARENA,
  brains,
  store,
  key,
  chainId: CHAIN_ID,
  registry: REGISTRY,
  vault: VAULT,
  vaultName: VAULT_NAME,
  builtInBrains,
  relayer: relayer ? { address: relayer.address, cosmos: relayer.cosmosAddress } : null,
  prize,
  rules,
  nativeChainId: NATIVE_CHAIN_ID,
  signupFeeUqor: signup?.feeUqor ?? null,
  explorerUrl: env.EXPLORER_URL?.trim() || null,
  readRobots,
  readRobot,
  prizeFor,
  readTxSummary,
  corsOrigin: env.CORS_ORIGIN || undefined,
  brainRateLimit: Number(env.BRAIN_RATE_LIMIT ?? 6),
  sessionRateLimit: Number(env.SESSION_RATE_LIMIT ?? 30),
  trustProxy: parseTrustProxy(env.TRUST_PROXY),
  webDist: env.WEB_DIST?.trim() ? resolve(env.WEB_DIST) : undefined,
});

// Self-check: the digests this server builds must equal the contracts' own, or every signature it
// asks players and owners for would be refused on chain. Mismatch: stop. RPC down: warn, go on.
{
  const who = "0x1111111111111111111111111111111111111111" as const;
  const dl = 1_900_000_000n;
  const h = ("0x" + "ab".repeat(32)) as `0x${string}`;
  const checks: [string, () => Promise<`0x${string}`>, `0x${string}`][] = [
    ["vault withdrawDigest", () => client.readContract({ address: VAULT, abi: vaultAbi, functionName: "withdrawDigest", args: [1n, who, 2n, dl] }), withdrawDigest(CHAIN_ID, VAULT, 1n, who, 2n, dl, vaultDomain(VAULT_NAME))],
    ["registry startSessionDigest", () => client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "startSessionDigest", args: [1n, who, 2n, dl] }), startSessionDigest(CHAIN_ID, REGISTRY, 1n, who, 2n, dl)],
    ["registry resultDigest", () => client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "resultDigest", args: [3n, 1n, who, true, h, dl] }), resultDigest(CHAIN_ID, REGISTRY, 3n, 1n, who, true, h, dl)],
  ];
  for (const [name, onChain, local] of checks) {
    const got = await onChain().catch((e: Error) => {
      console.warn(`digest self-check skipped for ${name}: ${e.message.slice(0, 120)}`);
      return null;
    });
    if (got && got.toLowerCase() !== local.toLowerCase()) throw new Error(`${name}: this server builds ${local}, the contract ${got}. Signatures would be refused; fix the signing domain before starting.`);
  }
}

// A win whose payout failed (network, RPC) is retried by the server too, not only by the player's
// "Try again" button, so it is paid even if the player closed the page.
if (relayer) {
  setInterval(() => {
    game
      .retryFailedRelays()
      .then((n) => n && console.log(`retried ${n} unfinished payout(s)`))
      .catch((e: Error) => console.error(`payout retry: ${e.message.slice(0, 200)}`));
  }, 120_000).unref();
}

const port = Number(env.PORT ?? 8787);
await app.listen({ port, host: env.HOST ?? "127.0.0.1" });
console.log(`RedZone referee on http://${env.HOST ?? "127.0.0.1"}:${port}`);
console.log(`  vault: ${VAULT_NAME} ${VAULT}${PREVIOUS_VAULTS.length ? ` (history also from ${PREVIOUS_VAULTS.map((v) => v.address).join(", ")})` : ""}`);
console.log(`  brains: ${Object.entries(builtInBrains).map(([k, v]) => `${k}=${v.slice(0, 10)}…`).join(", ")}`);
console.log(`  llm: ${endpoint ? `${endpoint.baseUrl} (${models.length} model(s))` : "off (rule brain only)"}`);
console.log(`  relayer: ${relayer ? `${relayer.address} (${relayer.cosmosAddress})` : "none (players relay their own transactions)"}`);
console.log(`  own AI keys: ${keys ? "on" : "off (set BRAIN_KEY_SECRET)"}`);
console.log(`  fallbacks: ${fallbacks.length ? fallbacks.map((f) => `${f.model} at ${new URL(f.endpoint.baseUrl).host}`).join(" -> ") : "none"}`);

/** TRUST_PROXY: unset/false = off, true = trust every hop, a number = that many hops, else a list of proxy IPs/CIDRs. */
function parseTrustProxy(v: string | undefined): boolean | string | ((address: string, hop: number) => boolean) {
  const t = v?.trim();
  if (!t || t === "false" || t === "0") return false;
  if (t === "true") return true;
  if (/^\d+$/.test(t)) {
    const hops = Number(t);
    return (_address, hop) => hop < hops;
  }
  return t;
}
