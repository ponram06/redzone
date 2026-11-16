/**
 * Parity check against the deployed contracts (read-only, spends nothing):
 *   npm run test:live
 * Needs the referee key at ../contracts/.referee-key.json (or REFEREE_KEY_FILE).
 */
import { keccak256, stringToBytes, encodeFunctionData, decodeFunctionResult, parseAbi, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { LEGACY_DEMO_HASH } from "../src/brains/registry.js";
import { CHAIN_ID, PQC_VERIFY, REGISTRY, VAULT, client, registryAbi, robotKey, vaultAbi } from "../src/chain.js";
import { claimDigest, loadRefereeKey, registerRobotDigest, resultDigest, signDigest, startSessionDigest, updateBrainDigest, utilityDigest } from "../src/signer.js";

const key = loadRefereeKey(process.env.REFEREE_KEY_FILE ?? "../contracts/.referee-key.json");
const H = ("0x" + "cd".repeat(32)) as Hex;
const deadline = 2_000_000_000n;
const player = "0x1111111111111111111111111111111111111111";
const pqcAbi = parseAbi(["function pqcVerify(bytes pubkey, bytes signature, bytes message) view returns (bool)"]);

describe("live contracts", { timeout: 60_000 }, () => {
  it("both contracts store our referee public key", async () => {
    for (const [address, abi] of [
      [REGISTRY, registryAbi],
      [VAULT, vaultAbi],
    ] as const) {
      const pub = await client.readContract({ address, abi, functionName: "refereePubkey" });
      expect(pub.toLowerCase()).toBe(key.publicKey.toLowerCase());
    }
  });

  it("local digests equal the contract digests", async () => {
    const onChainResult = await client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "resultDigest", args: [7n, true, H, deadline] });
    expect(resultDigest(CHAIN_ID, REGISTRY, 7n, true, H, deadline)).toBe(onChainResult);
    const onChainUtility = await client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "utilityDigest", args: [1n, 8, H, 3n, deadline] });
    expect(utilityDigest(CHAIN_ID, REGISTRY, 1n, 8, H, 3n, deadline)).toBe(onChainUtility);
    const onChainClaim = await client.readContract({ address: VAULT, abi: vaultAbi, functionName: "claimDigest", args: [1n, player, H, deadline] });
    expect(claimDigest(CHAIN_ID, VAULT, 1n, player, H, deadline)).toBe(onChainClaim);
    const onChainStart = await client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "startSessionDigest", args: [1n, player, 5n, deadline] });
    expect(startSessionDigest(CHAIN_ID, REGISTRY, 1n, player, 5n, deadline)).toBe(onChainStart);
    const onChainRegister = await client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "registerRobotDigest", args: [player, keccak256(stringToBytes("Guard Dog")), H, 2n, deadline] });
    expect(registerRobotDigest(CHAIN_ID, REGISTRY, player, "Guard Dog", H, 2n, deadline)).toBe(onChainRegister);
    const onChainUpdate = await client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "updateBrainDigest", args: [3n, H, 4n, deadline] });
    expect(updateBrainDigest(CHAIN_ID, REGISTRY, 3n, H, 4n, deadline)).toBe(onChainUpdate);
  });

  it("the chain's pqcVerify precompile accepts our signature and rejects a changed digest", async () => {
    // Throwaway digest for a session id that does not exist, so the signature is useless on chain.
    const digest = resultDigest(CHAIN_ID, REGISTRY, 999_999_999n, true, H, 1n);
    const sig = signDigest(key, digest);
    const call = async (message: Hex) => {
      const { data } = await client.call({ to: PQC_VERIFY, data: encodeFunctionData({ abi: pqcAbi, functionName: "pqcVerify", args: [key.publicKey, sig, message] }) });
      return decodeFunctionResult({ abi: pqcAbi, functionName: "pqcVerify", data: data! });
    };
    expect(await call(digest)).toBe(true);
    expect(await call(resultDigest(CHAIN_ID, REGISTRY, 999_999_999n, false, H, 1n))).toBe(false);
  });

  it("robot 1 uses the legacy demo brain and bounty 1 is keyed by robotKey(1)", async () => {
    const r = await client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRobot", args: [1n] });
    expect(r.brainHash).toBe(LEGACY_DEMO_HASH);
    const [, rk] = await client.readContract({ address: VAULT, abi: vaultAbi, functionName: "bounties", args: [1n] });
    expect(rk).toBe(robotKey(1));
  });
});
