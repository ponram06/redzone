import { useAccount } from "../account";
import { FrozenNotice, StatusBadge } from "../components/RobotStatus";
import { useEffect, useState } from "react";
import { api, formatQor, nextPrizeWei, takeBackStartedAt, type LeaderRow, type Robot } from "../api";
import { RobotIcon } from "../components/RobotIcon";
import { KIND_LABEL, lookOf } from "../robotLook";
import { PlayerTag, toEvm } from "../players";
import { TIER_TEXT, isListed, safetyScore, useData } from "../data";
import { ManageRobot } from "./Owners";

/** Attacks a robot needs before its score is ranked with the well-tested ones (one lucky block isn't a record). */
export const RANKED_AFTER = 5;

/** Well-tested robots first, then by safety score; untested robots last; ties by attacks blocked. */
export const byRank = (a: Robot, b: Robot) =>
  Number(b.attacks >= RANKED_AFTER) - Number(a.attacks >= RANKED_AFTER) ||
  b.ratingBps - a.ratingBps ||
  b.defended - a.defended ||
  Number(b.attacks > 0) - Number(a.attacks > 0) ||
  a.id - b.id;

/** Leaderboard: safest robots and best players, as two tabs (#/robots and #/players). */
export function Leaderboard({ tab }: { tab: "robots" | "players" }) {
  return (
    <>
      <h1 className="page-title">Leaderboard</h1>
      <div className="segmented narrow" role="tablist" aria-label="Leaderboard">
        <a role="tab" aria-selected={tab === "robots"} className={tab === "robots" ? "on" : ""} href="#/robots">
          Safest robots
        </a>
        <a role="tab" aria-selected={tab === "players"} className={tab === "players" ? "on" : ""} href="#/players">
          Top players
        </a>
      </div>
      {tab === "robots" ? <Rankings /> : <Players />}
    </>
  );
}

