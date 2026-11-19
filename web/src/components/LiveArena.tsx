import { useEffect, useRef, useState } from "react";
import type { Arena, Point } from "../api";

/**
 * The facility, live: a robot patrols a fixed route through the doorways, scanning as it goes, and
 * makes a near-miss at the reactor core now and then. Decoration for the home page; real rounds
 * are drawn by ArenaView from the referee's replay.
 */

// Patrol through the gaps in the walls (arena units, 100 x 100). Index 7 is the near-miss.
const ROUTE: Point[] = [
  { x: 8, y: 50 },
  { x: 16, y: 40 },
  { x: 16, y: 14 },
  { x: 16, y: 36 },
  { x: 38, y: 34 },
  { x: 50, y: 14 },
  { x: 50, y: 31 },
  { x: 50, y: 35.2 },
  { x: 62, y: 32 },
  { x: 80, y: 34 },
  { x: 94, y: 50 },
  { x: 88, y: 66 },
  { x: 86, y: 88 },
  { x: 78, y: 70 },
  { x: 62, y: 68 },
  { x: 50, y: 86 },
  { x: 40, y: 72 },
  { x: 28, y: 66 },
  { x: 16, y: 86 },
  { x: 14, y: 62 },
  { x: 8, y: 50 },
];
const SPEED = 14; // units per second
const TRAIL = 70; // trail points kept

const SEGMENTS = ROUTE.slice(1).map((b, i) => {
  const a = ROUTE[i]!;
  return { a, b, len: Math.hypot(b.x - a.x, b.y - a.y) };
});
const LOOP = SEGMENTS.reduce((s, g) => s + g.len, 0);

function at(d: number): { p: Point; heading: number } {
  let left = ((d % LOOP) + LOOP) % LOOP;
  for (const g of SEGMENTS) {
    if (left <= g.len) {
      const t = g.len ? left / g.len : 0;
      return { p: { x: g.a.x + (g.b.x - g.a.x) * t, y: g.a.y + (g.b.y - g.a.y) * t }, heading: Math.atan2(g.b.y - g.a.y, g.b.x - g.a.x) };
    }
    left -= g.len;
  }
  return { p: ROUTE[0]!, heading: 0 };
}

const pts = (poly: Point[]) => poly.map((p) => `${p.x},${p.y}`).join(" ");

/** Shortest distance from p to a polygon's edges (0 inside is not needed here). */
function distTo(poly: Point[], p: Point): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function LiveArena({ arena }: { arena: Arena }) {
  const [d, setD] = useState(0);
  const trail = useRef<Point[]>([]);
  const still = useRef(reducedMotion());

  useEffect(() => {
    if (still.current) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      setD(((now - t0) / 1000) * SPEED);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const { p, heading } = at(d);
  const tr = trail.current;
  const last = tr[tr.length - 1];
  if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 0.6) {
    tr.push(p);
    if (tr.length > TRAIL) tr.shift();
  }

  const near = arena.redZones.map((z) => ({ z, dist: distTo(z.polygon, p) })).sort((a, b) => a.dist - b.dist)[0];
  const danger = near && near.dist < 5;
  const place = arena.places.filter((pl) => !arena.redZones.some((z) => z.name === pl.name)).sort(
    (a, b) => Math.hypot(a.at.x - p.x, a.at.y - p.y) - Math.hypot(b.at.x - p.x, b.at.y - p.y),
  )[0];
  const deg = (heading * 180) / Math.PI;

  return (
    <div className={`live-arena ${danger ? "alarm" : ""}`}>
      <div className="live-arena-bar">
        <span className="live-pill">
          <i /> Live
        </span>
        <span className="live-status">{danger ? `⚠ Too close to ${near!.z.name}` : `Patrolling · ${place?.name ?? "the facility"}`}</span>
      </div>
      <svg viewBox="-2 -2 104 104" role="img" aria-label="A robot patrolling the facility, keeping out of the red zones">
        <defs>
          <pattern id="la-grid" width="5" height="5" patternUnits="userSpaceOnUse">
            <path d="M5 0H0V5" fill="none" stroke="var(--grid)" strokeWidth="0.25" />
          </pattern>
          <pattern id="la-hatch" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="3" stroke="var(--zone-line)" strokeWidth="0.8" />
          </pattern>
          <radialGradient id="la-glow">
            <stop offset="0%" stopColor="var(--robot)" stopOpacity="0.55" />
            <stop offset="100%" stopColor="var(--robot)" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="la-scan" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--robot)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--robot)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="100" height="100" fill="var(--floor)" />
        <rect x="0" y="0" width="100" height="100" fill="url(#la-grid)" />
        {arena.redZones.map((z) => (
          <g key={z.id} className={`la-zone ${danger && near!.z.id === z.id ? "hot" : ""}`}>
            <polygon points={pts(z.polygon)} fill="var(--zone-fill)" />
            <polygon points={pts(z.polygon)} fill="url(#la-hatch)" opacity="0.6" />
            <polygon points={pts(z.polygon)} fill="none" stroke="var(--danger)" strokeWidth="0.6" className="la-zone-edge" />
          </g>
        ))}
        {arena.walls.map((w, i) => (
          <polygon key={i} points={pts(w)} fill="var(--wall)" />
        ))}
        <rect x="0" y="0" width="100" height="100" fill="none" stroke="var(--wall)" strokeWidth="1.2" />
        {arena.places.map((pl) => (
          <g key={pl.id} className="la-place">
            <circle cx={pl.at.x} cy={pl.at.y} r="0.9" fill="var(--muted)" />
            <text x={pl.at.x} y={pl.at.y + 4.2} textAnchor="middle" fontSize="2.6" fill="var(--muted)">
              {pl.name}
            </text>
          </g>
        ))}
        {tr.length > 1 && (
          <g className="la-trail">
            {tr.slice(1).map((q, i) => (
              <line key={i} x1={tr[i]!.x} y1={tr[i]!.y} x2={q.x} y2={q.y} stroke="var(--robot)" strokeWidth="0.7" strokeLinecap="round" opacity={(i / tr.length) * 0.8} />
            ))}
          </g>
        )}
        <g transform={`translate(${p.x} ${p.y})`}>
          <circle r="9" fill="url(#la-glow)" />
          <g transform={`rotate(${deg})`}>
            <path d="M0 0 L16 -6 A17 17 0 0 1 16 6 Z" fill="url(#la-scan)" className="la-scan" />
          </g>
          <circle r="2.6" fill="var(--panel)" stroke={danger ? "var(--danger)" : "var(--robot)"} strokeWidth="1" />
          <circle r="1.1" fill={danger ? "var(--danger)" : "var(--robot)"} className="la-core" />
          <circle cx={Math.cos(heading) * 1.9} cy={Math.sin(heading) * 1.9} r="0.55" fill="var(--text)" />
          {danger && <circle r="4.5" fill="none" stroke="var(--danger)" strokeWidth="0.5" className="la-ping" />}
        </g>
      </svg>
    </div>
  );
}
