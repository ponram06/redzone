/**
 * Brain registry: maps a robot's on-chain brainHash to the brain config that answers for it.
 *
 * brainHash = keccak256(canonical JSON of the config). Owners create a config with
 * POST /brains, get its hash, and register the robot with that hash on chain.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, stringToBytes, type Hex } from "viem";
import { hashJson } from "../canonical.js";
import type { Arena } from "../arena.js";
import { PROVIDERS, isApiKeyShape, isProvider, type KeyVault, type ProviderId } from "./keys.js";
import { LlmBrain, type LlmEndpoint, type LlmFallback } from "./llm.js";
import { RuleBrain } from "./rule.js";
import type { Brain, BrainConfig } from "./types.js";

export const RULE_BRAIN: BrainConfig = { kind: "rule", version: 1 };

/** Robot 1 ("Sentinel-01") was registered before configs existed, with this fixed hash. */
export const LEGACY_DEMO_HASH: Hex = keccak256(stringToBytes("redzone-demo-brain-v1"));

export const MAX_PROMPT = 4000;
export const MAX_MODELS = 5;

export function brainHash(config: BrainConfig): Hex {
  return hashJson(config);
}

/**
 * Check a brain config. Without an owner key only free models are allowed, so nobody spends on our
 * key. `trusted` is for configs this server wrote itself: only those may carry a keyId.
 */
export function validateConfig(value: unknown, trusted = false): BrainConfig {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object") throw new Error("config must be an object");
  if (v.kind === "rule") return RULE_BRAIN;
  if (v.kind !== "llm") throw new Error('kind must be "rule" or "llm"');
  const models = v.models;
  if (!Array.isArray(models) || models.length < 1 || models.length > MAX_MODELS) {
    throw new Error(`models must list 1 to ${MAX_MODELS} model ids`);
  }
  for (const m of models) {
    if (typeof m !== "string" || m.length > 100 || !/^[\w.\-/:]+$/.test(m)) throw new Error(`bad model id: ${String(m)}`);
  }
  const keyed = v.keyId !== undefined || v.provider !== undefined;
  if (keyed) {
    if (!trusted) throw new Error("to use your own AI provider, send the API key separately (apiKey); keyId is set by the server");
    if (typeof v.keyId !== "string" || !/^[0-9a-f]{32}$/.test(v.keyId)) throw new Error("bad keyId");
    if (!isProvider(v.provider)) throw new Error("unknown provider");
  } else {
    for (const m of models) if (!(m as string).endsWith(":free")) throw new Error(`only free models (ending in ":free") are allowed: ${m}`);
  }
  if (typeof v.systemPrompt !== "string" || !v.systemPrompt.trim() || v.systemPrompt.length > MAX_PROMPT) {
    throw new Error(`systemPrompt must be 1 to ${MAX_PROMPT} characters`);
  }
  const base = { kind: "llm" as const, version: 1 as const, models: models as string[], systemPrompt: v.systemPrompt };
  return keyed ? { ...base, provider: v.provider as ProviderId, keyId: v.keyId as string } : base;
}

export class BrainRegistry {
  private readonly dir: string;

  constructor(
    dataDir: string,
    private readonly endpoint: LlmEndpoint | null,
    builtIns: BrainConfig[] = [],
    private readonly fallbacks: LlmFallback[] = [],
    private readonly keys: KeyVault | null = null,
  ) {
    this.dir = join(dataDir, "brains");
    mkdirSync(this.dir, { recursive: true });
    for (const c of [RULE_BRAIN, ...builtIns]) this.save(c);
  }

  save(config: BrainConfig): Hex {
    const hash = brainHash(config);
    const file = join(this.dir, `${hash}.json`);
    if (!existsSync(file)) writeFileSync(file, JSON.stringify(config, null, 2));
    return hash;
  }

  config(hash: string): BrainConfig | null {
    if (hash.toLowerCase() === LEGACY_DEMO_HASH) return RULE_BRAIN;
    if (!/^0x[0-9a-f]{64}$/.test(hash.toLowerCase())) return null;
    const file = join(this.dir, `${hash.toLowerCase()}.json`);
    if (!existsSync(file)) return null;
    const config = validateConfig(JSON.parse(readFileSync(file, "utf8")), true);
    return brainHash(config) === hash.toLowerCase() ? config : null;
  }

  brain(hash: string): Brain | null {
    const c = this.config(hash);
    if (!c) return null;
    if (c.kind === "rule") return new RuleBrain();
    if (c.keyId && c.provider) {
      const apiKey = this.keys?.get(c.keyId);
      if (!apiKey) return null;
      // The owner's provider first; if it fails (quota, outage) the operator backups keep the game running.
      return new LlmBrain(c.models, c.systemPrompt, { baseUrl: PROVIDERS[c.provider].baseUrl, apiKey }, this.fallbacks);
    }
    if (this.endpoint) return new LlmBrain(c.models, c.systemPrompt, this.endpoint, this.fallbacks);
    if (this.fallbacks[0]) return new LlmBrain([], c.systemPrompt, this.fallbacks[0].endpoint, this.fallbacks);
    return null;
  }

  /** Whether own-API-key brains are enabled on this server. */
  get keysEnabled(): boolean {
    return !!this.keys;
  }

  /**
   * "Bring your own AI": store the key encrypted, check it really answers (without our backups),
   * then save the config. The key is never returned or logged.
   */
  async publishKeyed(input: { provider: unknown; model: unknown; systemPrompt: unknown }, apiKey: unknown, arena: Arena) {
    if (!this.keys) throw new Error("own API keys are not enabled on this server");
    if (!isProvider(input.provider)) throw new Error(`provider must be one of: ${Object.keys(PROVIDERS).join(", ")}`);
    if (!isApiKeyShape(apiKey)) throw new Error("that doesn't look like an API key");
    const keyId = this.keys.save(apiKey);
    try {
      const config = validateConfig({ kind: "llm", version: 1, models: [input.model], systemPrompt: input.systemPrompt, provider: input.provider, keyId }, true);
      if (config.kind !== "llm") throw new Error("bad config");
      const probe = new LlmBrain(config.models, config.systemPrompt, { baseUrl: PROVIDERS[input.provider].baseUrl, apiKey, timeoutMs: 45_000 }, []);
      try {
        await probe.plan(arena, "Please go to the office.");
      } catch {
        throw new Error(`we couldn't get an answer from ${PROVIDERS[input.provider].name} with this key and model: check both and try again`);
      }
      return { brainHash: this.save(config), config };
    } catch (e) {
      this.keys.remove(keyId);
      throw e;
    }
  }

  /** May `owner` put this brain on a robot? Brains with an owner key belong to whoever used them first. */
  canUse(hash: string, owner: string): boolean {
    const c = this.config(hash);
    if (!c || c.kind !== "llm" || !c.keyId) return true;
    const o = this.keys?.owner(c.keyId);
    return o === null || o === owner.toLowerCase();
  }

  /** Bind a keyed brain to the owner who just put it on a robot. */
  bindOwner(hash: string, owner: string): void {
    const c = this.config(hash);
    if (c?.kind === "llm" && c.keyId) this.keys?.bind(c.keyId, owner);
  }
}
