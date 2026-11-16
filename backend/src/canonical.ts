import { keccak256, stringToBytes, type Hex } from "viem";

/** JSON with sorted object keys, so the same value always gives the same bytes and hash. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function hashJson(value: unknown): Hex {
  return keccak256(stringToBytes(canonicalJson(value)));
}
