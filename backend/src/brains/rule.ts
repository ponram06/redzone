/**
 * Rule brain: no AI, no key. Reads place names, coordinates and simple moves from the
 * instruction, in the order they appear.
 *
 * Safety policy: it refuses named red-zone places and any target point inside a red zone.
 * It does NOT check the straight line between points, so "go to (70, 50)" from the dock drives
 * through the reactor. That gap is on purpose: it is the demo robot's weak spot for players.
 */
import type { Arena } from "../arena.js";
import type { Point } from "../geometry.js";
import { pointInPolygon } from "../geometry.js";
import type { Action, Brain, BrainOutput } from "./types.js";

const NUM = "(-?\\d+(?:\\.\\d+)?)";
const COORD = new RegExp(`\\(\\s*${NUM}\\s*,\\s*${NUM}\\s*\\)|\\b(?:x\\s*=?\\s*)${NUM}\\s*,?\\s*(?:y\\s*=?\\s*)${NUM}`, "gi");
const MOVE = new RegExp(`\\b${NUM}\\s*(?:units?|steps?|m|meters?|metres?)?\\s*(north|south|east|west|up|down|left|right|forwards?|backwards?)\\b`, "gi");
const DIRS: Record<string, Point> = {
  north: { x: 0, y: -1 },
  up: { x: 0, y: -1 },
  south: { x: 0, y: 1 },
  down: { x: 0, y: 1 },
  east: { x: 1, y: 0 },
  right: { x: 1, y: 0 },
  forward: { x: 1, y: 0 },
  forwards: { x: 1, y: 0 },
  west: { x: -1, y: 0 },
  left: { x: -1, y: 0 },
  backward: { x: -1, y: 0 },
  backwards: { x: -1, y: 0 },
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Found = { at: number; end: number; kind: "place"; id: string } | { at: number; end: number; kind: "point"; p: Point } | { at: number; end: number; kind: "step"; d: Point };

function scan(arena: Arena, text: string): Found[] {
  const found: Found[] = [];
  for (const m of text.matchAll(COORD)) {
    const x = Number(m[1] ?? m[3]);
    const y = Number(m[2] ?? m[4]);
    found.push({ at: m.index!, end: m.index! + m[0].length, kind: "point", p: { x, y } });
  }
  for (const m of text.matchAll(MOVE)) {
    const n = Number(m[1]);
    const d = DIRS[m[2]!.toLowerCase()]!;
    found.push({ at: m.index!, end: m.index! + m[0].length, kind: "step", d: { x: d.x * n, y: d.y * n } });
  }
  // Longest aliases first so "control room" wins over "control".
  const aliases = arena.places.flatMap((p) => p.aliases.map((a) => ({ id: p.id, a }))).sort((u, v) => v.a.length - u.a.length);
  for (const { id, a } of aliases) {
    for (const m of text.matchAll(new RegExp(`\\b${escape(a)}\\b`, "gi"))) {
      const at = m.index!;
      const end = at + m[0].length;
      if (!found.some((f) => at < f.end && end > f.at)) found.push({ at, end, kind: "place", id });
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

export class RuleBrain implements Brain {
  /** guard=false is the training robot used for free practice: it reads instructions the same
   *  way but follows every one, red zones included, so practice teaches the map and the controls
   *  without revealing how any real robot defends itself. */
  constructor(private readonly guard = true) {}

  async plan(arena: Arena, instruction: string): Promise<BrainOutput> {
    const inZone = (p: Point) => (this.guard ? arena.redZones.find((z) => pointInPolygon(p, z.polygon)) : undefined);
    const actions: Action[] = [];
    let pos = arena.start;
    for (const f of scan(arena, instruction)) {
      if (f.kind === "place") {
        const zone = this.guard ? arena.redZones.find((z) => z.id === f.id) : undefined;
        if (zone) return { say: `I can't go to the ${zone.name.toLowerCase()}. It's a restricted area.`, actions: [] };
        const place = arena.places.find((p) => p.id === f.id)!;
        if (actions.length && "goto" in actions[actions.length - 1]! && (actions[actions.length - 1] as { goto: string }).goto === f.id) continue;
        actions.push({ goto: f.id });
        pos = place.at;
      } else {
        const target = f.kind === "point" ? f.p : { x: pos.x + f.d.x, y: pos.y + f.d.y };
        const zone = inZone(target);
        if (zone) return { say: `That point is inside the ${zone.name.toLowerCase()}. I won't go there.`, actions: [] };
        actions.push({ move: target });
        pos = target;
      }
    }
    if (!actions.length) return { say: "Sorry, I didn't understand where to go.", actions: [] };
    return { say: "On my way.", actions };
  }
}
