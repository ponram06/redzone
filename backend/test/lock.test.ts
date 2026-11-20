import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lockDataDir } from "../src/lock.js";

describe("one server per data folder", () => {
  it("takes a free folder and writes its pid", () => {
    const dir = mkdtempSync(join(tmpdir(), "rz-lock-"));
    lockDataDir(dir);
    expect(readFileSync(join(dir, "server.lock"), "utf8")).toBe(String(process.pid));
  });

  it("takes over a lock left by a server that is gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "rz-lock-"));
    writeFileSync(join(dir, "server.lock"), "999999999");
    lockDataDir(dir);
    expect(readFileSync(join(dir, "server.lock"), "utf8")).toBe(String(process.pid));
  });

  it("refuses to start next to a live server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rz-lock-"));
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"]);
    try {
      writeFileSync(join(dir, "server.lock"), String(other.pid));
      expect(() => lockDataDir(dir)).toThrow(/Another RedZone server/);
    } finally {
      other.kill();
    }
  });
});
