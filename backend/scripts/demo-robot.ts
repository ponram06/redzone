/**
 * demo-robot.ts - put demo robot "Sentinel-01" (rule brain) on the current contracts, owned by the
 * admin account, with a 1 QOR prize pool (0.5 QOR per win) paid exactly the way a maker pays from QoreX:
 *
 *   1. registerRobotFor, authorised by the admin's ML-DSA-87 signature, sent by the relayer
 *   2. a hybrid-signed native transfer of 1 QOR from the admin to the relayer, memo "RedZone bounty #<id> prize 0.5"
 *   3. the relayer locks exactly the unlocked amount with depositPool (the vault makes the admin the owner)
 *
 *   npx tsx --env-file=.env scripts/demo-robot.ts
 *
 * Every step checks the chain first, so running it again never registers or pays twice.
 * Keys come from backend/.env (relayer) and ../contracts/.env (admin) and are never printed.
 */
import { readFileSync } from "node:fs";
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner,
  deriveUnifiedAccount,
  getNetwork,
  isValidRecoveryCode,
  msg as qoreMsg,
  pqcSign,
  pqcVerify,
  unifiedAccountFromSeed,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { decodeEventLog, encodeFunctionData, hexToBytes, toHex, type Address } from "viem";
import { RULE_BRAIN, brainHash } from "../src/brains/registry.js";
import {
  CHAIN_ID,
  REGISTRY,
  REGISTRY_DEPLOY_BLOCK,
  REST_URL,
  VAULT,
  VAULT_DEPLOY_BLOCK,
  client,
  readNativeTransfer,
  readPqcKey,
  readRobots,
  registryAbi,
  vaultAbi,
} from "../src/chain.js";
import { bountyMemo, parseBountyMemo } from "../src/game.js";
import { ChainLedger } from "../src/ledger.js";
import { ChainRelayer } from "../src/relayer.js";
import { registerRobotDigest } from "../src/signer.js";

