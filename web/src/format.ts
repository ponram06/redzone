/** Display helpers. Amounts come in two units: uqor (native, 6 decimals) and wei (EVM, 18 decimals). */

export const qorAmount = (uqor: string) => `${(Number(uqor) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })} QOR`;

export const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
