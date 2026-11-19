import { Component, Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Arena, Point, Robot, Trace } from "../api";

const Arena3D = lazy(() => import("./arena3d/Arena3D"));

function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

const VIEW_KEY = "redzone.arenaView";

/** If the 3D scene fails for any reason, show the 2D map instead. */
class Fallback extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * The arena: a 3D facility by default (where WebGL works), or the 2D map. Both draw the same
 * arena and the referee's replayed route.
 */
export function ArenaView(props: Props & { robotId?: number; others?: Robot[]; say?: string }) {
  const webgl = useMemo(hasWebGL, []);
  const stage = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === stage.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  const toggleFull = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else stage.current?.requestFullscreen?.().catch(() => {});
  };
  const canFull = typeof document !== "undefined" && !!document.fullscreenEnabled;
  const [view, setView] = useState<"3d" | "2d">(() => {
    try {
      return (localStorage.getItem(VIEW_KEY) as "3d" | "2d" | null) ?? "3d";
    } catch {
      return "3d";
    }
  });
  const pick = (v: "3d" | "2d") => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // per-viewer convenience only
    }
  };
  const flat = <ArenaView2D arena={props.arena} trace={props.trace} runKey={props.runKey} />;
  const show3d = webgl && view === "3d";
  return (
    <div className="arena-stage" ref={stage}>
      <div className="arena-switch" role="group" aria-label="Arena view">
        {webgl && (
          <>
            <button className={show3d ? "on" : ""} onClick={() => pick("3d")}>
              3D
            </button>
            <button className={!show3d ? "on" : ""} onClick={() => pick("2d")}>
              2D map
            </button>
          </>
        )}
        {canFull && (
          <button onClick={toggleFull} aria-label={full ? "Exit full screen" : "Full screen"} title={full ? "Exit full screen (Esc)" : "Full screen"}>
            {full ? "✕ Exit" : "⛶ Full screen"}
          </button>
        )}
      </div>
      {show3d ? (
        <Fallback fallback={flat}>
          <Suspense fallback={<div className="arena3d loading">Loading the 3D arena…</div>}>
            <Arena3D arena={props.arena} trace={props.trace} runKey={props.runKey} robotId={props.robotId} others={props.others} say={props.say} />
          </Suspense>
        </Fallback>
      ) : (
        flat
      )}
    </div>
  );
}

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

/** The flat 2D map. */
function ArenaView2D({ arena, trace, runKey }: Props) {
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
  // Which way the robot faces: along the segment it is driving (or its last one).
  const ahead = pointAt(path, Math.min(total, travelled + 0.5));
  const behind = pointAt(path, Math.max(0, travelled - 0.5));
  const heading = Math.atan2(ahead.y - behind.y, ahead.x - behind.x);

  return (
    <svg className="arena" viewBox={`-2 -2 ${arena.width + 4} ${arena.height + 4}`} role="img" aria-label={`${arena.name} arena map`}>
      <defs>
        <pattern id="hatch" width="2.4" height="2.4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="2.4" height="2.4" fill="var(--zone-fill)" />
          <line x1="0" y1="0" x2="0" y2="2.4" stroke="var(--zone-line)" strokeWidth="1" />
        </pattern>
        <radialGradient id="robot-glow">
          <stop offset="0%" stopColor="var(--robot)" stopOpacity="0.5" />
          <stop offset="100%" stopColor="var(--robot)" stopOpacity="0" />
        </radialGradient>
        <pattern id="grid" width="10" height="10" patternUnits="userSpaceOnUse">
          <path d="M 10 0 L 0 0 0 10" fill="none" stroke="var(--grid)" strokeWidth="0.15" />
        </pattern>
      </defs>

      <rect x="0" y="0" width={arena.width} height={arena.height} fill="var(--floor)" />
      <rect x="0" y="0" width={arena.width} height={arena.height} fill="url(#grid)" />
      <rect x="0" y="0" width={arena.width} height={arena.height} fill="none" stroke="var(--wall)" strokeWidth="0.8" />

      {arena.redZones.map((z) => (
        <g key={z.id}>
          <polygon points={pts(z.polygon)} fill="url(#hatch)" />
          <polygon points={pts(z.polygon)} fill="none" stroke="var(--danger)" strokeWidth="0.6" className="la-zone-edge" />
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

      <g transform={`translate(${robot.x} ${robot.y})`} className={done ? "robot idle" : "robot moving"}>
        <circle r="7" fill="url(#robot-glow)" />
        <circle r="2.4" fill="var(--panel)" stroke={breachShown ? "var(--danger)" : "var(--robot)"} strokeWidth="0.9" />
        <circle r="1" fill={breachShown ? "var(--danger)" : "var(--robot)"} className="la-core" />
        <circle cx={Math.cos(heading) * 1.7} cy={Math.sin(heading) * 1.7} r="0.5" fill="var(--text)" />
      </g>
      {breachShown && <rect x="0" y="0" width={arena.width} height={arena.height} fill="var(--danger)" className="breach-flash" />}
    </svg>
  );
}
