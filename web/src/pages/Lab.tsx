import { useEffect, useState } from "react";
import { api, type LabState } from "../api";

/**
 * Q-Day Lab: a funded bait account whose classical ECDSA key is published, as if a quantum computer had
 * cracked it. Our bot attacks it every hour with that key; anyone can try the same.
 */

/** Attack runs listed before "Show all": the newest ones. */
const LOG_SHOWN = 8;
const REPO = "https://github.com/ponram06/redzone/blob/main";
const qor = (uqor: string | bigint) => (Number(BigInt(uqor)) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 });

export function Lab() {
  const [s, setS] = useState<LabState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [allRuns, setAllRuns] = useState(false);

  useEffect(() => {
    const load = () =>
      api
        .lab()
        .then((x) => (setS(x), setError(null)))
        .catch((e: Error) => setError(e.message));
    load();
    const a = setInterval(load, 60_000);
    const b = setInterval(() => setNow(Date.now()), 1000);
    return () => (clearInterval(a), clearInterval(b));
  }, []);

  const copy = () =>
    s &&
    navigator.clipboard
      ?.writeText(s.ecdsaPrivateKey)
      .then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))
      .catch(() => {});

  const runs = s?.runs.filter((r) => !r.skipped) ?? [];
  const first = runs[runs.length - 1];
  const lost = first ? BigInt(first.balanceBefore) - BigInt(s!.balanceUqor) : 0n;
  const next = s?.nextAt ? Math.max(0, Math.round((s.nextAt - now) / 1000)) : null;

  return (
    <div className="vf lab">
      <section className="vf-hero">
        <p className="rp-kicker">
          <span className="rp-rule" /> Q-Day Lab · live
        </p>
        <h1 className="vf-title">
          Steal this QOR<span className="red">.</span>
        </h1>
        <p className="lead">
          Every RedZone prize, a player's winnings and a robot maker's bounty, is QOR held by a QoreChain account. Here is one such account with its{" "}
          <strong>classical ECDSA private key published</strong>, as if a quantum computer had already cracked it. Every {s?.everyMinutes ?? 60} minutes
          our bot uses that key to try to take the QOR, and you can try too. The account also has an ML-DSA-87 key that stays secret, and QoreChain asks
          for both, the same protection RedZone's players and makers get.
        </p>
      </section>

      {error && <p className="note warn-text">The lab could not be loaded: {error}</p>}

      {s && (
        <>
          <div className="lab-stats">
            <div className="panel">
              <span className="rp-label">In the account</span>
              <b className="gold">{qor(s.balanceUqor)} QOR</b>
            </div>
            <div className="panel">
              <span className="rp-label">Attacks blocked</span>
              <b>
                {s.totals.blocked}/{s.totals.attempts}
              </b>
            </div>
            <div className="panel">
              <span className="rp-label">QOR stolen</span>
              <b className={lost > 0n ? "red" : "ok-text"}>{qor(lost > 0n ? lost : 0n)}</b>
            </div>
            <div className="panel">
              <span className="rp-label">Next attack</span>
              <b>{next === null ? "–" : next === 0 ? "now" : `${Math.floor(next / 60)}:${String(next % 60).padStart(2, "0")}`}</b>
            </div>
          </div>

          <div className="vf-grid">
            <section className="panel">
              <h2>The leaked key</h2>
              <dl className="vf-dl">
                <dt>Account</dt>
                <dd>
                  <code>{s.cosmos}</code>
                </dd>
                <dt>EVM address</dt>
                <dd>
                  <code>{s.evm}</code>
                </dd>
                <dt>ECDSA key</dt>
                <dd>
                  <code className="lab-key">{s.ecdsaPrivateKey}</code>{" "}
                  <button className="btn small" onClick={copy}>
                    {copied ? "Copied" : "Copy"}
                  </button>
                </dd>
                <dt>ML-DSA-87 key</dt>
                <dd>{s.pqcRegistered ? <span className="badge ok">Registered, secret</span> : <span className="badge danger">Not registered yet</span>}</dd>
              </dl>
              <p className="note">
                Testnet QOR only. If you manage to move it, it's yours, and you've found a real bug: please tell us.
              </p>
            </section>

            <section className="panel">
              <h2>Why it holds</h2>
              <ul className="lab-why">
                <li>
                  The account has registered an ML-DSA-87 key, so the chain refuses any native transaction that is not also signed with it (PQC code 20).
                </li>
                <li>A made-up ML-DSA key fails the check against the registered one (code 21), and a new key can't replace it without the old one.</li>
                <li>
                  The EVM side only takes transactions inside a window, and opening a window is itself hybrid-signed. This account never opens one.
                </li>
                <li>The ML-DSA key comes from a separate recovery code that is not on our server, so even our own bot has only the leaked key.</li>
              </ul>
            </section>
          </div>

          <section className="panel lab-log">
            <h2>Attack log</h2>
            {s.runs.length === 0 && <p className="note">The first attack runs a minute after the server starts.</p>}
            {(allRuns ? s.runs : s.runs.slice(0, LOG_SHOWN)).map((r) => (
              <details key={r.at} open={r === s.runs[0]}>
                <summary>
                  <span>{new Date(r.at * 1000).toLocaleString()}</span>
                  {r.skipped ? (
                    <span className="note">{r.skipped}</span>
                  ) : (
                    <span className={r.attempts.every((a) => a.blocked) ? "ok-text" : "red"}>
                      {r.attempts.filter((a) => a.blocked).length}/{r.attempts.length} blocked · balance {qor(r.balanceBefore)} → {qor(r.balanceAfter)} QOR
                    </span>
                  )}
                </summary>
                <ul className="vf-tries">
                  {r.attempts.map((a) => (
                    <li key={a.attack} className={a.blocked ? "good" : "bad"}>
                      <strong>{a.blocked ? "✓ Blocked" : "✗ Went through"}</strong> {a.attack}
                      <span>{a.detail}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
            {!allRuns && s.runs.length > LOG_SHOWN && (
              <button className="btn lab-more" onClick={() => setAllRuns(true)}>
                Show all {s.runs.length} attack runs
              </button>
            )}
          </section>

          <section className="vf-how">
            <h2>Try it yourself</h2>
            <pre className="lab-code">{`// Node, with viem: send the QOR using only the leaked key
import { createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
const chain = { id: 9800, name: "QoreChain testnet", nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: ["https://evm-testnet.qore.host"] } } };
const w = createWalletClient({ chain, account: privateKeyToAccount("${s.ecdsaPrivateKey}"), transport: http() });
await w.sendTransaction({ to: "0xYourAddress", value: parseEther("1") });`}</pre>
            <p>
              Bot code: <a href={`${REPO}/backend/src/qdaylab.ts`}>backend/src/qdaylab.ts</a> · first drill and its threat model:{" "}
              <a href={`${REPO}/docs/QDAY_DRILL.md`}>docs/QDAY_DRILL.md</a>
            </p>
          </section>
        </>
      )}
    </div>
  );
}
