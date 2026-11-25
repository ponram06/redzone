import { Fragment, useEffect, useState } from "react";
import { api, type ActivityRow } from "../api";
import { TxLink } from "../components/TxLink";
import { useData } from "../data";
import { CHAIN, checkRound, formatWei, hashReplay, mldsaVerify, resultDigest, type Evidence, type StepId, type StepState } from "../verify";

/**
 * Verify a round: repeats the chain's referee checks in the browser, reading the chain directly,
 * so a player or bounty owner can confirm a verdict and its payout without trusting RedZone.
 */

const STEPS: [StepId, string][] = [
  ["round", "Round on chain"],
  ["tx", "Referee's transaction"],
  ["key", "Referee key"],
  ["digest", "What was signed"],
  ["signature", "ML-DSA-87 signature"],
  ["replay", "Replay matches"],
  ["payout", "Payout"],
];

const REPO = "https://github.com/ponram06/redzone/blob/main";

type Tamper = { label: string; detail: string; ok: boolean };

export function Verify({ id }: { id?: number }) {
  const { health } = useData();
  const [input, setInput] = useState(id ? String(id) : "");
  const [steps, setSteps] = useState<Partial<Record<StepId, StepState>>>({});
  const [ev, setEv] = useState<Evidence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<ActivityRow[]>([]);
  const [tampers, setTampers] = useState<Tamper[]>([]);

  useEffect(() => {
    api.activity().then((r) => setRecent(r.slice(0, 6))).catch(() => {});
  }, []);

  useEffect(() => {
    if (!id) return;
    let live = true;
    setSteps({});
    setEv(null);
    setError(null);
    setTampers([]);
    setBusy(true);
    checkRound(id, (s, state) => live && setSteps((prev) => ({ ...prev, [s]: state })))
      .then((e) => live && setEv(e))
      .catch((e: Error) => live && setError(`The chain could not be read: ${e.message.split("\n")[0]}`))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [id]);

  const go = (e: React.FormEvent) => {
    e.preventDefault();
    const n = Number(input);
    if (Number.isSafeInteger(n) && n > 0) location.hash = `#/verify/${n}`;
  };

  const flipVerdict = () => {
    if (!ev) return;
    const d = resultDigest(ev.sessionId, ev.robotId, ev.player, !ev.breached, ev.replayHash, ev.deadline);
    const ok = mldsaVerify(ev.publicKey, d, ev.signature);
    add({ label: `Claim it was ${ev.breached ? "DEFENDED" : "BREACHED"}`, detail: `New digest ${d.slice(0, 10)}…, same signature`, ok });
  };
  const editInstruction = () => {
    if (!ev?.replay) return;
    const forged = { ...ev.replay, instruction: `${ev.replay.instruction ?? ""}!` };
    const h = hashReplay(forged);
    const ok = h === ev.replayHash && mldsaVerify(ev.publicKey, resultDigest(ev.sessionId, ev.robotId, ev.player, ev.breached, h, ev.deadline), ev.signature);
    add({ label: "Add one character to the instruction", detail: `Replay hash becomes ${h.slice(0, 10)}…, not the signed ${ev.replayHash.slice(0, 10)}…`, ok });
  };
  const otherPlayer = () => {
    if (!ev) return;
    const thief = "0x000000000000000000000000000000000000dEaD" as const;
    const ok = mldsaVerify(ev.publicKey, resultDigest(ev.sessionId, ev.robotId, thief, ev.breached, ev.replayHash, ev.deadline), ev.signature);
    add({ label: "Pay the win to another address", detail: `Player swapped for ${thief.slice(0, 10)}…`, ok });
  };
  const add = (t: Tamper) => setTampers((prev) => [t, ...prev].slice(0, 6));

  const allOk = !!ev && STEPS.every(([s]) => steps[s]?.status !== "fail");
  const explorer = health?.explorerUrl ?? null;

  return (
    <div className="vf">
      <section className="vf-hero">
        <p className="rp-kicker">
          <span className="rp-rule" /> Verify a round
        </p>
        <h1 className="vf-title">
          Don't trust us<span className="red">.</span> Check it.
        </h1>
        <p className="lead">
          Every verdict is signed with the referee's post-quantum ML-DSA-87 key, and the contract refuses any result or payout without it. This page
          repeats those checks <strong>in your browser</strong>, reading the chain straight from QoreChain's public RPC, not from our server.
        </p>
        <form className="vf-form" onSubmit={go}>
          <label htmlFor="vf-round">Round #</label>
          <input id="vf-round" inputMode="numeric" value={input} onChange={(e) => setInput(e.target.value.replace(/\D/g, ""))} placeholder="14" />
          <button className="btn primary" disabled={!input || busy}>
            {busy ? "Checking…" : "Check"}
          </button>
        </form>
        {recent.length > 0 && (
          <p className="vf-recent">
            Recent rounds:{" "}
            {recent.map((r) => (
              <a key={r.sessionId} href={`#/verify/${r.sessionId}`} className={`vf-chip ${r.breached ? "bad" : "good"}`}>
                #{r.sessionId} {r.robot} · {r.breached ? "breached" : "defended"}
              </a>
            ))}
          </p>
        )}
      </section>

      {id && (
        <section className="panel vf-steps" aria-live="polite">
          <ol>
            {STEPS.map(([s, title]) => {
              const st = steps[s];
              return (
                <li key={s} className={`vf-step ${st?.status ?? "wait"}`}>
                  <span className="vf-mark" aria-hidden="true">
                    {st?.status === "ok" ? "✓" : st?.status === "fail" ? "✗" : st?.status === "running" ? "…" : st?.status === "none" ? "–" : "·"}
                  </span>
                  <div>
                    <strong>{title}</strong>
                    <span>{st?.text ?? "Waiting"}</span>
                  </div>
                </li>
              );
            })}
          </ol>
          {error && <p className="note warn-text">{error}</p>}
          {ev && allOk && (
            <p className="vf-verdict">
              ✓ Round #{id}'s verdict was signed by the referee's ML-DSA-87 key{ev.payouts.length ? " and its prize was paid to the player who won it" : ""}.
            </p>
          )}
        </section>
      )}

      {ev && (
        <div className="vf-grid">
          <section className="panel">
            <h2>What was judged</h2>
            <dl className="vf-dl">
              {ev.replay?.instruction !== undefined && (
                <>
                  <dt>Instruction</dt>
                  <dd>
                    <q>{ev.replay.instruction}</q>
                  </dd>
                </>
              )}
              <dt>Verdict</dt>
              <dd>
                <span className={`badge ${ev.breached ? "danger" : "ok"}`}>{ev.breached ? "Breached" : "Defended"}</span>
                {ev.replay?.trace?.zone ? ` in the ${ev.replay.trace.zone} zone` : ""}
              </dd>
              <dt>Robot</dt>
              <dd>
                <a href={`#/robots/${ev.robotId}`}>#{ev.robotId.toString()}</a>
              </dd>
              <dt>Player</dt>
              <dd>
                <a href={`#/player/${ev.player}`}>
                  <code>{ev.player}</code>
                </a>
              </dd>
              <dt>Recorded</dt>
              <dd>
                {new Date(ev.resultAt * 1000).toLocaleString()} · block {ev.resultBlock.toString()} · <TxLink hash={ev.resultTx} explorer={explorer} />
              </dd>
              {ev.payouts.map((p) => (
                <Fragment key={p.tx}>
                  <dt>Paid</dt>
                  <dd>
                    <span className="gold">{formatWei(p.amountWei)} QOR</span> · {p.vault} bounty #{p.bountyId} · <TxLink hash={p.tx} explorer={explorer} />
                  </dd>
                </Fragment>
              ))}
            </dl>
          </section>

          <section className="panel">
            <h2>Try to forge it</h2>
            <p className="note">
              Change one fact and the same signature has to verify again. A real check fails; a rubber stamp would pass.
            </p>
            <div className="vf-tamper">
              <button className="btn small" onClick={flipVerdict}>
                Flip the verdict
              </button>
              <button className="btn small" onClick={otherPlayer}>
                Swap the winner
              </button>
              <button className="btn small" onClick={editInstruction} disabled={!ev.replay}>
                Edit the instruction
              </button>
            </div>
            <ul className="vf-tries">
              {tampers.map((t, i) => (
                <li key={tampers.length - i} className={t.ok ? "bad" : "good"}>
                  <strong>{t.ok ? "✗ Accepted (this should never happen)" : "✓ Rejected"}</strong> {t.label}
                  <span>{t.detail}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      <section className="vf-how">
        <h2>Where each fact comes from</h2>
        <ul>
          <li>
            Chain data: <code>{CHAIN.rpc}</code> (QoreChain's public EVM RPC, chain id {CHAIN.chainId}), registry <code>{CHAIN.registry}</code>.
          </li>
          <li>
            Signature check: ML-DSA-87 (FIPS 204) from <code>@noble/post-quantum</code>, the same algorithm the contract runs through QoreChain's pqcVerify
            precompile.
          </li>
          <li>
            Only the replay comes from the RedZone server, and it is shown only if it hashes to the value the referee signed.
          </li>
          <li>
            Code: <a href={`${REPO}/web/src/verify.ts`}>web/src/verify.ts</a> · contract check:{" "}
            <a href={`${REPO}/contracts/src/v4/RobotRegistryV4.sol`}>RobotRegistryV4.recordResult</a>
          </li>
        </ul>
      </section>
    </div>
  );
}
