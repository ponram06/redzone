/** File storage for replays and finished verdicts. Replays are named by their replayHash. */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "viem";
import { canonicalJson, hashJson } from "./canonical.js";

const HASH = /^0x[0-9a-f]{64}$/;

export type RobotProfile = { job: string; updatedAt: number; owner: string };

export class Store {
  private readonly replays: string;
  private readonly verdicts: string;
  private readonly profiles: string;

  constructor(dataDir: string) {
    this.replays = join(dataDir, "replays");
    this.verdicts = join(dataDir, "verdicts");
    this.profiles = join(dataDir, "profiles");
    mkdirSync(this.replays, { recursive: true });
    mkdirSync(this.verdicts, { recursive: true });
    mkdirSync(this.profiles, { recursive: true });
  }

  /** A robot's public profile (what it is used for), written by its owner. */
  getProfile(robotId: number): RobotProfile | null {
    const file = join(this.profiles, `${robotId}.json`);
    return Number.isSafeInteger(robotId) && existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as RobotProfile) : null;
  }

  saveProfile(robotId: number, profile: RobotProfile): void {
    if (!Number.isSafeInteger(robotId) || robotId < 1) throw new Error("bad robot id");
    atomicWrite(join(this.profiles, `${robotId}.json`), JSON.stringify(profile, null, 2));
  }

  /** Save a replay; returns replayHash = keccak256(canonical JSON). */
  saveReplay(replay: unknown): Hex {
    const hash = hashJson(replay);
    const file = join(this.replays, `${hash}.json`);
    if (!existsSync(file)) atomicWrite(file, canonicalJson(replay));
    return hash;
  }

  getReplay(hash: string): unknown | null {
    const h = hash.toLowerCase();
    if (!HASH.test(h)) return null;
    const file = join(this.replays, `${h}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  }

  getVerdict<T>(key: string): T | null {
    const file = join(this.verdicts, `${safe(key)}.json`);
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null;
  }

  /** Every stored verdict whose key starts with `prefix`. */
  listVerdicts<T>(prefix: string): T[] {
    return readdirSync(this.verdicts)
      .filter((n) => n.startsWith(prefix) && n.endsWith(".json"))
      .map((n) => JSON.parse(readFileSync(join(this.verdicts, n), "utf8")) as T);
  }

  saveVerdict(key: string, verdict: unknown): void {
    atomicWrite(join(this.verdicts, `${safe(key)}.json`), JSON.stringify(verdict, null, 2));
  }
}

function safe(key: string): string {
  if (!/^[\w-]{1,100}$/.test(key)) throw new Error("bad key");
  return key;
}

function atomicWrite(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}
