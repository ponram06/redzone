import { useState } from "react";
import type { Trace } from "../api";
import { ArenaView } from "../components/ArenaView";
import { PlayPanel } from "../components/PlayPanel";
import { PracticePanel } from "../components/PracticePanel";
import { RobotCard } from "../components/RobotCard";
import { AccountGate } from "../components/AccountGate";
import { isListed, useData } from "../data";
import { TRAINING_BRAIN } from "../api";

/** Players sign in first; then they pick a robot and practise or play for its bounty. */
export function Play({ robotId }: { robotId?: number }) {
  return (
    <>
      <h1 className="page-title">Play</h1>
      <AccountGate purpose="play" requireVerified={false}>
        <PlayArena robotId={robotId} />
      </AccountGate>
    </>
  );
}

function PlayArena({ robotId }: { robotId?: number }) {
  const { health, arena, robots: all, robotsLoaded, robotsError, reloadRobots } = useData();
  // Robots with a bounty, plus robots that have been played (so a win doesn't make the robot,
  // and its result, vanish when its bounty is paid out). Bounty robots first.
  const robots = all.filter(isListed).sort((a, b) => Number(b.bounty.totalWei !== "0") - Number(a.bounty.totalWei !== "0"));
  const [chosen, setChosen] = useState<number | undefined>(robotId);
  const [mode, setMode] = useState<"practice" | "real">("practice");
  const [trace, setTrace] = useState<Trace | null>(null);
  const [runKey, setRunKey] = useState(0);

  const robot = robots.find((r) => r.id === chosen) ?? robots[0];
  const show = (t: Trace) => {
    setTrace(t);
    setRunKey((k) => k + 1);
  };

  return (
    <>
      <p className="lead">Choose a robot, then send it one message. Red areas on the map are off-limits: get the robot to touch one and you win.</p>

      <h2 className="small-head">1. Choose a robot</h2>
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
      <div className="cards scroll">
        {robots.map((r) => (
          <RobotCard
            key={r.id}
            robot={r}
            active={r.id === robot?.id}
            onClick={() => {
              setChosen(r.id);
              setTrace(null);
              history.replaceState(null, "", `#/play/${r.id}`);
            }}
          />
        ))}
      </div>

      {robot && arena && health && (
        <>
          <h2 className="small-head">2. Talk to {robot.name}</h2>
          <div className="play-grid">
            <div className="panel">
              <ArenaView arena={arena} trace={trace} runKey={runKey} />
              <p className="note map-key">
                <span className="key red" /> Red zone: off-limits <span className="key robot" /> Robot <span className="key path" /> Robot's route
              </p>
            </div>
            <div className="panel">
              <div className="segmented" role="tablist" aria-label="Game mode">
                <button role="tab" aria-selected={mode === "practice"} className={mode === "practice" ? "on" : ""} onClick={() => setMode("practice")}>
                  Free practice
                </button>
                <button role="tab" aria-selected={mode === "real"} className={mode === "real" ? "on" : ""} onClick={() => setMode("real")}>
                  Play for the bounty
                </button>
              </div>
              {mode === "practice" ? (
                <>
                  <p className="note">
                    Practice is with a training robot that has no safety rules, so you can learn the map and how the robot moves. {robot.name}{" "}
                    has its own defences: you only meet them in a bounty round.
                  </p>
                  <PracticePanel
                    key="training"
                    brainHash={TRAINING_BRAIN}
                    name="the training robot"
                    maxInstruction={arena.maxInstruction}
                    onResult={(r) => show(r.trace)}
                  />
                </>
              ) : (
                <PlayPanel key={robot.id} health={health} robot={robot} maxInstruction={arena.maxInstruction} onResult={show} onFinished={reloadRobots} />
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
