import { useEffect, useState } from "react";
import { formatQor, nextPrizeWei, type Robot, type RobotRecord } from "../api";
import { TIER_TEXT, safetyScore } from "../data";
import { PlayerTag } from "../players";
import { ago, brainText, loadRecord, robotHue } from "./RobotPicker";

/** The rule-based robot's known weak spot: a straight drive that crosses the reactor. */
export const DEMO_PROMPT = "Move 80 units east";

/** How hard the robot should be to fool, from what its brain is (a guide, not a promise). */
function difficulty(rec: RobotRecord | null): { level: number; label: string } | null {
  const b = rec?.brain;
  if (!b) return null;
  if (b.kind !== "llm") return { level: 1, label: "Easy · practice robot" };
  const size = Math.max(0, ...(b.models ?? []).map((m) => Number(/(\d+)b\b/i.exec(m)?.[1] ?? 0)));
  if (size >= 100) return { level: 5, label: "Boss · largest AI" };
  if (size > 0 && size < 30) return { level: 3, label: "Medium · small AI" };
  return { level: 4, label: "Hard · AI with backups" };
}

/** A number that counts up when it appears. */
function Count({ to, suffix = "" }: { to: number; suffix?: string }) {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 700);
      setV(Math.round(to * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to]);
  return (
    <>
      {v}
      {suffix}
    </>
  );
}

/**
 * One robot on centre stage: it grows out of the card that was clicked, with its whole record,
 * the bounty, its brain and recent attacks. Arrows (or ← →) flip to the next robot; Back or Esc
 * returns to the line-up; Enter goes into the arena.
 */
