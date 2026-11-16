/** Read-only access to the deployed RedZone contracts on qorechain-diana. */
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  decodeFunctionResult,
  defineChain,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  stringToBytes,
  type Address,
  type Hex,
} from "viem";

const deployments = JSON.parse(
  readFileSync(new URL("../../deployments/testnet.json", import.meta.url), "utf8"),
) as { evmChainId: number; contracts: { EscrowVault: { address: Address }; RobotRegistryV2: { address: Address } } };

export const CHAIN_ID = deployments.evmChainId;
export const VAULT = deployments.contracts.EscrowVault.address;
/** RobotRegistryV2 (QoreX-signed, relayable sessions). v1 stays on chain for history only. */
export const REGISTRY = deployments.contracts.RobotRegistryV2.address;
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
  "function nonces(address account) view returns (uint256)",
  "function attemptsLeftToday(address player) view returns (uint256)",
  "function startSessionDigest(uint256 robotId, address player, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function startSessionFor(uint256 robotId, address player, uint256 deadline, bytes playerSig) returns (uint256)",
  "event SessionStarted(uint256 indexed sessionId, uint256 indexed robotId, address indexed player, uint256 expiresAt)",
  "function registerRobotDigest(address owner, bytes32 nameHash, bytes32 brainHash, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function registerRobotFor(address owner, string name, bytes32 brainHash, uint256 deadline, bytes ownerSig) returns (uint256)",
  "function updateBrainDigest(uint256 robotId, bytes32 brainHash, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function updateBrain(uint256 robotId, bytes32 brainHash, uint256 deadline, bytes ownerSig)",
  "event RobotRegistered(uint256 indexed robotId, address indexed owner, bytes32 brainHash, string name)",
  "event BrainUpdated(uint256 indexed robotId, bytes32 brainHash)",
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

/** Lower-case on purpose, like PQC_VERIFY. */
export const PQC_KEY_STATUS = "0x0000000000000000000000000000000000000a02" as Address;
const keyStatusAbi = parseAbi(["function pqcKeyStatus(address account) view returns (bool registered, uint8 algorithmId, bytes pubkey)"]);

/** The registered ML-DSA-87 key of an account, from the pqcKeyStatus precompile. */
export async function readPqcKey(account: Address): Promise<{ registered: boolean; algorithmId: number; pubkey: Hex }> {
  const { data } = await client.call({
    to: PQC_KEY_STATUS,
    data: encodeFunctionData({ abi: keyStatusAbi, functionName: "pqcKeyStatus", args: [account] }),
  });
  const [registered, algorithmId, pubkey] = decodeFunctionResult({ abi: keyStatusAbi, functionName: "pqcKeyStatus", data: data! });
  return { registered, algorithmId, pubkey };
}

/** Per-player state on RobotRegistryV2: request nonce and sessions left today. */
export async function readPlayer(player: Address): Promise<{ nonce: bigint; attemptsLeft: number }> {
  const [nonce, left] = await Promise.all([
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "nonces", args: [player] }),
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "attemptsLeftToday", args: [player] }),
  ]);
  return { nonce, attemptsLeft: Number(left) };
}

export type NativeTransfer = { code: number; from: string; to: string; uqor: bigint; memo: string; height: number };

/** A confirmed native transaction, read over REST: its first MsgSend, if any. Null when not found. */
export async function readNativeTransfer(txHash: string, rest = process.env.QORE_REST_URL ?? "https://api-testnet.qore.host"): Promise<NativeTransfer | null> {
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(txHash)) return null;
  const hash = txHash.replace(/^0x/, "").toUpperCase();
  const res = await fetch(`${rest}/cosmos/tx/v1beta1/txs/${hash}`, { signal: AbortSignal.timeout(20_000) });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`tx lookup failed: HTTP ${res.status}`);
  const body = (await res.json()) as {
    tx?: { body?: { memo?: string; messages?: { "@type"?: string; from_address?: string; to_address?: string; amount?: { denom: string; amount: string }[] }[] } };
    tx_response?: { code?: number; height?: string };
  };
  const send = body.tx?.body?.messages?.find((m) => m["@type"] === "/cosmos.bank.v1beta1.MsgSend");
  if (!send) return { code: body.tx_response?.code ?? 0, from: "", to: "", uqor: 0n, memo: body.tx?.body?.memo ?? "", height: Number(body.tx_response?.height ?? 0) };
  const uqor = (send.amount ?? []).filter((c) => c.denom === "uqor").reduce((s, c) => s + BigInt(c.amount), 0n);
  return {
    code: body.tx_response?.code ?? 0,
    from: send.from_address ?? "",
    to: send.to_address ?? "",
    uqor,
    memo: body.tx?.body?.memo ?? "",
    height: Number(body.tx_response?.height ?? 0),
  };
}
