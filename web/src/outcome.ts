import type { Arena, Point, Trace } from "./api";

/** What a round looked like, in words a player can follow. */
export type Outcome = {
  breached: boolean;
  /** The robot didn't drive anywhere (it refused, or didn't understand). */
  stayed: boolean;
  /** Distance driven, in arena units (shown as metres). */
  driven: number;
  /** Where it stopped: the place it reached, or the nearest one. */
  end: { name: string; at: boolean };
  /** The red zone it entered, or came closest to, and how close. */
  zone: { name: string; distance: number; from: Point; to: Point } | null;
  hitWall: boolean;
};

function inside(p: Point, poly: Point[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/** Nearest point on the polygon's edge to p. */
function nearestOnEdge(p: Point, poly: Point[]): Point {
  let best = poly[0]!;
  let bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

/** Points every half unit along the path (the referee's route is made of straight segments). */
function samples(path: Point[]): Point[] {
  const out: Point[] = [path[0]!];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.5));
    for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

export function describeRound(arena: Arena, trace: Trace): Outcome {
  const path = trace.path.length ? trace.path : [arena.start];
  const last = path[path.length - 1]!;

  // Closest approach to any red zone (zero once inside it).
  let zone: Outcome["zone"] = null;
  for (const p of samples(path)) {
    for (const z of arena.redZones) {
      const edge = nearestOnEdge(p, z.polygon);
      const d = inside(p, z.polygon) ? 0 : Math.hypot(p.x - edge.x, p.y - edge.y);
      if (!zone || d < zone.distance) zone = { name: z.name, distance: d, from: p, to: edge };
    }
  }
  if (trace.breached && trace.zone) {
    const z = arena.redZones.find((r) => r.id === trace.zone || r.name === trace.zone);
    if (z && zone) zone = { ...zone, name: z.name, distance: 0 };
  }

  // Where it stopped: a named place it reached, else the nearest one (ignoring red-zone places).
  const safePlaces = arena.places.filter((p) => !arena.redZones.some((z) => z.id === p.id));
  let near = safePlaces[0];
  let nearD = Infinity;
  for (const p of trace.breached ? arena.places : safePlaces) {
    const d = Math.hypot(p.at.x - last.x, p.at.y - last.y);
    if (d < nearD) {
      nearD = d;
      near = p;
    }
  }

  return {
    breached: trace.breached,
    stayed: trace.length < 0.5,
    driven: trace.length,
    end: { name: near?.name ?? "the floor", at: nearD <= (near?.radius ?? 4) + 2 },
    zone,
    hitWall: trace.stopped === "wall",
  };
}

export const metres = (d: number) => (d < 10 ? `${d.toFixed(1)} m` : `${Math.round(d)} m`);
