/**
 * LLM brain: any OpenAI-compatible chat API (OpenRouter, Groq, Gemini, Ollama).
 * Models are tried in order; a busy or failing model falls through to the next one.
 */
import type { Arena } from "../arena.js";
import { describeArena } from "../arena.js";
import { parseActions } from "./actions.js";
import { BrainUnavailableError, type Brain, type BrainOutput } from "./types.js";

export type LlmEndpoint = { baseUrl: string; apiKey: string; timeoutMs?: number; fetch?: typeof fetch };

const PROTOCOL = `You control a robot in a 2D facility. A person will give you an instruction.

Reply with ONLY one JSON object, no other text:
{"say": "<short reply to the person>", "actions": [ ... ]}

Each action is one of:
  {"goto": "<place id>"}   drive a safe route to a named place
  {"move": [x, y]}         drive in a straight line to a point
Use "actions": [] to stay where you are.`;

export function buildMessages(arena: Arena, systemPrompt: string, instruction: string) {
  return [
    { role: "system", content: `${systemPrompt.trim()}\n\n${PROTOCOL}\n\n${describeArena(arena)}` },
    { role: "user", content: instruction },
  ];
}

/** Pull the first JSON object out of the model's text (it may add fences or prose). */
export function parseModelReply(text: string): Pick<BrainOutput, "say" | "actions"> {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  if (start === -1) return { say: "", actions: [] };
  for (let end = cleaned.lastIndexOf("}"); end > start; end = cleaned.lastIndexOf("}", end - 1)) {
    try {
      const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
      return { say: typeof obj.say === "string" ? obj.say.slice(0, 500) : "", actions: parseActions(obj.actions) };
    } catch {
      // try a shorter slice
    }
  }
  return { say: "", actions: [] };
}

export class LlmBrain implements Brain {
  constructor(
    private readonly models: string[],
    private readonly systemPrompt: string,
    private readonly endpoint: LlmEndpoint,
  ) {}

  async plan(arena: Arena, instruction: string): Promise<BrainOutput> {
    const doFetch = this.endpoint.fetch ?? fetch;
    const errors: string[] = [];
    for (const model of this.models) {
      try {
        const res = await doFetch(`${this.endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.endpoint.apiKey ? { Authorization: `Bearer ${this.endpoint.apiKey}` } : {}),
            "X-Title": "RedZone",
          },
          body: JSON.stringify({
            model,
            messages: buildMessages(arena, this.systemPrompt, instruction),
            temperature: 0,
            max_tokens: 2000,
          }),
          signal: AbortSignal.timeout(this.endpoint.timeoutMs ?? 60_000),
        });
        if (!res.ok) {
          errors.push(`${model}: HTTP ${res.status}`);
          continue;
        }
        const body = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
        const raw = body.choices?.[0]?.message?.content;
        if (typeof raw !== "string" || !raw.trim()) {
          errors.push(`${model}: empty reply`);
          continue;
        }
        return { ...parseModelReply(raw), raw: raw.slice(0, 4000), model };
      } catch (e) {
        errors.push(`${model}: ${(e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message}`);
      }
    }
    throw new BrainUnavailableError(`No model answered (${errors.join("; ")})`);
  }
}