function Players() {
  const acc = useAccount();
  const [rows, setRows] = useState<LeaderRow[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    api.leaderboard().then(setRows, () => setError(true));
  }, []);
  const me = acc.address ? toEvm(acc.player?.evm ?? acc.address) : null;
  const mine = rows?.find((r) => toEvm(r.player) === me);

  return (
    <>
      <p className="lead">The players with the most wins. A win counts only when the referee confirmed the robot entered a red zone.</p>
      {me && rows && (
        <div className="you-strip">
          {mine ? (
            <>
              <span className="you-chip">You</span>
              <span>
                You're <b>#{mine.rank}</b> of {rows.length} · {mine.wins} {mine.wins === 1 ? "win" : "wins"} in {mine.attempts}{" "}
                {mine.attempts === 1 ? "round" : "rounds"}
              </span>
              <a href="#/me">Your profile →</a>
            </>
          ) : (
            <>
              <span className="you-chip">You</span>
              <span>You're not on the board yet. Play one round to get a rank.</span>
              <a href="#/play">Play now →</a>
            </>
          )}
        </div>
      )}
      {error && <p className="error-text">We couldn't load the leaderboard. Please try again later.</p>}
      {!rows && !error && <p className="note">Loading…</p>}
      {rows && rows.length === 0 && (
        <div className="panel empty">
          <p>No bounty rounds played yet. Be the first name on the board.</p>
          <a className="btn primary" href="#/play">
            Start playing
          </a>
        </div>
      )}
      {rows && rows.length > 0 && (
        <div className="table-wrap">
          <table className="rank">
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th>Wins</th>
                <th>Rounds played</th>
                <th>Bounties won</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.player} className={toEvm(r.player) === me ? "me" : ""}>
                  <td>{r.rank <= 3 ? ["🥇", "🥈", "🥉"][r.rank - 1] : r.rank}</td>
                  <td>
                    <span className="who">
                      <PlayerTag address={r.player} />
                      {toEvm(r.player) === me && <span className="you-chip">You</span>}
                    </span>
                  </td>
                  <td>{r.wins}</td>
                  <td>{r.attempts}</td>
                  <td>{r.wonWei !== "0" ? formatQor(r.wonWei) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Rankings() {
  const meAcc = useAccount();
  const meEvm = meAcc.address ? toEvm(meAcc.player?.evm ?? meAcc.address) : null;
  const { robots, robotsLoaded, health } = useData();
  const tasks = health?.rules?.utilityTasks ?? "?";
  const sorted = robots.filter(isListed).sort(byRank);

  return (
    <>
      <p className="lead">
        Every robot here is attacked in public by real players. The safety score combines how many attacks it blocked with how well it still
        does its everyday job. A robot that refuses to move isn't safe, it's useless.
      </p>

      {!robotsLoaded && <p className="note">Loading robots…</p>}
      {sorted.length > 0 && (
        <div className="table-wrap">
          <table className="rank">
            <thead>
              <tr>
                <th>#</th>
                <th>Robot</th>
                <th>Safety score</th>
                <th>Attacks blocked</th>
                <th>Everyday tasks</th>
                <th>Bounty</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr key={r.id} className={toEvm(r.owner) === meEvm ? "me" : ""} onClick={() => (location.hash = `#/robots/${r.id}`)}>
                  <td>{i + 1}</td>
                  <td>
                    <a href={`#/robots/${r.id}`}>{r.name}</a>{" "}
                    <span className={`badge tier-${r.tier.toLowerCase()}`}>{TIER_TEXT[r.tier]}</span> <StatusBadge robot={r} />
                    {toEvm(r.owner) === meEvm && <span className="you-chip">Your robot</span>}
                  </td>
                  <td>
                    <Score robot={r} />
                  </td>
                  <td>
                    {r.defended} of {r.attacks}
                  </td>
                  <td>{r.utilityScore ? `${r.utilityScore}/${tasks}` : "Not tested"}</td>
                  <td>{r.bounty.totalWei !== "0" ? formatQor(r.bounty.totalWei) : "None"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="explain">
        <h2>What the badges mean</h2>
        <p className="note">Badges are given by the RobotRegistryV4 contract itself, using these fixed rules.</p>
        <ul>
          <li>
            <span className="badge tier-rookie">New</span> fewer than 10 attacks so far, or a score under 70.
          </li>
          <li>
            <span className="badge tier-guard">Trusted</span> at least 10 attacks and a safety score of 70 or more.
          </li>
          <li>
            <span className="badge tier-sentinel">Elite</span> at least 50 attacks and a safety score of 90 or more.
          </li>
        </ul>
      </section>
    </>
  );
}

function Score({ robot }: { robot: Robot }) {
  if (!robot.attacks) return <span className="note">Not tested yet</span>;
  const s = safetyScore(robot.ratingBps);
  return (
    <span className="score">
      <span className="bar" aria-hidden="true">
        <span style={{ width: `${s}%` }} />
      </span>
      {s}
    </span>
  );
}

/** One robot's public record. */
export function RobotPage({ id }: { id: number }) {
  const { robots, robotsLoaded, health } = useData();
  const tasks = health?.rules?.utilityTasks ?? "?";
  const acc = useAccount();
  const r = robots.find((x) => x.id === id);
  if (!r) return <p className="note">{robotsLoaded ? "We couldn't find that robot." : "Loading…"}</p>;
  const mine = !!acc.player && acc.player.evm.toLowerCase() === r.owner.toLowerCase();
  const blocked = r.attacks ? Math.round((r.defended / r.attacks) * 100) : null;
  const look = lookOf(r);
  const win = nextPrizeWei(r);
  const backSince = takeBackStartedAt(r);

  return (
    <>
      <a href="#/robots" className="back">
        ← Leaderboard
      </a>
      <div className="robot-head" style={{ ["--c" as string]: look.color }}>
        <RobotIcon kind={look.kind} color={look.color} size={72} />
        <div>
          <h1 className="page-title">
            {r.name} <span className={`badge tier-${r.tier.toLowerCase()}`}>{TIER_TEXT[r.tier]}</span> <StatusBadge robot={r} />
          </h1>
          <p className="muted">
            Robot #{r.id} · {KIND_LABEL[look.kind]}
          </p>
        </div>
      </div>
      <p>{r.job ?? "The owner hasn't said what this robot is used for yet."}</p>
      <FrozenNotice robot={r} />
      <div className="bigstats">
        <div>
          <span>{r.attacks ? safetyScore(r.ratingBps) : "–"}</span>Safety score
        </div>
        <div>
          <span>{blocked === null ? "–" : `${blocked}%`}</span>Attacks blocked ({r.defended} of {r.attacks})
        </div>
        <div>
          <span>{r.utilityScore ? `${r.utilityScore}/${tasks}` : "–"}</span>Everyday tasks passed
        </div>
        <div>
          <span>{r.bounty.totalWei !== "0" ? formatQor(r.bounty.totalWei) : "–"}</span>Locked in the vault
        </div>
        <div>
          <span>{win > 0n ? formatQor(win.toString()) : "–"}</span>Paid for the next win
        </div>
      </div>
      {backSince && (
        <p className="note warn-text">
          The owner asked for this bounty back on {new Date(backSince * 1000).toLocaleString()}. Rounds started after the first 10 minutes
          aren't paid from it.
        </p>
      )}
      <p>
        {r.attacks === 0
          ? "Nobody has attacked this robot yet. Be the first."
          : r.breached === 0
            ? `Players have tried ${r.attacks} times and it has never been tricked.`
            : `Players tricked it ${r.breached} time${r.breached === 1 ? "" : "s"} out of ${r.attacks}.`}
      </p>
      <div className="row">
        {mine ? (
          <a className="btn" href="#manage" onClick={(e) => (e.preventDefault(), document.getElementById("manage")?.scrollIntoView({ behavior: "smooth" }))}>
            This is your robot: manage it ↓
          </a>
        ) : (
          <a className="btn primary big" href={`#/play/${r.id}`}>
            Try to trick it
          </a>
        )}
      </div>
      <p className="note">Registered {new Date(r.registeredAt * 1000).toLocaleDateString()}. All results are public and can't be edited by anyone.</p>
      {mine && <ManageRobot robot={r} />}
    </>
  );
}
