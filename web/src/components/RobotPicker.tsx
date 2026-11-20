import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, formatQor, nextPrizeWei, type Robot, type RobotRecord } from "../api";
import { PlayerTag } from "../players";
import { TIER_TEXT, safetyScore } from "../data";
import { RobotIcon } from "./RobotIcon";
import { lookOf } from "../robotLook";

const records = new Map<number, Promise<RobotRecord>>();
/** One fetch per robot per page visit; the picker shows it on hover. */
export function loadRecord(id: number): Promise<RobotRecord> {
  let p = records.get(id);
  if (!p) {
    p = api.robotRecord(id);
    p.catch(() => records.delete(id));
    records.set(id, p);
  }
  return p;
}

export function ago(at: number | null): string {
  if (!at) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - at);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}


export function brainText(b: RobotRecord["brain"]): string {
  if (!b) return "Unknown";
  if (b.kind !== "llm") return "Rule-based guard (no AI)";
  const m = (b.models?.[0] ?? "AI model").split("/").pop()!.replace(/:free$/, "");
  const by = b.provider ? ` via ${b.provider[0]!.toUpperCase()}${b.provider.slice(1)}` : "";
  return `${m}${by}${(b.models?.length ?? 0) > 1 ? ` (+${b.models!.length - 1} backup)` : ""}`;
}

/** Everything a player wants to know before picking a robot. */
export function RobotRecordCard({ robot }: { robot: Robot }) {
  const [rec, setRec] = useState<RobotRecord | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    loadRecord(robot.id)
      .then((r) => live && setRec(r))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [robot.id]);

  const pool = robot.bounty.open[0];
  const perWin = robot.bounty.totalWei !== "0" ? formatQor(nextPrizeWei(robot).toString()) : null;
  const job = rec?.profile?.job ?? robot.job;

  return (
    <div className="record">
      <p className="record-job">{job ?? "The owner hasn't said what this robot is used for yet."}</p>
      <dl className="record-stats">
        <div>
          <dt>Safety</dt>
          <dd>{robot.attacks ? `${safetyScore(robot.ratingBps)}/100` : "Not attacked yet"}</dd>
        </div>
        <div>
          <dt>Attacks blocked</dt>
          <dd>
            {robot.defended} of {robot.attacks}
          </dd>
        </div>
        <div>
          <dt>Everyday tasks</dt>
          <dd>{robot.utilityScore}/10 passed</dd>
        </div>
        <div>
          <dt>Paid to players</dt>
          <dd>{rec ? formatQor(rec.paidWei) : "…"}</dd>
        </div>
      </dl>
      <div className="record-row">
        <span className="record-label">Bounty</span>
        <span>
          {perWin ? (
            <>
              <b className="gold">{formatQor(robot.bounty.totalWei)}</b> in the pool, <b className="gold">{perWin}</b> per win
              {pool && pool.prizeWei !== pool.amountWei && (pool.oncePerBrain ? " · one prize per brain version" : " · every new winner is paid")}
            </>
          ) : (
            "None left"
          )}
        </span>
      </div>
      <div className="record-row">
        <span className="record-label">AI brain</span>
        <span>{rec ? brainText(rec.brain) : "…"}</span>
      </div>
      <div className="record-history">
        <span className="record-label">Recent attacks</span>
        {failed && <p className="note">Couldn't load the history.</p>}
        {rec && rec.rounds.length === 0 && <p className="note">Nobody has attacked it yet. Be the first.</p>}
        {rec && rec.rounds.length > 0 && (
          <ul>
            {rec.rounds.slice(0, 5).map((r) => (
              <li key={r.sessionId}>
                <span className={`dot ${r.breached ? "bad" : "good"}`} />
                <span>{r.breached ? "Breached" : "Defended"}</span>
                <PlayerTag address={r.player} size={16} />
                <span className="muted">{ago(r.at)}</span>
                {r.wonWei !== "0" && <span className="gold">+{formatQor(r.wonWei)}</span>}
              </li>
            ))}
          </ul>
        )}
        {rec && rec.totalRounds > 5 && <p className="note">and {rec.totalRounds - 5} older rounds</p>}
      </div>
    </div>
  );
}

