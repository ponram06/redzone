/**
 * Operator tool: set a robot's public job description directly in the data folder (owners normally
 * do this from the site with a QoreX signature). Use it for the demo robots the operator owns.
 *
 *   npx tsx --env-file=.env scripts/set-job.ts <robotId> "What the robot is used for"
 */
import { resolve } from "node:path";
import { Store } from "../src/store.js";
import { readRobot } from "../src/chain.js";

const [id, ...words] = process.argv.slice(2);
const robotId = Number(id);
const job = words.join(" ").replace(/\s+/g, " ").trim();
if (!Number.isSafeInteger(robotId) || robotId < 1 || job.length < 3 || job.length > 280) {
  console.error('usage: scripts/set-job.ts <robotId> "job, 3 to 280 characters"');
  process.exit(1);
}
const robot = await readRobot(robotId);
if (!robot) throw new Error(`robot #${robotId} not found`);
const store = new Store(resolve(process.env.DATA_DIR ?? "./data"));
store.saveProfile(robotId, { job, owner: robot.owner.toLowerCase(), updatedAt: Math.floor(Date.now() / 1000) });
console.log(`#${robotId} ${robot.name}: ${job}`);