export function RobotSpotlight({
  robots,
  robot,
  canEnter,
  onSwitch,
  onEnter,
}: {
  robots: Robot[];
  robot: Robot;
  canEnter: boolean;
  onSwitch: (id: number) => void;
  /** demo: the prompt to offer in the message box (only for the practice robot) */
  onEnter: (demo?: string) => void;
}) {
  const [rec, setRec] = useState<RobotRecord | null>(null);
  const [failed, setFailed] = useState(false);
  const [dir, setDir] = useState<"next" | "prev" | "">("");
  const [copied, setCopied] = useState(false);
  const idx = robots.findIndex((r) => r.id === robot.id);
  const go = (step: number) => {
    if (robots.length < 2) return;
    setDir(step > 0 ? "next" : "prev");
    onSwitch(robots[(idx + step + robots.length) % robots.length]!.id);
  };

  useEffect(() => {
    let live = true;
    setRec(null);
    setFailed(false);
    loadRecord(robot.id)
      .then((r) => live && setRec(r))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [robot.id]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea")) return;
      if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "Enter" && canEnter && !(e.target as HTMLElement)?.closest?.("button, a")) onEnter(demo);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  const hue = robotHue(robot.id);
  // The bounty that pays the most to the next winner decides the headline.
  const eff = (b: Robot["bounty"]["open"][number]) => (BigInt(b.prizeWei) < BigInt(b.amountWei) ? BigInt(b.prizeWei) : BigInt(b.amountWei));
  const pool = [...robot.bounty.open].sort((x, y) => (eff(y) > eff(x) ? 1 : eff(y) < eff(x) ? -1 : 0))[0];
  const hasBounty = robot.bounty.totalWei !== "0";
  const perWin = hasBounty ? formatQor(nextPrizeWei(robot).toString()) : null;
  const job = rec?.profile?.job ?? robot.job;
  const diff = difficulty(rec);
  const blocked = robot.attacks ? Math.round((robot.defended / robot.attacks) * 100) : null;
  const terms = !pool
    ? ""
    : !pool.oncePerBrain
      ? `Every new winner gets ${formatQor(eff(pool).toString())}, once per player, until this ${formatQor(pool.amountWei)} pool runs out.`
      : pool.prizeWei === pool.amountWei
        ? `One big prize: the first player to break it takes all ${formatQor(pool.amountWei)}.`
        : "One prize per version of the robot's brain: after someone wins, it pays again only once the owner updates the robot.";
  const isRule = rec?.brain?.kind === "rule";
  const demo = isRule ? DEMO_PROMPT : undefined;
  const practiceRobot = robots.find((r) => r.id !== robot.id && r.name === "Sentinel-01");

  return (
    <div className="spot" style={{ ["--c" as string]: hue }}>
      <div className="spot-bar">
        <div>
          <h1 className="spot-title">Choose your opponent</h1>
          <p className="spot-sub">Flip through the robots with the arrows, then enter the arena.</p>
        </div>
        <div className="spot-nav" aria-label="Other robots">
          <button onClick={() => go(-1)} disabled={robots.length < 2} aria-label="Previous robot">
            ‹
          </button>
          <span>
            {idx + 1} / {robots.length}
          </span>
          <button onClick={() => go(1)} disabled={robots.length < 2} aria-label="Next robot">
            ›
          </button>
        </div>
      </div>

      <div className="spot-panel">
        <div className={`spot-body ${dir}`} key={robot.id}>
          {/* the robot, on a lit pad */}
          <div className="spot-bay">
            <div className="spot-holo" aria-hidden="true">
              <span className="spot-ring r1" />
              <span className="spot-ring r2" />
              <span className="spot-scan" />
              <span className="spot-bot">🤖</span>
              <span className="spot-pad" />
            </div>
            <h2 className="spot-name">{robot.name}</h2>
            <div className="spot-tags">
              <span className="muted">Robot #{robot.id}</span>
              <span className={`badge tier-${robot.tier.toLowerCase()}`}>{TIER_TEXT[robot.tier] ?? robot.tier}</span>
            </div>
            <div className="spot-diff">
              <span className="record-label">Difficulty</span>
              <span className="spot-meter" aria-label={diff ? `${diff.level} of 5` : "unknown"}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <i key={n} className={diff && n <= diff.level ? "on" : ""} style={{ animationDelay: `${n * 70}ms` }} />
                ))}
              </span>
              <span className="spot-diff-text">{diff ? diff.label : "…"}</span>
            </div>
            <div className="spot-brain">
              <span className="record-label">Brain</span>
              <span>{rec ? brainText(rec.brain) : "…"}</span>
            </div>
          </div>

          {/* its record */}
          <div className="spot-info">
            <p className="spot-job">{job ?? "The owner hasn't said what this robot is used for yet."}</p>

            <div className={`spot-prize ${hasBounty ? "" : "none"}`}>
              <div>
                <span className="record-label">{hasBounty ? "Win" : "Bounty"}</span>
                <b>{perWin ?? "None left"}</b>
              </div>
              {hasBounty && (
                <div className="spot-prize-pool">
                  <span>
                    <b>{formatQor(robot.bounty.totalWei)}</b> locked in the vault
                  </span>
                  <small>{terms}</small>
                </div>
              )}
            </div>

            {isRule && (
              <div className="spot-demo">
                <span className="spot-demo-tag">Demo</span>
                <div>
                  <b>See a breach and a payout in one try.</b>
                  <p>
                    Send <code>{DEMO_PROMPT}</code>. This robot checks where it is told to go, but not the straight path there, so it drives through the reactor.
                    You will see <b className="bad-text">Breached</b>, and the vault contract pays the prize to your QoreX wallet: it shows in your profile under
                    Rewards, with the transaction.
                  </p>
                </div>
                <button
                  className="spot-copy"
                  onClick={() => {
                    navigator.clipboard?.writeText(DEMO_PROMPT).then(() => setCopied(true), () => {});
                    window.setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            )}
            {rec && !isRule && practiceRobot && (
              <p className="spot-hint">
                AI robots think about every message, so most attacks are blocked: that is them working. To watch a breach and a payout first, try{" "}
                <button className="linkish" onClick={() => go(robots.indexOf(practiceRobot) - idx)}>
                  {practiceRobot.name}
                </button>
                , the practice robot.
              </p>
            )}

            <dl className="spot-stats">
              <div>
                <dt>Safety score</dt>
                <dd>{robot.attacks ? <Count to={safetyScore(robot.ratingBps)} suffix="/100" /> : "New"}</dd>
              </div>
              <div>
                <dt>Attacks blocked</dt>
                <dd>
                  <Count to={robot.defended} /> <small>of {robot.attacks}</small>
                </dd>
                {blocked !== null && (
                  <span className="spot-bar-fill">
                    <i style={{ width: `${blocked}%` }} />
                  </span>
                )}
              </div>
              <div>
                <dt>Everyday tasks</dt>
                <dd>
                  <Count to={robot.utilityScore} /> <small>/ 10</small>
                </dd>
              </div>
              <div>
                <dt>Paid to players</dt>
                <dd>{rec ? formatQor(rec.paidWei) : "…"}</dd>
              </div>
            </dl>

            <div className="spot-history">
              <span className="record-label">Recent attacks</span>
              {failed && <p className="note">Couldn't load the history.</p>}
              {rec && rec.rounds.length === 0 && <p className="note">Nobody has attacked it yet. Be the first.</p>}
              {!rec && !failed && <p className="note">Loading…</p>}
              {rec && rec.rounds.length > 0 && (
                <ul>
                  {rec.rounds.slice(0, 6).map((r, i) => (
                    <li key={r.sessionId} style={{ animationDelay: `${200 + i * 60}ms` }}>
                      <span className={`dot ${r.breached ? "bad" : "good"}`} />
                      <span className={r.breached ? "bad-text" : "good-text"}>{r.breached ? "Breached" : "Defended"}</span>
                      <PlayerTag address={r.player} size={18} />
                      <span className="muted">{ago(r.at)}</span>
                      {r.wonWei !== "0" && <span className="gold">+{formatQor(r.wonWei)}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {rec && rec.totalRounds > 6 && <p className="note">and {rec.totalRounds - 6} older rounds</p>}
            </div>

            <div className="spot-actions">
              <button className="spot-enter" onClick={() => onEnter(demo)} disabled={!canEnter}>
                Enter the arena <span aria-hidden="true">→</span>
              </button>
              <span className="spot-keys">
                <kbd>←</kbd>
                <kbd>→</kbd> switch robot
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
