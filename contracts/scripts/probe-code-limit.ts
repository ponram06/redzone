/** probe-code-limit.ts - largest contract code the chain accepts in one deployment (eth_call only). */
const RPC = "https://evm-testnet.qore.host";
const from = "0x454DCD55DCB9154216fEfb173C0B5B4D26bA80A2";
const hex = (n: number, w: number) => n.toString(16).padStart(w, "0");

async function tryN(n: number): Promise<string> {
  // CODECOPY the n-byte body after this 14-byte header to memory, then RETURN it as the code.
  const header = `61${hex(n, 4)}600e600039` + `61${hex(n, 4)}6000f3`;
  const data = "0x" + header + "5b".repeat(n);
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from, data, gas: "0x1c9c380" }, "latest"] }),
  });
  const j = (await res.json()) as { result?: string; error?: { message: string } };
  return j.error ? j.error.message.slice(0, 80) : `ok (${(j.result!.length - 2) / 2} bytes)`;
}

if (!process.argv.includes("--estimate-only")) for (const n of [16000, 21400, 24000]) console.log(n, await tryN(n));

async function estimate(n: number): Promise<string> {
  const header = `61${hex(n, 4)}600e600039` + `61${hex(n, 4)}6000f3`;
  const data = "0x" + header + "5b".repeat(n);
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_estimateGas", params: [{ from, data }] }),
  });
  const j = (await res.json()) as { result?: string; error?: { message: string } };
  return j.error ? j.error.message.slice(0, 80) : String(BigInt(j.result!));
}
for (const n of [20000, 22800, 23000, 24000, 24576]) console.log("estimate", n, await estimate(n));
if (process.argv.includes("--estimate-only")) process.exit(0);
let lo = 21400;
let hi = 24000;
while (hi - lo > 50) {
  const mid = Math.floor((lo + hi) / 2);
  if ((await tryN(mid)).startsWith("ok")) lo = mid;
  else hi = mid;
}
console.log("largest code that fits in one eth_call:", lo);

export {}; // a module, so top-level await is allowed
