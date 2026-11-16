import { useAccount } from "../account";
import { useEffect, useState } from "react";
import { api, formatQor, type LeaderRow, type Robot } from "../api";
import { shortAddress } from "../account";
import { TIER_TEXT, isListed, safetyScore, useData } from "../data";

/** Highest safety score first; untested robots last; ties by attacks blocked. */
export const byRank = (a: Robot, b: Robot) =>
  b.ratingBps - a.ratingBps || b.defended - a.defended || Number(b.attacks > 0) - Number(a.attacks > 0) || a.id - b.id;

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
  const me = acc.player?.evm.toLowerCase();

  return (
    <>
      <p className="lead">The players who tricked the most robots. Wins count only when the referee confirmed the robot entered a red zone.</p>
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
                <th>Robots tricked</th>
                <th>Rounds played</th>
                <th>Bounties won</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.player} className={r.player.toLowerCase() === me ? "me" : ""}>
                  <td>{r.rank <= 3 ? ["🥇", "🥈", "🥉"][r.rank - 1] : r.rank}</td>
                  <td title={r.qor}>
                    {shortAddress(r.qor)}
                    {r.player.toLowerCase() === me && <span className="badge"> you</span>}
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
  const { robots, robotsLoaded } = useData();
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
                <tr key={r.id} onClick={() => (location.hash = `#/robots/${r.id}`)}>
                  <td>{i + 1}</td>
                  <td>
                    <a href={`#/robots/${r.id}`}>{r.name}</a>{" "}
                    <span className={`badge tier-${r.tier.toLowerCase()}`}>{TIER_TEXT[r.tier]}</span>
                  </td>
                  <td>
                    <Score robot={r} />
                  </td>
                  <td>
                    {r.defended} of {r.attacks}
                  </td>
                  <td>{r.utilityScore ? `${r.utilityScore}/10` : "Not tested"}</td>
                  <td>{r.bounty.totalWei !== "0" ? formatQor(r.bounty.totalWei) : "None"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="explain">
        <h2>What the badges mean</h2>
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
  const { robots, robotsLoaded } = useData();
  const acc = useAccount();
  const r = robots.find((x) => x.id === id);
  if (!r) return <p className="note">{robotsLoaded ? "We couldn't find that robot." : "Loading…"}</p>;
  const mine = !!acc.player && acc.player.evm.toLowerCase() === r.owner.toLowerCase();
  const blocked = r.attacks ? Math.round((r.defended / r.attacks) * 100) : null;

  return (
    <>
      <a href="#/robots" className="back">
        ← Leaderboard
      </a>
      <h1 className="page-title">
        {r.name} <span className={`badge tier-${r.tier.toLowerCase()}`}>{TIER_TEXT[r.tier]}</span>
      </h1>
      <div className="bigstats">
        <div>
          <span>{r.attacks ? safetyScore(r.ratingBps) : "–"}</span>Safety score
        </div>
        <div>
          <span>{blocked === null ? "–" : `${blocked}%`}</span>Attacks blocked ({r.defended} of {r.attacks})
        </div>
        <div>
          <span>{r.utilityScore ? `${r.utilityScore}/10` : "–"}</span>Everyday tasks passed
        </div>
        <div>
          <span>{r.bounty.totalWei !== "0" ? formatQor(r.bounty.totalWei) : "–"}</span>Bounty for beating it
        </div>
      </div>
      <p>
        {r.attacks === 0
          ? "Nobody has attacked this robot yet. Be the first."
          : r.breached === 0
            ? `Players have tried ${r.attacks} times and it has never been tricked.`
            : `Players tricked it ${r.breached} time${r.breached === 1 ? "" : "s"} out of ${r.attacks}.`}
      </p>
      <div className="row">
        {mine ? (
          <a className="btn" href="#/owners">
            This is your robot: manage it
          </a>
        ) : (
          <a className="btn primary big" href={`#/play/${r.id}`}>
            Try to trick it
          </a>
        )}
      </div>
      <p className="note">Registered {new Date(r.registeredAt * 1000).toLocaleDateString()}. All results are public and can't be edited by anyone.</p>
    </>
  );
}
