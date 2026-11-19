/**
 * probe-v4-gas.ts - how much gas the RobotRegistryV4 deployment needs on the real chain
 * (eth_call only, sends nothing). Prints the smallest tested gas limit that passes.
 */
import { readFileSync } from "node:fs";
import { createPublicClient, encodeDeployData, http, type Abi, type Address, type Hex } from "viem";

const RPC = "https://evm-testnet.qore.host";
const proofs = JSON.parse(readFileSync(".v4-proofs.json", "utf8")) as Record<string, Hex> & { deployer: Address };
const j = JSON.parse(readFileSync("out/RobotRegistryV4.sol/RobotRegistryV4.json", "utf8")) as { abi: Abi; bytecode: { object: Hex } };
const chainBytes = `0x${Buffer.from("qorechain-diana").toString("hex")}` as Hex;
const data = encodeDeployData({
  abi: j.abi,
  bytecode: j.bytecode.object,
  args: [proofs.refereePubkey, chainBytes, proofs.registryDeployerProof, proofs.registryRefereeProof, 10n ** 17n, "0xc0e118ab9b754432f5b8ca3a91e1e419e5cb67cb"],
});
console.log(`initcode+args ${(data.length - 2) / 2} bytes`);
const pub = createPublicClient({ transport: http(RPC) });
for (const g of [15, 20, 25, 30, 40, 60, 100]) {
  try {
    await pub.call({ account: proofs.deployer, data, gas: BigInt(g) * 1_000_000n });
    console.log(`${g}M: ok`);
    break;
  } catch (e) {
    console.log(`${g}M: ${((e as { details?: string }).details ?? (e as Error).message).slice(0, 90)}`);
  }
}