const NAME = "Sentinel-01";
const BOUNTY_UQOR = 1_000_000n;
const WEI_PER_UQOR = 10n ** 12n;
const FEE = { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" };

/** KEY=value lines of an env file, without touching process.env. */
function readEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

/** The admin account, loaded the same way as contracts/scripts/window.ts. */
async function adminAccount(): Promise<UnifiedAccount> {
  const env = readEnv(new URL("../../contracts/.env", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  if (env.QORE_MNEMONIC?.trim()) return deriveUnifiedAccount(env.QORE_MNEMONIC.trim(), 0);
  const key = env.PRIVATE_KEY?.trim() ?? "";
  const code = env.QORE_PQC_RECOVERY_CODE?.trim() ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(key) || !isValidRecoveryCode(code)) throw new Error("admin key missing in contracts/.env");
  return unifiedAccountFromSeed(Uint8Array.from(Buffer.from(key.slice(2), "hex")), { recoveryCode: code });
}

const deployments = JSON.parse(readFileSync(new URL("../../deployments/testnet.json", import.meta.url), "utf8")) as { deployer: { evm: string } };
const admin = await adminAccount();
if (admin.evm.toLowerCase() !== deployments.deployer.evm.toLowerCase()) throw new Error("contracts/.env is not the admin account");
const relayer = ChainRelayer.fromEnv(process.env, [REGISTRY, VAULT]);
if (!relayer) throw new Error("relayer keys missing in backend/.env");
const owner = admin.evm as Address;
const brain = brainHash(RULE_BRAIN);
console.log(`admin ${owner} (${admin.cosmos}); relayer ${relayer.address} (${relayer.cosmosAddress})`);
console.log(`brain ${brain} (rule)`);

// 1. The robot.
let robotId = (await readRobots()).find((r) => r.owner.toLowerCase() === owner.toLowerCase() && r.name === NAME)?.id;
if (robotId) {
  console.log(`1. robot #${robotId} already registered`);
} else {
  const nonce = await client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "nonces", args: [owner] });
  const deadline = (await client.getBlock()).timestamp + 600n;
  const digest = registerRobotDigest(CHAIN_ID, REGISTRY, owner, NAME, brain, nonce, deadline);
  const sig = pqcSign(admin.pqc.secretKey, hexToBytes(digest));
  // Same check the contract makes, against the key registered on chain, before any gas is spent.
  const onChain = await readPqcKey(owner);
  if (!onChain.registered || !pqcVerify(hexToBytes(onChain.pubkey), hexToBytes(digest), sig)) throw new Error("admin ML-DSA key does not match the chain");
  const r = await relayer.send(
    REGISTRY,
    encodeFunctionData({ abi: registryAbi, functionName: "registerRobotFor", args: [owner, NAME, brain, deadline, toHex(sig)] }),
  );
  if (r.status !== "success") throw new Error(`registerRobotFor reverted (${r.hash})`);
  for (const log of r.logs) {
    try {
      const ev = decodeEventLog({ abi: registryAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "RobotRegistered") robotId = Number(ev.args.robotId);
    } catch {
      // not our event
    }
  }
  if (!robotId) throw new Error(`no RobotRegistered event (${r.hash})`);
  console.log(`1. registered robot #${robotId}: ${r.hash}`);
}

// 2. The payment, from the chain's own records.
const ledger = new ChainLedger(client, REGISTRY, REGISTRY_DEPLOY_BLOCK, VAULT, VAULT_DEPLOY_BLOCK, REST_URL);
const memo = `${bountyMemo(robotId)} prize 0.5`;
const terms = parseBountyMemo(memo, robotId)!;
const paidUqor = async () =>
  (await ledger.transfers(admin.cosmos, relayer.cosmosAddress))
    .filter((t) => t.height >= Number(VAULT_DEPLOY_BLOCK) && t.memo.trim() === memo) // payments locked in older vaults don't count
    .reduce((s, t) => s + t.uqor, 0n);
let paid = await paidUqor();
if (paid >= BOUNTY_UQOR) {
  console.log(`2. already paid ${paid} uqor with memo "${memo}"`);
} else {
  const net = getNetwork("testnet");
  const res = await fetch(`${REST_URL}/cosmos/auth/v1beta1/accounts/${admin.cosmos}`);
  const body = (await res.json()) as { account?: Record<string, unknown> };
  const a = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
  const transport = await StargateClient.connect(net.endpoints.rpc);
  let hash: string;
  try {
    const r = await new EthNativeSigner(admin, { signMode: "hybrid", rest: REST_URL }).signAndBroadcast(transport, {
      chainId: net.chainId,
      accountNumber: BigInt(a.account_number ?? "0"),
      sequence: BigInt(a.sequence ?? "0"),
      fee: FEE,
      memo,
      messages: [qoreMsg.bank.send({ fromAddress: admin.cosmos, toAddress: relayer.cosmosAddress, amount: [{ denom: "uqor", amount: (BOUNTY_UQOR - paid).toString() }] })],
    });
    if (r.code !== 0) throw new Error(`payment refused: code ${r.code} ${r.rawLog ?? ""}`);
    hash = r.transactionHash;
  } finally {
    transport.disconnect();
  }
  console.log(`2. paid ${BOUNTY_UQOR - paid} uqor to the relayer: ${hash}`);
  for (let i = 0; i < 20 && (paid = await paidUqor()) < BOUNTY_UQOR; i++) await new Promise((ok) => setTimeout(ok, 3000));
  const t = await readNativeTransfer(hash);
  if (!t || t.code !== 0 || paid < BOUNTY_UQOR) throw new Error("payment not indexed yet: run the script again in a minute");
}

// 3. Lock what was paid and not yet locked.
await ledger.sync();
const locked = ledger
  .deposits()
  .filter((d) => d.robotId === robotId && d.funder.toLowerCase() === relayer.address.toLowerCase())
  .reduce((s, d) => s + d.amountWei / WEI_PER_UQOR, 0n);
const missing = paid - locked;
if (missing <= 0n) {
  console.log(`3. already locked ${locked} uqor for robot #${robotId}`);
} else {
  const prize = terms.prizeUqor! < missing ? terms.prizeUqor! : missing;
  const data = encodeFunctionData({ abi: vaultAbi, functionName: "depositPool", args: [BigInt(robotId), prize * WEI_PER_UQOR, terms.oncePerBrain] });
  const r = await relayer.send(VAULT, data, missing * WEI_PER_UQOR);
  if (r.status !== "success") throw new Error(`depositPool reverted (${r.hash})`);
  console.log(`3. locked ${missing} uqor for robot #${robotId}: ${r.hash}`);
}
