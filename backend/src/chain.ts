/** Read-only access to the deployed RedZone contracts on qorechain-diana. */
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  decodeEventLog,
  decodeFunctionResult,
  defineChain,
  encodeFunctionData,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";

const deployments = JSON.parse(
  readFileSync(new URL("../../deployments/testnet.json", import.meta.url), "utf8"),
) as {
  evmChainId: number;
  network: string;
  contracts: {
    EscrowVaultV4: { address: Address; deployBlock: number };
    RobotRegistryV4: { address: Address; deployBlock: number; nativeChainId: string };
  };
};

/** Native (Cosmos) chain id QoreX signs for, from the deployment record. */
export const NATIVE_CHAIN_ID = deployments.contracts.RobotRegistryV4.nativeChainId;
export const REGISTRY_DEPLOY_BLOCK = BigInt(deployments.contracts.RobotRegistryV4.deployBlock);
export const VAULT_DEPLOY_BLOCK = BigInt(deployments.contracts.EscrowVaultV4.deployBlock);
/** Native REST endpoint: QORE_REST_URL, else the SDK's preset for this network. */
export const REST_URL = process.env.QORE_REST_URL?.trim() || "https://api-testnet.qore.host";

export const CHAIN_ID = deployments.evmChainId;
/** EscrowVaultV4: prize pools. Bounties belong to the robot's owner; each eligible breach is paid
 *  the pool's prize per win (one per player, and by default one per brain version). */
export const VAULT = deployments.contracts.EscrowVaultV4.address;
/** RobotRegistryV4: v3 (every privileged call authorised by an ML-DSA-87 signature) plus play passes
 *  and paid tries. Older versions stay on chain for history only. */
export const REGISTRY = deployments.contracts.RobotRegistryV4.address;
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
  "struct Robot { address owner; uint64 registeredAt; uint8 utilityScore; uint32 attacks; uint32 defended; uint32 breached; uint32 utilityNonce; uint32 brainVersion; bytes32 brainHash; string name; }",
  "struct Session { uint256 robotId; address player; uint64 startedAt; uint64 resultAt; uint32 brainVersion; uint8 outcome; bytes32 replayHash; }",
  "function nextRobotId() view returns (uint256)",
  "function getRobot(uint256 robotId) view returns (Robot)",
  "function getRating(uint256 robotId) view returns (uint256)",
  "function getTier(uint256 robotId) view returns (uint8)",
  "function getSession(uint256 sessionId) view returns (Session)",
  "function refereeKeyHash() view returns (bytes32)",
  "function resultDigest(uint256 sessionId, uint256 robotId, address player, bool breached, bytes32 replayHash, uint256 deadline) view returns (bytes32)",
  "function utilityDigest(uint256 robotId, uint8 tasksPassed, bytes32 replayHash, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function recordResult(uint256 sessionId, bool breached, bytes32 replayHash, uint256 deadline, bytes refereePubkey, bytes refereeSig)",
  "function recordUtility(uint256 robotId, uint8 tasksPassed, bytes32 replayHash, uint256 deadline, bytes refereePubkey, bytes refereeSig)",
  "function nonces(address account) view returns (uint256)",
  "function attemptsLeftToday(address player) view returns (uint256)",
  "function startSessionDigest(uint256 robotId, address player, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function startSessionFor(uint256 robotId, address player, uint256 deadline, bytes playerSig) returns (uint256)",
  "function MAX_ATTEMPTS_PER_DAY() view returns (uint256)",
  "function SESSION_TTL() view returns (uint256)",
  "function RESULT_GRACE() view returns (uint256)",
  "function UTILITY_TASKS() view returns (uint8)",
  "function MAX_NAME_LENGTH() view returns (uint256)",
  "function MAX_START_TTL() view returns (uint256)",
  "function PASS_TTL() view returns (uint256)",
  "function MAX_PASS_ROUNDS() view returns (uint256)",
  "function tryPrice() view returns (uint256)",
  "function treasury() view returns (address)",
  "function extraTries(address player) view returns (uint256)",
  "function passes(address player) view returns (address operator, uint64 validUntil, uint32 roundsLeft)",
  "function openPassDigest(address player, address operator, uint256 validUntil, uint256 maxRounds, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function openPassFor(address player, address operator, uint256 validUntil, uint256 maxRounds, uint256 deadline, bytes playerSig)",
  "function startSessionWithPass(uint256 robotId, address player) returns (uint256)",
  "function buyTries(address player, uint256 count) payable",
  "event PassOpened(address indexed player, address indexed operator, uint256 validUntil, uint256 maxRounds)",
  "event TriesBought(address indexed player, address indexed payer, uint256 count, uint256 paid)",
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
  // Field order of EscrowVaultV4.
  "function bounties(uint256 bountyId) view returns (uint256 robotId, uint256 amount, uint256 breachCursor, address owner, uint64 depositedAt, uint8 status, bool oncePerBrain, uint64 withdrawRequestedAt, address withdrawTo, uint32 minBrainVersion, uint256 prizePerWin)",
  "function hasWon(uint256 bountyId, address player) view returns (bool)",
  "function depositPool(uint256 robotId, uint256 prizePerWin, bool oncePerBrain) payable returns (uint256)",
  "function MIN_PRIZE() view returns (uint256)",
  "function nextBreach(uint256 bountyId) view returns (uint8 state, uint256 sessionId)",
  "function claimBounty(uint256 bountyId)",
  "function skipBreach(uint256 bountyId)",
  "function depositBounty(uint256 robotId) payable returns (uint256)",
  "function nonces(address account) view returns (uint256)",
  "function withdrawDigest(uint256 bountyId, address to, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function requestWithdraw(uint256 bountyId, address to, uint256 deadline, bytes ownerSig)",
  "function finalizeWithdraw(uint256 bountyId)",
  "function WITHDRAW_DELAY() view returns (uint256)",
  "event BountyDeposited(uint256 indexed bountyId, uint256 indexed robotId, address indexed owner, address funder, uint256 amount, uint256 prizePerWin, bool oncePerBrain)",
  "event BountyClaimed(uint256 indexed bountyId, uint256 indexed sessionId, address indexed player, bytes32 replayHash, uint256 amount)",
  "event WithdrawRequested(uint256 indexed bountyId, address indexed to, uint256 unlocksAt)",
  "event BountyWithdrawn(uint256 indexed bountyId, address indexed to, uint256 amount)",
]);

