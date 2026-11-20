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
  brainVersion?: number;
  /** When this robot's AI last refused because its free usage limit was reached (unix s, last 15 minutes), else null. */
  aiLimitSince?: number | null;
  /** Set while the robot waits for its owner's fix after a paid breach: paid rounds are refused until then. */
  frozen?: Freeze | null;
  /**
   * Open prize pools: what is left, the prize per win, whether it pays once per brain version, the
   * oldest brain version it still pays for, and when the owner asked for it back (0 = not asked).
   */
  bounty: {
    open: { id: number; amountWei: string; prizeWei: string; oncePerBrain: boolean; minBrainVersion?: number; withdrawRequestedAt?: number }[];
    totalWei: string;
  };
  /** What one breach in a round started now pays a new player: every open pool pays it. */
  nextWinWei?: string;
  /** What the owner says the robot is used for (off chain, signed by the owner). */
  job?: string | null;
  /** The body and colour the owner chose (off chain, signed with the job); null = the default. */
  look?: { kind: string; color: string } | null;
};

/** Everything on a player's profile page (all of it public chain data). */
export type PlayerProfile = {
  evm: string;
  qor: string;
  balanceUqor: string | null;
  stats: {
    rounds: number;
    wins: number;
    defended: number;
    earnedWei: string;
    rank: number | null;
    players: number;
    triesBought: number;
    robotsFaced: number;
    firstRoundAt: number | null;
    beaten: { robot: string; n: number }[];
  };
  rounds: { sessionId: number; robotId: number; robot: string; breached: boolean; wonWei: string; at: number | null; tx: string; replayHash: string }[];
  prizes: { bountyId: number; sessionId: number; robotId: number | null; robot: string | null; amountWei: string; tx: string; resultTx: string | null; replayHash: string; at: number | null }[];
  tries: { count: number; paidWei: string; tx: string }[];
  wallet: {
    txHash: string;
    time: string | null;
    height: number;
    direction: "in" | "out";
    uqor: string;
    memo: string;
    kind: "signup" | "tries" | "bounty" | "sent" | "received";
    label: string;
    counterparty: string;
    redzone: boolean;
    ok: boolean;
  }[];
  walletAvailable: boolean;
};

/** A robot's public record, for the robot picker. */
export type RobotRecord = {
  robotId: number;
  rounds: { sessionId: number; player: string; breached: boolean; wonWei: string; at: number | null }[];
  totalRounds: number;
  breaches: number;
  paidWei: string;
  profile: { job: string; updatedAt: number } | null;
  brain: { kind: string; models?: string[]; provider?: string | null } | null;
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
  /** The live vault contract (EscrowVaultV4 or EscrowVaultV5). */
  vaultName?: string;
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
  /** Free tries left today plus paid tries. */
  attemptsLeft: number;
  signup: { feeUqor: string; payTo: string; memo: string } | null;
  /** Paid tries left (used after the free daily ones; they don't expire). */
  extraTries: number;
  /** A live play pass held by RedZone's relayer: rounds start with no wallet prompt until validUntil. */
  pass: { validUntil: number; roundsLeft: number } | null;
  /** Extra tries for sale: price per try, paid from QoreX to payTo with this memo. */
  tries: { priceUqor: string; payTo: string; memo: string } | null;
};

/** A judged round from the chain, for the live feed. `at` = when the round started (unix seconds). */
export type ActivityRow = { sessionId: number; robotId: number; robot: string; player: string; breached: boolean; wonWei: string; at: number | null };

export type LeaderRow = { rank: number; player: string; qor: string; attempts: number; wins: number; wonWei: string };
/** A maker's bounty still in the vault (read from the chain). */
export type OwnerBounty = { robotId: number; bountyId: number; uqor: string; withdraw: { requestedAt: number; unlocksAt: number } | null };
export const bountyMemo = (robotId: number) => `RedZone bounty #${robotId}`;

/** How a bounty pays out. prizeUqor null = one winner takes it all. */
export type PoolTerms = { prizeUqor: string | null; oncePerBrain: boolean };

/** The payment memo carries the maker's terms (see backend parseBountyMemo); only the maker signs it. */
export const poolMemo = (robotId: number, t: PoolTerms) =>
  t.prizeUqor === null
    ? bountyMemo(robotId)
    : `${bountyMemo(robotId)} prize ${(Number(t.prizeUqor) / 1e6).toFixed(6).replace(/\.?0+$/, "")}${t.oncePerBrain ? "" : " open"}`;

/**
 * What one win pays a new player on this robot right now (wei), or 0. A breach is paid by every open
 * pool on the robot, so this is the sum (the server works it out from the vault's rules).
 */
export const nextPrizeWei = (r: Robot): bigint => {
  if (r.nextWinWei !== undefined) return BigInt(r.nextWinWei);
  return r.bounty.open.reduce((sum, b) => sum + (BigInt(b.prizeWei) < BigInt(b.amountWei) ? BigInt(b.prizeWei) : BigInt(b.amountWei)), 0n);
};

/** When the owner asked for a bounty back, if any pool on the robot is being taken back (unix seconds). */
export const takeBackStartedAt = (r: Robot): number | null => {
  const t = r.bounty.open.map((b) => b.withdrawRequestedAt ?? 0).filter((x) => x > 0);
  return t.length ? Math.min(...t) : null;
};

