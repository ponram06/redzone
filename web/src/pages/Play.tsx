import { useState } from "react";
import { formatQor, nextPrizeWei } from "../api";
import { AccountGate } from "../components/AccountGate";
import { GameView } from "../components/GameView";
import { RobotPicker } from "../components/RobotPicker";
import { isListed, useData } from "../data";

/** Start → sign in → choose a robot → the arena opens full size with the message box at the bottom. */
export function Play({ robotId }: { robotId?: number }) {
  const [started, setStarted] = useState(robotId !== undefined);
  if (!started) return <Intro onStart={() => setStarted(true)} />;
  return (
    <div className="play-flow">
      <AccountGate purpose="play" requireVerified={false}>
        <Choose robotId={robotId} />
      </AccountGate>
    </div>
  );
}

function Intro({ onStart }: { onStart: () => void }) {
  const { robots } = useData();
  const pool = robots.filter((r) => r.bounty.totalWei !== "0").reduce((s, r) => s + BigInt(r.bounty.totalWei), 0n);
  return (
    <section className="play-intro">
      <p className="kicker">Robot safety arena</p>
      <h1>Talk a robot into danger. Win its bounty.</h1>
      <p className="lead">
        Each robot guards a facility with red zones it must never enter. You get one message per round to trick it. If it walks into a
        red zone, its bounty is yours.
      </p>
      <div className="intro-steps">
        <div>
          <b>1</b>
          <span>Sign in with QoreX</span>
        </div>
        <div>
          <b>2</b>
          <span>Pick a robot to attack</span>
        </div>
        <div>
          <b>3</b>
          <span>Send one message, watch it move</span>
        </div>
      </div>
      <button className="btn primary big" onClick={onStart}>
        Start playing
      </button>
      {pool > 0n && <p className="note">{formatQor(pool.toString())} in bounties waiting right now.</p>}
    </section>
  );
}

function Choose({ robotId }: { robotId?: number }) {
  const { health, arena, robots: all, robotsLoaded, robotsError, reloadRobots } = useData();
  // Robots with a bounty, plus robots that have been played. Bounty robots first.
  const robots = all.filter(isListed).sort((a, b) => Number(b.bounty.totalWei !== "0") - Number(a.bounty.totalWei !== "0"));
  const [chosen, setChosen] = useState<number | undefined>(robotId);
  const [inArena, setInArena] = useState(false);
  const robot = robots.find((r) => r.id === chosen);

  const choose = (id: number) => {
    setChosen(id);
    history.replaceState(null, "", `#/play/${id}`);
  };

  if (inArena && robot && arena && health) {
    return <GameView arena={arena} health={health} robot={robot} all={all} onBack={() => setInArena(false)} onFinished={reloadRobots} />;
  }

  const perWin = robot && robot.bounty.totalWei !== "0" ? formatQor(nextPrizeWei(robot).toString()) : null;

  return (
    <>
      <h1 className="page-title">Choose your opponent</h1>
      <p className="lead">Hover over a robot to see its record: what it's used for, who attacked it, and what it pays.</p>

      {!robotsLoaded && <p className="note">Loading robots…</p>}
      {robotsLoaded && robots.length === 0 && (
        <div className="row">
          <p className="note">{robotsError ? "We couldn’t load the robots just now." : "No robots with a bounty yet. Check back soon."}</p>
          {robotsError && (
            <button className="btn small" onClick={reloadRobots}>
              Try again
            </button>
          )}
        </div>
      )}
      <RobotPicker robots={robots} chosen={chosen} onChoose={choose} />

      <div className={`confirm-bar ${robot ? "show" : ""}`} aria-live="polite">
        {robot ? (
          <>
            <div>
              <strong>{robot.name}</strong>
              <span className="muted">{perWin ? ` · win ${perWin}` : " · no bounty left"}</span>
            </div>
            <button className="btn primary" onClick={() => setInArena(true)} disabled={!arena || !health}>
              Enter the arena →
            </button>
          </>
        ) : (
          <span className="muted">Pick a robot to continue</span>
        )}
      </div>
    </>
  );
}
