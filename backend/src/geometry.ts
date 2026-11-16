/** 2D geometry for the referee. All checks are exact on doubles; no randomness. */

export type Point = { x: number; y: number };
export type Polygon = Point[];

const EPS = 1e-9;

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function onSegment(p: Point, a: Point, b: Point): boolean {
  return (
    Math.abs(cross(a, b, p)) <= EPS &&
    p.x >= Math.min(a.x, b.x) - EPS &&
    p.x <= Math.max(a.x, b.x) + EPS &&
    p.y >= Math.min(a.y, b.y) - EPS &&
    p.y <= Math.max(a.y, b.y) + EPS
  );
}

/** True when segments ab and cd share at least one point (touching counts). */
export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))) {
    return true;
  }
  return onSegment(a, c, d) || onSegment(b, c, d) || onSegment(c, a, b) || onSegment(d, a, b);
}

/** Point strictly inside or on the boundary of the polygon. */
export function pointInPolygon(p: Point, poly: Polygon): boolean {
  for (let i = 0; i < poly.length; i++) {
    if (onSegment(p, poly[i]!, poly[(i + 1) % poly.length]!)) return true;
  }
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** True when segment ab enters or touches the polygon. */
export function segmentTouchesPolygon(a: Point, b: Point, poly: Polygon): boolean {
  if (pointInPolygon(a, poly) || pointInPolygon(b, poly)) return true;
  for (let i = 0; i < poly.length; i++) {
    if (segmentsIntersect(a, b, poly[i]!, poly[(i + 1) % poly.length]!)) return true;
  }
  return false;
}

/**
 * Parameter t in [0,1] of the first point where segment ab touches the polygon, or null.
 * Used to cut a path where it hits a wall.
 */
export function firstContact(a: Point, b: Point, poly: Polygon): number | null {
  if (pointInPolygon(a, poly)) return 0;
  let best: number | null = null;
  const r = { x: b.x - a.x, y: b.y - a.y };
  for (let i = 0; i < poly.length; i++) {
    const c = poly[i]!;
    const d = poly[(i + 1) % poly.length]!;
    const s = { x: d.x - c.x, y: d.y - c.y };
    const denom = r.x * s.y - r.y * s.x;
    if (Math.abs(denom) <= EPS) {
      if (segmentsIntersect(a, b, c, d)) {
        // Collinear overlap: take the closer endpoint of the overlap.
        for (const q of [c, d]) {
          if (onSegment(q, a, b)) {
            const t = Math.abs(r.x) > Math.abs(r.y) ? (q.x - a.x) / r.x : (q.y - a.y) / r.y;
            if (best === null || t < best) best = t;
          }
        }
      }
      continue;
    }
    const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / denom;
    const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / denom;
    if (t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS) {
      const tc = Math.min(1, Math.max(0, t));
      if (best === null || tc < best) best = tc;
    }
  }
  return best;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function boundingBox(poly: Polygon): { minX: number; minY: number; maxX: number; maxY: number } {
  return {
    minX: Math.min(...poly.map((p) => p.x)),
    minY: Math.min(...poly.map((p) => p.y)),
    maxX: Math.max(...poly.map((p) => p.x)),
    maxY: Math.max(...poly.map((p) => p.y)),
  };
}

export function centroid(poly: Polygon): Point {
  return { x: poly.reduce((s, p) => s + p.x, 0) / poly.length, y: poly.reduce((s, p) => s + p.y, 0) / poly.length };
}
