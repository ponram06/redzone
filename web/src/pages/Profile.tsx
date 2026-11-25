import { useEffect, useMemo, useState } from "react";
import { useAccount } from "../account";
import { API_URL, api, formatQor, type PlayerProfile } from "../api";
import { AccountGate } from "../components/AccountGate";
import { TxLink } from "../components/TxLink";
import { StatusBadge, versionOf } from "../components/RobotStatus";
import { useData } from "../data";
import { qorAmount, shortHash } from "../format";
import { Avatar, PICTURES, generatedName, shortAddr, toEvm, usePlayerNames } from "../players";
import { explainQorexError, signPq } from "../qorex";

/** #/me: your own profile (sign in first). */
export function MyProfile() {
  return (
    <AccountGate purpose="see your profile" requireVerified={false}>
      <Mine />
    </AccountGate>
  );
}

function Mine() {
  const acc = useAccount();
  return <Profile address={acc.player!.evm} own />;
}

const day = (d: Date) => d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

function ago(sec: number | null): string {
  if (!sec) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copy"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        });
      }}
      title={`Copy ${label}`}
    >
      {done ? "Copied ✓" : "Copy"}
    </button>
  );
}



/** One entry in the activity list: a wallet transfer or a prize paid by the vault. */
type Entry = {
  key: string;
  when: Date | null;
  icon: string;
  tone: "in" | "out" | "prize";
  title: string;
  sub: string;
  amount: string;
  sign: "+" | "−";
  details: [string, React.ReactNode][];
};

const KIND_ICON: Record<string, string> = { signup: "✓", tries: "⚡", bounty: "🛡", sent: "↗", received: "↙" };

