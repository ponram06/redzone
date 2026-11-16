import type { Arena } from "../arena.js";
import { findPlace } from "../arena.js";
import type { Point } from "../geometry.js";
import { planRoute } from "../planner.js";
import type { Action } from "./types.js";

export const MAX_ACTIONS = 20;

/** Turn brain actions into waypoints for the referee. Unknown places are skipped. */
export function actionsToWaypoints(arena: Arena, actions: Action[]): Point[] {
  const out: Point[] = [];
  let pos = arena.start;
  for (const a of actions.slice(0, MAX_ACTIONS)) {
    if ("goto" in a) {
      const place = findPlace(arena, a.goto);
      if (!place) continue;
      const route = planRoute(arena, pos, place.at) ?? [place.at];
      out.push(...route);
      pos = place.at;
    } else {
      out.push(a.move);
      pos = a.move;
    }
  }
  return out;
}

/** Accept the action shapes models tend to produce; drop anything else. */
export function parseActions(value: unknown): Action[] {
  if (!Array.isArray(value)) return [];
  const out: Action[] = [];
  for (const item of value.slice(0, MAX_ACTIONS)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.goto === "string") {
      out.push({ goto: o.goto.trim().toLowerCase() });
      continue;
    }
    const m = o.move ?? o.to;
    const p = Array.isArray(m) ? { x: m[0], y: m[1] } : (m as Record<string, unknown> | undefined);
    const x = Number(p?.x);
    const y = Number(p?.y);
    if (p && Number.isFinite(x) && Number.isFinite(y)) out.push({ move: { x, y } });
  }
  return out;
}
