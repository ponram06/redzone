/**
 * Owner API keys for "bring your own AI" brains.
 *
 * - Keys are encrypted at rest (AES-256-GCM) with BRAIN_KEY_SECRET; the plaintext never leaves
 *   this process except in the Authorization header sent to the owner's chosen provider.
 * - Providers come from a fixed allowlist, so a key (or our server) can't be pointed at an
 *   arbitrary URL.
 * - Each key gets a random keyId. The brain config stores only the keyId, so its hash stays
 *   public and checkable while the key stays secret.
 * - A key is bound to the first robot owner who registers a robot with it, so nobody else can
 *   reuse someone's brain (and spend their key) for their own robot.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PROVIDERS = {
  openrouter: { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  openai: { name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  groq: { name: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  gemini: { name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  mistral: { name: "Mistral", baseUrl: "https://api.mistral.ai/v1" },
  deepseek: { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  together: { name: "Together AI", baseUrl: "https://api.together.xyz/v1" },
} as const;

export type ProviderId = keyof typeof PROVIDERS;

export const isProvider = (p: unknown): p is ProviderId => typeof p === "string" && Object.hasOwn(PROVIDERS, p);

const KEY_ID = /^[0-9a-f]{32}$/;

/** Plausible API key: 16 to 300 visible ASCII characters, no spaces. */
export const isApiKeyShape = (k: unknown): k is string => typeof k === "string" && /^[\x21-\x7e]{16,300}$/.test(k);

type Record_ = { v: 1; iv: string; tag: string; data: string; owner: string | null; createdAt: number };

export class KeyVault {
  private readonly dir: string;
  private readonly secret: Buffer;

  /** `secretHex` must be 64 hex characters (32 bytes). */
  constructor(dataDir: string, secretHex: string) {
    if (!/^[0-9a-fA-F]{64}$/.test(secretHex)) throw new Error("BRAIN_KEY_SECRET must be 64 hex characters");
    this.secret = Buffer.from(secretHex, "hex");
    this.dir = join(dataDir, "keys");
    mkdirSync(this.dir, { recursive: true });
  }

  private file(keyId: string): string {
    if (!KEY_ID.test(keyId)) throw new Error("bad keyId");
    return join(this.dir, `${keyId}.json`);
  }

  private read(keyId: string): Record_ | null {
    if (!KEY_ID.test(keyId)) return null;
    const f = this.file(keyId);
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record_) : null;
  }

  private write(keyId: string, r: Record_): void {
    const f = this.file(keyId);
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(r), { mode: 0o600 });
    renameSync(tmp, f);
  }

  save(apiKey: string): string {
    const keyId = randomBytes(16).toString("hex");
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.secret, iv);
    c.setAAD(Buffer.from(keyId));
    const data = Buffer.concat([c.update(apiKey, "utf8"), c.final()]);
    this.write(keyId, { v: 1, iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), data: data.toString("hex"), owner: null, createdAt: Date.now() });
    return keyId;
  }

  get(keyId: string): string | null {
    const r = this.read(keyId);
    if (!r) return null;
    try {
      const d = createDecipheriv("aes-256-gcm", this.secret, Buffer.from(r.iv, "hex"));
      d.setAAD(Buffer.from(keyId));
      d.setAuthTag(Buffer.from(r.tag, "hex"));
      return Buffer.concat([d.update(Buffer.from(r.data, "hex")), d.final()]).toString("utf8");
    } catch {
      return null;
    }
  }

  /** undefined: no such key. null: not bound yet. */
  owner(keyId: string): string | null | undefined {
    const r = this.read(keyId);
    return r ? r.owner : undefined;
  }

  /** Bind to `owner` (lowercase 0x address). Returns false if it already belongs to someone else. */
  bind(keyId: string, owner: string): boolean {
    const r = this.read(keyId);
    if (!r) return false;
    const o = owner.toLowerCase();
    if (r.owner && r.owner !== o) return false;
    if (!r.owner) this.write(keyId, { ...r, owner: o });
    return true;
  }

  remove(keyId: string): void {
    const f = this.file(keyId);
    if (existsSync(f)) unlinkSync(f);
  }
}
