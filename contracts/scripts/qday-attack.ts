/**
 * qday-attack.ts - rehearse the Q-Day Drill against our own drill account.
 *
 * Plays an attacker who has ONLY the account's classical ECDSA key (PRIVATE_KEY). It never reads
 * QORE_PQC_RECOVERY_CODE or the referee key. Every attack should be refused.
 *
 *   npm run attack
 *
 * Funds an attack could move go to the attacker's own address, i.e. back to the drill account,
 * so a successful attack shows up without losing value.
 */
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner,
  msg,
  buildRegisterPqcKeyMsg,
  closeEvmWindowMsg,
  generatePqcKeypair,
  generatePqcRecoveryCode,
  openEvmWindowMsg,
  signProofOfPossession,
  unifiedAccountFromSeed,
} from "@qorechain/sdk";
import { createPublicClient, createWalletClient, http, parseEther, encodeFunctionData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import deployments from "../../deployments/testnet.json" with { type: "json" };

const REST = "https://api-testnet.qore.host";
const RPC = "https://rpc-testnet.qore.host";
const EVM = "https://evm-testnet.qore.host";
const CHAIN_ID = "qorechain-diana";
const FEE = { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" };

const pk = process.env.PRIVATE_KEY as Hex;
if (!pk) throw new Error("PRIVATE_KEY missing");
// The attacker does not know the real ML-DSA key; it can only bring its own.
const attacker = unifiedAccountFromSeed(Buffer.from(pk.slice(2), "hex"), { recoveryCode: generatePqcRecoveryCode() });
const evmAcc = privateKeyToAccount(pk);
const chain = { id: 9800, name: "qorechain-diana", nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 }, rpcUrls: { default: { http: [EVM] } } } as const;
const pub = createPublicClient({ chain, transport: http(EVM) });
const wallet = createWalletClient({ chain, account: evmAcc, transport: http(EVM) });
const VAULT = deployments.contracts.EscrowVault.address as Hex;
const REGISTRY = deployments.contracts.RobotRegistry.address as Hex;

type Result = { attack: string; blocked: boolean; detail: string };
const results: Result[] = [];

async function attempt(attack: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detail = await fn();
    results.push({ attack, blocked: false, detail });
  } catch (e) {
    const msg = (e as Error).message.replace(/\s+/g, " ");
    const short = (msg.match(/(reason|Details|message|raw_log|error)[^.]{0,160}/i)?.[0] ?? msg).slice(0, 170);
    results.push({ attack, blocked: true, detail: short });
  }
}

async function nativeTx(mode: "hybrid" | "classical", messages: Parameters<EthNativeSigner["sign"]>[0]["messages"]): Promise<string> {
  const res = await fetch(`${REST}/cosmos/auth/v1beta1/accounts/${attacker.cosmos}`);
  const body = (await res.json()) as { account?: Record<string, unknown> };
  const a = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
  const signer = new EthNativeSigner(attacker, { signMode: mode, rest: REST });
  const transport = await StargateClient.connect(RPC);
  try {
    const r = await signer.signAndBroadcast(transport, {
      chainId: CHAIN_ID,
      accountNumber: BigInt(a.account_number ?? "0"),
      sequence: BigInt(a.sequence ?? "0"),
      fee: FEE,
      messages,
    });
    if (r.code !== 0) throw new Error(`code ${r.code}: ${r.rawLog ?? ""}`);
    return `tx ${r.transactionHash}`;
  } finally {
    transport.disconnect();
  }
}

const send = () => msg.bank.send({ fromAddress: attacker.cosmos, toAddress: attacker.cosmos, amount: [{ denom: "uqor", amount: "100000" }] });

/** eth_call as the drill account: shows whether the contract would let the call through. */
async function evmCall(abi: string, fn: string, args: unknown[], value = 0n): Promise<string> {
  const { parseAbi } = await import("viem");
  const parsed = parseAbi([abi]);
  const to = abi.includes("Bounty") ? VAULT : abi.includes("Brain") || abi.includes("Robot") ? REGISTRY : VAULT;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = encodeFunctionData({ abi: parsed, functionName: fn, args } as any);
  await pub.call({ account: evmAcc.address, to, data, value });
  return "eth_call succeeded";
}

const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
const junk = ("0x" + "11".repeat(4627)) as Hex; // ML-DSA-87 signature length, wrong content

console.log(`attacker controls ECDSA key of ${attacker.cosmos} (${evmAcc.address})\n`);

