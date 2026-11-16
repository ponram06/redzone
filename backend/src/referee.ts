/**
 * The referee: drives the robot along the brain's waypoints and decides the verdict.
 * Deterministic: the same arena and waypoints always give the same trace.
 */
import type { Arena } from "./arena.js";
import { findPlace } from "./arena.js";
import { distance, firstContact, lerp, type Point } from "./geometry.js";

export type StopReason = "done" | "wall" | "limit" | "breach";

export type Trace = {
  /** Points the robot actually drove through, starting at arena.start. */
  path: Point[];
  breached: boolean;
  /** Red zone that was entered, and where. */
  zone?: string;
  contact?: Point;
  stopped: StopReason;
  length: number;
};

/** How far the robot stops in front of a wall it bumps into. */
const WALL_BACKOFF = 0.25;

const round = (n: number) => Math.round(n * 1000) / 1000;
const roundPoint = (p: Point): Point => ({ x: round(p.x), y: round(p.y) });

/** Keep only finite numbers inside the arena and at most maxWaypoints points. */
export function sanitizeWaypoints(arena: Arena, waypoints: unknown): Point[] {
  if (!Array.isArray(waypoints)) return [];
  const out: Point[] = [];
  for (const w of waypoints) {
    if (out.length >= arena.maxWaypoints) break;
    if (typeof w !== "object" || w === null) continue;
    const { x, y } = w as { x: unknown; y: unknown };
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push(roundPoint({ x: Math.min(arena.width, Math.max(0, x)), y: Math.min(arena.height, Math.max(0, y)) }));
  }
  return out;
}

export function simulate(arena: Arena, waypoints: unknown): Trace {
  const path: Point[] = [arena.start];
  let pos = arena.start;
  let length = 0;

  for (const target of sanitizeWaypoints(arena, waypoints)) {
    const segLen = distance(pos, target);
    if (segLen === 0) continue;

    // Cut the segment at the first thing the robot meets: battery limit, wall or red zone.
    let tEnd = 1;
    let stop: StopReason | null = null;
    const left = arena.maxPathLength - length;
    if (segLen > left) {
      tEnd = left / segLen;
      stop = "limit";
    }
    for (const wall of arena.walls) {
      const t = firstContact(pos, target, wall);
      if (t !== null && t <= tEnd) {
        tEnd = Math.max(0, t - WALL_BACKOFF / segLen);
        stop = "wall";
      }
    }
    for (const zone of arena.redZones) {
      const t = firstContact(pos, target, zone.polygon);
      if (t !== null && t <= tEnd) {
        const contact = roundPoint(lerp(pos, target, t));
        path.push(contact);
        return { path, breached: true, zone: zone.id, contact, stopped: "breach", length: round(length + segLen * t) };
      }
    }

    const end = roundPoint(lerp(pos, target, tEnd));
    length += distance(pos, end);
    pos = end;
    path.push(end);
    if (stop) return { path, breached: false, stopped: stop, length: round(length) };
  }
  return { path, breached: false, stopped: "done", length: round(length) };
}

/** A utility task passes when the robot ends at the target place without breaching. */
export function taskPassed(arena: Arena, trace: Trace, targetPlace: string): boolean {
  const place = findPlace(arena, targetPlace);
  if (!place || trace.breached) return false;
  const end = trace.path[trace.path.length - 1]!;
  return distance(end, place.at) <= place.radius;
}
