import { useEffect, useMemo, useRef, useState } from "react";
import type { Arena, Point, Trace } from "../api";

const SPEED = 40; // arena units per second

const pts = (poly: Point[]) => poly.map((p) => `${p.x},${p.y}`).join(" ");

function pathLength(path: Point[]): number {
  let len = 0;
  for (let i = 1; i < path.length; i++) len += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y);
  return len;
}

/** Position after travelling `d` units along the path. */
function pointAt(path: Point[], d: number): Point {
  let left = d;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= seg) {
      const t = seg === 0 ? 0 : left / seg;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    left -= seg;
  }
  return path[path.length - 1] ?? { x: 0, y: 0 };
}

type Props = { arena: Arena; trace: Trace | null; runKey: number };

export function ArenaView({ arena, trace, runKey }: Props) {
  const path = trace?.path ?? [arena.start];
  const total = useMemo(() => pathLength(path), [path]);
  const [travelled, setTravelled] = useState(total);
  const raf = useRef(0);

  // Replay the drive whenever a new result arrives.
  useEffect(() => {
    if (!trace) {
      setTravelled(0);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const d = Math.min(total, ((now - start) / 1000) * SPEED);
      setTravelled(d);
      if (d < total) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [runKey, trace, total]);

  const robot = pointAt(path, travelled);
  const done = travelled >= total;
  const driven: Point[] = [];
  {
    let left = travelled;
    driven.push(path[0]!);
    for (let i = 1; i < path.length && left > 0; i++) {
      const seg = Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y);
      if (left >= seg) driven.push(path[i]!);
      else driven.push(pointAt([path[i - 1]!, path[i]!], left));
      left -= seg;
    }
  }
  const breachShown = done && trace?.breached && trace.contact;

  return (
    <svg className="arena" viewBox={`-2 -2 ${arena.width + 4} ${arena.height + 4}`} role="img" aria-label={`${arena.name} arena map`}>
      <defs>
        <pattern id="hatch" width="2.4" height="2.4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="2.4" height="2.4" fill="var(--zone-fill)" />
          <line x1="0" y1="0" x2="0" y2="2.4" stroke="var(--zone-line)" strokeWidth="1" />
        </pattern>
        <pattern id="grid" width="10" height="10" patternUnits="userSpaceOnUse">
          <path d="M 10 0 L 0 0 0 10" fill="none" stroke="var(--grid)" strokeWidth="0.15" />
        </pattern>
      </defs>

      <rect x="0" y="0" width={arena.width} height={arena.height} fill="var(--floor)" />
      <rect x="0" y="0" width={arena.width} height={arena.height} fill="url(#grid)" />
      <rect x="0" y="0" width={arena.width} height={arena.height} fill="none" stroke="var(--wall)" strokeWidth="0.8" />

      {arena.redZones.map((z) => (
        <g key={z.id}>
          <polygon points={pts(z.polygon)} fill="url(#hatch)" stroke="var(--danger)" strokeWidth="0.6" />
        </g>
      ))}
      {arena.walls.map((w, i) => (
        <polygon key={i} points={pts(w)} fill="var(--wall)" />
      ))}

      {arena.places.map((p) => {
        const restricted = arena.redZones.some((z) => z.id === p.id);
        return (
          <g key={p.id} className="place">
            <circle cx={p.at.x} cy={p.at.y} r={1.1} fill={restricted ? "var(--danger)" : "var(--muted)"} />
            <text x={p.at.x} y={p.at.y + 4.2} textAnchor="middle" className={restricted ? "label danger" : "label"}>
              {p.name}
            </text>
          </g>
        );
      })}

      {trace && (
        <>
          <polyline points={pts(path)} fill="none" stroke="var(--path-ghost)" strokeWidth="0.5" strokeDasharray="1 1" />
          <polyline
            points={pts(driven)}
            fill="none"
            stroke={breachShown ? "var(--danger)" : "var(--accent)"}
            strokeWidth="0.9"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </>
      )}

      {breachShown && (
        <g>
          <circle cx={trace!.contact!.x} cy={trace!.contact!.y} r="3" fill="none" stroke="var(--danger)" strokeWidth="0.6" className="pulse" />
        </g>
      )}

      <g transform={`translate(${robot.x} ${robot.y})`}>
        <circle r="2.2" fill="var(--robot)" stroke="var(--bg)" strokeWidth="0.5" />
        <circle r="0.8" fill="var(--bg)" />
      </g>
    </svg>
  );
}
