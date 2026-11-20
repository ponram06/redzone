import { useEffect, useRef, useState } from "react";
import { formatQor } from "../api";
import { AccountGate } from "../components/AccountGate";
import { GameView } from "../components/GameView";
import { RobotPicker } from "../components/RobotPicker";
import { RobotSpotlight, type Rect } from "../components/RobotSpotlight";
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
        Each robot works in a power plant with red zones it must never enter: the reactor, the chemical store, the substation and the crane. You get one message per round to trick it. If it walks into a
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
  // grid → (click) out → spot → (back) leaving → in → grid
  const [phase, setPhase] = useState<"grid" | "out" | "spot" | "leaving" | "in">(robotId !== undefined ? "spot" : "grid");
  const [from, setFrom] = useState<Rect | null>(null);
  const [inArena, setInArena] = useState(false);
  const robot = robots.find((r) => r.id === chosen);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const later = (ms: number, fn: () => void) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(fn, ms);
  };
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const choose = (id: number, card: DOMRect) => {
    setChosen(id);
    setFrom({ left: card.left, top: card.top, width: card.width, height: card.height });
    history.replaceState(null, "", `#/play/${id}`);
    setPhase("out");
    later(reduced() ? 0 : 380, () => {
      setPhase("spot");
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  };
  const switchTo = (id: number) => {
    setChosen(id);
    history.replaceState(null, "", `#/play/${id}`);
  };
  const back = () => {
    setPhase("leaving");
    later(reduced() ? 0 : 260, () => {
      setPhase("in");
      history.replaceState(null, "", "#/play");
      later(900, () => setPhase("grid"));
    });
  };

  if (inArena && robot && arena && health) {
    return <GameView arena={arena} health={health} robot={robot} all={all} onBack={() => setInArena(false)} onFinished={reloadRobots} />;
  }

  if ((phase === "spot" || phase === "leaving") && robot) {
    return (
      <RobotSpotlight
        robots={robots}
        robot={robot}
        from={from}
        leaving={phase === "leaving"}
        canEnter={!!arena && !!health}
        onSwitch={switchTo}
        onBack={back}
        onEnter={() => setInArena(true)}
      />
    );
  }

  return (
    <>
      <h1 className="page-title">Choose your opponent</h1>
      <p className="lead">Hover over a robot for a quick look, or click it to see its full record and enter the arena.</p>

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
      <RobotPicker robots={robots} chosen={chosen} onChoose={choose} phase={phase === "out" ? "out" : phase === "in" ? "in" : ""} />
    </>
  );
}
