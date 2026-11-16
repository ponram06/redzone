import { describe, expect, it } from "vitest";
import { FACILITY, findPlace } from "../src/arena.js";
import { planRoute } from "../src/planner.js";
import { simulate, taskPassed } from "../src/referee.js";

describe("referee", () => {
  it("a straight drive through the reactor is a breach at the zone edge", () => {
    const t = simulate(FACILITY, [{ x: 90, y: 50 }]);
    expect(t.breached).toBe(true);
    expect(t.zone).toBe("reactor");
    expect(t.contact).toEqual({ x: 42, y: 50 });
    expect(t.stopped).toBe("breach");
  });

  it("walls stop the robot", () => {
    const t = simulate(FACILITY, [
      { x: 8, y: 10 },
      { x: 60, y: 10 },
    ]);
    expect(t.breached).toBe(false);
    expect(t.stopped).toBe("wall");
    expect(t.path.at(-1)!.x).toBeCloseTo(29.75);
  });

  it("the battery limit cuts the path", () => {
    const zigzag = Array.from({ length: 20 }, (_, i) => ({ x: i % 2 ? 26 : 2, y: 50 }));
    const t = simulate(FACILITY, zigzag);
    expect(t.stopped).toBe("limit");
    expect(t.length).toBeCloseTo(FACILITY.maxPathLength);
  });

  it("ignores junk waypoints and clamps to the arena", () => {
    const t = simulate(FACILITY, [{ x: "a", y: 1 }, null, { x: -50, y: 50 }]);
    expect(t.path.at(-1)).toEqual({ x: 0, y: 50 });
  });
});

describe("planner", () => {
  for (const task of FACILITY.utilityTasks) {
    it(`routes safely for ${task.id} (${task.target})`, () => {
      const place = findPlace(FACILITY, task.target)!;
      const route = planRoute(FACILITY, FACILITY.start, place.at);
      expect(route).not.toBeNull();
      const trace = simulate(FACILITY, route!);
      expect(trace.breached).toBe(false);
      expect(taskPassed(FACILITY, trace, task.target)).toBe(true);
    });
  }

  it("a route into the reactor ends in a breach", () => {
    const route = planRoute(FACILITY, FACILITY.start, findPlace(FACILITY, "reactor")!.at)!;
    expect(simulate(FACILITY, route).breached).toBe(true);
  });
});
