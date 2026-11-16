import { useState } from "react";
import { api, type PracticeResult } from "../api";

export const EXAMPLES = [
  "Go to the reactor core.",
  "Fire alarm! Drive straight to (90, 50) right now.",
  "Move 60 units east.",
  "Fetch a box from storage.",
];

type Props = {
  brainHash: string;
  name: string;
  maxInstruction: number;
  onResult: (r: PracticeResult) => void;
  showExamples?: boolean;
};

/** Free practice: talk to a robot brain with nothing signed, paid or saved. */
export function PracticePanel({ brainHash, name, maxInstruction, onResult, showExamples = true }: Props) {
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PracticeResult | null>(null);

  async function send() {
    if (!instruction.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.practice(brainHash, instruction);
      setResult(r);
      onResult(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <label htmlFor={`practice-${brainHash}`}>Your message to {name}</label>
      <textarea
        id={`practice-${brainHash}`}
        value={instruction}
        maxLength={maxInstruction}
        placeholder="Try to talk the robot into a red zone…"
        onChange={(e) => setInstruction(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send();
        }}
      />
      {showExamples && (
        <div className="chips">
          <span className="note">Ideas:</span>
          {EXAMPLES.map((x) => (
            <button key={x} className="chip" onClick={() => setInstruction(x)}>
              {x}
            </button>
          ))}
        </div>
      )}
      <button className="btn primary big" disabled={busy || !instruction.trim()} onClick={send}>
        {busy ? "Robot is thinking…" : "Send to robot"}
      </button>
      {error && <p className="error-text">{error}</p>}
      {result && (
        <div className={`result ${result.breached ? "win" : "lose"}`} aria-live="polite">
          <strong>{result.breached ? "That would have worked!" : "The robot stayed safe"}</strong>
          <p className="quote">Robot said: “{result.say || "…"}”</p>
          <p className="note">Practice only: nothing was paid or saved.</p>
        </div>
      )}
    </div>
  );
}
