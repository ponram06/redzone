/**
 * Referee signer: builds the same digests as the contracts and signs them with ML-DSA-87.
 *
 *   digest = keccak256(abi.encodePacked(keccak256(domainTag), chainid, contract, keccak256(abi.encode(TYPEHASH, ...))))
 *
 * See PQAdmin._digest, RobotRegistry.resultDigest / utilityDigest and EscrowVault.claimDigest.
 */
import { readFileSync } from "node:fs";
import { pqcSign, pqcVerify } from "@qorechain/sdk";
import { encodeAbiParameters, encodePacked, hexToBytes, keccak256, stringToBytes, toHex, type Address, type Hex } from "viem";

export const REGISTRY_DOMAIN = "RedZone.RobotRegistry.v2";
export const VAULT_DOMAIN = "RedZone.EscrowVault.v1";

const typehash = (s: string) => keccak256(stringToBytes(s));
export const RESULT_TYPEHASH = typehash("RedZone.Result(uint256 sessionId,bool breached,bytes32 replayHash,uint256 deadline)");
export const UTILITY_TYPEHASH = typehash(
  "RedZone.Utility(uint256 robotId,uint8 tasksPassed,bytes32 replayHash,uint256 nonce,uint256 deadline)",
);
export const CLAIM_TYPEHASH = typehash("RedZone.Claim(uint256 bountyId,address claimer,bytes32 replayHash,uint256 deadline)");

export function domainDigest(domain: string, chainId: number, contract: Address, structData: Hex): Hex {
  return keccak256(
    encodePacked(
      ["bytes32", "uint256", "address", "bytes32"],
      [keccak256(stringToBytes(domain)), BigInt(chainId), contract, keccak256(structData)],
    ),
  );
}

export function resultDigest(chainId: number, registry: Address, sessionId: bigint, breached: boolean, replayHash: Hex, deadline: bigint): Hex {
  const data = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "bool" }, { type: "bytes32" }, { type: "uint256" }],
    [RESULT_TYPEHASH, sessionId, breached, replayHash, deadline],
  );
  return domainDigest(REGISTRY_DOMAIN, chainId, registry, data);
}

export function utilityDigest(
  chainId: number,
  registry: Address,
  robotId: bigint,
  tasksPassed: number,
  replayHash: Hex,
  nonce: bigint,
  deadline: bigint,
): Hex {
  const data = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "uint8" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
    [UTILITY_TYPEHASH, robotId, tasksPassed, replayHash, nonce, deadline],
  );
  return domainDigest(REGISTRY_DOMAIN, chainId, registry, data);
}

export function claimDigest(chainId: number, vault: Address, bountyId: bigint, claimer: Address, replayHash: Hex, deadline: bigint): Hex {
  const data = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }],
    [CLAIM_TYPEHASH, bountyId, claimer, replayHash, deadline],
  );
  return domainDigest(VAULT_DOMAIN, chainId, vault, data);
}

export type RefereeKey = { publicKey: Hex; secretKey: Uint8Array };

/** Load the referee key made by `npm run referee-key` in contracts/. Never log the secret. */
export function loadRefereeKey(file: string): RefereeKey {
  const j = JSON.parse(readFileSync(file, "utf8")) as { algorithm?: string; publicKey: Hex; secretKey: Hex };
  if (j.algorithm && j.algorithm !== "ML-DSA-87") throw new Error(`unexpected referee key algorithm ${j.algorithm}`);
  const key = { publicKey: j.publicKey, secretKey: hexToBytes(j.secretKey) };
  // Self-check so a broken key fails at startup, not when a player wins.
  const probe = stringToBytes("redzone-referee-startup-check");
  if (!pqcVerify(hexToBytes(key.publicKey), probe, pqcSign(key.secretKey, probe))) throw new Error("referee key self-check failed");
  return key;
}

export function signDigest(key: RefereeKey, digest: Hex): Hex {
  return toHex(pqcSign(key.secretKey, hexToBytes(digest)));
}
