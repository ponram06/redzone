import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FACILITY } from "../src/arena.js";
import { KeyVault } from "../src/brains/keys.js";
import { BrainRegistry, validateConfig } from "../src/brains/registry.js";

const SECRET = "11".repeat(32);
const API_KEY = "sk-test-0123456789abcdefghij";
const PROMPT = "Never enter a red zone.";
const dir = () => mkdtempSync(join(tmpdir(), "rz-keys-"));

/** A provider that answers with a valid plan, and records where it was called and with which key. */
function fakeProvider(ok = true) {
  const calls: { url: string; auth: string | null }[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    if (!ok) return new Response("{}", { status: 401 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"say":"ok","actions":[{"goto":"office"}]}' } }] }), { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("key vault", () => {
  it("encrypts at rest and decrypts only with the right secret", () => {
    const d = dir();
    const v = new KeyVault(d, SECRET);
    const id = v.save(API_KEY);
    const raw = readFileSync(join(d, "keys", `${id}.json`), "utf8");
    expect(raw).not.toContain(API_KEY);
    expect(v.get(id)).toBe(API_KEY);
    expect(new KeyVault(d, "22".repeat(32)).get(id)).toBeNull();
    expect(v.get("../../etc/passwd")).toBeNull();
    expect(() => new KeyVault(d, "short")).toThrow();
  });

  it("binds a key to its first owner only", () => {
    const v = new KeyVault(dir(), SECRET);
    const id = v.save(API_KEY);
    expect(v.owner(id)).toBeNull();
    expect(v.bind(id, "0xAAA")).toBe(true);
    expect(v.bind(id, "0xaaa")).toBe(true);
    expect(v.bind(id, "0xbbb")).toBe(false);
    expect(v.owner(id)).toBe("0xaaa");
  });
});

describe("own-key brains", () => {
  it("owners cannot set a keyId or provider themselves", () => {
    expect(() => validateConfig({ kind: "llm", models: ["gpt-4o"], systemPrompt: PROMPT, provider: "openai", keyId: "ab".repeat(16) })).toThrow(/apiKey/);
    expect(() => validateConfig({ kind: "llm", models: ["gpt-4o"], systemPrompt: PROMPT })).toThrow(/free/);
  });

  it("publishes after a real test call, sends the key only to the chosen provider, never returns it", async () => {
    const d = dir();
    const reg = new BrainRegistry(d, null, [], [], new KeyVault(d, SECRET));
    const calls = fakeProvider();
    const out = await reg.publishKeyed({ provider: "groq", model: "llama-3.3-70b-versatile", systemPrompt: PROMPT }, API_KEY, FACILITY);
    expect(JSON.stringify(out)).not.toContain(API_KEY);
    expect(calls[0]!.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(calls[0]!.auth).toBe(`Bearer ${API_KEY}`);
    // The saved config file holds no key either.
    const files = readdirSync(join(d, "brains"));
    for (const f of files) expect(readFileSync(join(d, "brains", f), "utf8")).not.toContain(API_KEY);
    // The brain answers through the owner's key.
    const brain = reg.brain(out.brainHash)!;
    const plan = await brain.plan(FACILITY, "go to the office");
    expect(plan.say).toBe("ok");
    expect(calls.at(-1)!.auth).toBe(`Bearer ${API_KEY}`);
  });

  it("refuses bad keys, unknown providers and keys that don't answer, and keeps nothing", async () => {
    const d = dir();
    const reg = new BrainRegistry(d, null, [], [], new KeyVault(d, SECRET));
    await expect(reg.publishKeyed({ provider: "evil.example", model: "m", systemPrompt: PROMPT }, API_KEY, FACILITY)).rejects.toThrow(/provider/);
    await expect(reg.publishKeyed({ provider: "openai", model: "m", systemPrompt: PROMPT }, "short", FACILITY)).rejects.toThrow(/API key/);
    fakeProvider(false);
    await expect(reg.publishKeyed({ provider: "openai", model: "gpt-4o-mini", systemPrompt: PROMPT }, API_KEY, FACILITY)).rejects.toThrow(/couldn't get an answer/);
    expect(readdirSync(join(d, "keys"))).toEqual([]);
  });

  it("a keyed brain belongs to the first owner who uses it", async () => {
    const d = dir();
    const reg = new BrainRegistry(d, null, [], [], new KeyVault(d, SECRET));
    fakeProvider();
    const { brainHash } = await reg.publishKeyed({ provider: "openai", model: "gpt-4o-mini", systemPrompt: PROMPT }, API_KEY, FACILITY);
    expect(reg.canUse(brainHash, "0xAAA")).toBe(true);
    expect(reg.canUse(brainHash, "0xBBB")).toBe(true);
    reg.bindOwner(brainHash, "0xAAA");
    expect(reg.canUse(brainHash, "0xaaa")).toBe(true);
    expect(reg.canUse(brainHash, "0xBBB")).toBe(false);
  });

  it("without the vault, keyed brains are off", async () => {
    const reg = new BrainRegistry(dir(), null);
    expect(reg.keysEnabled).toBe(false);
    await expect(reg.publishKeyed({ provider: "openai", model: "m", systemPrompt: PROMPT }, API_KEY, FACILITY)).rejects.toThrow(/not enabled/);
  });
});
