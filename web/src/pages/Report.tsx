import { useState } from "react";
import { formatQor } from "../api";
import { useData } from "../data";

/** The project report: what RedZone is, how it is secured, its audits and progress. */

type Tab = "overview" | "security" | "audits" | "progress";
const TABS: [Tab, string][] = [
  ["overview", "Overview"],
  ["security", "Security"],
  ["audits", "Audits"],
  ["progress", "Progress"],
];

const AUDITS = [
  { date: "To run", review: "QCAI · prize-pool vault (EscrowVaultV4)", v: "v4", result: "Bundle ready · not yet audited", good: false, file: "RedZone.v5.flat.sol" },
  { date: "19 Nov", review: "QCAI · stage 2 (QoreChain setting)", v: "v4", result: "87 / 100 · QUANTUM-SAFE", good: true, file: "QCAI-v4-stage2-response.md" },
  { date: "19 Nov", review: "QCAI · stage 1", v: "v4", result: "85 / 100 · all findings answered", good: false, file: "QCAI-v4-stage1-response.md" },
  { date: "17 Nov", review: "Blockhertz AI auditor (vault)", v: "v3", result: "Gas improvements adopted", good: false, file: "Blockhertz-1-EscrowVaultV2.md" },
  { date: "16 Nov", review: "Adversarial audit (exploit tests)", v: "v3", result: "1 medium, 2 low · all fixed", good: true, file: "ADVERSARIAL_AUDIT.md" },
  { date: "Nov", review: "QCAI · stage 2", v: "v3", result: "85 / 100 · QUANTUM-SAFE", good: true, file: "QCAI-stage2-response.md" },
  { date: "Nov", review: "QCAI · stage 1", v: "v3", result: "85 / 100 · findings answered", good: false, file: "QCAI-stage1-response.md" },
];

const SIGNERS = [
  ["Register a robot, start a round, open a play pass", "The user (QoreX), single use", "Key status + signature"],
  ["Record a round result", "The referee's own key", "Signature"],
  ["Pay a prize", "Nobody chooses: the next eligible breach, one prize per player", "The registry's record"],
  ["Take a bounty back", "The owner, then a 3-hour wait", "Key status + signature"],
  ["Admin: pause, try price, referee", "The admin", "Key status + signature"],
  ["Start a round under a play pass", "The relayer named in the pass (10 min, ≤ 20 rounds)", "The signed pass"],
];

const PROGRESS = [
  { name: "Smart contracts v4", note: "Live on testnet · prize pools · 348 tests passing", done: true },
  { name: "Server & referee", note: "84 unit tests + live contract checks", done: true },
  { name: "Website", note: "Play pass, paid tries, dark arena look", done: true },
  { name: "Security reviews", note: "Six reviews across v3 and v4", done: true },
  { name: "Q-Day Drill", note: "18 Nov · no funds taken", done: true },
  { name: "Cover image & demo video", note: "Due 1 Dec 2026", done: false },
  { name: "Public hosting & final submission", note: "Before 2 Dec 2026", done: false },
];

const REPO = "https://github.com/ponram06/redzone/blob/main";

