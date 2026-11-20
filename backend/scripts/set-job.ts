/**
 * Operator tool: set a robot's public job description directly in the data folder (owners normally
 * do this from the site with a QoreX signature). Use it for the demo robots the operator owns.
 *
 *   npx tsx --env-file=.env scripts/set-job.ts <robotId> "What the robot is used for" [--body dog --color #36c5ff]
 */
import { resolve } from "node:path";
import { Store } from "../src/store.js";
import { readRobot } from "../src/chain.js";
import { ROBOT_KINDS } from "../src/game.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const body = flag("body");
const color = flag("color")?.toLowerCase();
if ((body || color) && (!body || !ROBOT_KINDS.includes(body) || !color || !/^#[0-9a-f]{6}$/.test(color))) {
  console.error(`--body is one of ${ROBOT_KINDS.join(", ")} and --color looks like #36c5ff (give both)`);
  process.exit(1);
}
const [id, ...words] = args;
const robotId = Number(id);
const job = words.join(" ").replace(/\s+/g, " ").trim();
if (!Number.isSafeInteger(robotId) || robotId < 1 || job.length < 3 || job.length > 280) {
  console.error('usage: scripts/set-job.ts <robotId> "job, 3 to 280 characters"');
  process.exit(1);
}
const robot = await readRobot(robotId);
if (!robot) throw new Error(`robot #${robotId} not found`);
const store = new Store(resolve(process.env.DATA_DIR ?? "./data"));
const before = store.getProfile(robotId);
const look = body && color ? { kind: body, color } : before?.kind && before.color ? { kind: before.kind, color: before.color } : {};
store.saveProfile(robotId, { job, ...look, owner: robot.owner.toLowerCase(), updatedAt: Math.floor(Date.now() / 1000) });
console.log(`#${robotId} ${robot.name}: ${job}${"kind" in look ? ` (${look.kind}, ${look.color})` : ""}`);
