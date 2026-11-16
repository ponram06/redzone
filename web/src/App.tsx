import { useEffect, useState } from "react";
import { AccountProvider, shortAddress, useAccount } from "./account";
import { DataProvider, useData } from "./data";
import { plural } from "./format";
import { Help } from "./pages/Help";
import { Home } from "./pages/Home";
import { Owners } from "./pages/Owners";
import { Play } from "./pages/Play";
import { Leaderboard, RobotPage } from "./pages/Rankings";

/** Tiny hash router: #/, #/play, #/play/2, #/robots, #/robots/2, #/owners, #/help */
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
        <Shell />
      </AccountProvider>
    </DataProvider>
  );
}

const NAV = [
  ["", "Home"],
  ["play", "Play"],
  ["robots", "Leaderboard"],
  ["owners", "For robot makers"],
  ["help", "Help"],
] as const;

function Shell() {
  const [page, arg] = useRoute();
  const { error } = useData();
  const id = arg ? Number(arg) : undefined;

  let content;
  if (page === "play") content = <Play key={id ?? 0} robotId={id} />;
  else if (page === "robots" && id) content = <RobotPage id={id} />;
  else if (page === "robots") content = <Leaderboard tab="robots" />;
  else if (page === "players") content = <Leaderboard tab="players" />;
  else if (page === "owners") content = <Owners />;
  else if (page === "help") content = <Help />;
  else content = <Home />;

  return (
    <>
      <header className="header">
        <div className="header-inner">
          <a className="brand" href="#/">
            <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
              <rect x="5" y="5" width="22" height="22" rx="3" fill="none" stroke="var(--danger)" strokeWidth="3" />
              <circle cx="16" cy="16" r="4" fill="var(--danger)" />
            </svg>
            RedZone
          </a>
          <nav className="nav" aria-label="Main">
            {NAV.map(([path, label]) => (
              <a key={path} href={`#/${path}`} className={(page === "players" ? "robots" : (page ?? "")) === path ? "on" : ""}>
                {label}
              </a>
            ))}
          </nav>
          <AccountChip />
        </div>
      </header>
      <main className="shell">
        {error ? (
          <div className="panel">
            <h2>Something's wrong on our side</h2>
            <p>{error}</p>
          </div>
        ) : (
          content
        )}
      </main>
      <footer className="footer">
        RedZone · a safety arena for robot brains · prizes protected by quantum-safe signatures · <a href="#/help">Help</a>
      </footer>
    </>
  );
}

function AccountChip() {
  const acc = useAccount();
  if (!acc.address) {
    return (
      <button className="btn small" disabled={!!acc.busy} onClick={acc.signIn}>
        Sign in
      </button>
    );
  }
  return (
    <div className="account">
      <span className="who" title={acc.address}>
        {shortAddress(acc.address)}
        {acc.player?.signedUp && <span className="note"> · {plural(acc.player.attemptsLeft, "try", "tries")} left</span>}
      </span>
      <button className="link" onClick={acc.signOut}>
        Sign out
      </button>
    </div>
  );
}
