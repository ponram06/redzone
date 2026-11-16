/** Client for the RedZone referee backend. */

/**
 * The RedZone server. Set VITE_API_URL when building for production; without it a production build
 * calls its own origin (put the server behind the same domain), and `npm run dev` uses the local server.
 */
export const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? (import.meta.env.DEV ? "http://127.0.0.1:8787" : "");

export type Point = { x: number; y: number };
export type Place = { id: string; name: string; at: Point; radius: number };
export type Arena = {
  id: string;
  name: string;
  width: number;
  height: number;
  start: Point;
  walls: Point[][];
  redZones: { id: string; name: string; polygon: Point[] }[];
  places: Place[];
  utilityTasks: { id: string; instruction: string; target: string }[];
  maxInstruction: number;
};

export type Robot = {
  id: number;
  owner: string;
  name: string;
  brainHash: string;
  registeredAt: number;
  attacks: number;
  defended: number;
  breached: number;
  utilityScore: number;
  ratingBps: number;
  tier: "Rookie" | "Guard" | "Sentinel";
  bounty: { open: { id: number; amountWei: string }[]; totalWei: string };
};

export type Trace = {
  path: Point[];
  breached: boolean;
  zone?: string;
  contact?: Point;
  stopped: "done" | "wall" | "limit" | "breach";
  length: number;
};

export type Action = { goto: string } | { move: Point };

export type PracticeResult = {
  practice: true;
  breached: boolean;
  say: string;
  actions: Action[];
  model?: string;
  trace: Trace;
};

