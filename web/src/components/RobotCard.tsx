import { formatQor, nextPrizeWei, type Robot } from "../api";
import { TIER_TEXT, safetyScore } from "../data";
import { RobotIcon } from "./RobotIcon";
import { lookOf } from "../robotLook";
import { StatusBadge } from "./RobotStatus";

/** A robot at a glance: name, badge, safety score, attacks blocked, bounty. */
export function RobotCard({ robot, href, active, onClick }: { robot: Robot; href?: string; active?: boolean; onClick?: () => void }) {
  const body = (
    <>
      <div className="card-top">
        <RobotIcon {...lookOf(robot)} size={44} className="card-robot" />
        <div>
          <div className="card-name">{robot.name}</div>
          <span className={`badge tier-${robot.tier.toLowerCase()}`}>{TIER_TEXT[robot.tier] ?? robot.tier}</span> <StatusBadge robot={robot} />
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
        {robot.bounty.totalWei !== "0" && nextPrizeWei(robot).toString() !== robot.bounty.totalWei && (
          <div>
            <dt>Per win</dt>
            <dd className="bounty">{robot.frozen ? "Frozen" : nextPrizeWei(robot) > 0n ? formatQor(nextPrizeWei(robot).toString()) : "Nothing now"}</dd>
          </div>
        )}
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
