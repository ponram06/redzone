import { generatePqcKeypair, pqcVerify } from "@qorechain/sdk";
import { hexToBytes, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { resultDigest, signDigest, utilityDigest, withdrawDigest } from "../src/signer.js";

const REG = "0x69564de848d807ea895e1987b53749e1648cadbf";
const VAULT = "0x16cc5efcda75a788f597dd0c785862db1bdbeb7f";
const P1 = "0x1111111111111111111111111111111111111111";
const P2 = "0x2222222222222222222222222222222222222222";
const H = ("0x" + "ab".repeat(32)) as `0x${string}`;

describe("signer", () => {
  it("digests bind every field", () => {
    const base = resultDigest(9800, REG, 1n, 1n, P1, true, H, 100n);
    expect(resultDigest(9800, REG, 1n, 1n, P1, false, H, 100n)).not.toBe(base);
    expect(resultDigest(9800, REG, 2n, 1n, P1, true, H, 100n)).not.toBe(base);
    expect(resultDigest(9800, REG, 1n, 2n, P1, true, H, 100n)).not.toBe(base);
    expect(resultDigest(9800, REG, 1n, 1n, P2, true, H, 100n)).not.toBe(base);
    expect(resultDigest(1, REG, 1n, 1n, P1, true, H, 100n)).not.toBe(base);
    expect(resultDigest(9800, VAULT, 1n, 1n, P1, true, H, 100n)).not.toBe(base);
    expect(utilityDigest(9800, REG, 1n, 7, H, 0n, 100n)).not.toBe(utilityDigest(9800, REG, 1n, 7, H, 1n, 100n));
    expect(withdrawDigest(9800, VAULT, 1n, P1, 0n, 100n)).not.toBe(withdrawDigest(9800, VAULT, 1n, P2, 0n, 100n));
  });

  it("produces ML-DSA-87 signatures that verify", () => {
    const kp = generatePqcKeypair();
    const d = resultDigest(9800, REG, 1n, 1n, P1, true, H, 100n);
    const sig = signDigest({ publicKey: toHex(kp.publicKey), secretKey: kp.secretKey }, d);
    expect(hexToBytes(sig).length).toBe(4627);
    expect(pqcVerify(kp.publicKey, hexToBytes(d), hexToBytes(sig))).toBe(true);
  });
});