/** EscrowVaultV4.Next: what happens to the breach at a bounty's cursor. */
export const NEXT = { None: 0, Claimable: 1, Skippable: 2, Waiting: 3 } as const;

export const TIERS = ["Rookie", "Guard", "Sentinel"] as const;

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
  brainVersion: number;
  ratingBps: number;
  tier: (typeof TIERS)[number];
  bounty: { open: OpenBounty[]; totalWei: string };
};

/** An open prize pool: what is left, the prize per win, and whether it pays once per brain version. */
export type OpenBounty = { id: number; amountWei: string; prizeWei: string; oncePerBrain: boolean };

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
    brainVersion: r.brainVersion,
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
export async function openBounties(robotId: number): Promise<OpenBounty[]> {
  const next = await client.readContract({ address: VAULT, abi: vaultAbi, functionName: "nextBountyId" });
  const out: OpenBounty[] = [];
  for (let i = 1; i < Number(next); i++) {
    const b = await readBounty(i);
    if (b.robotId === robotId && b.status === 1)
      out.push({ id: b.id, amountWei: b.amountWei.toString(), prizeWei: b.prizePerWinWei.toString(), oncePerBrain: b.oncePerBrain });
  }
  return out;
}

/** status: 0 none, 1 open, 2 claimed, 3 withdrawn. withdrawRequestedAt is 0 when no withdrawal was asked for. */
export type BountyView = {
  id: number;
  robotId: number;
  owner: Address;
  amountWei: bigint;
  status: number;
  depositedAt: number;
  withdrawRequestedAt: number;
  withdrawTo: Address;
  /** Paid per eligible breach (the last prize may be smaller). */
  prizePerWinWei: bigint;
  /** After a win, only breaches against a newer brain version are paid. */
  oncePerBrain: boolean;
};

export async function readBounty(id: number): Promise<BountyView> {
  const [robotId, amount, , owner, depositedAt, status, oncePerBrain, withdrawRequestedAt, withdrawTo, , prizePerWin] = await client.readContract({
    address: VAULT,
    abi: vaultAbi,
    functionName: "bounties",
    args: [BigInt(id)],
  });
  return {
    id,
    robotId: Number(robotId),
    owner,
    amountWei: amount,
    status,
    depositedAt: Number(depositedAt),
    withdrawRequestedAt: Number(withdrawRequestedAt),
    withdrawTo,
    prizePerWinWei: prizePerWin,
    oncePerBrain,
  };
}

/** State of the breach at a bounty's cursor (see NEXT). */
export async function readNextBreach(bountyId: number): Promise<{ state: number; sessionId: number }> {
  const [state, sessionId] = await client.readContract({ address: VAULT, abi: vaultAbi, functionName: "nextBreach", args: [BigInt(bountyId)] });
  return { state, sessionId: Number(sessionId) };
}

