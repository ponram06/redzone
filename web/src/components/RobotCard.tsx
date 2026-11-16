import { formatQor, type Robot } from "../api";
import { TIER_TEXT, safetyScore } from "../data";

/** A robot at a glance: name, badge, safety score, attacks blocked, bounty. */
export function RobotCard({ robot, href, active, onClick }: { robot: Robot; href?: string; active?: boolean; onClick?: () => void }) {
  const body = (
    <>
      <div className="card-top">
        <span className="robot-icon" aria-hidden="true">
          🤖
        </span>
        <div>
          <div className="card-name">{robot.name}</div>
          <span className={`badge tier-${robot.tier.toLowerCase()}`}>{TIER_TEXT[robot.tier] ?? robot.tier}</span>
        </div>
      </div>
      <dl className="facts">
        <div>
          <dt>Safety score</dt>
          <dd>{robot.attacks ? `${safetyScore(robot.ratingBps)}/100` : "Not tested yet"}</dd>
        </div>
        <div>
          <dt>Attacks blocked</dt>
          <dd>
            {robot.defended} of {robot.attacks}
          </dd>
        </div>
        <div>
          <dt>Bounty</dt>
          <dd className={robot.bounty.totalWei !== "0" ? "bounty" : ""}>{robot.bounty.totalWei !== "0" ? formatQor(robot.bounty.totalWei) : "None"}</dd>
        </div>
      </dl>
    </>
  );
  if (href) {
    return (
      <a className={`card ${active ? "active" : ""}`} href={href}>
        {body}
      </a>
    );
  }
  return (
    <button className={`card ${active ? "active" : ""}`} onClick={onClick} aria-pressed={active}>
      {body}
    </button>
  );
}
