import type { Robot } from "../api";

/**
 * Shown when a robot's AI provider recently refused because its free usage limit is reached, so a
 * player (or a judge) knows why rounds against it fail, before spending a try.
 */
export function AiLimitNotice({ robot }: { robot: Robot }) {
  if (!robot.aiLimitSince) return null;
  const mins = Math.max(1, Math.round((Date.now() / 1000 - robot.aiLimitSince) / 60));
  return (
    <div className="ai-limit" role="status">
      <b>Free AI limit reached</b>
      <span>
        This robot runs on a free AI plan, and its provider stopped answering {mins} {mins === 1 ? "minute" : "minutes"} ago because the free limit is used up.
        Rounds against it may fail until the limit resets; a failed message doesn't use up your try. Sentinel-01 needs no AI and always answers.
      </span>
    </div>
  );
}
