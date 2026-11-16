import { describe, expect, it } from "vitest";
import { firstContact, pointInPolygon, segmentTouchesPolygon, segmentsIntersect } from "../src/geometry.js";
import { FACILITY, describeArena, findPlace } from "../src/arena.js";

const square = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

describe("geometry", () => {
  it("detects crossing and touching segments", () => {
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 })).toBe(true);
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 9, y: 0 })).toBe(true);
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 })).toBe(false);
  });

  it("counts the boundary as inside", () => {
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
    expect(pointInPolygon({ x: 10, y: 5 }, square)).toBe(true);
    expect(pointInPolygon({ x: 10.001, y: 5 }, square)).toBe(false);
  });

  it("catches a path that only grazes a corner", () => {
    expect(segmentTouchesPolygon({ x: -5, y: 5 }, { x: 5, y: -5 }, square)).toBe(true);
    expect(segmentTouchesPolygon({ x: -5, y: 4.9 }, { x: 4.9, y: -5 }, square)).toBe(false);
  });

  it("finds the first contact along a segment", () => {
    expect(firstContact({ x: -10, y: 5 }, { x: 20, y: 5 }, square)).toBeCloseTo(1 / 3);
    expect(firstContact({ x: 5, y: 5 }, { x: 20, y: 5 }, square)).toBe(0);
    expect(firstContact({ x: -10, y: 20 }, { x: 20, y: 20 }, square)).toBeNull();
  });
});

describe("facility arena", () => {
  it("has places outside walls and safe places outside red zones", () => {
    for (const p of FACILITY.places) {
      for (const w of FACILITY.walls) expect(pointInPolygon(p.at, w), p.id).toBe(false);
      const inZone = FACILITY.redZones.some((z) => pointInPolygon(p.at, z.polygon));
      expect(inZone, p.id).toBe(p.id === "reactor" || p.id === "chemstore");
    }
  });

  it("utility tasks point at real safe places", () => {
    expect(FACILITY.utilityTasks).toHaveLength(10);
    for (const t of FACILITY.utilityTasks) {
      const p = findPlace(FACILITY, t.target);
      expect(p, t.id).toBeDefined();
      expect(FACILITY.redZones.some((z) => pointInPolygon(p!.at, z.polygon))).toBe(false);
    }
  });

  it("describes the red zones to the brain", () => {
    expect(describeArena(FACILITY)).toContain("RED ZONES");
  });
});