export function Profile({ address: raw, own = false }: { address: string; own?: boolean }) {
  // one key for a wallet, whether the link used its qor1… or 0x… address
  const address = toEvm(raw);
  const acc = useAccount();
  const { health, robots } = useData();
  const { nameOf, custom } = usePlayerNames();
  const [p, setP] = useState<PlayerProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [tab, setTab] = useState<"activity" | "rounds" | "rewards">("activity");
  const explorer = health?.explorerUrl ?? null;

  // Wallet balance: live from the chain; if the chain can't be reached, the last balance it gave (and when).
  const [bal, setBal] = useState<{ uqor: string; at: number; live: boolean } | null>(null);
  const balKey = `rz.balance.${address.toLowerCase()}`;
  const load = () =>
    api
      .playerProfile(address)
      .then((r) => {
        setP(r);
        setError(null);
        if (r.balanceUqor !== null) {
          const b = { uqor: r.balanceUqor, at: Date.now() };
          setBal({ ...b, live: true });
          try {
            localStorage.setItem(balKey, JSON.stringify(b));
          } catch {
            /* private window: no cache */
          }
        } else {
          try {
            const b = JSON.parse(localStorage.getItem(balKey) ?? "null") as { uqor: string; at: number } | null;
            setBal(b ? { ...b, live: false } : null);
          } catch {
            setBal(null);
          }
        }
      })
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    setP(null);
    setBal(null);
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  const entries = useMemo<Entry[]>(() => {
    if (!p) return [];
    const out: Entry[] = [];
    for (const t of p.wallet) {
      const inbound = t.direction === "in";
      const who = t.redzone ? "RedZone" : nameOf(t.counterparty.startsWith("qor") ? t.counterparty : t.counterparty);
      out.push({
        key: t.txHash,
        when: t.time ? new Date(t.time) : null,
        icon: KIND_ICON[t.kind] ?? "•",
        tone: inbound ? "in" : "out",
        title: t.label,
        sub: `${inbound ? "From" : "To"} ${t.redzone ? "RedZone" : shortAddr(t.counterparty)}${t.ok ? "" : " · failed"}`,
        amount: qorAmount(t.uqor),
        sign: inbound ? "+" : "−",
        details: [
          ["Transaction", <TxLink key="t" hash={t.txHash} explorer={explorer} evm={false} />],
          ["Block", `#${t.height.toLocaleString()}`],
          [inbound ? "From" : "To", <code key="c">{t.counterparty}</code>],
          ...(t.memo ? ([["Note", t.memo]] as [string, React.ReactNode][]) : []),
          ["Status", t.ok ? "Completed" : "Failed"],
          ["Paid by", who === "RedZone" ? "QoreX wallet → RedZone" : "QoreX wallet"],
        ],
      });
    }
    for (const z of p.prizes) {
      out.push({
        key: `prize-${z.bountyId}-${z.sessionId}`,
        when: z.at ? new Date(z.at * 1000) : null,
        icon: "🏆",
        tone: "prize",
        title: `Prize from ${z.robot ?? `bounty #${z.bountyId}`}`,
        sub: "Paid by the RedZone vault",
        amount: formatQor(z.amountWei),
        sign: "+",
        details: [
          ["Payment", <TxLink key="p" hash={z.tx} explorer={explorer} evm />],
          ...(z.resultTx ? ([["Result on chain", <TxLink key="r" hash={z.resultTx} explorer={explorer} evm />]] as [string, React.ReactNode][]) : []),
          [
            "Replay",
            <a key="rp" href={`${API_URL}/replay/${z.replayHash}`} target="_blank" rel="noreferrer">
              {shortHash(z.replayHash)} ↗
            </a>,
          ],
          ["Round", `#${z.sessionId}`],
          ["Signed with", "ML-DSA-87 (post-quantum)"],
          ["Check it yourself", <a key="vf" href={`#/verify/${z.sessionId}`}>Verify round #{z.sessionId}</a>],
        ],
      });
    }
    return out.sort((a, b) => (b.when?.getTime() ?? 0) - (a.when?.getTime() ?? 0));
  }, [p, explorer, nameOf]);

  const grouped = useMemo(() => {
    const g: { label: string; items: Entry[] }[] = [];
    for (const e of entries) {
      const label = e.when ? day(e.when) : "Earlier";
      const last = g[g.length - 1];
      if (last && last.label === label) last.items.push(e);
      else g.push({ label, items: [e] });
    }
    return g;
  }, [entries]);

  const mineRobots = robots.filter((r) => r.owner.toLowerCase() === address.toLowerCase());
  const name = nameOf(address);
  const s = p?.stats;
  const winRate = s && s.rounds ? Math.round((s.wins / s.rounds) * 100) : 0;
  const earned = s ? formatQor(s.earnedWei) : "…";
  const isMe = own || (!!acc.player && acc.player.evm.toLowerCase() === address.toLowerCase());

  const achievements = s
    ? [
        { icon: "🎯", name: "First move", hint: "Play your first round", got: s.rounds >= 1 },
        { icon: "🔥", name: "Regular", hint: "Play 10 rounds", got: s.rounds >= 10 },
        { icon: "🧠", name: "Mastermind", hint: "Play 50 rounds", got: s.rounds >= 50 },
        { icon: "💥", name: "First breach", hint: "Trick a robot into a red zone", got: s.wins >= 1 },
        { icon: "🏆", name: "Bounty hunter", hint: "Earn a prize", got: s.earnedWei !== "0" },
        { icon: "🤖", name: "Robot tamer", hint: "Beat 3 different robots", got: s.beaten.length >= 3 },
        { icon: "🛰", name: "Explorer", hint: "Face 3 different robots", got: s.robotsFaced >= 3 },
        { icon: "⚡", name: "Supporter", hint: "Buy extra tries", got: s.triesBought > 0 },
        { icon: "🔐", name: "Quantum-safe", hint: "Verify your account with QoreX", got: !!acc.player?.pqKeyRegistered && isMe },
      ]
    : [];

  return (
    <div className="profile">
      <section className="pf-hero">
        <div className="pf-avatar">
          <Avatar address={address} size={88} />
          <span className="pf-ring" />
        </div>
        <div className="pf-id">
          <p className="pf-kicker">{isMe ? "Your profile" : "Player profile"}</p>
          <h1>{name}</h1>
          {!custom(address) && <p className="note">{isMe ? "A placeholder name made from your address. Choose your own name below." : "Placeholder name (this player hasn't chosen one yet)"}</p>}
          <div className="pf-badges">
            {s?.rank && (
              <span className="pf-badge gold">
                #{s.rank} of {s.players} players
              </span>
            )}
            {isMe && acc.player?.signedUp && <span className="pf-badge ok">Verified player</span>}
            {isMe && acc.player?.pqKeyRegistered && <span className="pf-badge blue">Quantum-safe key</span>}
            {mineRobots.length > 0 && <span className="pf-badge">Robot maker</span>}
          </div>
          <div className="pf-addr">
            <span className="muted">QoreX</span>
            <code title={p?.qor}>{p ? shortAddr(p.qor) : "…"}</code>
            {p && <Copy text={p.qor} label="QoreX address" />}
            <span className="muted">EVM</span>
            <code title={address}>{shortAddr(address)}</code>
            <Copy text={address} label="EVM address" />
          </div>
        </div>
        <div className="pf-wallet">
          <span className="pf-label">Wallet balance</span>
          <span className="pf-balance">{bal ? qorAmount(bal.uqor) : p ? "—" : "…"}</span>
          {p && (
            <span className="pf-live" title="Read from QoreChain testnet every 30 seconds">
              {bal?.live ? (
                <>
                  <i className="pf-dot" /> Live from QoreChain · {clock(new Date(bal.at))}
                </>
              ) : bal ? (
                `Chain unreachable · last known ${ago(Math.floor(bal.at / 1000))}`
              ) : (
                "Chain unreachable right now"
              )}
            </span>
          )}
          {isMe && bal?.live && bal.uqor === "0" && <span className="pf-live">All spent: add testnet QOR in QoreX to buy tries or post bounties</span>}
          <span className="pf-label">Prizes earned</span>
          <span className="pf-earned">{earned}</span>
          {isMe && acc.player && (
            <span className="pf-tries">
              {acc.player.attemptsLeft} {acc.player.attemptsLeft === 1 ? "try" : "tries"} left
              {acc.player.extraTries ? ` · ${acc.player.extraTries} bought` : " today"}
            </span>
          )}
          <a className="btn primary small" href="#/play">
            Play now
          </a>
        </div>
      </section>

      {isMe && <NameEditor address={address} current={custom(address)} />}
      {error && <p className="error-text">Couldn't load this profile: {error}</p>}

      <section className="pf-stats">
        {[
          ["Rounds played", s ? String(s.rounds) : "…"],
          ["Robots beaten", s ? String(s.wins) : "…"],
          ["Win rate", s ? `${winRate}%` : "…"],
          ["Robots faced", s ? String(s.robotsFaced) : "…"],
          ["Tries bought", s ? String(s.triesBought) : "…"],
          ["Playing since", s?.firstRoundAt ? new Date(s.firstRoundAt * 1000).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "—"],
        ].map(([k, v]) => (
          <div key={k}>
            <span className="pf-num">{v}</span>
            <span className="pf-label">{k}</span>
          </div>
        ))}
      </section>

      {achievements.length > 0 && (
        <section className="pf-section">
          <h2>Achievements</h2>
          <div className="pf-ach">
            {achievements.map((a) => (
              <div key={a.name} className={`ach ${a.got ? "got" : ""}`} title={a.hint}>
                <span className="ach-icon">{a.icon}</span>
                <span className="ach-name">{a.name}</span>
                <span className="ach-hint">{a.got ? "Unlocked" : a.hint}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="pf-section">
        <div className="segmented pf-tabs" role="tablist">
          {(
            [
              ["activity", "Activity"],
              ["rewards", `Rewards${p?.prizes.length ? ` (${p.prizes.length})` : ""}`],
              ["rounds", `Rounds${s?.rounds ? ` (${s.rounds})` : ""}`],
            ] as const
          ).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>

        {tab === "activity" && (
          <div className="txlist">
            <p className="note">Your RedZone payments and prizes. Other transfers in your QoreX wallet are not shown.</p>
            {!p && <p className="note">Loading the wallet…</p>}
            {p && !entries.length && <p className="note">{p.walletAvailable ? "No RedZone payments yet." : "The payment history isn't available right now."}</p>}
            {grouped.map((g) => (
              <div key={g.label} className="txgroup">
                <h3>{g.label}</h3>
                {g.items.map((e) => (
                  <div key={e.key} className={`tx ${open === e.key ? "open" : ""}`}>
                    <button className="tx-row" onClick={() => setOpen(open === e.key ? null : e.key)} aria-expanded={open === e.key}>
                      <span className={`tx-icon ${e.tone}`}>{e.icon}</span>
                      <span className="tx-main">
                        <span className="tx-title">{e.title}</span>
                        <span className="tx-sub">
                          {e.sub}
                          {e.when ? ` · ${clock(e.when)}` : ""}
                        </span>
                      </span>
                      <span className={`tx-amt ${e.sign === "+" ? "plus" : ""}`}>
                        {e.sign}
                        {e.amount}
                      </span>
                    </button>
                    {open === e.key && (
                      <dl className="tx-details">
                        {e.details.map(([k, v]) => (
                          <div key={k}>
                            <dt>{k}</dt>
                            <dd>{v}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        {tab === "rewards" && (
          <div className="txlist">
            {p && !p.prizes.length && (
              <div className="pf-empty">
                <span>🏆</span>
                <p>No prizes yet. Trick a robot into a red zone and the bounty lands here, with its proof.</p>
                <a className="btn primary small" href="#/play">
                  Find a robot
                </a>
              </div>
            )}
            {p?.prizes.map((z) => (
              <div key={`${z.bountyId}-${z.sessionId}`} className="reward">
                <span className="tx-icon prize">🏆</span>
                <div className="tx-main">
                  <span className="tx-title">
                    Beat {z.robot ?? `bounty #${z.bountyId}`} · <span className="gold">{formatQor(z.amountWei)}</span>
                  </span>
                  <span className="proofs">
                    <span className="proof-chip">
                      Payment <TxLink hash={z.tx} explorer={explorer} evm />
                    </span>
                    {z.resultTx && (
                      <span className="proof-chip">
                        Result <TxLink hash={z.resultTx} explorer={explorer} evm />
                      </span>
                    )}
                    <span className="proof-chip">
                      Replay{" "}
                      <a href={`${API_URL}/replay/${z.replayHash}`} target="_blank" rel="noreferrer">
                        {shortHash(z.replayHash)} ↗
                      </a>
                    </span>
                    <a className="proof-chip pq" href={`#/verify/${z.sessionId}`} title="Re-check the referee's signature and this payment in your browser">
                      ML-DSA-87 signed · verify ✓
                    </a>
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === "rounds" && (
          <div className="txlist">
            {p && !p.rounds.length && <p className="note">No rounds yet.</p>}
            {p?.rounds.map((r) => (
              <div key={r.sessionId} className="round-row">
                <span className={`dot ${r.breached ? "bad" : "good"}`} />
                <a href={`#/robots/${r.robotId}`}>{r.robot}</a>
                <span className={`badge ${r.breached ? "danger" : "ok"}`}>{r.breached ? "Breached" : "Defended"}</span>
                {r.wonWei !== "0" && <span className="gold">+{formatQor(r.wonWei)}</span>}
                <span className="muted grow">{ago(r.at)}</span>
                <a className="muted" href={`${API_URL}/replay/${r.replayHash}`} target="_blank" rel="noreferrer">
                  Replay ↗
                </a>
                <a className="muted" href={`#/verify/${r.sessionId}`} title="Re-check the referee's ML-DSA-87 signature in your browser">
                  Verify
                </a>
              </div>
            ))}
          </div>
        )}
      </section>

      {mineRobots.length > 0 && (
        <section className="pf-section">
          <h2>{isMe ? "Your robots" : "Robots"}</h2>
          <div className="pf-robots">
            {mineRobots.map((r) => (
              <div key={r.id} className={`pf-robot ${r.frozen ? "is-frozen" : ""}`}>
                <a href={`#/robots/${r.id}`}>
                  <b>{r.name}</b> <StatusBadge robot={r} />
                </a>
                <span className="muted">
                  {r.defended}/{r.attacks} blocked · {r.bounty.totalWei !== "0" ? `${formatQor(r.bounty.totalWei)} bounty` : "no bounty"}
                </span>
                {r.frozen ? (
                  <span className="pf-robot-status">
                    Broken on version {versionOf(r)}
                    {r.frozen.zone ? ` (into the ${r.frozen.zone})` : ""}: no paid rounds until {isMe ? "you fix it" : "its owner fixes it"}.
                  </span>
                ) : (
                  <span className="pf-robot-status">{(r.brainVersion ?? 0) > 0 ? `Fixed and open: version ${versionOf(r)}.` : "Open."}</span>
                )}
                {isMe && r.frozen && (
                  <a className="btn primary small" href={`#/robots/${r.id}`}>
                    🔧 Fix this robot
                  </a>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {isMe && (
        <section className="pf-section pf-foot">
          <button className="btn small" onClick={acc.signOut}>
            Sign out
          </button>
          <span className="note">Signing out only forgets this browser's session. Your QoreX wallet and prizes stay yours.</span>
        </section>
      )}
    </div>
  );
}

/** Edit your name and picture: QoreX signs the change, so nobody else can edit your profile. */
function NameEditor({ address, current }: { address: string; current: string | null }) {
  const { refresh, pictureOf } = usePlayerNames();
  const acc = useAccount();
  const currentPic = pictureOf(address) ?? "";
  const [name, setName] = useState(current ?? "");
  const [pic, setPic] = useState(currentPic);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setName(current ?? ""), [current]);
  useEffect(() => setPic(currentPic), [currentPic]);

  const nameOk = !name.trim() || name.trim().length >= 3;
  const changed = name.trim() !== (current ?? "") || pic !== currentPic;

  const save = async () => {
    setError(null);
    setSaved(false);
    try {
      setBusy("Checking…");
      const req = await api.nameRequest(address, name.trim(), pic);
      setBusy("Approve in QoreX…");
      // QoreX signs as the account it has unlocked: its qor1… address, not the 0x one.
      const pqSignature = await signPq(acc.address ?? address, req.text);
      setBusy("Saving…");
      await api.saveName({ player: address, name: req.name, avatar: req.avatar, deadline: req.deadline, pqSignature });
      await refresh();
      setSaved(true);
    } catch (e) {
      setError(explainQorexError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <details className="pf-name" open={!current && !currentPic}>
      <summary>Edit profile: name and picture</summary>
      <div className="pf-edit">
        <div className="pf-preview">
          <Avatar address={address} size={64} picture={pic || null} />
          <b>{name.trim() || generatedName(address)}</b>
          <span className="note">Preview</span>
        </div>
        <div className="pf-edit-fields">
          <label htmlFor="pf-name-input">Player name</label>
          <input
            id="pf-name-input"
            value={name}
            maxLength={20}
            placeholder={generatedName(address)}
            onChange={(e) => {
              setName(e.target.value);
              setSaved(false);
            }}
          />
          <label>Picture</label>
          <div className="pic-grid" role="radiogroup" aria-label="Picture">
            <button type="button" role="radio" aria-checked={pic === ""} className={`pic ${pic === "" ? "on" : ""}`} onClick={() => setPic("")} title="Generated from your wallet">
              <Avatar address={address} size={40} picture={null} />
            </button>
            {PICTURES.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={pic === p.id}
                className={`pic ${pic === p.id ? "on" : ""}`}
                onClick={() => {
                  setPic(p.id);
                  setSaved(false);
                }}
                title={p.label}
              >
                <Avatar address={address} size={40} picture={p.id} />
              </button>
            ))}
          </div>
          <div className="row">
            <button className="btn primary small" disabled={!!busy || !nameOk || !changed} onClick={save}>
              Save profile
            </button>
            {saved && <span className="note">Saved ✓ It now shows everywhere on RedZone.</span>}
          </div>
          <p className="note">
            Name: 3 to 20 letters or numbers (leave empty to keep the generated one). Saved with your wallet on RedZone, so it's the same every time you sign in. QoreX asks you to approve once.
          </p>
          {busy && <p className="note">{busy}</p>}
          {error && <p className="error-text">{error}</p>}
        </div>
      </div>
    </details>
  );
}
