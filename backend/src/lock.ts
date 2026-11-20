/**
 * One server per data folder. The relayer sends transactions from one key, so two servers would
 * race for the same nonces, and both would write the same verdict files. A second server started
 * on the same DATA_DIR stops at once with a clear message instead.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Take the folder's lock, or throw if another live server holds it. Released when this process exits. */
export function lockDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, "server.lock");
  try {
    writeFileSync(file, String(process.pid), { flag: "wx" });
  } catch {
    const pid = Number(readFileSync(file, "utf8").trim());
    if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) {
      throw new Error(
        `Another RedZone server (pid ${pid}) is already using ${dataDir}. Run one server per data folder: two would send the relayer's transactions at the same time.`,
      );
    }
    // A stale lock from a server that crashed: take it over.
    writeFileSync(file, String(process.pid));
  }
  const release = () => {
    try {
      if (readFileSync(file, "utf8").trim() === String(process.pid)) unlinkSync(file);
    } catch {
      // already gone
    }
  };
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => process.exit(0));
}
