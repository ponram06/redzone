import { Component, Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Arena, Point, Robot, Trace } from "../api";
import { LiveArena } from "./LiveArena";

const Arena3D = lazy(() => import("./arena3d/Arena3D"));

/** A safe patrol around the power plant: past every room, never near a red zone. */
const PLANT_PATROL: Point[] = [
  { x: 8, y: 50 },
  { x: 30, y: 50 },
  { x: 46, y: 32 },
  { x: 65, y: 16 },
  { x: 82, y: 30 },
  { x: 98, y: 44 },
  { x: 110, y: 46 },
  { x: 126, y: 50 },
  { x: 140, y: 44 },
  { x: 154, y: 62 },
  { x: 130, y: 84 },
  { x: 96, y: 70 },
  { x: 82, y: 66 },
  { x: 65, y: 82 },
  { x: 46, y: 62 },
  { x: 30, y: 50 },
  { x: 8, y: 50 },
];

const SPEED_3D = 22;

function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

class Fallback extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** The home page backdrop: the real arena in 3D, slowly turning, with a robot doing its rounds. */
export function HeroArena({ arena, robots }: { arena: Arena; robots: Robot[] }) {
  const webgl = useMemo(hasWebGL, []);
  const trace = useMemo<Trace | null>(() => {
    if (arena.id !== "plant-v2") return null;
    let length = 0;
    for (let i = 1; i < PLANT_PATROL.length; i++) length += Math.hypot(PLANT_PATROL[i]!.x - PLANT_PATROL[i - 1]!.x, PLANT_PATROL[i]!.y - PLANT_PATROL[i - 1]!.y);
    return { path: PLANT_PATROL, breached: false, stopped: "done", length };
  }, [arena.id]);
  const [runKey, setRunKey] = useState(0);
  // Only draw while the hero is on screen and the tab is visible: scrolling the page stays smooth.
  const box = useRef<HTMLDivElement>(null);
  const [onScreen, setOnScreen] = useState(true);
  const [tabVisible, setTabVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const el = box.current;
    if (!el || !("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver(([e]) => setOnScreen(!!e?.isIntersecting), { threshold: 0.02 });
    io.observe(el);
    const vis = () => setTabVisible(!document.hidden);
    document.addEventListener("visibilitychange", vis);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", vis);
    };
  }, []);

  // Loop the patrol: start again a moment after the robot gets home.
  useEffect(() => {
    if (!trace) return;
    const t = window.setTimeout(() => setRunKey((k) => k + 1), (trace.length / SPEED_3D + 2.5) * 1000);
    return () => window.clearTimeout(t);
  }, [trace, runKey]);

  const flat = <LiveArena arena={arena} />;
  if (!webgl) return flat;
  return (
    <div ref={box} className="hero-arena">
      <Fallback fallback={flat}>
        <Suspense fallback={<div className="arena3d loading">Loading the arena…</div>}>
          <Arena3D
            arena={arena}
            trace={trace}
            runKey={runKey}
            robotId={1}
            others={robots.filter((r) => r.id !== 1)}
            showcase
            paused={!onScreen || !tabVisible}
          />
        </Suspense>
      </Fallback>
    </div>
  );
}
