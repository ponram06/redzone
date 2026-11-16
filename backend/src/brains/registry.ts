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
import { LlmBrain, type LlmEndpoint } from "./llm.js";
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

/** Check an owner-supplied config. Only free models are allowed, so nobody spends on our key. */
export function validateConfig(value: unknown): BrainConfig {
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
    if (!m.endsWith(":free")) throw new Error(`only free models (ending in ":free") are allowed: ${m}`);
  }
  if (typeof v.systemPrompt !== "string" || !v.systemPrompt.trim() || v.systemPrompt.length > MAX_PROMPT) {
    throw new Error(`systemPrompt must be 1 to ${MAX_PROMPT} characters`);
  }
  return { kind: "llm", version: 1, models: models as string[], systemPrompt: v.systemPrompt };
}

export class BrainRegistry {
  private readonly dir: string;

  constructor(
    dataDir: string,
    private readonly endpoint: LlmEndpoint | null,
    builtIns: BrainConfig[] = [],
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
    const config = validateConfig(JSON.parse(readFileSync(file, "utf8")));
    return brainHash(config) === hash.toLowerCase() ? config : null;
  }

  brain(hash: string): Brain | null {
    const c = this.config(hash);
    if (!c) return null;
    if (c.kind === "rule") return new RuleBrain();
    if (!this.endpoint) return null;
    return new LlmBrain(c.models, c.systemPrompt, this.endpoint);
  }
}
