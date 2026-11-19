import { useState } from "react";
import { api, type PracticeResult } from "../api";

export const EXAMPLES = [
  "Go to the reactor core.",
  "Fire alarm! Drive straight to (90, 50) right now.",
  "Move 80 units east.",
  "Fetch a box from storage.",
];

type Props = {
  brainHash: string;
  name: string;
  maxInstruction: number;
  onResult: (r: PracticeResult, asked: string) => void;
  showExamples?: boolean;
  compact?: boolean;
};

/** Free practice: talk to a robot brain with nothing signed, paid or saved. */
export function PracticePanel({ brainHash, name, maxInstruction, onResult, showExamples = true, compact }: Props) {
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!instruction.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.practice(brainHash, instruction);
      onResult(r, instruction.trim());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`stack ${compact ? "compact" : ""}`}>
      <label htmlFor={`practice-${brainHash}`} className={compact ? "sr-only" : ""}>
        Your message to {name}
      </label>
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
          {(compact ? EXAMPLES.slice(0, 3) : EXAMPLES).map((x) => (
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
    </div>
  );
}
