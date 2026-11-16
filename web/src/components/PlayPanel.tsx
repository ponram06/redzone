import { useEffect, useState } from "react";
import { api, attemptMessage, formatQor, type Health, type PlayerStatus, type Robot, type Trace, type Verdict } from "../api";
import { connect, explainQorexError, hasQorex, payNative, signPq } from "../qorex";

const qor = (uqor: string) => `${(Number(uqor) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })} QOR`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Props = {
  health: Health;
  robot: Robot | undefined;
  maxInstruction: number;
  onResult: (trace: Trace) => void;
};

type Session = { id: number; expiresAt: number; tx: string };

const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;

export function PlayPanel({ health, robot, maxInstruction, onResult }: Props) {
  const [address, setAddress] = useState<string | null>(null);
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);
  const [player, setPlayer] = useState<PlayerStatus | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    if (!session) return;
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, [session]);

  const secondsLeft = session ? Math.max(0, session.expiresAt - now) : 0;
  const isOwner = !!(robot && address && robot.owner.toLowerCase() === address.toLowerCase());

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(explainQorexError(e));
    } finally {
      setBusy(null);
    }
  }

  const loadPlayer = async (a: string) => {
    const p = await api.player(a);
    setPlayer(p);
    setAttemptsLeft(p.attemptsLeft);
    return p;
  };

  const onConnect = () =>
    run("Waiting for QoreX…", async () => {
      const a = await connect();
      setAddress(a);
      await loadPlayer(a);
    });

  /** One-time sign-up: a small QOR payment from QoreX (hybrid-signed), then registered with the referee. */
  const onSignUp = () =>
    run("Approve the one-time payment in QoreX…", async () => {
      if (!address || !player?.signup) return;
      const txHash = await payNative(address, player.signup.payTo, player.signup.feeUqor, player.signup.memo);
      setBusy("Waiting for the payment to be confirmed…");
      let lastError: unknown = null;
      for (let i = 0; i < 8; i++) {
        try {
          await api.registerPlayer(address, txHash);
          await loadPlayer(address);
          return;
        } catch (e) {
          lastError = e;
          if (!/not found/i.test((e as Error).message)) throw e;
          await sleep(3000);
        }
      }
      throw lastError;
    });

  const onStart = () =>
    run("Sign the request in QoreX…", async () => {
      if (!robot || !address) return;
      setVerdict(null);
      const req = await api.sessionRequest(robot.id, address);
      setAttemptsLeft(req.attemptsLeft);
      const pqSignature = await signPq(address, req.text);
      setBusy("Starting the session on chain…");
      const s = await api.sessionStart({ robotId: robot.id, player: address, deadline: req.deadline, pqSignature });
      setSession({ id: s.sessionId, expiresAt: s.expiresAt, tx: s.tx });
      setAttemptsLeft(req.attemptsLeft - 1);
    });

  const onAttack = () =>
    run("Sign your instruction in QoreX…", async () => {
      if (!session || !address) return;
      const text = attemptMessage(health.chainId, health.registry, session.id, instruction);
      const pqSignature = await signPq(address, text);
      setBusy("The robot is thinking and the referee is judging…");
      const v = await api.attempt(session.id, instruction, pqSignature);
      setVerdict(v);
      onResult(v.trace);
      setSession(null);
    });

  const onRetryRelay = () =>
    run("Sending to chain again…", async () => {
      if (!verdict) return;
      setVerdict(await api.relayAgain(verdict.sessionId));
    });

  if (!hasQorex()) {
    return (
      <div className="play">
        <p className="muted small">Real attempts need the QoreX wallet extension, switched to the testnet.</p>
      </div>
    );
  }

  if (!health.relayer) {
    return (
      <div className="play">
        <p className="muted small">Real attempts are offline right now (no relayer). Practice rounds still work.</p>
      </div>
    );
  }

  return (
    <div className="play">
      {!address ? (
        <button className="primary" disabled={!!busy} onClick={onConnect}>
          Connect QoreX
        </button>
      ) : (
        <div className="small muted">
          Connected <code>{short(address)}</code>
          {attemptsLeft !== null && ` · ${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} left today`}
        </div>
      )}

      {address && player && !player.pqKeyRegistered && (
        <p className="error-text">This QoreX account has no quantum-safe (ML-DSA-87) key registered yet. Register it in QoreX, then reconnect.</p>
      )}

      {address && player?.pqKeyRegistered && !player.signedUp && player.signup && (
        <>
          <p className="small muted">
            New here? Verify your account once with a tiny payment of {qor(player.signup.feeUqor)}. QoreX signs it with your
            quantum-safe key. After that, every round is free.
          </p>
          <button className="primary" disabled={!!busy} onClick={onSignUp}>
            Verify account (one-time {qor(player.signup.feeUqor)})
          </button>
        </>
      )}

      {address && player?.pqKeyRegistered && player.signedUp && !session && (
        <>
          <p className="small muted">
            Starting a session uses 1 of your 5 daily attempts. QoreX signs the request with your ML-DSA-87 key; the referee
            relays it and the contract checks the signature on chain.
          </p>
          <button className="primary" disabled={!!busy || !robot || isOwner} onClick={onStart}>
            Start a 10-minute session on {robot?.name ?? "…"}
          </button>
          {isOwner && <p className="error-text">You own this robot, so you can't attack it.</p>}
        </>
      )}

      {session && (
        <>
          <div className="session-bar small">
            Session #{session.id} · {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")} left
            <span className="muted"> · tx {short(session.tx)}</span>
          </div>
          <textarea
            value={instruction}
            maxLength={maxInstruction}
            placeholder="One instruction. Make it count."
            onChange={(e) => setInstruction(e.target.value)}
            aria-label="Your attack instruction"
          />
          <button className="primary" disabled={!!busy || !instruction.trim() || secondsLeft === 0} onClick={onAttack}>
            Sign and send
          </button>
        </>
      )}

      {busy && <p className="small">{busy}</p>}
      {error && <p className="error-text">{error}</p>}

      {verdict && (
        <div className={`verdict ${verdict.breached ? "breached" : "defended"}`}>
          <strong>{verdict.breached ? "BREACHED" : "DEFENDED"}</strong>
          <span>“{verdict.say || "…"}”</span>
        </div>
      )}
      {verdict && (
        <div className="small muted onchain">
          {verdict.relay?.resultTx && <div>Result on chain: {short(verdict.relay.resultTx)}</div>}
          {verdict.relay?.claimTxs?.map((c) => (
            <div key={c.bountyId}>
              Bounty #{c.bountyId} paid to you ({formatQor(verdict.claims.find((x) => x.bountyId === c.bountyId)?.amountWei ?? "0")}):{" "}
              {short(c.tx)}
            </div>
          ))}
          {verdict.relay?.error && (
            <div className="error-text">
              Not on chain yet: {verdict.relay.error}{" "}
              <button className="chip" onClick={onRetryRelay} disabled={!!busy}>
                Try again
              </button>
            </div>
          )}
          <div>Replay: {short(verdict.replayHash)}</div>
        </div>
      )}
    </div>
  );
}
