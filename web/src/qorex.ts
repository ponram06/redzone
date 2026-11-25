/**
 * Minimal QoreX wallet access: window.qorex, injected by the QoreX browser extension (desktop) and by the
 * dApp browser inside the QoreX phone app. Both give the same native provider, except that the app has
 * no listAccounts(); getKey() returns the active account in both.
 */

/** The native chain id QoreX signs for. Set from the server's /health (deployment record) on load. */
let NATIVE_CHAIN_ID = "";
export function setNativeChainId(id: string) {
  NATIVE_CHAIN_ID = id;
}
function chainId(): string {
  if (!NATIVE_CHAIN_ID) throw new Error("Still connecting to RedZone, try again in a moment.");
  return NATIVE_CHAIN_ID;
}

type QorexNative = {
  enable(chainId: string): Promise<unknown>;
  listAccounts?(): Promise<{ accounts: { address: string; label?: string }[]; activeIndex: number }>;
  getKey(chainId: string): Promise<{ bech32Address: string }>;
  signArbitrary(chainId: string, signer: string, data: string): Promise<{ signatureType?: string; pq?: { algorithmId: number | string; signature: string } }>;
};

declare global {
  interface Window {
    qorex?: { native?: QorexNative };
  }
}

export function hasQorex(): boolean {
  return !!window.qorex?.native;
}

function native(): QorexNative {
  const n = window.qorex?.native;
  if (!n) throw new Error("QoreX is not installed in this browser");
  return n;
}

/** Ask QoreX for access and return the active qor1… address. */
export async function connect(): Promise<string> {
  const n = native();
  await n.enable(chainId());
  if (typeof n.listAccounts === "function") {
    const { accounts, activeIndex } = await n.listAccounts();
    const acc = accounts[activeIndex] ?? accounts[0];
    if (acc) return acc.address;
  }
  // The QoreX app's dApp browser: getKey is the active account.
  const key = await n.getKey(chainId());
  if (!key?.bech32Address) throw new Error("QoreX has no account");
  return key.bech32Address;
}

const isLocked = (e: unknown) => /locked/i.test((e as Error)?.message ?? String(e));

/**
 * QoreX keeps its unlocked state in memory only: it locks itself after its auto-lock time, and
 * also whenever Chrome stops its idle background worker. Its signing calls then fail with "wallet
 * is locked" instead of asking. enable() is the call that shows QoreX's unlock window (and does
 * nothing when it's already unlocked), so run it first, and once more if signing still says locked.
 */
async function withUnlocked<T>(fn: () => Promise<T>): Promise<T> {
  await native().enable(chainId());
  try {
    return await fn();
  } catch (e) {
    if (!isLocked(e)) throw e;
    await native().enable(chainId());
    return fn();
  }
}

/** Sign text with the account's ML-DSA-87 key; returns the post-quantum signature (base64). */
export async function signPq(address: string, text: string): Promise<string> {
  const r = await withUnlocked(() => native().signArbitrary(chainId(), address, text));
  // The server checks this signature against the ML-DSA-87 key registered on chain.
  if (!r.pq?.signature || (r.signatureType && r.signatureType !== "ml-dsa-87-hybrid")) {
    throw new Error("QoreX did not return an ML-DSA-87 signature (is the account's PQC key registered?)");
  }
  return r.pq.signature;
}

/** Friendlier messages for the errors people actually hit. */
export function explainQorexError(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  if (/locked/i.test(m)) return "QoreX locked itself. Unlock QoreX (the icon in your browser bar, or the QoreX app), then try again.";
  if (/does not match the active network|mismatch/i.test(m))
    return `Switch QoreX to the testnet (${NATIVE_CHAIN_ID}) and try again. In the QoreX app: Settings, then Use testnet.`;
  if (/reject|denied|cancel/i.test(m)) return "You cancelled the request in QoreX.";
  return m;
}

// --- one-time sign-up payment (native MsgSend, hybrid-signed by QoreX) ---

const enc = new TextEncoder();

function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

/** Protobuf length-delimited field. */
function field(no: number, bytes: Uint8Array): number[] {
  return [...varint((no << 3) | 2), ...varint(bytes.length), ...bytes];
}

/** cosmos.bank.v1beta1.MsgSend { from_address = 1; to_address = 2; repeated Coin amount = 3 } */
export function encodeMsgSend(from: string, to: string, uqor: string): Uint8Array {
  const coin = new Uint8Array([...field(1, enc.encode("uqor")), ...field(2, enc.encode(uqor))]);
  return new Uint8Array([...field(1, enc.encode(from)), ...field(2, enc.encode(to)), ...field(3, coin)]);
}

type BroadcastResult = { txHash: string; code: number };

/** Send `uqor` to `to` with a memo; QoreX shows the transfer and signs it with the PQC layer. */
export async function payNative(from: string, to: string, uqor: string, memo: string): Promise<string> {
  const n = (window.qorex?.native ?? null) as unknown as {
    signAndBroadcast(p: { chainId: string; messages: { typeUrl: string; value: Uint8Array }[]; memo: string }): Promise<BroadcastResult>;
  } | null;
  if (!n) throw new Error("QoreX is not installed in this browser");
  const r = await withUnlocked(() =>
    n.signAndBroadcast({
      chainId: chainId(),
      messages: [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: encodeMsgSend(from, to, uqor) }],
      memo,
    }),
  );
  if (r.code !== 0) throw new Error(`The payment failed on chain (code ${r.code})`);
  return r.txHash;
}
