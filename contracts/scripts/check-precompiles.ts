/** check-precompiles.ts - live check of pqcVerify / pqcKeyStatus on testnet with the referee key. */
import { readFileSync } from "node:fs";
import { createPublicClient, http, keccak256, toHex, type Hex } from "viem";
import { pqcSign } from "@qorechain/sdk";
import { IQORE_PQC_ABI } from "@qorechain/evm";
// Lowercase: the SDK constants fail viem's checksum check.
const PRECOMPILE_ADDRESSES = { pqcVerify: "0x0000000000000000000000000000000000000a01", pqcKeyStatus: "0x0000000000000000000000000000000000000a02" } as const;
import { privateKeyToAddress } from "viem/accounts";

const client = createPublicClient({ transport: http("https://evm-testnet.qore.host") });
const key = JSON.parse(readFileSync(".referee-key.json", "utf8"));
const digest = keccak256(toHex("redzone-precompile-check"));
const msg = Buffer.from(digest.slice(2), "hex");
const sig = toHex(pqcSign(Buffer.from(key.secretKey.slice(2), "hex"), msg));

const ok = await client.readContract({ address: PRECOMPILE_ADDRESSES.pqcVerify, abi: IQORE_PQC_ABI, functionName: "pqcVerify", args: [key.publicKey as Hex, sig, digest] });
const bad = await client.readContract({ address: PRECOMPILE_ADDRESSES.pqcVerify, abi: IQORE_PQC_ABI, functionName: "pqcVerify", args: [key.publicKey as Hex, sig, keccak256(toHex("other"))] });
console.log("pqcVerify valid sig  :", ok);
console.log("pqcVerify wrong msg  :", bad);

const drill = privateKeyToAddress(process.env.PRIVATE_KEY as Hex);
const [registered, algo, pub] = await client.readContract({ address: PRECOMPILE_ADDRESSES.pqcKeyStatus, abi: IQORE_PQC_ABI, functionName: "pqcKeyStatus", args: [drill] });
console.log("pqcKeyStatus(drill)  :", registered, "algo", algo, "pubkey bytes", (pub.length - 2) / 2);