export type Health = {
  ok: boolean;
  chainId: number;
  registry: string;
  vault: string;
  refereePubkeyHash: string;
  builtInBrains: Record<string, string>;
  relayer: { address: string; cosmos: string } | null;
  /** Bounties are paid to payTo from QoreX and locked in the vault by RedZone. */
  prize?: { minUqor: string; payTo: string } | null;
  /** Native chain id QoreX signs for (from the deployment record). */
  nativeChainId: string | null;
  signupFeeUqor: string | null;
  /** Game rules, read from the contract by the server. */
  rules: { attemptsPerDay: number; sessionTtl: number; resultGrace: number; utilityTasks: number; maxNameLength: number } | null;
  explorerUrl: string | null;
  ownKeys?: { enabled: boolean; providers: { id: string; name: string }[] };
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export type SessionRequest = { robotId: number; player: string; nonce: string; deadline: number; digest: string; text: string; attemptsLeft: number };
export type SessionStarted = { sessionId: number; tx: string; expiresAt: number; player: string };
export type Verdict = {
  sessionId: number;
  robotId: number;
  player: string;
  breached: boolean;
  say: string;
  trace: Trace;
  replayHash: string;
  claims: { bountyId: number; amountWei: string }[];
  relay?: { resultTx?: string; claimTxs?: { bountyId: number; tx: string }[]; error?: string };
};

/** Same text the backend and the referee check (game.ts attemptMessage). */
export const attemptMessage = (chainId: number, registry: string, sessionId: number, instruction: string) =>
  `RedZone attempt\nchain: ${chainId}\nregistry: ${registry.toLowerCase()}\nsession: ${sessionId}\ninstruction: ${instruction.replace(/\r\n?/g, "\n").trim()}`;

export type PlayerStatus = {
  evm: string;
  qor: string;
  pqKeyRegistered: boolean;
  signedUp: boolean;
  signupTx: string | null;
  attemptsLeft: number;
  signup: { feeUqor: string; payTo: string; memo: string } | null;
};

export type LeaderRow = { rank: number; player: string; qor: string; attempts: number; wins: number; wonWei: string };
/** A maker's bounty still in the vault (read from the chain). */
export type OwnerBounty = { robotId: number; bountyId: number; uqor: string };
export const bountyMemo = (robotId: number) => `RedZone bounty #${robotId}`;
export type SignRequest = { deadline: number; digest: string; text: string };
export type BrainConfig = { kind: "rule"; version: 1 } | { kind: "llm"; version: 1; models: string[]; systemPrompt: string };
export type UtilityResult = { robotId: number; tasksPassed: number; relay?: { tx?: string; error?: string } };

export const api = {
  publishOwnBrain: (provider: string, model: string, systemPrompt: string, apiKey: string) =>
    call<{ brainHash: string }>("/brains", { method: "POST", body: JSON.stringify({ config: { provider, model, systemPrompt }, apiKey }) }),
  addBounty: (robotId: number, owner: string, txHash: string) =>
    call<{ robotId: number; bountyIds: number[]; lockedUqor: string; depositTx: string | null }>("/owner/bounty", {
      method: "POST",
      body: JSON.stringify({ robotId, owner, txHash }),
    }),
  ownerBounties: (owner: string) => call<{ bounties: OwnerBounty[] }>(`/owner/${encodeURIComponent(owner)}/bounties`).then((r) => r.bounties),
  bountyBackRequest: (bountyId: number, owner: string) =>
    call<SignRequest>(`/owner/bounty/back/request?bountyId=${bountyId}&owner=${encodeURIComponent(owner)}`),
  takeBountyBack: (body: { bountyId: number; owner: string; deadline: number; pqSignature: string }) =>
    call<{ bountyId: number; tx: string; uqor: string }>("/owner/bounty/back", { method: "POST", body: JSON.stringify(body) }),
  leaderboard: () => call<{ players: LeaderRow[] }>("/leaderboard").then((r) => r.players),
  publishBrain: (config: BrainConfig) => call<{ brainHash: string }>("/brains", { method: "POST", body: JSON.stringify({ config }) }),
  brain: (hash: string) => call<{ brainHash: string; config: BrainConfig }>(`/brains/${hash}`),
  robotRequest: (owner: string, name: string, brainHash: string) =>
    call<SignRequest>(`/owner/robot/request?owner=${encodeURIComponent(owner)}&name=${encodeURIComponent(name)}&brainHash=${brainHash}`),
  registerRobot: (body: { owner: string; name: string; brainHash: string; deadline: number; pqSignature: string }) =>
    call<{ robotId: number; tx: string }>("/owner/robot", { method: "POST", body: JSON.stringify(body) }),
  brainRequest: (robotId: number, owner: string, brainHash: string) =>
    call<SignRequest>(`/owner/brain/request?robotId=${robotId}&owner=${encodeURIComponent(owner)}&brainHash=${brainHash}`),
  updateBrain: (body: { robotId: number; owner: string; brainHash: string; deadline: number; pqSignature: string }) =>
    call<{ robotId: number; tx: string }>("/owner/brain", { method: "POST", body: JSON.stringify(body) }),
  utility: (robotId: number) => call<UtilityResult>(`/utility/${robotId}`, { method: "POST" }),
  player: (address: string) => call<PlayerStatus>(`/player/${encodeURIComponent(address)}`),
  registerPlayer: (address: string, txHash: string) =>
    call<{ signedUp: boolean; txHash: string }>("/player/register", { method: "POST", body: JSON.stringify({ address, txHash }) }),
  sessionRequest: (robotId: number, player: string) =>
    call<SessionRequest>(`/session/request?robotId=${robotId}&player=${encodeURIComponent(player)}`),
  sessionStart: (body: { robotId: number; player: string; deadline: number; pqSignature: string }) =>
    call<SessionStarted>("/session/start", { method: "POST", body: JSON.stringify(body) }),
  attempt: (sessionId: number, instruction: string, pqSignature: string) =>
    call<Verdict>("/attempt", { method: "POST", body: JSON.stringify({ sessionId, instruction, pqSignature }) }),
  relayAgain: (sessionId: number) => call<Verdict>(`/attempt/${sessionId}/relay`, { method: "POST" }),
  health: () => call<Health>("/health"),
  arena: () => call<Arena>("/arena"),
  robots: () => call<{ robots: Robot[] }>("/robots").then((r) => r.robots),
  practice: (brainHash: string, instruction: string) =>
    call<PracticeResult>("/practice", { method: "POST", body: JSON.stringify({ brainHash, instruction }) }),
};

export const formatQor = (wei: string) => {
  const n = Number(BigInt(wei) / 10n ** 14n) / 10_000;
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 4 })} QOR`;
};
