import { generatePqcKeypair, pqcVerify } from "@qorechain/sdk";
import { hexToBytes, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { REGISTRY_DOMAIN, VAULT_DOMAIN, VAULT_DOMAINS, resultDigest, signDigest, utilityDigest, vaultDomain, withdrawDigest } from "../src/signer.js";

/** The domain tag a contract passes to PQAccess, read from its Solidity source. */
const tagIn = (file: string) => readFileSync(new URL(`../../contracts/src/${file}`, import.meta.url), "utf8").match(/PQAccess\("([^"]+)"/)![1];

const REG = "0x69564de848d807ea895e1987b53749e1648cadbf";
const VAULT = "0x16cc5efcda75a788f597dd0c785862db1bdbeb7f";
const P1 = "0x1111111111111111111111111111111111111111";
const P2 = "0x2222222222222222222222222222222222222222";
const H = ("0x" + "ab".repeat(32)) as `0x${string}`;

describe("signer", () => {
  it("signing domains are the contracts' own tags, so the server can't drift from the chain", () => {
    expect(REGISTRY_DOMAIN).toBe(tagIn("v4/RobotRegistryV4.sol"));
    expect(VAULT_DOMAINS.EscrowVaultV4).toBe(tagIn("v4/EscrowVaultV4.sol"));
    expect(VAULT_DOMAINS.EscrowVaultV5).toBe(tagIn("v5/EscrowVaultV5.sol"));
    expect(VAULT_DOMAIN).toBe(tagIn("v5/EscrowVaultV5.sol")); // the live vault
    expect(vaultDomain("EscrowVaultV5")).toBe("RedZone.EscrowVault.v5");
    expect(() => vaultDomain("EscrowVaultV9")).toThrow(/unknown vault/);
    // A take-back signed for one vault version is useless on the other.
    expect(withdrawDigest(9800, VAULT, 1n, P1, 0n, 100n, VAULT_DOMAINS.EscrowVaultV4)).not.toBe(withdrawDigest(9800, VAULT, 1n, P1, 0n, 100n));
  });

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
