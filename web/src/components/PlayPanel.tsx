import { useEffect, useState } from "react";
import { useAccount } from "../account";
import { API_URL, api, attemptMessage, formatQor, newRoundKey, type Health, type Robot, type Trace, type Verdict } from "../api";
import { plural, shortHash } from "../format";
import { explainQorexError, payNative, signPq } from "../qorex";
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

/** The play pass this browser opened: its key (never sent until a round starts) and end time. */
type StoredPass = { player: string; key: string; validUntil: number };
const PASS_STORE = "redzone.pass";
function savePass(p: StoredPass | null) {
  try {
    if (p) sessionStorage.setItem(PASS_STORE, JSON.stringify(p));
    else sessionStorage.removeItem(PASS_STORE);
  } catch {
    // storage blocked: a reload just asks for a new pass
  }
}
function loadPass(address: string | null): StoredPass | null {
  try {
    const p = JSON.parse(sessionStorage.getItem(PASS_STORE) ?? "null") as StoredPass | null;
    return p && address && p.player === address.toLowerCase() && p.validUntil > Date.now() / 1000 ? p : null;
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

  const [pass, setPassState] = useState<StoredPass | null>(() => loadPass(address));

  /** One QoreX approval opens a play pass; rounds then start with no wallet prompt until it ends. */
  async function openPass(): Promise<StoredPass> {
    setBusy("Approve once in QoreX: it covers your rounds for the next 10 minutes…");
    const req = await api.passRequest(address);
    const pqSignature = await signPq(address, req.text);
    setBusy("Opening your play pass…");
    const pk = await newRoundKey();
    const r = await api.passOpen({ player: address, validUntil: req.validUntil, maxRounds: req.maxRounds, deadline: req.deadline, pqSignature, passKeyHash: pk.hash });
    const p = { player: address.toLowerCase(), key: pk.key, validUntil: r.validUntil };
    savePass(p);
    setPassState(p);
    return p;
  }

  const start = () =>
    run("Starting your round…", async () => {
      setVerdict(null);
      const live = pass && pass.validUntil > Math.floor(Date.now() / 1000) + 15 ? pass : null;
      const begin = async (p: StoredPass) => {
        setBusy("Starting your round…");
        const rk = await newRoundKey();
        const s = await api.sessionStartWithPass({ robotId: robot.id, player: address, passKey: p.key, roundKeyHash: rk.hash });
        setRound({ id: s.sessionId, expiresAt: s.expiresAt, tx: s.tx, roundKey: rk.key });
      };
      try {
        await begin(live ?? (await openPass()));
      } catch (e) {
        // The pass ended or was used up: approve a new one once, then start.
        if (!live || !/play pass|ended|used up|no play pass/i.test((e as Error).message)) throw e;
        savePass(null);
        setPassState(null);
        await begin(await openPass());
      }
      acc.setAttemptsLeft(player.attemptsLeft - 1);
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
              ? `${plural(player.attemptsLeft, "try", "tries")} left${player.extraTries ? ` (${player.extraTries} bought)` : " today"}.${health.rules ? ` Each round lasts ${Math.round(health.rules.sessionTtl / 60)} minutes.` : ""}`
              : `You've used all ${health.rules?.attemptsPerDay ?? "your"} free tries for today. Buy more below, come back tomorrow, or keep practising for free.`}
          </p>
          <p className="note">
            {pass && pass.validUntil > now
              ? `Play pass on until ${new Date(pass.validUntil * 1000).toLocaleTimeString()}: rounds start without asking QoreX.`
              : "QoreX asks once, then you can play for 10 minutes without approving every round."}
          </p>
          {player.tries && <BuyTries address={address} tries={player.tries} onBought={acc.refresh} />}
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

/** Buy extra tries: pay from QoreX, then RedZone adds them on chain (the payment goes to the site owner). */
function BuyTries({ address, tries, onBought }: { address: string; tries: { priceUqor: string; payTo: string; memo: string }; onBought: () => Promise<void> }) {
  const [count, setCount] = useState(5);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const price = BigInt(tries.priceUqor);
  const n = Number.isSafeInteger(count) && count >= 1 && count <= 100 ? count : 0;
  const totalUqor = price * BigInt(n);
  const qor = (u: bigint) => formatQor((u * 10n ** 12n).toString());

  const buy = async () => {
    if (!n) return;
    setBusy("Approve the payment in QoreX…");
    setError(null);
    setDone(null);
    try {
      const tx = await payNative(address, tries.payTo, totalUqor.toString(), tries.memo);
      setBusy("Adding your tries…");
      for (let i = 0; ; i++) {
        try {
          const r = await api.buyTries(address, tx);
          setDone(`Added ${plural(r.bought, "try", "tries")}. You have ${plural(r.extraTries, "bought try", "bought tries")}.`);
          break;
        } catch (e) {
          // The payment can take a few seconds to show up on chain; retrying never charges twice.
          if (i >= 10 || !/not (found|indexed)/i.test((e as Error).message)) throw e;
          await new Promise((ok) => setTimeout(ok, 3000));
        }
      }
      await onBought();
    } catch (e) {
      setError(explainQorexError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <details className="buy-tries">
      <summary>Want more tries? {qor(price)} each</summary>
      <div className="row">
        <label htmlFor="try-count">Tries</label>
        <input id="try-count" type="number" min={1} max={100} value={count} onChange={(e) => setCount(Number(e.target.value))} style={{ width: "5em" }} />
        <button className="btn small" disabled={!n || !!busy} onClick={buy}>
          Buy {n || ""} for {qor(totalUqor)}
        </button>
      </div>
      <p className="note">Bought tries never expire and are used after your free daily ones.</p>
      {busy && <p className="note">{busy}</p>}
      {done && <p className="note">{done}</p>}
      {error && <p className="error-text">{error}</p>}
    </details>
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
