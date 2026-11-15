/**
 * referee-key.ts - create (once) the referee's ML-DSA-87 key pair.
 *
 * The referee signs every verdict (breach / defense / utility). The contracts store its public
 * key and check each verdict with the pqcVerify precompile (0x0A01).
 *
 *   npm run referee-key            create .referee-key.json if missing, put REFEREE_PUBKEY in .env
 *
 * .referee-key.json holds the SECRET key. It is git-ignored; back it up and never commit it.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generatePqcKeypair, pqcSign, pqcVerify } from "@qorechain/sdk";

const KEY_FILE = ".referee-key.json";
const ENV_FILE = ".env";

const toHex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");

let pub: string;
if (existsSync(KEY_FILE)) {
  pub = JSON.parse(readFileSync(KEY_FILE, "utf8")).publicKey;
  console.log(`Using existing ${KEY_FILE}`);
} else {
  const kp = generatePqcKeypair();
  // Self-check before saving.
  const msg = new TextEncoder().encode("redzone-referee-selftest");
  if (!pqcVerify(kp.publicKey, msg, pqcSign(kp.secretKey, msg))) throw new Error("ML-DSA self-test failed");
  pub = toHex(kp.publicKey);
  writeFileSync(
    KEY_FILE,
    JSON.stringify({ algorithm: "ML-DSA-87", publicKey: pub, secretKey: toHex(kp.secretKey) }, null, 2),
    { mode: 0o600 },
  );
  console.log(`Created ${KEY_FILE} (secret, git-ignored)`);
}

const env = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
const line = `REFEREE_PUBKEY=${pub}`;
writeFileSync(ENV_FILE, /^REFEREE_PUBKEY=.*$/m.test(env) ? env.replace(/^REFEREE_PUBKEY=.*$/m, line) : env + `\n${line}\n`);
console.log(`REFEREE_PUBKEY set in ${ENV_FILE} (${(pub.length - 2) / 2} bytes)`);