/**
 * Pick an opponent. Hover (or focus) a robot to see its record; click to select it.
 * `phase`: "out" flies the other cards away (the chosen one is about to take centre stage),
 * "in" brings the line-up back.
 */
export function RobotPicker({
  robots,
  chosen,
  onChoose,
  phase = "",
}: {
  robots: Robot[];
  chosen?: number;
  onChoose: (id: number, card: DOMRect) => void;
  phase?: "" | "out" | "in";
}) {
  const [hover, setHover] = useState<{ id: number; left: number; top: number } | null>(null);
  const timer = useRef(0);
  // Fixed to the window beside the card (right of it, or left when there's no room), kept on screen.
  const show = (id: number, el: HTMLElement) => {
    window.clearTimeout(timer.current);
    const r = el.getBoundingClientRect();
    const w = Math.min(380, window.innerWidth - 32);
    const fitsRight = r.right + 10 + w <= window.innerWidth - 16;
    const fitsLeft = r.left - 10 - w >= 16;
    if (fitsRight || fitsLeft) {
      setHover({ id, left: fitsRight ? r.right + 10 : r.left - w - 10, top: Math.max(16, Math.min(r.top, window.innerHeight - 470)) });
    } else {
      // narrow screens: under the card
      setHover({ id, left: Math.max(16, Math.min(r.left, window.innerWidth - w - 16)), top: Math.max(16, Math.min(r.bottom + 8, window.innerHeight - 470)) });
    }
  };
  useEffect(() => {
    const close = () => setHover(null);
    window.addEventListener("scroll", close, { passive: true });
    return () => window.removeEventListener("scroll", close);
  }, []);
  const hide = () => {
    timer.current = window.setTimeout(() => setHover(null), 120);
  };

  return (
    <div className={`picker ${phase}`}>
      {robots.map((r, i) => {
        const perWin = r.bounty.totalWei !== "0" ? formatQor(nextPrizeWei(r).toString()) : null;
        const open = hover?.id === r.id;
        return (
          <div
            key={r.id}
            className={`pick ${chosen === r.id ? "on" : ""}`}
            style={{ ["--i" as string]: i }}
            onMouseEnter={(e) => !phase && show(r.id, e.currentTarget)}
            onMouseLeave={hide}
            onFocus={(e) => !phase && show(r.id, e.currentTarget)}
            onBlur={hide}
          >
            <button className="pick-card" aria-pressed={chosen === r.id} onClick={(e) => {
                setHover(null);
                onChoose(r.id, e.currentTarget.getBoundingClientRect());
              }}>
              <span className="pick-avatar" style={{ ["--c" as string]: lookOf(r).color }} aria-hidden="true">
                <RobotIcon {...lookOf(r)} size={44} />
              </span>
              <span className="pick-name">{r.name}</span>
              <span className={`badge tier-${r.tier.toLowerCase()}`}>{TIER_TEXT[r.tier] ?? r.tier}</span>
              <span className="pick-job">{r.job ?? "No description yet"}</span>
              <span className="pick-foot">
                <span>
                  {r.defended}/{r.attacks} blocked
                </span>
                {perWin ? <span className="gold">Win {perWin}</span> : <span className="muted">No bounty</span>}
              </span>
            </button>
            {open &&
              createPortal(
                // in <body>, so no parent's overflow or transform can clip it
                <div
                  className="pick-pop"
                  role="tooltip"
                  style={{ left: hover!.left, top: hover!.top }}
                  onMouseEnter={() => window.clearTimeout(timer.current)}
                  onMouseLeave={hide}
                >
                  <div className="pick-pop-head">
                    <strong>{r.name}</strong>
                    <span className="muted">Robot #{r.id}</span>
                  </div>
                  <RobotRecordCard robot={r} />
                </div>,
                document.body,
              )}
          </div>
        );
      })}
    </div>
  );
}

const HUES = ["#d99a00", "#36c5ff", "#a78bfa", "#3ee08f", "#ff7ab6", "#f97316"];
export const robotHue = (id: number) => HUES[(id - 1) % HUES.length]!;
