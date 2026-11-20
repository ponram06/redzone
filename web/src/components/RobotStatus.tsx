import { API_URL, type Robot } from "../api";
import { PlayerTag } from "../players";

const ago = (at: number) => {
  const m = Math.max(1, Math.round((Date.now() / 1000 - at) / 60));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

/** The brain version people see: the first brain is version 1. */
export const versionOf = (robot: Robot) => (robot.brainVersion ?? 0) + 1;

/** A small badge for cards and lists: Frozen, Fixed (version N), or nothing. */
export function StatusBadge({ robot }: { robot: Robot }) {
  if (robot.frozen) return <span className="badge status-frozen">🔒 Frozen</span>;
  if ((robot.brainVersion ?? 0) > 0) return <span className="badge status-fixed">🛠 Fixed · v{versionOf(robot)}</span>;
  return null;
}

/**
 * Why a robot is frozen. Everyone sees who broke it and when; its owner (`forOwner`) also sees the
 * message that broke it and the red zone, with the replay, to fix it.
 */
export function FrozenNotice({ robot, forOwner = false }: { robot: Robot; forOwner?: boolean }) {
  const f = robot.frozen;
  if (!f) return null;
  return (
    <div className="frozen" role="status">
      <b>🔒 Frozen: waiting for its owner's fix</b>
      <span>
        <PlayerTag address={f.player} size={18} /> broke version {versionOf(robot)} {ago(f.at)}
        {f.zone ? <> and drove it into the <b>{f.zone}</b></> : null} and was paid. It pays again after its owner fixes it.
      </span>
      {forOwner && f.instruction && (
        <span className="frozen-msg">
          They sent: <q>{f.instruction}</q>
        </span>
      )}
      <a href={`${API_URL}/replay/${f.replayHash}`} target="_blank" rel="noreferrer">
        See the replay ↗
      </a>
    </div>
  );
}
