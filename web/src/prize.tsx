import { useEffect, useState } from "react";
import { useAccount } from "./account";
import { api, formatQor, nextPrizeWei, takeBackStartedAt, type PlayerPrize, type Robot } from "./api";

/**
 * What a breach would pay the signed-in player on this robot right now, from the vault itself:
 * pools they already won are skipped. null while loading, when signed out, or for their own robot.
 * Refetched when the robot's pools change or `refresh` changes (e.g. after a round).
 */
export function usePlayerPrize(robot: Robot | null, refresh?: unknown): PlayerPrize | null {
  // The vault knows players by their EVM address (0x…), not the qor1… one QoreX shows.
  const evm = useAccount().player?.evm ?? null;
  const [prize, setPrize] = useState<PlayerPrize | null>(null);
  const id = robot?.id;
  const pools = robot ? `${robot.bounty.totalWei}:${robot.nextWinWei ?? ""}` : "";
  const own = !!(robot && evm && robot.owner.toLowerCase() === evm.toLowerCase());
  useEffect(() => {
    setPrize(null);
    if (!id || !evm || own) return;
    let live = true;
    api
      .prizeFor(id, evm)
      .then((p) => live && setPrize(p))
      .catch(() => live && setPrize(null));
    return () => {
      live = false;
    };
  }, [id, evm, own, pools, refresh]);
  return prize;
}

/**
 * The headline for a robot's prize. `amount` is what one win pays (null when nothing can be won
 * right now) and `note` says why, in plain words, when the robot has money locked but it can't pay.
 */
export function prizeHeadline(robot: Robot, mine: PlayerPrize | null): { amount: string | null; note: string | null } {
  if (robot.bounty.totalWei === "0") return { amount: null, note: null };
  const general = nextPrizeWei(robot);
  if (mine) {
    const wei = BigInt(mine.wei);
    if (wei > 0n) return { amount: formatQor(wei.toString()), note: null };
    if (mine.wonAll) return { amount: null, note: "You already won what this robot pays. It pays you again only after its owner updates it." };
  }
  if (general > 0n) return { amount: formatQor(general.toString()), note: null };
  if (takeBackStartedAt(robot)) return { amount: null, note: "Its owner is taking the bounty back, so new rounds aren't paid." };
  return { amount: null, note: "Someone already won this version of the robot. It pays again after its owner updates it." };
}
