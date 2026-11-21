import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { depositFromReceipt, vaultAbi } from "../src/chain.js";

const LIVE = "0x241767f1d799149060d133001cf4728d85ac41b7" as Address;
const OLD = "0xb0a270a8fe9a54ba2600b582830f324c94fdece8" as Address;
const owner = "0x454DCD55DCB9154216fEfb173C0B5B4D26bA80A2" as Address;

const depositLog = (address: Address, bountyId: bigint, amount: bigint) => ({
  address,
  topics: encodeEventTopics({ abi: vaultAbi, eventName: "BountyDeposited", args: { bountyId, robotId: 2n, owner } }) as Hex[],
  data: encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bool" }],
    [owner, amount, 2n * 10n ** 18n, true],
  ),
});

describe("deposit receipts", () => {
  it("counts a deposit into the live vault", () => {
    const r = depositFromReceipt({ status: "success", logs: [depositLog(LIVE, 1n, 15n * 10n ** 18n)] }, LIVE);
    expect(r).toEqual({ status: "success", bountyId: 1, amountWei: 15n * 10n ** 18n });
  });

  it("ignores a deposit the server made into an earlier vault (the V4 -> V5 switch)", () => {
    // Before this fix, old V4 deposits were subtracted from new V5 payments and pools were locked short.
    const r = depositFromReceipt({ status: "success", logs: [depositLog(OLD, 6n, 10n * 10n ** 18n)] }, LIVE);
    expect(r.status).toBe("reverted");
    expect(r.amountWei).toBe(0n);
  });

  it("ignores reverted transactions and unrelated logs", () => {
    expect(depositFromReceipt({ status: "reverted", logs: [depositLog(LIVE, 1n, 1n)] }, LIVE).status).toBe("reverted");
    expect(depositFromReceipt({ status: "success", logs: [{ address: LIVE, topics: [("0x" + "ab".repeat(32)) as Hex], data: "0x" }] }, LIVE).status).toBe("reverted");
  });
});