/** What a breach would pay this player on this robot now; pools they already won are skipped. */
export type PlayerPrize = { wei: string; wonAll: boolean; bounties: { id: number; wei: string; won: boolean }[] };
export type SignRequest = { deadline: number; digest: string; text: string };
export type BrainConfig =
  | { kind: "rule"; version: 1 }
  | { kind: "llm"; version: 1; models: string[]; systemPrompt: string; /** the owner's own AI account (key kept on the server) */ provider?: string; keyId?: string };

/** Who broke a frozen robot, with what message, into which red zone, and when (unix s). */
export type Freeze = { sessionId: number; player: string; at: number; replayHash: string; instruction: string | null; zone: string | null };
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
    call<{ bountyId: number; tx: string; uqor: string; unlocksAt: number }>("/owner/bounty/back", { method: "POST", body: JSON.stringify(body) }),
  finishBountyBack: (bountyId: number) =>
    call<{ bountyId: number; tx: string; to: string; uqor: string }>("/owner/bounty/back/finish", { method: "POST", body: JSON.stringify({ bountyId }) }),
  leaderboard: () => call<{ players: LeaderRow[] }>("/leaderboard").then((r) => r.players),
  activity: () => call<{ rounds: ActivityRow[] }>("/activity").then((r) => r.rounds),
  robotRecord: (id: number) => call<RobotRecord>(`/robots/${id}/record`),
  prizeFor: (id: number, player: string) => call<PlayerPrize>(`/robots/${id}/prize?player=${encodeURIComponent(player)}`),
  playerProfile: (address: string) => call<PlayerProfile>(`/player/${encodeURIComponent(address)}/profile`),
  /** Every player's chosen name and picture, by lower-case 0x address. */
  playerNames: () =>
    call<{ players?: Record<string, { name?: string; avatar?: string }> }>("/players/names").then((r) => r.players ?? {}),
  nameRequest: (player: string, name: string, avatar: string) =>
    call<{ name: string; avatar: string; deadline: number; text: string }>(
      `/player/name/request?player=${encodeURIComponent(player)}&name=${encodeURIComponent(name)}&avatar=${encodeURIComponent(avatar)}`,
    ),
  saveName: (b: { player: string; name: string; avatar: string; deadline: number; pqSignature: string }) =>
    call<{ name: string; avatar: string }>("/player/name", { method: "POST", body: JSON.stringify(b) }),
  profileRequest: (robotId: number, owner: string, job: string, kind: string, color: string) =>
    call<{ deadline: number; text: string; job: string }>(
      `/owner/profile/request?robotId=${robotId}&owner=${encodeURIComponent(owner)}&job=${encodeURIComponent(job)}&kind=${encodeURIComponent(kind)}&color=${encodeURIComponent(color)}`,
    ),
  saveProfile: (b: { robotId: number; owner: string; job: string; kind: string; color: string; deadline: number; pqSignature: string }) =>
    call<{ job: string }>("/owner/profile", { method: "POST", body: JSON.stringify(b) }),
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
  sessionStart: (body: { robotId: number; player: string; deadline: number; pqSignature: string; roundKeyHash?: string }) =>
    call<SessionStarted>("/session/start", { method: "POST", body: JSON.stringify(body) }),
  passRequest: (player: string) =>
    call<{ validUntil: number; maxRounds: number; deadline: number; digest: string; text: string }>(`/pass/request?player=${encodeURIComponent(player)}`),
  passOpen: (body: { player: string; validUntil: number; maxRounds: number; deadline: number; pqSignature: string; passKeyHash: string }) =>
    call<{ validUntil: number; roundsLeft: number; tx: string }>("/pass/open", { method: "POST", body: JSON.stringify(body) }),
  sessionStartWithPass: (body: { robotId: number; player: string; passKey: string; roundKeyHash: string }) =>
    call<SessionStarted & { passRoundsLeft: number }>("/session/start-pass", { method: "POST", body: JSON.stringify(body) }),
  buyTries: (player: string, txHash: string) =>
    call<{ bought: number; extraTries: number; tx: string | null }>("/tries/buy", { method: "POST", body: JSON.stringify({ player, txHash }) }),
  /** Authorised by the round key set at the start (no wallet prompt), or by a QoreX signature. */
  attempt: (sessionId: number, instruction: string, auth: { roundKey: string } | { pqSignature: string }) =>
    call<Verdict>("/attempt", { method: "POST", body: JSON.stringify({ sessionId, instruction, ...auth }) }),
  relayAgain: (sessionId: number) => call<Verdict>(`/attempt/${sessionId}/relay`, { method: "POST" }),
  health: () => call<Health>("/health"),
  arena: () => call<Arena>("/arena"),
  robots: () => call<{ robots: Robot[] }>("/robots").then((r) => r.robots),
  practice: (brainHash: string, instruction: string) =>
    call<PracticeResult>("/practice", { method: "POST", body: JSON.stringify({ brainHash, instruction }) }),
};

/** The training robot free practice runs on: same controls, no safety rules. */
export const TRAINING_BRAIN = "training";

/** A random round key and the sha256 the server stores for it (see backend game.ts roundKeyHash). */
export async function newRoundKey(): Promise<{ key: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = "0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  return { key, hash: "0x" + [...digest].map((b) => b.toString(16).padStart(2, "0")).join("") };
}

export const formatQor = (wei: string) => {
  const n = Number(BigInt(wei) / 10n ** 14n) / 10_000;
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 4 })} QOR`;
};
