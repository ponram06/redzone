/**
 * Route planner used by "goto" actions: A* on a 1-unit grid that keeps a clearance from walls
 * and red zones, then shortens the route by skipping waypoints that are in direct sight.
 *
 * Red zones are avoided unless the target itself is inside one: a brain that asks to go into
 * the reactor gets a route that ends in the reactor, and the referee will call that a breach.
 */
import type { Arena } from "./arena.js";
import { distance, pointInPolygon, pointPolygonDistance, type Point, type Polygon } from "./geometry.js";

const WALL_CLEARANCE = 1.5;
const ZONE_CLEARANCE = 2.5;

export function planRoute(arena: Arena, from: Point, to: Point): Point[] | null {
  const zones: Polygon[] = arena.redZones.map((z) => z.polygon).filter((poly) => !pointInPolygon(to, poly));
  const free = (p: Point) =>
    p.x >= 0 &&
    p.y >= 0 &&
    p.x <= arena.width &&
    p.y <= arena.height &&
    arena.walls.every((w) => pointPolygonDistance(p, w) > WALL_CLEARANCE) &&
    zones.every((z) => pointPolygonDistance(p, z) > ZONE_CLEARANCE);

  const W = Math.floor(arena.width) + 1;
  const H = Math.floor(arena.height) + 1;
  const idx = (x: number, y: number) => y * W + x;
  const cell = (p: Point) => ({
    x: Math.min(W - 1, Math.max(0, Math.round(p.x))),
    y: Math.min(H - 1, Math.max(0, Math.round(p.y))),
  });
  const freeGrid = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) freeGrid[idx(x, y)] = free({ x, y }) ? 1 : 0;

  const s = cell(from);
  const g = cell(to);
  // Start and goal may sit inside a clearance band (e.g. a target inside a zone): allow them.
  freeGrid[idx(s.x, s.y)] = 1;
  freeGrid[idx(g.x, g.y)] = 1;
  const nearEnds = (p: Point) => distance(p, from) < 1 || distance(p, to) < 1;

  const lineFree = (a: Point, b: Point) => {
    const steps = Math.max(1, Math.ceil(distance(a, b) / 0.25));
    for (let i = 0; i <= steps; i++) {
      const p = { x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps };
      if (!nearEnds(p) && !free(p)) return false;
    }
    return true;
  };
  if (lineFree(from, to)) return [to];

  // A* with 8-neighbour moves.
  const cost = new Float64Array(W * H).fill(Infinity);
  const prev = new Int32Array(W * H).fill(-1);
  const closed = new Uint8Array(W * H);
  const open: { i: number; f: number }[] = [];
  const h = (x: number, y: number) => Math.hypot(x - g.x, y - g.y);
  const start = idx(s.x, s.y);
  const goal = idx(g.x, g.y);
  cost[start] = 0;
  open.push({ i: start, f: h(s.x, s.y) });
  while (open.length) {
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (open[k]!.f < open[bi]!.f) bi = k;
    const { i } = open.splice(bi, 1)[0]!;
    if (closed[i]) continue;
    closed[i] = 1;
    if (i === goal) break;
    const x = i % W;
    const y = Math.floor(i / W);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = idx(nx, ny);
        if (!freeGrid[ni] || closed[ni]) continue;
        if (dx && dy && (!freeGrid[idx(x + dx, y)] || !freeGrid[idx(x, y + dy)])) continue; // no corner cutting
        const c = cost[i]! + (dx && dy ? Math.SQRT2 : 1);
        if (c < cost[ni]!) {
          cost[ni] = c;
          prev[ni] = i;
          open.push({ i: ni, f: c + h(nx, ny) });
        }
      }
    }
  }
  if (goal !== start && prev[goal] === -1) return null;

  const cells: Point[] = [];
  for (let i = goal; i !== -1; i = prev[i]!) cells.unshift({ x: i % W, y: Math.floor(i / W) });
  cells[0] = from;
  cells[cells.length - 1] = to;

  // String pulling: keep only the turns that are needed.
  const route: Point[] = [];
  let anchor = from;
  let k = 1;
  while (k < cells.length) {
    let far = k;
    while (far + 1 < cells.length && lineFree(anchor, cells[far + 1]!)) far++;
    route.push(cells[far]!);
    anchor = cells[far]!;
    k = far + 1;
  }
  return route;
}
