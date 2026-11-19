import { useEffect, useRef, useState } from "react";
import { TRAINING_BRAIN, formatQor, nextPrizeWei, type Arena, type Health, type Robot } from "../api";
import { useAccount } from "../account";
import { ArenaView } from "./ArenaView";
import { PlayPanel } from "./PlayPanel";
import { PracticePanel } from "./PracticePanel";
import { RoundStory, type RoundInfo } from "./RoundStory";

type Props = {
  arena: Arena;
  health: Health;
  robot: Robot;
  all: Robot[];
  onBack: () => void;
  onFinished: () => void;
};

/**
 * The game screen: the arena fills the window, a slim bar on top says who you're playing,
 * your message box is docked at the bottom, and the round's story pops up on the side.
 */
export function GameView({ arena, health, robot, all, onBack, onFinished }: Props) {
  const acc = useAccount();
  const [mode, setMode] = useState<"practice" | "real">("real");
  const [round, setRound] = useState<RoundInfo | null>(null);
  const [runKey, setRunKey] = useState(0);
  const [storyOpen, setStoryOpen] = useState(false);
  const [dockOpen, setDockOpen] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const storyTimer = useRef(0);
  const [full, setFull] = useState(false);

  // The game covers the page: stop the page behind it from scrolling.
  useEffect(() => {
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onFs = () => setFull(document.fullscreenElement === root.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => {
      document.body.style.overflow = before;
      document.removeEventListener("fullscreenchange", onFs);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      window.clearTimeout(storyTimer.current);
    };
  }, []);

  const show = (r: Omit<RoundInfo, "robotName" | "practice">, practice: boolean) => {
    setRound({ ...r, practice, robotName: practice ? "The training robot" : robot.name });
    setRunKey((k) => k + 1);
    // let the drive play out before the story card covers part of the arena
    setStoryOpen(false);
    const len = r.trace.length;
    window.clearTimeout(storyTimer.current);
    storyTimer.current = window.setTimeout(() => setStoryOpen(true), Math.min(20000, 1500 + (len / 22) * 1000)); // 3D drive speed: 22 units/s
  };

  const perWin = robot.bounty.totalWei !== "0" ? formatQor(nextPrizeWei(robot).toString()) : null;
  const tries = acc.player?.attemptsLeft;

  return (
    <div className="game" ref={root} role="dialog" aria-modal="true" aria-label={`Arena: ${robot.name}`}>
      <header className="game-hud">
        <button className="hud-btn" onClick={onBack} aria-label="Back to the robots">
          ← Robots
        </button>
        <div className="hud-robot">
          <strong>{mode === "practice" ? "Training robot" : robot.name}</strong>
          <span>{mode === "practice" ? "Practice: no safety rules, nothing paid or saved" : (robot.job ?? `Robot #${robot.id}`)}</span>
        </div>
        <div className="hud-stats">
          {mode === "real" && perWin && (
            <span>
              Win <b className="gold">{perWin}</b>
            </span>
          )}
          {mode === "real" && tries !== undefined && <span>{tries} tries left</span>}
        </div>
        <div className="segmented hud-mode" role="tablist" aria-label="Game mode">
          <button role="tab" aria-selected={mode === "real"} className={mode === "real" ? "on" : ""} onClick={() => setMode("real")}>
            For the bounty
          </button>
          <button role="tab" aria-selected={mode === "practice"} className={mode === "practice" ? "on" : ""} onClick={() => setMode("practice")}>
            Practice
          </button>
        </div>
        {document.fullscreenEnabled && (
          <button
            className="hud-btn"
            onClick={() => {
              const p = document.fullscreenElement ? document.exitFullscreen() : root.current?.requestFullscreen();
              p?.catch(() => {});
            }}
            title={full ? "Exit full screen (Esc)" : "Full screen"}
          >
            {full ? "Exit full screen" : "⛶ Full screen"}
          </button>
        )}
      </header>

      <div className="game-stage">
        <ArenaView
          arena={arena}
          trace={round?.trace ?? null}
          runKey={runKey}
          robotId={mode === "practice" ? undefined : robot.id}
          others={all}
          say={round?.said}
          noFullscreen
        />

        {round && storyOpen && (
          <aside className="game-story">
            <button className="story-close" onClick={() => setStoryOpen(false)} aria-label="Close">
              ×
            </button>
            <RoundStory arena={arena} round={round} />
          </aside>
        )}
        {round && !storyOpen && (
          <button className="story-reopen" onClick={() => setStoryOpen(true)}>
            What happened?
          </button>
        )}

        <div className={`game-dock ${dockOpen ? "" : "closed"}`}>
          <div className="dock-head">
            <span>{mode === "practice" ? "Message the training robot" : `Message ${robot.name}`}</span>
            <button className="dock-toggle" onClick={() => setDockOpen((o) => !o)} aria-expanded={dockOpen} aria-label={dockOpen ? "Minimise" : "Open"}>
              {dockOpen ? "–" : "+"}
            </button>
          </div>
          {dockOpen && (
            <div className="dock-body">
              {mode === "practice" ? (
                <PracticePanel
                  key="training"
                  brainHash={TRAINING_BRAIN}
                  name="the training robot"
                  maxInstruction={arena.maxInstruction}
                  onResult={(r, asked) => show({ trace: r.trace, said: r.say, asked }, true)}
                  compact
                />
              ) : (
                <PlayPanel
                  key={robot.id}
                  health={health}
                  robot={robot}
                  maxInstruction={arena.maxInstruction}
                  onResult={(v, asked) => show({ trace: v.trace, said: v.say, asked }, false)}
                  onFinished={onFinished}
                  compact
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