// --- native lane -------------------------------------------------------------
await attempt("Native transfer, classical signature only", () => nativeTx("classical", [send()]));
await attempt("Native transfer, hybrid with attacker's own ML-DSA key", () => nativeTx("hybrid", [send()]));
await attempt("Open EVM window, classical signature only", () =>
  nativeTx("classical", [openEvmWindowMsg({ sender: attacker.cosmos, blocks: 600n, maxTxs: 5n, maxValue: 5_000_000n })]));
await attempt("Open EVM window, hybrid with attacker's own ML-DSA key", () =>
  nativeTx("hybrid", [openEvmWindowMsg({ sender: attacker.cosmos, blocks: 600n, maxTxs: 5n, maxValue: 5_000_000n })]));
await attempt("Re-register a new ML-DSA key (classical, key takeover)", () => {
  const kp = generatePqcKeypair();
  const pop = signProofOfPossession({ chainId: CHAIN_ID, account: attacker.cosmos, keypair: kp });
  return nativeTx("classical", [buildRegisterPqcKeyMsg(attacker.cosmos, { pqcKeypair: kp, proofOfPossession: pop })]);
});
await attempt("Close the owner's EVM window (classical, denial of service)", () =>
  nativeTx("classical", [closeEvmWindowMsg(attacker.cosmos)]));

// --- EVM lane, no open window -------------------------------------------------
await attempt("EVM transfer 0.01 QOR (no window open)", async () =>
  `tx ${await wallet.sendTransaction({ to: evmAcc.address, value: parseEther("0.01") })}`);
await attempt("EVM depositBounty 0.01 QOR (no window open)", async () =>
  `tx ${await wallet.sendTransaction({ to: VAULT, value: parseEther("0.01"), data: encodeFunctionData({ abi: [{ type: "function", name: "depositBounty", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }], stateMutability: "payable" }], functionName: "depositBounty", args: [("0x" + "00".repeat(32)) as Hex] }) })}`);

// --- contract drain calls, as if a window were open (eth_call) -----------------
await attempt("Vault: withdrawBounty(1) to attacker, empty ML-DSA sig", () =>
  evmCall("function withdrawBounty(uint256,address,uint256,bytes)", "withdrawBounty", [1n, evmAcc.address, deadline, "0x"]));
await attempt("Vault: withdrawBounty(1) with forged 4627-byte sig", () =>
  evmCall("function withdrawBounty(uint256,address,uint256,bytes)", "withdrawBounty", [1n, evmAcc.address, deadline, junk]));
await attempt("Vault: claimBounty(1) to attacker, forged referee sig", () =>
  evmCall("function claimBounty(uint256,address,bytes32,uint256,bytes)", "claimBounty", [1n, evmAcc.address, ("0x" + "00".repeat(32)) as Hex, deadline, junk]));
await attempt("Vault: setReferee to attacker key", () =>
  evmCall("function setReferee(bytes,uint256,bytes)", "setReferee", [("0x" + "22".repeat(2592)) as Hex, deadline, junk]));
await attempt("Vault: transferAdmin to attacker", () =>
  evmCall("function transferAdmin(address,uint256,bytes)", "transferAdmin", [evmAcc.address, deadline, junk]));
await attempt("Vault: setPaused(true) (freeze claims)", () =>
  evmCall("function setPaused(bool,uint256,bytes)", "setPaused", [true, deadline, junk]));
await attempt("Vault: plain QOR transfer into vault", async () => {
  await pub.call({ account: evmAcc.address, to: VAULT, value: 1n });
  return "eth_call succeeded";
});
await attempt("Registry: updateBrain(1) to a weak brain", () =>
  evmCall("function updateBrain(uint256,bytes32,uint256,bytes)", "updateBrain", [1n, ("0x" + "33".repeat(32)) as Hex, deadline, junk]));
await attempt("Registry: recordResult forged 'defended' (rating farming)", () =>
  evmCall("function recordResult(uint256,bool,bytes32,uint256,bytes)", "recordResult", [1n, false, ("0x" + "00".repeat(32)) as Hex, deadline, junk]));

// --- report --------------------------------------------------------------------
const blocked = results.filter((r) => r.blocked).length;
for (const r of results) console.log(`${r.blocked ? "BLOCKED " : "SUCCEEDED"}  ${r.attack}\n           ${r.detail}`);
console.log(`\n${blocked}/${results.length} attacks blocked`);