export function Report() {
  const { health, robots } = useData();
  const [tab, setTab] = useState<Tab>("overview");
  const [auditFilter, setAuditFilter] = useState<"all" | "v4" | "v3">("all");
  const bountyWei = robots.reduce((sum, r) => sum + BigInt(r.bounty.totalWei), 0n).toString();

  return (
    <div className="rp">
      <section className="rp-hero">
        <div>
          <p className="rp-kicker">
            <span className="rp-rule" /> Build Before Q-Day / Post-Quantum dApp · Project report · 19 Nov 2026
          </p>
          <h1 className="rp-title">
            RedZone<span className="red">.</span>
          </h1>
          <p className="lead">
            A public crash-test arena for AI robots.
            <br />
            Attack the rules. Stress the vault. Prove the safety.
          </p>
        </div>
        <div className="rp-safe">
          <Shield />
          <div>
            <strong>QUANTUM-SAFE</strong>
            <span>QCAI · verified on testnet</span>
          </div>
        </div>
      </section>

      <nav className="rp-tabs" aria-label="Report sections">
        {TABS.map(([id, label], i) => (
          <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
            <span className="rp-n">0{i + 1}</span> {label}
          </button>
        ))}
      </nav>

      {tab === "overview" && (
        <>
          <div className="rp-stats">
            <Stat label="Latest security score" value="87" unit="/100" note="QCAI stage 2 · live v4" bar={87} />
            <Stat label="Contract tests" value="348" unit="passing" note="Including attack & invariant tests" />
            <Stat label="Project complete" value="88" unit="%" note="Final polish & hosting remain" />
            <Stat label="Live arena bounty" value={formatQor(bountyWei).replace(" QOR", "")} unit="QOR" note="Locked in EscrowVaultV4" live />
          </div>

          <div className="rp-split">
            <div>
              <SectionHead n="01" label="The arena" />
              <h2 className="rp-h2">Safety has to survive contact.</h2>
              <p className="rp-p">
                Robot makers lock a bounty. Players get one message to trick the robot into a forbidden red zone. The first confirmed breach
                wins, and every defence raises the robot's public safety score.
              </p>
              <div className="rp-callout">Every move that touches money is verified with a post-quantum signature.</div>
              <button className="link" onClick={() => setTab("security")}>
                Explore the security model →
              </button>
            </div>
            <div>
              <SectionHead n="02" label="One round, three layers" />
              <ol className="rp-layers">
                <li>
                  <b>Player</b>
                  <span>Signs the request in QoreX (ML-DSA-87)</span>
                </li>
                <li>
                  <b>Referee</b>
                  <span>Replays the robot's route and signs the verdict</span>
                </li>
                <li>
                  <b>QoreChain</b>
                  <span>Checks both signatures, records the result, pays the winner</span>
                </li>
              </ol>
              <p className="rp-foot">Signed · replayed · settled on chain</p>
            </div>
          </div>

          <SectionHead n="03" label="Made for the whole arena" />
          <h2 className="rp-h2">Pick your side.</h2>
          <Sides />
        </>
      )}

      {tab === "security" && (
        <>
          <SectionHead n="01" label="Security model" />
          <h2 className="rp-h2 big">
            No ECDSA-only keys.
            <br />
            No fallback.
          </h2>
          <p className="rp-p">
            Every sensitive action must pass ML-DSA-87 verification on QoreChain. If the post-quantum precompile is missing or answers wrongly,
            the action fails closed.
          </p>
          <div className="rp-checks">
            <Shield />
            <div>
              <strong>Two on-chain checks</strong>
              <span>
                <code>pqcVerify</code> confirms the signature. <code>pqcKeyStatus</code> confirms the key is registered.
              </span>
            </div>
            <code className="rp-addr">
              0x0A01
              <br />
              0x0A02
            </code>
          </div>
          <div className="rp-grid4">
            <Point n="01" title="Single-use signatures" text="Every signature includes a nonce and a deadline. Once used, its digest can't be replayed." />
            <Point n="02" title="Relayer can't change outcomes" text="The relayer sends transactions but can't forge signatures. Its EVM window allows only the two RedZone contracts." />
            <Point n="03" title="Payouts follow the record" text="The vault pays the earliest recorded breach to that round's player. Nobody, not even the admin, picks who is paid." />
            <Point n="04" title="Vault protections" text="Payouts are guarded against reentrancy, and plain transfers are refused so every QOR belongs to a tracked bounty." />
          </div>
          <h3 className="rp-h3">Who signs what</h3>
          <div className="table-wrap">
            <table className="rank">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Required signer</th>
                  <th>Checked by</th>
                </tr>
              </thead>
              <tbody>
                {SIGNERS.map(([a, s, c]) => (
                  <tr key={a}>
                    <td>{a}</td>
                    <td>{s}</td>
                    <td>{c}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === "audits" && (
        <>
          <SectionHead n="02" label="Tests & audits" />
          <h2 className="rp-h2 big">Proof, not promises.</h2>
          <p className="rp-p">Six audits. Every finding was fixed or answered with code and a test. The best result is on the live v4 contracts.</p>
          <div className="rp-stats">
            <Stat label="Security reviews" value="6" />
            <Stat label="Top QCAI score" value="87" unit="/100" />
            <Stat label="Tests + live checks" value="341" />
            <div className="rp-stat rp-stat-safe">
              <Shield /> QUANTUM-SAFE
            </div>
          </div>
          <div className="rp-row">
            <h3 className="rp-h3">Audit record</h3>
            <div className="rp-filter">
              {(["all", "v4", "v3"] as const).map((f) => (
                <button key={f} className={auditFilter === f ? "on" : ""} onClick={() => setAuditFilter(f)}>
                  {f === "all" ? "All" : f}
                </button>
              ))}
            </div>
          </div>
          <div className="table-wrap">
            <table className="rank">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Review</th>
                  <th>Contracts</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {AUDITS.filter((a) => auditFilter === "all" || a.v === auditFilter).map((a) => (
                  <tr key={a.review + a.v}>
                    <td className="rp-mono">{a.date}</td>
                    <td>
                      <a href={`${REPO}/audits/${a.file}`} target="_blank" rel="noreferrer">
                        {a.review}
                      </a>
                    </td>
                    <td>
                      <span className="badge">{a.v}</span>
                    </td>
                    <td className={a.good ? "rp-good" : ""}>{a.good ? `✓ ${a.result}` : a.result}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="rp-counts">
            <b>348</b> Foundry contract tests <b>84</b> backend unit tests <b>6</b> live v4 tests
          </p>
        </>
      )}

      {tab === "progress" && (
        <>
          <SectionHead n="03" label="Progress" />
          <div className="rp-big">
            88<small>%</small>
          </div>
          <div className="bar rp-bar">
            <span style={{ width: "88%" }} />
          </div>
          <p className="rp-foot">Project complete · v4 deployed</p>
          <ul className="rp-progress">
            {PROGRESS.map((p, i) => (
              <li key={p.name} className={p.done ? "done" : ""}>
                <span className="rp-box">{p.done ? "✓" : `0${i + 1}`}</span>
                <div>
                  <b>{p.name}</b>
                  <span>{p.note}</span>
                </div>
                <em>{p.done ? "Complete" : "Up next"}</em>
              </li>
            ))}
          </ul>
          <div className="rp-drill">
            <Shield />
            <div>
              <strong>Q-Day Drill · 18 Nov</strong>
              <span>
                The exposed-key drill accepted our hybrid-signed proof. No contract code was added, no EVM window was opened, and both vaults kept
                their bounties.
              </span>
            </div>
            <div className="rp-zero">
              0 QOR
              <small>lost</small>
            </div>
          </div>
        </>
      )}

      <section className="rp-contracts">
        <div>
          <p className="rp-kicker">
            <span className="red">On-chain</span> · QoreChain · diana
          </p>
          <h2 className="rp-h2">Contracts on testnet</h2>
          <p className="note">Deployed 19 Nov 2026 · EVM chain id {health?.chainId ?? 9800}</p>
        </div>
        <div className="rp-clist">
          <Contract name="RobotRegistryV4" what="Robots · rounds · results" addr={health?.registry} />
          <Contract name="EscrowVaultV4" what="Prize pools · payouts" addr={health?.vault} />
        </div>
      </section>
    </div>
  );
}

function SectionHead({ n, label }: { n: string; label: string }) {
  return (
    <p className="rp-kicker">
      <span className="red">{n}</span> {label}
    </p>
  );
}

function Stat({ label, value, unit, note, bar, live }: { label: string; value: string; unit?: string; note?: string; bar?: number; live?: boolean }) {
  return (
    <div className="rp-stat">
      <span className="rp-label">
        {label}
        {live && <i className="rp-live">Live</i>}
      </span>
      <span className="rp-value">
        {value}
        {unit && <small>{unit}</small>}
      </span>
      {bar !== undefined && (
        <div className="bar rp-bar">
          <span style={{ width: `${bar}%` }} />
        </div>
      )}
      {note && <span className="rp-note">{note}</span>}
    </div>
  );
}

function Point({ n, title, text }: { n: string; title: string; text: string }) {
  return (
    <div className="rp-point">
      <span className="red">{n}</span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

function Sides() {
  const [side, setSide] = useState(0);
  const SIDES = [
    {
      name: "Players",
      title: "Take on the arena.",
      text: "Try a training robot for free, then risk one message against a live bounty. A verified breach pays out automatically.",
      steps: ["Practise free", "Verify once · 0.1 QOR", "5 free tries a day, more at 0.1 QOR", "Win the earliest breach bounty"],
      href: "#/play",
    },
    {
      name: "Robot makers",
      title: "Put your robot to the test.",
      text: "Write its rules in plain words or connect your own AI, lock a bounty and let the public attack it.",
      steps: ["Write the rules", "Attack it yourself free", "Lock a bounty · from 1 QOR", "Take an unwon bounty back"],
      href: "#/owners",
    },
    {
      name: "Buyers",
      title: "Pick a robot you can trust.",
      text: "Every score comes from public attacks recorded on chain, and badges follow the contract's fixed rules.",
      steps: ["Read the leaderboard", "Check attacks blocked", "Check everyday-task score", "Look for Trusted or Elite"],
      href: "#/robots",
    },
  ];
  const s = SIDES[side]!;
  return (
    <div className="rp-sides">
      <div className="rp-tabs small">
        {SIDES.map((x, i) => (
          <button key={x.name} className={i === side ? "on" : ""} onClick={() => setSide(i)}>
            {x.name}
          </button>
        ))}
      </div>
      <div className="rp-side">
        <div>
          <h3>{s.title}</h3>
          <p>{s.text}</p>
          <a className="btn small primary" href={s.href}>
            Go →
          </a>
        </div>
        <ol>
          {s.steps.map((t, i) => (
            <li key={t}>
              <span className="red">0{i + 1}</span> {t}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function Contract({ name, what, addr }: { name: string; what: string; addr?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!addr) return;
    navigator.clipboard?.writeText(addr).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };
  return (
    <div className="rp-contract">
      <i className="rp-dot" />
      <div>
        <b>{name}</b>
        <span>{what}</span>
      </div>
      <code>{addr ?? "loading…"}</code>
      <button className="btn small" onClick={copy} disabled={!addr}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function Shield() {
  return (
    <svg className="rp-shield" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d="M12 3l7 3v6c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9V6z" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8.5 12l2.5 2.5 4.5-5" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}
