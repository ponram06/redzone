/**
 * Parity check against the deployed v3 contracts (read-only, spends nothing):
 *   npm run test:live
 * Needs the referee key at ../contracts/.referee-key.json (or REFEREE_KEY_FILE).
 */
import { keccak256, stringToBytes, encodeFunctionData, decodeFunctionResult, parseAbi, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { CHAIN_ID, PQC_VERIFY, REGISTRY, REGISTRY_DEPLOY_BLOCK, REST_URL, VAULT, VAULT_DEPLOY_BLOCK, client, readBounty, readRules, registryAbi, vaultAbi } from "../src/chain.js";
import { ChainLedger } from "../src/ledger.js";
import { loadRefereeKey, registerRobotDigest, resultDigest, signDigest, startSessionDigest, updateBrainDigest, utilityDigest, withdrawDigest } from "../src/signer.js";

const key = loadRefereeKey(process.env.REFEREE_KEY_FILE ?? "../contracts/.referee-key.json");
const H = ("0x" + "cd".repeat(32)) as Hex;
const deadline = 2_000_000_000n;
const player = "0x1111111111111111111111111111111111111111";
const pqcAbi = parseAbi(["function pqcVerify(bytes pubkey, bytes signature, bytes message) view returns (bool)"]);

describe("live contracts", { timeout: 60_000 }, () => {
  it("the registry's referee key hash is our referee key", async () => {
    const h = await client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "refereeKeyHash" });
    expect(h).toBe(keccak256(key.publicKey));
  });

  it("local digests equal the contract digests", async () => {
    const onChainResult = await client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "resultDigest", args: [7n, 2n, player, true, H, deadline] });
    expect(resultDigest(CHAIN_ID, REGISTRY, 7n, 2n, player, true, H, deadline)).toBe(onChainResult);
    const onChainUtility = await client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "utilityDigest", args: [1n, 8, H, 3n, deadline] });
    expect(utilityDigest(CHAIN_ID, REGISTRY, 1n, 8, H, 3n, deadline)).toBe(onChainUtility);
    const onChainStart = await client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "startSessionDigest", args: [1n, player, 5n, deadline] });
    expect(startSessionDigest(CHAIN_ID, REGISTRY, 1n, player, 5n, deadline)).toBe(onChainStart);
    const onChainRegister = await client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "registerRobotDigest", args: [player, keccak256(stringToBytes("Guard Dog")), H, 2n, deadline] });
    expect(registerRobotDigest(CHAIN_ID, REGISTRY, player, "Guard Dog", H, 2n, deadline)).toBe(onChainRegister);
    const onChainUpdate = await client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "updateBrainDigest", args: [3n, H, 4n, deadline] });
    expect(updateBrainDigest(CHAIN_ID, REGISTRY, 3n, H, 4n, deadline)).toBe(onChainUpdate);
    const onChainWithdraw = await client.readContract({ address: VAULT, abi: vaultAbi, functionName: "withdrawDigest", args: [2n, player, 7n, deadline] });
    expect(withdrawDigest(CHAIN_ID, VAULT, 2n, player, 7n, deadline)).toBe(onChainWithdraw);
  });

  it("the chain's pqcVerify precompile accepts our signature and rejects a changed digest", async () => {
    // Throwaway digest for a session id that does not exist, so the signature is useless on chain.
    const digest = resultDigest(CHAIN_ID, REGISTRY, 999_999_999n, 1n, player, true, H, 1n);
    const sig = signDigest(key, digest);
    const call = async (message: Hex) => {
      const { data } = await client.call({ to: PQC_VERIFY, data: encodeFunctionData({ abi: pqcAbi, functionName: "pqcVerify", args: [key.publicKey, sig, message] }) });
      return decodeFunctionResult({ abi: pqcAbi, functionName: "pqcVerify", data: data! });
    };
    expect(await call(digest)).toBe(true);
    expect(await call(resultDigest(CHAIN_ID, REGISTRY, 999_999_999n, 1n, player, false, H, 1n))).toBe(false);
  });

  it("bounty 1 decodes with the deployed field order: robot 1's open 1 QOR bounty, owned by the admin", async () => {
    const b = await readBounty(1);
    expect(b).toMatchObject({ id: 1, robotId: 1, amountWei: 10n ** 18n, withdrawRequestedAt: 0 });
    expect(b.owner.toLowerCase()).toBe("0x454dcd55dcb9154216fefb173c0b5b4d26ba80a2");
    expect([1, 2, 3]).toContain(b.status); // open, or later claimed / withdrawn
  });

  it("game rules are read from the contracts", async () => {
    expect(await readRules()).toEqual({
      attemptsPerDay: 5,
      sessionTtl: 600,
      resultGrace: 3600,
      utilityTasks: 10,
      maxNameLength: 64,
      maxStartTtl: 600,
      withdrawDelay: 3 * 3600,
    });
  });

  it("the ledger reads the v3 history and real native transfers", { timeout: 180_000 }, async () => {
    const ledger = new ChainLedger(client, REGISTRY, REGISTRY_DEPLOY_BLOCK, VAULT, VAULT_DEPLOY_BLOCK, REST_URL);
    await ledger.sync();
    const next = await client.readContract({ address: VAULT, abi: vaultAbi, functionName: "nextBountyId" });
    expect(ledger.deposits().length).toBe(Number(next) - 1);
    // The 3 QOR the main account sent to fund the relayer (16 Nov).
    const t = await ledger.transfers("qor1crs332umw4zr9adcegafrc0yr8juke7t7rsre5", "qor19n2e0wjparavk47wevc8mag90ce8nzysd8lp2d");
    expect(t.some((x) => x.uqor === 3_000_000n && x.code === 0)).toBe(true);
  });
});
