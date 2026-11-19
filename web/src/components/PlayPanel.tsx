import { useEffect, useState } from "react";
import { useAccount } from "../account";
import { API_URL, api, attemptMessage, formatQor, newRoundKey, type Health, type Robot, type Trace, type Verdict } from "../api";
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

/** roundKey: lets the message go without a second QoreX approval (only this tab knows it). */
type Round = { id: number; expiresAt: number; tx: string; roundKey?: string };

const ROUND_STORE = "redzone.round";
/** Keep a running round across a page reload, so the player can still send their message. */
function saveRound(r: Round | null) {
  try {
    if (r) sessionStorage.setItem(ROUND_STORE, JSON.stringify(r));
    else sessionStorage.removeItem(ROUND_STORE);
  } catch {
    // storage blocked: the round just won't survive a reload
  }
}
function loadRound(): Round | null {
  try {
    const r = JSON.parse(sessionStorage.getItem(ROUND_STORE) ?? "null") as Round | null;
    return r && r.expiresAt > Date.now() / 1000 ? r : null;
  } catch {
    return null;
  }
}

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
  const [round, setRoundState] = useState<Round | null>(loadRound);
  const setRound = (r: Round | null) => {
    saveRound(r);
    setRoundState(r);
  };
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
      const rk = await newRoundKey();
      const s = await api.sessionStart({ robotId: robot.id, player: address, deadline: req.deadline, pqSignature, roundKeyHash: rk.hash });
      setRound({ id: s.sessionId, expiresAt: s.expiresAt, tx: s.tx, roundKey: rk.key });
      acc.setAttemptsLeft(req.attemptsLeft - 1);
    });

  const send = () =>
    run(round?.roundKey ? "The robot is thinking…" : "Approve in QoreX…", async () => {
      if (!round) return;
      // Normally no wallet prompt: the round key from the start authorises the message.
      const auth = round.roundKey
        ? { roundKey: round.roundKey }
        : { pqSignature: await signPq(address, attemptMessage(health.chainId, health.registry, round.id, instruction)) };
      setBusy("The robot is thinking…");
      const v = await api.attempt(round.id, instruction, auth);
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
  // What this win paid: the bounties settled for it (each claim pays the robot's earliest win).
  const paidIds = new Set(verdict?.relay?.claimTxs?.map((c) => c.bountyId) ?? []);
  const paidWei = (verdict?.claims ?? []).filter((c) => paidIds.has(c.bountyId)).reduce((s, c) => s + BigInt(c.amountWei), 0n);

  return (
    <div className="stack">
      {verdict && (
        <div className={`result ${won ? "win" : "lose"}`} aria-live="polite">
          <strong>{won ? (paidWei > 0n ? `You won ${formatQor(paidWei.toString())}!` : "You did it!") : "The robot stayed safe"}</strong>
          <p>
            {won
              ? paid
                ? `${robot.name} walked into a red zone. ${paidWei > 0n ? formatQor(paidWei.toString()) : "The bounty"} has been sent to your QoreX account.`
                : verdict.claims.length
                  ? `${robot.name} walked into a red zone. Your bounty is being sent.`
                  : `${robot.name} walked into a red zone. It had no bounty left, but your win is on its public record.`
              : "It didn't fall for that one. Try a different trick."}
          </p>
          <p className="quote">Robot said: “{verdict.say || "…"}”</p>
          {won &&
            verdict.relay?.claimTxs?.map((c) => (
              <p key={c.bountyId} className="note">
                Bounty payment: <TxLink hash={c.tx} explorer={health.explorerUrl} />
              </p>
            ))}
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
            {verdict.relay?.resultTx && (
              <div>
                Result saved: <TxLink hash={verdict.relay.resultTx} explorer={health.explorerUrl} />
              </div>
            )}
            {verdict.relay?.claimTxs?.map((c) => (
              <div key={c.bountyId}>
                Bounty payment: <TxLink hash={c.tx} explorer={health.explorerUrl} />
              </div>
            ))}
            <div>
              Replay:{" "}
              <a href={`${API_URL}/replay/${verdict.replayHash}`} target="_blank" rel="noreferrer">
                {shortHash(verdict.replayHash)}
              </a>
            </div>
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
              ? `${plural(player.attemptsLeft, "try", "tries")} left today.${health.rules ? ` Each round lasts ${Math.round(health.rules.sessionTtl / 60)} minutes.` : ""}`
              : `You've used all ${health.rules?.attemptsPerDay ?? "your"} tries for today. Come back tomorrow, or keep practising for free.`}
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

/** A transaction hash, linked to the block explorer when the network has one. */
function TxLink({ hash, explorer }: { hash: string; explorer: string | null }) {
  if (!explorer) return <code title={hash}>{shortHash(hash)}</code>;
  return (
    <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer" title={hash}>
      {shortHash(hash)}
    </a>
  );
}
