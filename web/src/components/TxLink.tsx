import { useState } from "react";
import { API_URL } from "../api";
import { shortHash } from "../format";

/**
 * A transaction hash a player can verify. With a block explorer it links there. Without one (the
 * testnet has none yet) it offers the full hash to copy and, for RedZone's EVM transactions, a
 * "check" link to the chain's own receipt (with the public RPC to repeat the check yourself).
 * evm: false for native QoreX payments (sign-up, tries, bounty payments), which have no EVM receipt.
 */
export function TxLink({ hash, explorer, evm = true }: { hash: string; explorer: string | null; evm?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard
      ?.writeText(hash)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  if (explorer) {
    return (
      <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer" title={hash}>
        {shortHash(hash)} ↗
      </a>
    );
  }
  return (
    <span className="txlink">
      <code title={hash}>{shortHash(hash)}</code>
      <button type="button" className="linkish" onClick={copy} aria-label={`Copy transaction ${hash}`}>
        {copied ? "copied" : "copy"}
      </button>
      {evm && /^0x[0-9a-fA-F]{64}$/.test(hash) && (
        <a href={`${API_URL}/tx/${hash}`} target="_blank" rel="noreferrer" title="The chain's receipt for this transaction">
          check ↗
        </a>
      )}
    </span>
  );
}
