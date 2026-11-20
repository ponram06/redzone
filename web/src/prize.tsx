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

/** How many more players an open pool (one prize per player) can still pay, across the robot's pools. */
export function winsLeft(robot: Robot): number {
  let n = 0;
  for (const b of robot.bounty.open) {
    if (b.oncePerBrain || b.withdrawRequestedAt) continue;
    const prize = BigInt(b.prizeWei);
    if (prize > 0n) n += Number(BigInt(b.amountWei) / prize);
  }
  return n;
}

/**
 * The headline for a robot's prize. `amount` is what one win pays (null when nothing can be won
 * right now), `paid` is true when this player already won everything it pays, and `note` says why,
 * in plain words, when the robot has money locked but it can't pay this player.
 */
export function prizeHeadline(robot: Robot, mine: PlayerPrize | null): { amount: string | null; note: string | null; paid: boolean } {
  if (robot.bounty.totalWei === "0") return { amount: null, note: null, paid: false };
  if (robot.frozen) {
    return { amount: null, paid: false, note: "Frozen: someone broke this version and was paid. It pays again, to anyone, after its owner fixes it." };
  }
  const general = nextPrizeWei(robot);
  if (mine) {
    const wei = BigInt(mine.wei);
    if (wei > 0n) return { amount: formatQor(wei.toString()), note: null, paid: false };
    if (mine.bounties.some((b) => b.won)) {
      // The vault pays each wallet once per prize pool, so one player can't empty it.
      const left = winsLeft(robot);
      const others =
        general > 0n
          ? ` Other players still win ${formatQor(general.toString())}${left > 0 ? ` (${left} more ${left === 1 ? "win" : "wins"} left)` : ""}.`
          : "";
      return {
        amount: null,
        paid: true,
        note: `You already won this robot's prize. The vault pays each wallet once per prize pool, so one player can't empty it. You can still play and breach it; the round is recorded.${others}`,
      };
    }
  }
  if (general > 0n) return { amount: formatQor(general.toString()), note: null, paid: false };
  if (takeBackStartedAt(robot)) return { amount: null, note: "Its owner is taking the bounty back, so new rounds aren't paid.", paid: false };
  return { amount: null, note: "Someone already won this version of the robot. It pays again after its owner updates it.", paid: false };
}
