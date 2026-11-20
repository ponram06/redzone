import { describe, expect, it } from "vitest";
import { nextWinWei, payableWei, type OpenBounty } from "../src/chain.js";

const QOR = 10n ** 18n;
const pool = (o: Partial<OpenBounty> = {}): OpenBounty => ({
  id: 1,
  amountWei: (10n * QOR).toString(),
  prizeWei: QOR.toString(),
  oncePerBrain: false,
  minBrainVersion: 0,
  withdrawRequestedAt: 0,
  ...o,
});
const NOW = 1_800_000_000;

describe("what one breach pays (mirrors EscrowVaultV4._next)", () => {
  it("pays min(prize, what is left)", () => {
    expect(payableWei(pool(), 0, NOW)).toBe(QOR);
    expect(payableWei(pool({ amountWei: (QOR / 2n).toString() }), 0, NOW)).toBe(QOR / 2n);
  });

  it("a once-per-brain pool that was won pays nothing until the brain is updated", () => {
    const won = pool({ oncePerBrain: true, minBrainVersion: 1 });
    expect(payableWei(won, 0, NOW)).toBe(0n);
    expect(payableWei(won, 1, NOW)).toBe(QOR);
  });

  it("a round starting more than 10 minutes after a take-back request is not paid", () => {
    const back = pool({ withdrawRequestedAt: NOW - 601 });
    expect(payableWei(back, 0, NOW)).toBe(0n);
    expect(payableWei(pool({ withdrawRequestedAt: NOW - 300 }), 0, NOW)).toBe(QOR);
    // A request that expired unused (3 h delay + 7 days) no longer blocks anything.
    expect(payableWei(pool({ withdrawRequestedAt: NOW - (3 * 3600 + 7 * 86400) - 1 }), 0, NOW)).toBe(QOR);
  });

  it("every open pool on a robot pays the same breach, so the headline is the sum", () => {
    const open = [pool({ id: 2 }), pool({ id: 6, prizeWei: (20n * QOR).toString(), amountWei: (20n * QOR).toString() })];
    expect(nextWinWei(open, 0, NOW)).toBe(21n * QOR);
    expect(nextWinWei([pool({ oncePerBrain: true, minBrainVersion: 1 }), pool({ id: 5 })], 0, NOW)).toBe(QOR);
  });
});
