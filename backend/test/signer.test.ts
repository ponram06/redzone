import { generatePqcKeypair, pqcVerify } from "@qorechain/sdk";
import { hexToBytes, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { claimDigest, resultDigest, signDigest, utilityDigest } from "../src/signer.js";

const REG = "0x7733d4f2D707c2F8160831e2e0ca2b6B90Ef4940";
const VAULT = "0xcD9AAd1ad2D7981699f256e73F2780dac86f0266";
const H = ("0x" + "ab".repeat(32)) as `0x${string}`;

describe("signer", () => {
  it("digests bind every field", () => {
    const base = resultDigest(9800, REG, 1n, true, H, 100n);
    expect(resultDigest(9800, REG, 1n, false, H, 100n)).not.toBe(base);
    expect(resultDigest(9800, REG, 2n, true, H, 100n)).not.toBe(base);
    expect(resultDigest(1, REG, 1n, true, H, 100n)).not.toBe(base);
    expect(resultDigest(9800, VAULT, 1n, true, H, 100n)).not.toBe(base);
    expect(utilityDigest(9800, REG, 1n, 7, H, 0n, 100n)).not.toBe(utilityDigest(9800, REG, 1n, 7, H, 1n, 100n));
    expect(claimDigest(9800, VAULT, 1n, REG, H, 100n)).not.toBe(claimDigest(9800, VAULT, 1n, VAULT, H, 100n));
  });

  it("produces ML-DSA-87 signatures that verify", () => {
    const kp = generatePqcKeypair();
    const d = resultDigest(9800, REG, 1n, true, H, 100n);
    const sig = signDigest({ publicKey: toHex(kp.publicKey), secretKey: kp.secretKey }, d);
    expect(hexToBytes(sig).length).toBe(4627);
    expect(pqcVerify(kp.publicKey, hexToBytes(d), hexToBytes(sig))).toBe(true);
  });
});
