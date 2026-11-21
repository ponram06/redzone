/**
 * Referee signer: builds the same digests as the contracts and signs them with ML-DSA-87.
 *
 *   digest = keccak256(abi.encodePacked(keccak256(domainTag), chainid, contract, keccak256(abi.encode(TYPEHASH, ...))))
 *
 * See PQAccess._digest (contracts/src/v3) and RobotRegistryV3 / EscrowVaultV2's *Digest views.
 */
import { readFileSync } from "node:fs";
import { pqcSign, pqcVerify } from "@qorechain/sdk";
import { encodeAbiParameters, encodePacked, hexToBytes, keccak256, stringToBytes, toHex, type Address, type Hex } from "viem";

export const REGISTRY_DOMAIN = "RedZone.RobotRegistry.v4";
/** Each vault's signing domain: the tag it passes to PQAccess (checked against the sources in signer.test.ts). */
export const VAULT_DOMAINS: Record<string, string> = {
  EscrowVaultV4: "RedZone.EscrowVault.v4",
  EscrowVaultV5: "RedZone.EscrowVault.v5",
};
/** The live vault's domain (EscrowVaultV5). */
export const VAULT_DOMAIN = VAULT_DOMAINS.EscrowVaultV5!;

/** The signing domain of the vault named `name` (EscrowVaultV4 or EscrowVaultV5). */
export function vaultDomain(name: string): string {
  const d = VAULT_DOMAINS[name];
  if (!d) throw new Error(`unknown vault ${name}: add its domain tag to VAULT_DOMAINS`);
  return d;
}

const typehash = (s: string) => keccak256(stringToBytes(s));
export const RESULT_TYPEHASH = typehash(
  "RedZone.Result(uint256 sessionId,uint256 robotId,address player,bool breached,bytes32 replayHash,uint256 deadline)",
);
export const UTILITY_TYPEHASH = typehash(
  "RedZone.Utility(uint256 robotId,uint8 tasksPassed,bytes32 replayHash,uint256 nonce,uint256 deadline)",
);

export function domainDigest(domain: string, chainId: number, contract: Address, structData: Hex): Hex {
  return keccak256(
    encodePacked(
      ["bytes32", "uint256", "address", "bytes32"],
      [keccak256(stringToBytes(domain)), BigInt(chainId), contract, keccak256(structData)],
    ),
  );
}

/** RobotRegistryV3.resultDigest: binds the verdict to the session, its robot and its player. */
export function resultDigest(
  chainId: number,
  registry: Address,
  sessionId: bigint,
  robotId: bigint,
  player: Address,
  breached: boolean,
  replayHash: Hex,
  deadline: bigint,
): Hex {
  const data = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "bool" }, { type: "bytes32" }, { type: "uint256" }],
    [RESULT_TYPEHASH, sessionId, robotId, player, breached, replayHash, deadline],
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

export type RefereeKey = { publicKey: Hex; secretKey: Uint8Array };

/** Load the referee key made by `npm run referee-key` in contracts/. Never log the secret. */
export function loadRefereeKey(file: string): RefereeKey {
  return parseRefereeKey(readFileSync(file, "utf8"));
}

/** The referee key from the JSON text of a key file (e.g. a hosting secret). */
export function parseRefereeKey(json: string): RefereeKey {
  const j = JSON.parse(json) as { algorithm?: string; publicKey: Hex; secretKey: Hex };
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

export const START_SESSION_TYPEHASH = typehash("RedZone.StartSession(uint256 robotId,address player,uint256 nonce,uint256 deadline)");

/** RobotRegistryV3.startSessionDigest: what the player authorises (via QoreX) to start a session. */
export function startSessionDigest(chainId: number, registry: Address, robotId: bigint, player: Address, nonce: bigint, deadline: bigint): Hex {
  const data = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }],
    [START_SESSION_TYPEHASH, robotId, player, nonce, deadline],
  );
  return domainDigest(REGISTRY_DOMAIN, chainId, registry, data);
}

export const REGISTER_ROBOT_TYPEHASH = typehash(
  "RedZone.RegisterRobot(address owner,bytes32 nameHash,bytes32 brainHash,uint256 nonce,uint256 deadline)",
);
export const UPDATE_BRAIN_TYPEHASH = typehash("RedZone.UpdateBrain(uint256 robotId,bytes32 brainHash,uint256 nonce,uint256 deadline)");

/** RobotRegistryV3.registerRobotDigest, with nameHash = keccak256(bytes(name)). */
export function registerRobotDigest(chainId: number, registry: Address, owner: Address, name: string, brain: Hex, nonce: bigint, deadline: bigint): Hex {
  const data = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
    [REGISTER_ROBOT_TYPEHASH, owner, keccak256(stringToBytes(name)), brain, nonce, deadline],
  );
  return domainDigest(REGISTRY_DOMAIN, chainId, registry, data);
}

/** RobotRegistryV3.updateBrainDigest. */
export function updateBrainDigest(chainId: number, registry: Address, robotId: bigint, brain: Hex, nonce: bigint, deadline: bigint): Hex {
  const data = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
    [UPDATE_BRAIN_TYPEHASH, robotId, brain, nonce, deadline],
  );
  return domainDigest(REGISTRY_DOMAIN, chainId, registry, data);
}

export const WITHDRAW_TYPEHASH = typehash("RedZone.Withdraw(uint256 bountyId,address to,uint256 nonce,uint256 deadline)");

/** The vault's withdrawDigest: what the bounty owner signs (requestWithdraw) to take a bounty back. */
export function withdrawDigest(chainId: number, vault: Address, bountyId: bigint, to: Address, nonce: bigint, deadline: bigint, domain = VAULT_DOMAIN): Hex {
  const data = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }],
    [WITHDRAW_TYPEHASH, bountyId, to, nonce, deadline],
  );
  return domainDigest(domain, chainId, vault, data);
}

export const OPEN_PASS_TYPEHASH = typehash(
  "RedZone.OpenPass(address player,address operator,uint256 validUntil,uint256 maxRounds,uint256 nonce,uint256 deadline)",
);

/** RobotRegistryV4.openPassDigest: what the player signs once to play for PASS_TTL without new prompts. */
export function openPassDigest(
  chainId: number,
  registry: Address,
  player: Address,
  operator: Address,
  validUntil: bigint,
  maxRounds: bigint,
  nonce: bigint,
  deadline: bigint,
): Hex {
  const data = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    [OPEN_PASS_TYPEHASH, player, operator, validUntil, maxRounds, nonce, deadline],
  );
  return domainDigest(REGISTRY_DOMAIN, chainId, registry, data);
}
