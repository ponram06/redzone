/**
 * LLM brain: any OpenAI-compatible chat API (OpenRouter, Groq, Gemini, Ollama).
 * Models are tried in order; a busy or failing model falls through to the next one.
 */
import type { Arena } from "../arena.js";
import { describeArena } from "../arena.js";
import { parseActions } from "./actions.js";
import { BrainUnavailableError, type Brain, type BrainOutput } from "./types.js";

export type LlmEndpoint = {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  /** Extra request fields for this provider (e.g. turning off "thinking" on a local model). */
  extraBody?: Record<string, unknown>;
  fetch?: typeof fetch;
};

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

/**
 * Operator-run backup models (other free providers, or Ollama), tried in order only when every model
 * in the brain config fails. The replay records which model answered.
 */
export type LlmFallback = { endpoint: LlmEndpoint; model: string };

/**
 * How long a model may think before the next one starts alongside it (free models can sit in a
 * queue for a minute). The first valid answer wins and the others are cancelled.
 */
export const DEFAULT_HEDGE_MS = Number(process.env.BRAIN_HEDGE_MS) > 0 ? Number(process.env.BRAIN_HEDGE_MS) : 8_000;

type Attempt = { endpoint: LlmEndpoint; model: string };

export class LlmBrain implements Brain {
  constructor(
    private readonly models: string[],
    private readonly systemPrompt: string,
    private readonly endpoint: LlmEndpoint,
    private readonly fallbacks: LlmFallback[] = [],
    private readonly hedgeMs = DEFAULT_HEDGE_MS,
  ) {}

  /**
   * Models are asked in order. A model that fails hands over at once; one that is still thinking
   * after hedgeMs gets the next model started next to it. The first usable reply is the answer.
   */
  plan(arena: Arena, instruction: string): Promise<BrainOutput> {
    const attempts: Attempt[] = this.models.map((model) => ({ endpoint: this.endpoint, model }));
    attempts.push(...this.fallbacks);
    const errors: string[] = [];
    let limited = 0;
    const controllers: AbortController[] = [];
    return new Promise<BrainOutput>((resolve, reject) => {
      let next = 0;
      let running = 0;
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        done = true;
        clearTimeout(timer);
        for (const c of controllers) c.abort();
      };
      const launch = () => {
        if (done) return;
        clearTimeout(timer);
        if (next >= attempts.length) {
          if (running === 0) {
            finish();
            // Every model failed; if most of them said "limit reached", that is the reason to show.
            reject(new BrainUnavailableError(`No model answered (${errors.join("; ")})`, limited > 0 && limited * 2 >= errors.length));
          }
          return;
        }
        const attempt = attempts[next++]!;
        const ctl = new AbortController();
        controllers.push(ctl);
        running++;
        this.ask(attempt, arena, instruction, ctl.signal).then(
          (out) => {
            running--;
            if (done) return;
            finish();
            resolve(out);
          },
          (e: unknown) => {
            running--;
            if (done) return;
            if (e instanceof LimitError) limited++;
            errors.push(`${attempt.model}: ${(e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message}`);
            launch();
          },
        );
        if (next < attempts.length) timer = setTimeout(launch, this.hedgeMs);
      };
      launch();
    });
  }

  private async ask({ endpoint, model }: Attempt, arena: Arena, instruction: string, cancel: AbortSignal): Promise<BrainOutput> {
    const doFetch = endpoint.fetch ?? fetch;
    const res = await doFetch(`${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
        "X-Title": "RedZone",
      },
      body: JSON.stringify({
        model,
        messages: buildMessages(arena, this.systemPrompt, instruction),
        temperature: 0,
        max_tokens: 2000,
        ...endpoint.extraBody,
      }),
      signal: AbortSignal.any([cancel, AbortSignal.timeout(endpoint.timeoutMs ?? 60_000)]),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      if (res.status === 429 || res.status === 402 || /quota|rate.?limit|credit|per.?day|insufficient/i.test(detail)) {
        throw new LimitError(`HTTP ${res.status} (usage limit)`);
      }
      throw new Error(`HTTP ${res.status}`);
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    const raw = body.choices?.[0]?.message?.content;
    if (typeof raw !== "string" || !raw.trim()) throw new Error("empty reply");
    return { ...parseModelReply(raw), raw: raw.slice(0, 4000), model };
  }
}

/** A provider refused because a usage limit (free quota, rate limit, credits) is reached. */
class LimitError extends Error {}
