import { useEffect, useState } from "react";
import { useAccount } from "../account";
import { api, attemptMessage, formatQor, type Health, type Robot, type Trace, type Verdict } from "../api";
import { plural, shortHash } from "../format";
import { explainQorexError, signPq } from "../qorex";
import { AccountGate } from "./AccountGate";

type Props = {
  health: Health;
  robot: Robot;
  maxInstruction: number;
  onResult: (trace: Trace) => void;
  onFinished: () => void;
};

type Round = { id: number; expiresAt: number; tx: string };

/** A real round: start (uses one daily try), send one message, get the verdict and any bounty. */
export function PlayPanel(props: Props) {
  if (!props.health.relayer) {
    return <p className="note">Bounty rounds are paused right now. Free practice still works.</p>;
  }
  return (
    <AccountGate purpose="play for bounties">
      <RealRound {...props} />
    </AccountGate>
  );
}

function RealRound({ health, robot, maxInstruction, onResult, onFinished }: Props) {
  const acc = useAccount();
  const [round, setRound] = useState<Round | null>(null);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    if (!round) return;
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, [round]);

  const address = acc.address!;
  const player = acc.player!;
  const isOwner = robot.owner.toLowerCase() === player.evm.toLowerCase();
  const left = round ? Math.max(0, round.expiresAt - now) : 0;
  const bounty = robot.bounty.totalWei !== "0" ? formatQor(robot.bounty.totalWei) : null;

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

  const start = () =>
    run("Approve in QoreX…", async () => {
      setVerdict(null);
      const req = await api.sessionRequest(robot.id, address);
      const pqSignature = await signPq(address, req.text);
      setBusy("Starting your round…");
      const s = await api.sessionStart({ robotId: robot.id, player: address, deadline: req.deadline, pqSignature });
      setRound({ id: s.sessionId, expiresAt: s.expiresAt, tx: s.tx });
      acc.setAttemptsLeft(req.attemptsLeft - 1);
    });

  const send = () =>
    run("Approve in QoreX…", async () => {
      if (!round) return;
      const pqSignature = await signPq(address, attemptMessage(health.chainId, health.registry, round.id, instruction));
      setBusy("The robot is thinking…");
      const v = await api.attempt(round.id, instruction, pqSignature);
      setVerdict(v);
      onResult(v.trace);
      setRound(null);
      setInstruction("");
      onFinished();
    });

  const retry = () =>
    run("Trying again…", async () => {
      if (verdict) setVerdict(await api.relayAgain(verdict.sessionId));
    });

  if (isOwner) return <p className="note">This is your robot, so you can't play against it. Pick another robot.</p>;

  const won = verdict?.breached;
  const paid = verdict?.relay?.claimTxs?.length;

  return (
    <div className="stack">
      {verdict && (
        <div className={`result ${won ? "win" : "lose"}`} aria-live="polite">
          <strong>{won ? "You did it!" : "The robot stayed safe"}</strong>
          <p>
            {won
              ? paid
                ? "The robot walked into a red zone. The bounty has been sent to your QoreX account."
                : "The robot walked into a red zone. Your bounty is being sent."
              : "It didn't fall for that one. Try a different trick."}
          </p>
          <p className="quote">Robot said: “{verdict.say || "…"}”</p>
          {verdict.relay?.error && (
            <p className="error-text">
              We couldn't save this result yet.{" "}
              <button className="link" onClick={retry} disabled={!!busy}>
                Try again
              </button>
            </p>
          )}
          <details className="proof">
            <summary>Proof</summary>
            {verdict.relay?.resultTx && <div>Result saved: {shortHash(verdict.relay.resultTx)}</div>}
            {verdict.relay?.claimTxs?.map((c) => (
              <div key={c.bountyId}>Bounty payment: {shortHash(c.tx)}</div>
            ))}
            <div>Replay: {shortHash(verdict.replayHash)}</div>
          </details>
        </div>
      )}

      {!round ? (
        <>
          <p>
            {bounty ? (
              <>
                Trick <strong>{robot.name}</strong> into a red zone and win <strong>{bounty}</strong>.
              </>
            ) : (
              <>
                Trick <strong>{robot.name}</strong> into a red zone to beat it.
              </>
            )}{" "}
            You get one message per round.
          </p>
          <button className="btn primary big" disabled={!!busy || player.attemptsLeft < 1} onClick={start}>
            {verdict ? "Play again" : "Start a round"}
          </button>
          <p className="note">
            {player.attemptsLeft > 0
              ? `${plural(player.attemptsLeft, "try", "tries")} left today. Each round lasts 10 minutes.`
              : "You've used all 5 tries for today. Come back tomorrow, or keep practising for free."}
          </p>
        </>
      ) : (
        <>
          <div className="timer">
            Round running · <strong>{Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</strong> left
          </div>
          <label htmlFor="real-msg">Your message to {robot.name}</label>
          <textarea
            id="real-msg"
            value={instruction}
            maxLength={maxInstruction}
            placeholder="Think carefully. You only get one message this round."
            onChange={(e) => setInstruction(e.target.value)}
          />
          <button className="btn primary big" disabled={!!busy || !instruction.trim() || left === 0} onClick={send}>
            Send to robot
          </button>
          {left === 0 && <p className="note">Time's up for this round. Start a new one.</p>}
        </>
      )}

      {busy && <p className="note">{busy}</p>}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
