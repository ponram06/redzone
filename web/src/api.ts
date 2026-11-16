/** Client for the RedZone referee backend. */

export const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8787";

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

export const api = {
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
