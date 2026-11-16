/** Read-only access to the deployed RedZone contracts on qorechain-diana. */
import { readFileSync } from "node:fs";
import { createPublicClient, defineChain, http, keccak256, parseAbi, stringToBytes, type Address, type Hex } from "viem";

const deployments = JSON.parse(
  readFileSync(new URL("../../deployments/testnet.json", import.meta.url), "utf8"),
) as { evmChainId: number; contracts: { EscrowVault: { address: Address }; RobotRegistry: { address: Address } } };

export const CHAIN_ID = deployments.evmChainId;
export const VAULT = deployments.contracts.EscrowVault.address;
export const REGISTRY = deployments.contracts.RobotRegistry.address;
/** Lower-case on purpose: viem rejects the mixed-case precompile constants. */
export const PQC_VERIFY = "0x0000000000000000000000000000000000000a01" as Address;

export const qorechain = defineChain({
  id: CHAIN_ID,
  name: "QoreChain Diana testnet",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [process.env.EVM_RPC_URL ?? "https://evm-testnet.qore.host"] } },
});

export const client = createPublicClient({ chain: qorechain, transport: http(undefined, { retryCount: 3, timeout: 20_000 }) });

export const registryAbi = parseAbi([
  "struct Robot { address owner; uint64 registeredAt; uint8 utilityScore; uint32 attacks; uint32 defended; uint32 breached; uint32 utilityNonce; bytes32 brainHash; string name; }",
  "function nextRobotId() view returns (uint256)",
  "function getRobot(uint256 robotId) view returns (Robot)",
  "function getRating(uint256 robotId) view returns (uint256)",
  "function getTier(uint256 robotId) view returns (uint8)",
  "function sessions(uint256 sessionId) view returns (uint256 robotId, address player, uint64 startedAt, uint8 outcome, bytes32 replayHash)",
  "function refereePubkey() view returns (bytes)",
  "function resultDigest(uint256 sessionId, bool breached, bytes32 replayHash, uint256 deadline) view returns (bytes32)",
  "function utilityDigest(uint256 robotId, uint8 tasksPassed, bytes32 replayHash, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function recordResult(uint256 sessionId, bool breached, bytes32 replayHash, uint256 deadline, bytes refereeSig)",
  "function recordUtility(uint256 robotId, uint8 tasksPassed, bytes32 replayHash, uint256 deadline, bytes refereeSig)",
]);

export const vaultAbi = parseAbi([
  "function nextBountyId() view returns (uint256)",
  "function bounties(uint256 bountyId) view returns (address owner, bytes32 robotId, uint128 amount, uint8 status)",
  "function refereePubkey() view returns (bytes)",
  "function claimDigest(uint256 bountyId, address claimer, bytes32 replayHash, uint256 deadline) view returns (bytes32)",
  "function claimBounty(uint256 bountyId, address claimer, bytes32 replayHash, uint256 deadline, bytes refereeSig)",
]);

export const SESSION_TTL = 600;
export const RESULT_GRACE = 3600;
export const TIERS = ["Rookie", "Guard", "Sentinel"] as const;

/** The vault keys bounties by bytes32; robot N's key is keccak256("robot-N"). */
export function robotKey(robotId: bigint | number): Hex {
  return keccak256(stringToBytes(`robot-${robotId}`));
}

export type RobotView = {
  id: number;
  owner: Address;
  name: string;
  brainHash: Hex;
  registeredAt: number;
  attacks: number;
  defended: number;
  breached: number;
  utilityScore: number;
  utilityNonce: number;
  ratingBps: number;
  tier: (typeof TIERS)[number];
  bounty: { open: { id: number; amountWei: string }[]; totalWei: string };
};

export async function readRobot(id: number): Promise<RobotView | null> {
  const r = await client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRobot", args: [BigInt(id)] });
  if (r.owner === "0x0000000000000000000000000000000000000000") return null;
  const [rating, tier, bounty] = await Promise.all([
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRating", args: [BigInt(id)] }),
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getTier", args: [BigInt(id)] }),
    openBounties(id),
  ]);
  return {
    id,
    owner: r.owner,
    name: r.name,
    brainHash: r.brainHash,
    registeredAt: Number(r.registeredAt),
    attacks: r.attacks,
    defended: r.defended,
    breached: r.breached,
    utilityScore: r.utilityScore,
    utilityNonce: r.utilityNonce,
    ratingBps: Number(rating),
    tier: TIERS[tier] ?? "Rookie",
    bounty: { open: bounty, totalWei: bounty.reduce((s, b) => s + BigInt(b.amountWei), 0n).toString() },
  };
}

export async function readRobots(): Promise<RobotView[]> {
  const next = await client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "nextRobotId" });
  const ids = Array.from({ length: Number(next) - 1 }, (_, i) => i + 1);
  return (await Promise.all(ids.map(readRobot))).filter((r): r is RobotView => r !== null);
}

/** Open bounties for a robot (status 1 = Open). */
export async function openBounties(robotId: number): Promise<{ id: number; amountWei: string }[]> {
  const next = await client.readContract({ address: VAULT, abi: vaultAbi, functionName: "nextBountyId" });
  const key = robotKey(robotId);
  const out: { id: number; amountWei: string }[] = [];
  for (let i = 1n; i < next; i++) {
    const [, rk, amount, status] = await client.readContract({ address: VAULT, abi: vaultAbi, functionName: "bounties", args: [i] });
    if (rk === key && status === 1) out.push({ id: Number(i), amountWei: amount.toString() });
  }
  return out;
}

export type SessionView = { id: number; robotId: number; player: Address; startedAt: number; outcome: number };

export async function readSession(id: number): Promise<SessionView | null> {
  const [robotId, player, startedAt, outcome] = await client.readContract({
    address: REGISTRY,
    abi: registryAbi,
    functionName: "sessions",
    args: [BigInt(id)],
  });
  if (player === "0x0000000000000000000000000000000000000000") return null;
  return { id, robotId: Number(robotId), player, startedAt: Number(startedAt), outcome };
}
