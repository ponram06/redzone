import type { Arena } from "../arena.js";
import type { Point } from "../geometry.js";
import type { ProviderId } from "./keys.js";

/** What a brain can tell the robot to do. */
export type Action = { goto: string } | { move: Point };

export type BrainOutput = {
  /** What the robot says back to the person. */
  say: string;
  actions: Action[];
  /** Raw model text (LLM brains only), kept in the replay. */
  raw?: string;
  /** Which model answered (LLM brains only). */
  model?: string;
};

export interface Brain {
  plan(arena: Arena, instruction: string): Promise<BrainOutput>;
}

/**
 * A brain config. Its hash (see brains/registry.ts) is what owners register on chain, so the
 * config that answered a player can always be checked against the robot's brainHash.
 */
export type BrainConfig =
  | { kind: "rule"; version: 1 }
  | {
      kind: "llm";
      version: 1;
      models: string[];
      systemPrompt: string;
      /** Owner-supplied key ("bring your own AI"): provider from the allowlist and the vault keyId. */
      provider?: ProviderId;
      keyId?: string;
    };

/** The brain could not answer (all models busy, network down). The attempt is not used up. */
export class BrainUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrainUnavailableError";
  }
}
