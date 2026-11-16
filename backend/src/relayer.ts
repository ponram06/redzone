/**
 * Relayer: sends the EVM transactions players and owners cannot send from QoreX yet
 * (startSessionFor, recordResult, claimBounty). Every one of them is authorised by an ML-DSA-87
 * signature checked inside the contract, so the relayer cannot forge or redirect anything.
 *
 * Its EVM window is opened with `allowedTargets` = [RobotRegistryV2, EscrowVault] (chain v3.2.3):
 * even with the relayer's ECDSA key, nothing can be sent anywhere else, and value transfers to
 * those contracts are refused by them. The account should hold only a few QOR for gas.
 *
 * This account must NOT be the Q-Day Drill account (whose window must stay closed).
 */
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner,
  fetchEvmWindow,
  getNetwork,
  isValidRecoveryCode,
  openEvmWindowMsg,
  unifiedAccountFromSeed,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { createWalletClient, http, type Address, type Hex, type Log } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { client, qorechain } from "./chain.js";

export type RelayReceipt = { hash: Hex; status: "success" | "reverted"; logs: Log[] };

export interface Relayer {
  readonly address: Address;
  send(to: Address, data: Hex): Promise<RelayReceipt>;
}

const WINDOW_BLOCKS = 3000n;
const WINDOW_TXS = 40n;
/** Gas cap per relayed transaction; ML-DSA calldata (4.6 KB) plus pqcVerify fits well under it. */
const MAX_GAS = 1_500_000n;
const NATIVE_FEE = { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" };

export class ChainRelayer implements Relayer {
  readonly address: Address;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly net = getNetwork("testnet");

  constructor(
    private readonly acc: UnifiedAccount,
    private readonly privateKey: Hex,
    private readonly targets: Address[],
  ) {
    this.address = privateKeyToAccount(privateKey).address;
  }

  static fromEnv(env: NodeJS.ProcessEnv, targets: Address[]): ChainRelayer | null {
    const key = env.RELAYER_PRIVATE_KEY?.trim();
    const code = env.RELAYER_PQC_RECOVERY_CODE?.trim();
    if (!key || !code) return null;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("RELAYER_PRIVATE_KEY must be 0x + 64 hex characters");
    if (!isValidRecoveryCode(code)) throw new Error("RELAYER_PQC_RECOVERY_CODE is not a valid QRC1 code");
    const acc = unifiedAccountFromSeed(Uint8Array.from(Buffer.from(key.slice(2), "hex")), { recoveryCode: code });
    return new ChainRelayer(acc, key as Hex, targets);
  }

  get cosmosAddress(): string {
    return this.acc.cosmos;
  }

  /** One transaction at a time, so nonces never collide. */
  send(to: Address, data: Hex): Promise<RelayReceipt> {
    if (!this.targets.some((t) => t.toLowerCase() === to.toLowerCase())) {
      return Promise.reject(new Error(`relayer refuses target ${to}`));
    }
    const run = this.queue.then(() => this.sendNow(to, data));
    this.queue = run.catch(() => {});
    return run;
  }

  private async sendNow(to: Address, data: Hex): Promise<RelayReceipt> {
    await this.ensureWindow();
    const wallet = createWalletClient({ account: privateKeyToAccount(this.privateKey), chain: qorechain, transport: http() });
    const estimate = await client.estimateGas({ account: this.address, to, data });
    const gas = (estimate * 13n) / 10n;
    if (gas > MAX_GAS) throw new Error(`relay gas ${gas} above cap`);
    const gasPrice = ((await client.getGasPrice()) * 12n) / 10n;
    const hash = await wallet.sendTransaction({ to, data, gas, gasPrice, type: "legacy" });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 90_000 });
    return { hash, status: receipt.status, logs: receipt.logs };
  }

  /** Open a fresh window, scoped to our contracts, when the current one is missing or nearly used up. */
  private async ensureWindow(): Promise<void> {
    const w = await fetchEvmWindow({ rest: this.net.endpoints.rest, address: this.acc.cosmos });
    const height = await client.getBlockNumber();
    const fresh = w.found && w.live && w.maxTxs - w.usedTxs >= 2n && w.expiryHeight > height + 20n;
    if (fresh) return;
    const gasPrice = await client.getGasPrice();
    const perTxUqor = (MAX_GAS * ((gasPrice * 15n) / 10n)) / 10n ** 12n + 1n;
    const msg = openEvmWindowMsg({
      sender: this.acc.cosmos,
      blocks: WINDOW_BLOCKS,
      maxTxs: WINDOW_TXS,
      maxValue: perTxUqor * WINDOW_TXS,
      allowedTargets: this.targets,
    });
    await this.broadcastNative([msg]);
  }

  private async broadcastNative(messages: Parameters<EthNativeSigner["sign"]>[0]["messages"]): Promise<string> {
    const rest = this.net.endpoints.rest;
    const res = await fetch(`${rest}/cosmos/auth/v1beta1/accounts/${this.acc.cosmos}`);
    if (!res.ok) throw new Error(`relayer account lookup failed: HTTP ${res.status}`);
    const body = (await res.json()) as { account?: Record<string, unknown> };
    const a = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
    const signer = new EthNativeSigner(this.acc, { signMode: "hybrid", rest });
    const transport = await StargateClient.connect(this.net.endpoints.rpc);
    try {
      const r = await signer.signAndBroadcast(transport, {
        chainId: this.net.chainId,
        accountNumber: BigInt(a.account_number ?? "0"),
        sequence: BigInt(a.sequence ?? "0"),
        fee: NATIVE_FEE,
        messages,
      });
      if (r.code !== 0) throw new Error(`window open refused: code ${r.code} ${r.rawLog ?? ""}`);
      // Opening advances the nonce; wait one block so the next EVM tx reads the new one.
      await new Promise((ok) => setTimeout(ok, 6000));
      return r.transactionHash;
    } finally {
      transport.disconnect();
    }
  }
}
