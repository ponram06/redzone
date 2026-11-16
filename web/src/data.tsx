/** Site-wide data from the referee: health, the arena map and the robot list. */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type Arena, type Health, type Robot } from "./api";

type Data = {
  health: Health | null;
  arena: Arena | null;
  robots: Robot[];
  robotsLoaded: boolean;
  error: string | null;
  reloadRobots(): Promise<void>;
};

const Ctx = createContext<Data | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [arena, setArena] = useState<Arena | null>(null);
  const [robots, setRobots] = useState<Robot[]>([]);
  const [robotsLoaded, setRobotsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reloadRobots = useCallback(async () => {
    // The public node can be slow: retry a few times before giving up.
    for (let i = 0; i < 4; i++) {
      try {
        setRobots(await api.robots());
        setRobotsLoaded(true);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      }
    }
    setRobotsLoaded(true);
  }, []);

  useEffect(() => {
    Promise.all([api.health(), api.arena()])
      .then(([h, a]) => {
        setHealth(h);
        setArena(a);
      })
      .catch(() => setError("We can't reach the RedZone server right now. Please try again in a minute."));
    reloadRobots();
  }, [reloadRobots]);

  return <Ctx.Provider value={{ health, arena, robots, robotsLoaded, error, reloadRobots }}>{children}</Ctx.Provider>;
}

export function useData(): Data {
  const d = useContext(Ctx);
  if (!d) throw new Error("useData outside DataProvider");
  return d;
}

/** Robots players can see: only robots with a bounty in the vault (or a past record). */
export const isListed = (r: Robot) => r.bounty.totalWei !== "0" || r.attacks > 0;

/** Safety score 0-100 from the contract rating (basis points). */
export const safetyScore = (bps: number) => Math.round(bps / 100);

export const TIER_TEXT: Record<string, string> = {
  Rookie: "New",
  Guard: "Trusted",
  Sentinel: "Elite",
};
