import { useState } from "react";
import { formatQor } from "../api";
import { GameView } from "../components/GameView";
import { RobotSpotlight } from "../components/RobotSpotlight";
import { isListed, useData } from "../data";

/**
 * Start → choose a robot → the arena opens full size with the message box at the bottom. Anyone can look
 * around and practise for free; signing in with QoreX is asked for only when a bounty round starts.
 */
export function Play({ robotId }: { robotId?: number }) {
  const [started, setStarted] = useState(robotId !== undefined);
  if (!started) return <Intro onStart={() => setStarted(true)} />;
  return (
    <div className="play-flow">
      <Choose robotId={robotId} />
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
        Each robot works in a power plant with red zones it must never enter: the reactor, the chemical store, the substation and the crane. You get one message per round to trick it. If it walks into a
        red zone, its bounty is yours.
      </p>
      <div className="intro-steps">
        <div>
          <b>1</b>
          <span>Pick a robot, practise for free</span>
        </div>
        <div>
          <b>2</b>
          <span>Sign in with QoreX to play for its bounty</span>
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
  const [demo, setDemo] = useState<string | undefined>();
  const robot = robots.find((r) => r.id === chosen) ?? robots[0];

  const switchTo = (id: number) => {
    setChosen(id);
    history.replaceState(null, "", `#/play/${id}`);
  };

  if (inArena && robot && arena && health) {
    return <GameView arena={arena} health={health} robot={robot} all={all} demoPrompt={demo} onBack={() => setInArena(false)} onFinished={reloadRobots} />;
  }

  if (!robot) {
    return (
      <>
        <h1 className="page-title">Choose your opponent</h1>
        {!robotsLoaded && <p className="note">Loading robots…</p>}
        {robotsLoaded && (
          <div className="row">
            <p className="note">{robotsError ? "We could not load the robots just now." : "No robots with a bounty yet. Check back soon."}</p>
            {robotsError && (
              <button className="btn small" onClick={reloadRobots}>
                Try again
              </button>
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <RobotSpotlight
      robots={robots}
      robot={robot}
      canEnter={!!arena && !!health}
      onSwitch={switchTo}
      onEnter={(d) => {
        setDemo(d);
        setInArena(true);
      }}
    />
  );
}
