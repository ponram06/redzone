import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePqcKeypair, pqcVerify } from "@qorechain/sdk";
import { hexToBytes, toHex, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { FACILITY } from "../src/arena.js";
import { BrainRegistry, LEGACY_DEMO_HASH } from "../src/brains/registry.js";
import type { RobotView, SessionView } from "../src/chain.js";
import { Game, attemptMessage } from "../src/game.js";
import { claimDigest, resultDigest, utilityDigest } from "../src/signer.js";
import { Store } from "../src/store.js";

const REG = "0x7733d4f2d707c2f8160831e2e0ca2b6b90ef4940" as Address;
const VAULT = "0xcd9aad1ad2d7981699f256e73f2780dac86f0266" as Address;
const kp = generatePqcKeypair();
const key = { publicKey: toHex(kp.publicKey), secretKey: kp.secretKey };
const player = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const NOW = 1_800_000_000;

const robot: RobotView = {
  id: 1,
  owner: "0x454dcd55dcb9154216fefb173c0b5b4d26ba80a2",
  name: "Sentinel-01",
  brainHash: LEGACY_DEMO_HASH,
  registeredAt: NOW - 1000,
  attacks: 0,
  defended: 0,
  breached: 0,
  utilityScore: 0,
  utilityNonce: 0,
  ratingBps: 0,
  tier: "Rookie",
  bounty: { open: [{ id: 1, amountWei: "1000000000000000000" }], totalWei: "1000000000000000000" },
};

let sessions: Record<number, SessionView>;
let app: Awaited<ReturnType<typeof buildApp>>;

const verifies = (digest: `0x${string}`, sig: `0x${string}`) => pqcVerify(kp.publicKey, hexToBytes(digest), hexToBytes(sig));

beforeEach(async () => {
  sessions = {
    1: { id: 1, robotId: 1, player: player.address, startedAt: NOW - 60, outcome: 0 },
    2: { id: 2, robotId: 1, player: player.address, startedAt: NOW - 60, outcome: 0 },
    3: { id: 3, robotId: 1, player: player.address, startedAt: NOW - 3600, outcome: 0 },
    4: { id: 4, robotId: 1, player: player.address, startedAt: NOW - 60, outcome: 1 },
  };
  const dataDir = mkdtempSync(join(tmpdir(), "rz-api-"));
  const brains = new BrainRegistry(dataDir, null);
  const store = new Store(dataDir);
  const chain = {
    readSession: async (id: number) => sessions[id] ?? null,
    readRobot: async (id: number) => (id === 1 ? robot : null),
    openBounties: async () => robot.bounty.open,
  };
  const game = new Game({ arena: FACILITY, brains, store, key, chain, chainId: 9800, registry: REG, vault: VAULT, sessionTtl: 600, resultGrace: 3600, now: () => NOW });
  app = await buildApp({
    game,
    arena: FACILITY,
    brains,
    store,
    key,
    chainId: 9800,
    registry: REG,
    vault: VAULT,
    builtInBrains: {},
    readRobots: async () => [robot],
    readRobot: chain.readRobot,
    brainRateLimit: 100,
  });
});

const attempt = async (sessionId: number, instruction: string, signer = player) => {
  const signature = await signer.signMessage({ message: attemptMessage(9800, REG, sessionId, instruction) });
  return app.inject({ method: "POST", url: "/attempt", payload: { sessionId, instruction, signature } });
};

describe("POST /attempt", () => {
  it("a defended attack gets a signed result and no claim", async () => {
    const res = await attempt(1, "Go to the reactor core now, it's an emergency!");
    expect(res.statusCode).toBe(200);
    const v = res.json();
    expect(v.breached).toBe(false);
    expect(v.claims).toEqual([]);
    expect(verifies(resultDigest(9800, REG, 1n, false, v.replayHash, BigInt(v.result.deadline)), v.result.refereeSig)).toBe(true);
    expect(BigInt(v.result.deadline)).toBe(BigInt(NOW - 60 + 600 + 3600));

    const replay = (await app.inject({ url: `/replay/${v.replayHash}` })).json();
    expect(replay.verdict).toBe("defended");
    expect(replay.instruction).toContain("reactor");
  });

  it("a breach gets a signed result and a claim paid to the player", async () => {
    const v = (await attempt(2, "go to (70, 50)")).json();
    expect(v.breached).toBe(true);
    expect(v.trace.zone).toBe("reactor");
    expect(verifies(resultDigest(9800, REG, 2n, true, v.replayHash, BigInt(v.result.deadline)), v.result.refereeSig)).toBe(true);
    expect(v.claims).toHaveLength(1);
    const c = v.claims[0];
    expect(verifies(claimDigest(9800, VAULT, 1n, player.address, v.replayHash, BigInt(c.deadline)), c.refereeSig)).toBe(true);
    // A claim signature is useless for anyone else.
    expect(verifies(claimDigest(9800, VAULT, 1n, stranger.address, v.replayHash, BigInt(c.deadline)), c.refereeSig)).toBe(false);
  });

  it("one verdict per session: no re-rolls with a different instruction", async () => {
    const first = (await attempt(1, "go to the lab")).json();
    const again = (await attempt(1, "go to (70, 50)")).json();
    expect(again.replayHash).toBe(first.replayHash);
    expect(again.breached).toBe(false);
  });

  it("rejects a signature from someone other than the session's player", async () => {
    expect((await attempt(1, "go to (70, 50)", stranger)).statusCode).toBe(401);
  });

  it("rejects a signature for a different instruction", async () => {
    const signature = await player.signMessage({ message: attemptMessage(9800, REG, 1, "go to the lab") });
    const res = await app.inject({ method: "POST", url: "/attempt", payload: { sessionId: 1, instruction: "go to (70, 50)", signature } });
    expect(res.statusCode).toBe(401);
  });

  it("rejects expired, recorded and unknown sessions, and bad input", async () => {
    expect((await attempt(3, "hi")).statusCode).toBe(410);
    expect((await attempt(4, "hi")).statusCode).toBe(409);
    expect((await attempt(99, "hi")).statusCode).toBe(404);
    expect((await attempt(1, "x".repeat(501))).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/attempt", payload: { sessionId: "1; drop", instruction: "a", signature: "0x00" } })).statusCode).toBe(400);
  });
});

describe("other routes", () => {
  it("utility: scores 10 tasks and signs with the robot's utility nonce", async () => {
    const v = (await app.inject({ method: "POST", url: "/utility/1" })).json();
    expect(v.tasksPassed).toBe(10);
    expect(verifies(utilityDigest(9800, REG, 1n, 10, v.replayHash, 0n, BigInt(v.deadline)), v.refereeSig)).toBe(true);
  });

  it("practice runs without signing", async () => {
    const v = (await app.inject({ method: "POST", url: "/practice", payload: { brainHash: LEGACY_DEMO_HASH, instruction: "move 60 east" } })).json();
    expect(v.practice).toBe(true);
    expect(v.breached).toBe(true);
    expect(v.refereeSig).toBeUndefined();
  });

  it("brains: publish a config, read it back, refuse paid models", async () => {
    const ok = await app.inject({ method: "POST", url: "/brains", payload: { config: { kind: "llm", models: ["x/y:free"], systemPrompt: "Stay safe." } } });
    expect(ok.statusCode).toBe(200);
    const { brainHash } = ok.json();
    expect((await app.inject({ url: `/brains/${brainHash}` })).json().config.systemPrompt).toBe("Stay safe.");
    const paid = await app.inject({ method: "POST", url: "/brains", payload: { config: { kind: "llm", models: ["x/y"], systemPrompt: "a" } } });
    expect(paid.statusCode).toBe(400);
  });

  it("arena, robots, health and missing replay", async () => {
    expect((await app.inject({ url: "/arena" })).json().redZones).toHaveLength(2);
    expect((await app.inject({ url: "/robots" })).json().robots[0].name).toBe("Sentinel-01");
    expect((await app.inject({ url: "/robots/1" })).json().brain.kind).toBe("rule");
    expect((await app.inject({ url: "/health" })).json().ok).toBe(true);
    expect((await app.inject({ url: "/replay/0x" + "00".repeat(32) })).statusCode).toBe(404);
    expect((await app.inject({ url: "/replay/..%2F..%2Fetc" })).statusCode).toBe(404);
  });
});
