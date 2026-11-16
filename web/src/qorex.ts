/** Minimal QoreX wallet access (window.qorex, injected by the QoreX extension). */

export const NATIVE_CHAIN_ID = "qorechain-diana";

type QorexNative = {
  enable(chainId: string): Promise<unknown>;
  listAccounts(): Promise<{ accounts: { address: string; label?: string }[]; activeIndex: number }>;
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
  await n.enable(NATIVE_CHAIN_ID);
  const { accounts, activeIndex } = await n.listAccounts();
  const acc = accounts[activeIndex] ?? accounts[0];
  if (!acc) throw new Error("QoreX has no account");
  return acc.address;
}

/** Sign text with the account's ML-DSA-87 key; returns the post-quantum signature (base64). */
export async function signPq(address: string, text: string): Promise<string> {
  const r = await native().signArbitrary(NATIVE_CHAIN_ID, address, text);
  if (r.signatureType !== "ml-dsa-87-hybrid" || !r.pq?.signature) {
    throw new Error("QoreX did not return an ML-DSA-87 signature (is the account's PQC key registered?)");
  }
  return r.pq.signature;
}

/** Friendlier messages for the errors people actually hit. */
export function explainQorexError(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  if (/locked/i.test(m)) return "QoreX is locked. Unlock it and try again.";
  if (/does not match the active network/i.test(m)) return "Switch QoreX to the testnet (qorechain-diana) and try again.";
  if (/reject|denied|cancel/i.test(m)) return "You cancelled the request in QoreX.";
  return m;
}
