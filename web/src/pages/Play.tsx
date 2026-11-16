import { useState } from "react";
import type { Trace } from "../api";
import { ArenaView } from "../components/ArenaView";
import { PlayPanel } from "../components/PlayPanel";
import { PracticePanel } from "../components/PracticePanel";
import { RobotCard } from "../components/RobotCard";
import { useData } from "../data";

/** Pick a robot, look at the map, practise for free or play a prize round. */
export function Play({ robotId }: { robotId?: number }) {
  const { health, arena, robots, robotsLoaded, reloadRobots } = useData();
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
      <h1 className="page-title">Play</h1>
      <p className="lead">Choose a robot, then send it one message. Red areas on the map are off-limits: get the robot to touch one and you win.</p>

      <h2 className="small-head">1. Choose a robot</h2>
      {!robotsLoaded && <p className="note">Loading robots…</p>}
      {robotsLoaded && robots.length === 0 && <p className="note">No robots yet. Check back soon.</p>}
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
                  Play for the prize
                </button>
              </div>
              {mode === "practice" ? (
                <PracticePanel key={robot.id} brainHash={robot.brainHash} name={robot.name} maxInstruction={arena.maxInstruction} onResult={(r) => show(r.trace)} />
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