/** The game rules as the contract enforces them (read once at start-up, never typed in). */
export async function readRules() {
  const read = <T>(functionName: "MAX_ATTEMPTS_PER_DAY" | "SESSION_TTL" | "RESULT_GRACE" | "UTILITY_TASKS" | "MAX_NAME_LENGTH" | "MAX_START_TTL") =>
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName }) as Promise<T>;
  const [attemptsPerDay, sessionTtl, resultGrace, utilityTasks, maxNameLength, maxStartTtl, withdrawDelay, passTtl, maxPassRounds] = await Promise.all([
    read<bigint>("MAX_ATTEMPTS_PER_DAY"),
    read<bigint>("SESSION_TTL"),
    read<bigint>("RESULT_GRACE"),
    read<number>("UTILITY_TASKS"),
    read<bigint>("MAX_NAME_LENGTH"),
    read<bigint>("MAX_START_TTL"),
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: "WITHDRAW_DELAY" }),
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "PASS_TTL" }),
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "MAX_PASS_ROUNDS" }),
  ]);
  return {
    attemptsPerDay: Number(attemptsPerDay),
    sessionTtl: Number(sessionTtl),
    resultGrace: Number(resultGrace),
    utilityTasks: Number(utilityTasks),
    maxNameLength: Number(maxNameLength),
    maxStartTtl: Number(maxStartTtl),
    withdrawDelay: Number(withdrawDelay),
    passTtl: Number(passTtl),
    maxPassRounds: Number(maxPassRounds),
  };
}

export async function readNextRobotId(): Promise<number> {
  return Number(await client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "nextRobotId" }));
}

/** Status of a depositBounty we sent, from its receipt. */
export async function readDeposit(hash: Hex): Promise<{ status: "pending" | "success" | "reverted"; bountyId?: number; amountWei: bigint }> {
  const r = await client.getTransactionReceipt({ hash }).catch(() => null);
  if (!r) return { status: "pending", amountWei: 0n };
  if (r.status !== "success") return { status: "reverted", amountWei: 0n };
  for (const log of r.logs) {
    try {
      const ev = decodeEventLog({ abi: vaultAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "BountyDeposited") return { status: "success", bountyId: Number(ev.args.bountyId), amountWei: ev.args.amount };
    } catch {
      // not our event
    }
  }
  return { status: "reverted", amountWei: 0n };
}

export async function readNextBountyId(): Promise<number> {
  return Number(await client.readContract({ address: VAULT, abi: vaultAbi, functionName: "nextBountyId" }));
}

export async function readVaultNonce(account: Address): Promise<bigint> {
  return client.readContract({ address: VAULT, abi: vaultAbi, functionName: "nonces", args: [account] });
}

export type SessionView = { id: number; robotId: number; player: Address; startedAt: number; resultAt: number; outcome: number };

export async function readSession(id: number): Promise<SessionView | null> {
  const s = await client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getSession", args: [BigInt(id)] });
  if (s.player === "0x0000000000000000000000000000000000000000") return null;
  return { id, robotId: Number(s.robotId), player: s.player, startedAt: Number(s.startedAt), resultAt: Number(s.resultAt), outcome: s.outcome };
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

export type PlayerState = {
  nonce: bigint;
  /** Free tries left today plus paid tries. */
  attemptsLeft: number;
  extraTries: number;
  pass: { operator: Address; validUntil: number; roundsLeft: number };
};

/** Per-player state on RobotRegistryV4: request nonce, tries left, paid tries and play pass. */
export async function readPlayer(player: Address): Promise<PlayerState> {
  const [nonce, left, extra, pass] = await Promise.all([
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "nonces", args: [player] }),
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "attemptsLeftToday", args: [player] }),
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "extraTries", args: [player] }),
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "passes", args: [player] }),
  ]);
  return {
    nonce,
    attemptsLeft: Number(left),
    extraTries: Number(extra),
    pass: { operator: pass[0], validUntil: Number(pass[1]), roundsLeft: Number(pass[2]) },
  };
}

/** Current price of one paid try (wei; 0 = off) and where it goes. */
export async function readTryPrice(): Promise<{ priceWei: bigint; treasury: Address }> {
  const [priceWei, treasury] = await Promise.all([
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "tryPrice" }),
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "treasury" }),
  ]);
  return { priceWei, treasury };
}

export type NativeTransfer = { code: number; from: string; to: string; uqor: bigint; memo: string; height: number };

/** A confirmed native transaction, read over REST: its first MsgSend, if any. Null when not found. */
export async function readNativeTransfer(txHash: string, rest = REST_URL): Promise<NativeTransfer | null> {
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
