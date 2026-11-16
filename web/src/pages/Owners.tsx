import { useEffect, useState } from "react";
import { useAccount } from "../account";
import { api, type BrainConfig, type Trace } from "../api";
import { AccountGate } from "../components/AccountGate";
import { ArenaView } from "../components/ArenaView";
import { PracticePanel } from "../components/PracticePanel";
import { RobotCard } from "../components/RobotCard";
import { useData } from "../data";
import { explainQorexError, signPq } from "../qorex";

type Kind = "rule" | "ai";

/** Robot makers: choose a brain, test it, put the robot in the arena, manage robots. */
export function Owners() {
  const { health, arena, robots, reloadRobots } = useData();
  const acc = useAccount();
  const [kind, setKind] = useState<Kind>("ai");
  const [aiBase, setAiBase] = useState<Extract<BrainConfig, { kind: "llm" }> | null>(null);
  const [rules, setRules] = useState("");
  const [brainHash, setBrainHash] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [brainError, setBrainError] = useState<string | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [runKey, setRunKey] = useState(0);

  // Start the AI option from the built-in sentinel brain.
  const sentinelHash = health?.builtInBrains["llm-sentinel"];
  useEffect(() => {
    if (!sentinelHash) return;
    api
      .brain(sentinelHash)
      .then((b) => {
        if (b.config.kind === "llm") {
          setAiBase(b.config);
          setRules(b.config.systemPrompt);
        }
      })
      .catch(() => {});
  }, [sentinelHash]);

  // Any change to the choice means the brain must be saved again.
  useEffect(() => setBrainHash(null), [kind, rules]);

  async function saveBrain(): Promise<string | null> {
    if (brainHash) return brainHash;
    setSaving(true);
    setBrainError(null);
    try {
      let hash: string;
      if (kind === "rule") {
        hash = health!.builtInBrains.rule!;
      } else {
        if (!aiBase) throw new Error("The AI brain isn't available right now.");
        hash = (await api.publishBrain({ kind: "llm", version: 1, models: aiBase.models, systemPrompt: rules })).brainHash;
      }
      setBrainHash(hash);
      return hash;
    } catch (e) {
      setBrainError((e as Error).message);
      return null;
    } finally {
      setSaving(false);
    }
  }

  const mine = acc.player ? robots.filter((r) => r.owner.toLowerCase() === acc.player!.evm.toLowerCase()) : [];

  return (
    <>
      <h1 className="page-title">For robot makers</h1>
      <p className="lead">
        Put your robot's brain in the arena and let players try to break it. Every blocked attack raises its public safety score, which buyers
        can check before they trust it.
      </p>

      <section className="panel step">
        <h2>
          <span className="num">1</span> Choose a brain
        </h2>
        <div className="choice">
          <button className={kind === "ai" ? "option on" : "option"} onClick={() => setKind("ai")} aria-pressed={kind === "ai"}>
            <strong>AI guard</strong>
            <span>Understands everyday language. You write its safety rules in plain words.</span>
          </button>
          <button className={kind === "rule" ? "option on" : "option"} onClick={() => setKind("rule")} aria-pressed={kind === "rule"}>
            <strong>Simple guard</strong>
            <span>Follows fixed rules. Fast and predictable, but easier to trick.</span>
          </button>
        </div>
        {kind === "ai" && (
          <>
            <label htmlFor="rules">Safety rules for your robot</label>
            <textarea id="rules" className="tall" value={rules} maxLength={4000} onChange={(e) => setRules(e.target.value)} />
            <p className="note">Tell it what it must never do, and how to handle tricks. Runs on free AI models.</p>
          </>
        )}
      </section>

      <section className="panel step">
        <h2>
          <span className="num">2</span> Test it for free
        </h2>
        <p className="note">Attack your own brain before anyone else does. Nothing here is saved.</p>
        {arena && (
          <div className="play-grid">
            <div>
              <ArenaView arena={arena} trace={trace} runKey={runKey} />
            </div>
            <div>
              {brainHash ? (
                <PracticePanel
                  brainHash={brainHash}
                  name="your robot"
                  maxInstruction={arena.maxInstruction}
                  onResult={(r) => {
                    setTrace(r.trace);
                    setRunKey((k) => k + 1);
                  }}
                />
              ) : (
                <button className="btn primary" disabled={saving} onClick={saveBrain}>
                  {saving ? "Getting your brain ready…" : "Start testing"}
                </button>
              )}
              {brainError && <p className="error-text">{brainError}</p>}
            </div>
          </div>
        )}
      </section>

      <section className="panel step">
        <h2>
          <span className="num">3</span> Put it in the arena
        </h2>
        <AccountGate purpose="add your robot">
          <AddRobot saveBrain={saveBrain} onAdded={reloadRobots} />
        </AccountGate>
      </section>

      {mine.length > 0 && (
        <section className="panel step">
          <h2>Your robots</h2>
          <div className="cards">
            {mine.map((r) => (
              <div key={r.id} className="stack">
                <RobotCard robot={r} href={`#/robots/${r.id}`} />
                <ChangeBrain robotId={r.id} current={r.brainHash} saveBrain={saveBrain} onDone={reloadRobots} />
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="panel step">
        <h2>Prizes</h2>
        <p>
          A prize makes players try harder, so your score means more. Prizes are locked in a safe vault and only move when a player really
          beats your robot, or when you take them back.
        </p>
        <p className="note">
          Adding a prize from this page is coming soon: the QoreX wallet can't send this kind of payment yet. Until then, contact the RedZone
          team to add one.
        </p>
      </section>
    </>
  );
}

/** Asks QoreX to approve a request, then runs it. Shared by add-robot and change-brain. */
function useSigned() {
  const acc = useAccount();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: (address: string) => Promise<void>) {
    setError(null);
    setBusy("Approve in QoreX…");
    try {
      await fn(acc.address!);
    } catch (e) {
      setError(explainQorexError(e));
    } finally {
      setBusy(null);
    }
  }
  return { busy, setBusy, error, run };
}

function AddRobot({ saveBrain, onAdded }: { saveBrain: () => Promise<string | null>; onAdded: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [done, setDone] = useState<{ id: number; skills?: number } | null>(null);
  const s = useSigned();
  const clean = name.trim();
  const valid = clean.length > 0 && clean.length <= 64 && /^[\x20-\x7e]+$/.test(clean);

  const add = () =>
    s.run(async (address) => {
      const hash = await saveBrain();
      if (!hash) return;
      const req = await api.robotRequest(address, clean, hash);
      const pqSignature = await signPq(address, req.text);
      s.setBusy("Adding your robot…");
      const r = await api.registerRobot({ owner: address, name: clean, brainHash: hash, deadline: req.deadline, pqSignature });
      setDone({ id: r.robotId });
      s.setBusy("Running the everyday-tasks test…");
      try {
        const u = await api.utility(r.robotId);
        setDone({ id: r.robotId, skills: u.tasksPassed });
      } catch {
        // The test can be run again later; the robot is already live.
      }
      setName("");
      await onAdded();
    });

  if (done) {
    return (
      <div className="result win">
        <strong>Your robot is live!</strong>
        <p>
          It's robot #{done.id}.{done.skills !== undefined && ` It passed ${done.skills} of 10 everyday tasks.`} Players can attack it now.
        </p>
        <div className="row">
          <a className="btn" href={`#/robots/${done.id}`}>
            See its page
          </a>
          <button className="btn" onClick={() => setDone(null)}>
            Add another
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <label htmlFor="robot-name">Robot name</label>
      <input id="robot-name" value={name} maxLength={64} placeholder="e.g. Warehouse Helper" onChange={(e) => setName(e.target.value)} />
      {name && !valid && <p className="error-text">Use plain letters, numbers and punctuation (up to 64).</p>}
      <button className="btn primary big" disabled={!valid || !!s.busy} onClick={add}>
        Add my robot
      </button>
      <p className="note">Free. It uses the brain you chose in step 1. Players can attack it straight away.</p>
      {s.busy && <p className="note">{s.busy}</p>}
      {s.error && <p className="error-text">{s.error}</p>}
    </div>
  );
}

function ChangeBrain({
  robotId,
  current,
  saveBrain,
  onDone,
}: {
  robotId: number;
  current: string;
  saveBrain: () => Promise<string | null>;
  onDone: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  const [ok, setOk] = useState(false);
  const s = useSigned();

  const change = () =>
    s.run(async (address) => {
      const hash = await saveBrain();
      if (!hash) return;
      if (hash.toLowerCase() === current.toLowerCase()) throw new Error("This robot already uses that brain.");
      const req = await api.brainRequest(robotId, address, hash);
      const pqSignature = await signPq(address, req.text);
      s.setBusy("Updating…");
      await api.updateBrain({ robotId, owner: address, brainHash: hash, deadline: req.deadline, pqSignature });
      s.setBusy("Running the everyday-tasks test…");
      await api.utility(robotId).catch(() => {});
      setOk(true);
      setConfirm(false);
      await onDone();
    });

  if (ok) return <p className="note">Brain updated.</p>;
  if (!confirm) {
    return (
      <button className="btn small" onClick={() => setConfirm(true)}>
        Use the brain from step 1
      </button>
    );
  }
  return (
    <div className="stack">
      <p className="note">This swaps in the brain from step 1 and resets this robot's score to zero. Continue?</p>
      <div className="row">
        <button className="btn primary small" disabled={!!s.busy} onClick={change}>
          Yes, change it
        </button>
        <button className="btn small" onClick={() => setConfirm(false)}>
          Cancel
        </button>
      </div>
      {s.busy && <p className="note">{s.busy}</p>}
      {s.error && <p className="error-text">{s.error}</p>}
    </div>
  );
}
