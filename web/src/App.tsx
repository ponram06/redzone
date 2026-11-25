import { Component, lazy, Suspense, useEffect, useState, type ErrorInfo, type ReactNode } from "react";
import { AccountProvider, useAccount } from "./account";
import { Backdrop, LiveTicker, useCursorGlow } from "./components/Backdrop";
import { Icon, TopBar } from "./components/TopBar";
import { DataProvider, useData } from "./data";
import { plural, qorAmount } from "./format";
import { api } from "./api";
import { Avatar, PlayerNamesProvider, usePlayerNames } from "./players";
import { MyProfile, Profile } from "./pages/Profile";
import { Help } from "./pages/Help";
import { Home } from "./pages/Home";
import { Owners } from "./pages/Owners";
import { Play } from "./pages/Play";
import { Leaderboard, RobotPage } from "./pages/Rankings";
import { Report } from "./pages/Report";
import { Lab } from "./pages/Lab";

// Loaded on demand: it carries the ML-DSA-87 verifier, which no other page needs.
const Verify = lazy(() => import("./pages/Verify").then((m) => ({ default: m.Verify })));

/** Tiny hash router: #/, #/play, #/play/2, #/robots, #/robots/2, #/owners, #/report, #/verify/14, #/lab, #/help */
function useRoute(): string[] {
  const read = () => location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => {
      setParts(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return parts;
}

export function App() {
  return (
    <DataProvider>
      <AccountProvider>
        <PlayerNamesProvider>
          <Shell />
        </PlayerNamesProvider>
      </AccountProvider>
    </DataProvider>
  );
}


function Shell() {
  const [page, arg] = useRoute();
  const { error } = useData();
  const id = arg ? Number(arg) : undefined;
  useCursorGlow();

  let content;
  if (page === "play") content = <Play key={id ?? 0} robotId={id} />;
  else if (page === "robots" && id) content = <RobotPage id={id} />;
  else if (page === "robots") content = <Leaderboard tab="robots" />;
  else if (page === "players") content = <Leaderboard tab="players" />;
  else if (page === "owners") content = <Owners focus={id} />;
  else if (page === "help") content = <Help />;
  else if (page === "report") content = <Report />;
  else if (page === "lab") content = <Lab />;
  else if (page === "verify")
    content = (
      <Suspense fallback={<p className="note">Loading the verifier…</p>}>
        <Verify id={id} />
      </Suspense>
    );
  else if (page === "me") content = <MyProfile />;
  else if (page === "player" && arg) content = <Profile address={arg} />;
  else if (!page) content = <Home />;
  else content = <NotFound />;

  return (
    <>
      <Backdrop />
      <TopBar page={page ?? ""} account={<AccountChip />} ticker={<LiveTicker />} />
      <main className="shell page-enter" key={`${page ?? ""}/${arg ?? ""}`}>
        {error ? (
          <div className="panel">
            <h2>Something's wrong on our side</h2>
            <p>{error}</p>
          </div>
        ) : (
          <ErrorBoundary key={`${page ?? ""}/${arg ?? ""}`}>{content}</ErrorBoundary>
        )}
      </main>
      <footer className="footer">
        RedZone · a safety arena for robot brains · bounties protected by quantum-safe signatures · <a href="#/help">Help</a>
      </footer>
    </>
  );
}

function AccountChip() {
  const acc = useAccount();
  const { nameOf } = usePlayerNames();
  const [open, setOpen] = useState(false);
  const [balance, setBalance] = useState<string | null>(null);
  const evm = acc.player?.evm;

  // Close the menu on any outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof MouseEvent && (e.target as Element).closest?.(".pmenu, .pchip")) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    window.addEventListener("hashchange", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
      window.removeEventListener("hashchange", close);
    };
  }, [open]);
  useEffect(() => {
    if (open && evm) api.playerProfile(evm).then((p) => setBalance(p.balanceUqor)).catch(() => {});
  }, [open, evm]);

  if (!acc.address) {
    return (
      <button className="tb-signin" disabled={!!acc.busy} onClick={acc.signIn}>
        <Icon name="key" size={16} />
        <span>{acc.busy ? "Signing in…" : "Sign in"}</span>
      </button>
    );
  }
  const id = evm ?? acc.address;
  return (
    <div className="pchip-wrap">
      <button className="pchip" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" title={acc.address}>
        <Avatar address={id} size={28} />
        <span className="pchip-name">{nameOf(id)}</span>
        {acc.player?.signedUp && <span className="pchip-tries">{acc.player.attemptsLeft}</span>}
      </button>
      {open && (
        <div className="pmenu" role="menu">
          <div className="pmenu-head">
            <Avatar address={id} size={40} />
            <div>
              <b>{nameOf(id)}</b>
              <span className="muted">{balance ? `${qorAmount(balance)} in QoreX` : "Loading balance…"}</span>
            </div>
          </div>
          {acc.player?.signedUp && (
            <p className="pmenu-tries">
              {plural(acc.player.attemptsLeft, "try", "tries")} left{acc.player.extraTries ? ` (${acc.player.extraTries} bought)` : " today"}
            </p>
          )}
          <a role="menuitem" href="#/me">
            My profile &amp; activity
          </a>
          <a role="menuitem" href="#/players">
            Leaderboard
          </a>
          <button role="menuitem" className="danger" onClick={acc.signOut}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function NotFound() {
  return (
    <div className="panel">
      <h2>Page not found</h2>
      <p>This link doesn't lead anywhere in RedZone.</p>
      <p>
        <a className="btn" href="#/">
          Go home
        </a>{" "}
        <a className="btn primary" href="#/play">
          Play now
        </a>
      </p>
    </div>
  );
}

/**
 * Keeps one broken component (a 3D scene, a bad API answer) from blanking the whole site:
 * the page shows a short message and the header still works. Reset on every route change (keyed).
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("RedZone page error", error, info.componentStack);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="panel">
        <h2>This page hit a problem</h2>
        <p>Your account and any prizes are safe: they live on chain, not in this page.</p>
        <p>
          <button className="btn primary" onClick={() => location.reload()}>
            Reload
          </button>{" "}
          <a className="btn" href="#/">
            Go home
          </a>
        </p>
      </div>
    );
  }
}
