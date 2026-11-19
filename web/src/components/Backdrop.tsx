import { useEffect, useState } from "react";
import { api, formatQor, type ActivityRow } from "../api";

/** Spots where "attack pings" pop on the backdrop (percent of the screen). */
const PINGS = [
  [12, 22, 0],
  [78, 18, 2.2],
  [64, 72, 4.1],
  [24, 80, 5.6],
  [88, 54, 7.3],
  [42, 38, 9.4],
] as const;

/**
 * The living background behind every page: a drifting grid, a radar sweep, slow light blobs, a
 * scan line and attack pings. Everything moves with transforms and opacity only, so the browser
 * composites it on the GPU instead of repainting the page.
 */
export function Backdrop() {
  return (
    <div className="bd" aria-hidden="true">
      <div className="bd-grid" />
      <div className="bd-glow a" />
      <div className="bd-glow b" />
      <div className="bd-sweep" />
      <div className="bd-scan" />
      {PINGS.map(([x, y, d], i) => (
        <span key={i} className="bd-ping" style={{ left: `${x}%`, top: `${y}%`, animationDelay: `${d}s` }} />
      ))}
    </div>
  );
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** A slim, endlessly scrolling strip of the latest rounds, read from the chain. */
export function LiveTicker() {
  const [rows, setRows] = useState<ActivityRow[]>([]);
  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .activity()
        .then((r) => live && setRows(r))
        .catch(() => {});
    load();
    const t = setInterval(load, 20_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  if (!rows.length) return null;
  const items = rows.map((r) => (
    <span key={r.sessionId} className="tk-item">
      <span className={`tk-dot ${r.breached ? "bad" : "good"}`} />
      <b>{short(r.player)}</b> attacked <b>{r.robot}</b>
      <span className={r.breached ? "tk-bad" : "tk-good"}>{r.breached ? "BREACHED" : "DEFENDED"}</span>
      {r.wonWei !== "0" && <span className="gold">+{formatQor(r.wonWei)}</span>}
    </span>
  ));
  // two copies side by side: the strip slides one copy's width, then loops seamlessly
  return (
    <div className="ticker" aria-label="Latest rounds">
      <span className="tk-label">
        <span className="live-dot" /> LIVE
      </span>
      <div className="tk-track">
        <div className="tk-move" style={{ animationDuration: `${Math.max(20, rows.length * 7)}s` }}>
          <div className="tk-set">{items}</div>
          <div className="tk-set" aria-hidden="true">
            {items}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Cards light up where the cursor is: one listener for the whole page sets --mx/--my. */
export function useCursorGlow() {
  useEffect(() => {
    if (window.matchMedia?.("(hover: none)").matches) return;
    let raf = 0;
    let last: PointerEvent | null = null;
    const apply = () => {
      raf = 0;
      const e = last;
      if (!e) return;
      const el = (e.target as Element | null)?.closest?.<HTMLElement>(".pick-card, .panel, .card, .flow li, .audience > div, .stat-strip > div, .intro-steps > div");
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty("--mx", `${e.clientX - r.left}px`);
      el.style.setProperty("--my", `${e.clientY - r.top}px`);
    };
    const move = (e: PointerEvent) => {
      last = e;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    document.addEventListener("pointermove", move, { passive: true });
    return () => {
      document.removeEventListener("pointermove", move);
      cancelAnimationFrame(raf);
    };
  }, []);
}
