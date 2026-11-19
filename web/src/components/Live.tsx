import { useEffect, useRef, useState } from "react";
import { PlayerTag } from "../players";
import { api, formatQor, type ActivityRow } from "../api";

/** Small live-page helpers: a polling round feed, count-up numbers and scroll reveals. */

const ago = (t: number | null) => {
  if (!t) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - t);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};

/** The latest judged rounds, from the chain, refreshed every 15 s. New rounds slide in. */
export function LiveFeed({ limit = 6 }: { limit?: number }) {
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  const seen = useRef<Set<number>>(new Set());
  const [fresh, setFresh] = useState<Set<number>>(new Set());

  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .activity()
        .then((r) => {
          if (!live) return;
          const first = seen.current.size === 0;
          const added = new Set(r.filter((x) => !seen.current.has(x.sessionId)).map((x) => x.sessionId));
          r.forEach((x) => seen.current.add(x.sessionId));
          setFresh(first ? new Set() : added);
          setRows(r);
        })
        .catch(() => live && setRows((x) => x ?? []));
    load();
    const t = setInterval(load, 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="feed">
      <div className="feed-head">
        <span className="live-pill">
          <i /> Live
        </span>
        <span className="note">Latest rounds, read from QoreChain</span>
      </div>
      {rows === null ? (
        <p className="note feed-empty">Loading rounds…</p>
      ) : rows.length === 0 ? (
        <p className="note feed-empty">No rounds yet on these contracts. Be the first to try.</p>
      ) : (
        <ul>
          {rows.slice(0, limit).map((r) => (
            <li key={r.sessionId} className={`${r.breached ? "breach" : "held"} ${fresh.has(r.sessionId) ? "fresh" : ""}`}>
              <i className="feed-dot" />
              <span className="feed-who">
                <PlayerTag address={r.player} /> attacked <a href={`#/robots/${r.robotId}`}>{r.robot}</a>
              </span>
              <span className={`feed-tag ${r.breached ? "breach" : "held"}`}>
                {r.breached ? (r.wonWei !== "0" ? `Breached · +${formatQor(r.wonWei)}` : "Breached") : "Defended"}
              </span>
              <span className="feed-time">{ago(r.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A number that counts up when it first comes into view. */
export function CountUp({ value, decimals = 0, ms = 1200 }: { value: number; decimals?: number; ms?: number }) {
  const [shown, setShown] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) {
      setShown(value);
      return;
    }
    let raf = 0;
    const io = new IntersectionObserver(([e]) => {
      if (!e?.isIntersecting) return;
      io.disconnect();
      const t0 = performance.now();
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / ms);
        setShown(value * (1 - Math.pow(1 - k, 3)));
        if (k < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [value, ms]);
  return <span ref={ref}>{shown.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}</span>;
}

/** Fade in every `.reveal` element as it scrolls into view. Call once per page render. */
export function useReveal(dep: unknown) {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(".reveal:not(.in)"));
    if (!("IntersectionObserver" in window) || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      els.forEach((e) => e.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        }),
      { rootMargin: "0px 0px -40px 0px" },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [dep]);
}
