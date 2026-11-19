import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";

/**
 * People, not hashes: every player shows as a name and an avatar. A player can choose a nickname
 * (signed in QoreX); everyone else gets a stable generated name, like "Crimson Falcon", made from
 * their address. The address is still one hover away, for anyone who wants to check it.
 */

const ADJ = [
  "Crimson", "Silent", "Neon", "Iron", "Rapid", "Lucky", "Shadow", "Clever", "Frost", "Solar",
  "Quantum", "Rogue", "Steady", "Wild", "Hidden", "Golden", "Electric", "Brave", "Cosmic", "Swift",
  "Sly", "Stormy", "Velvet", "Atomic", "Jade", "Copper", "Polar", "Hyper", "Mellow", "Scarlet",
  "Cobalt", "Ember",
];
const NOUN = [
  "Falcon", "Otter", "Panther", "Fox", "Comet", "Raven", "Tiger", "Wolf", "Lynx", "Hawk",
  "Viper", "Badger", "Orca", "Mantis", "Phoenix", "Coyote", "Koala", "Shark", "Gecko", "Bison",
  "Jaguar", "Puffin", "Moth", "Cobra", "Heron", "Yak", "Mongoose", "Owl", "Ferret", "Kraken",
  "Marten", "Pelican",
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** The generated name for an address (stable: the same address always gets the same name). */
export function generatedName(address: string): string {
  const h = hash(address.toLowerCase());
  return `${ADJ[h % ADJ.length]} ${NOUN[(h >>> 8) % NOUN.length]}`;
}

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

type Names = { nameOf: (address: string) => string; custom: (address: string) => string | null; refresh: () => Promise<void> };
const Ctx = createContext<Names>({ nameOf: generatedName, custom: () => null, refresh: async () => {} });

export function PlayerNamesProvider({ children }: { children: ReactNode }) {
  const [names, setNames] = useState<Record<string, string>>({});
  const refresh = useCallback(async () => {
    try {
      setNames(await api.playerNames());
    } catch {
      // generated names still work
    }
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [refresh]);
  const value = useMemo<Names>(
    () => ({
      nameOf: (a) => names[a.toLowerCase()] ?? generatedName(a),
      custom: (a) => names[a.toLowerCase()] ?? null,
      refresh,
    }),
    [names, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const usePlayerNames = () => useContext(Ctx);

/** A small symmetric pixel avatar, unique to the address. */
export function Avatar({ address, size = 28 }: { address: string; size?: number }) {
  const cells = useMemo(() => {
    const h1 = hash(address.toLowerCase());
    const h2 = hash(`${address.toLowerCase()}#`);
    const hue = h1 % 360;
    const on: [number, number][] = [];
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 3; x++) {
        const bit = ((y * 3 + x) < 16 ? h2 >>> (y * 3 + x) : h1 >>> (y * 3 + x - 16)) & 1;
        if (bit) {
          on.push([x, y]);
          if (x < 2) on.push([4 - x, y]);
        }
      }
    return { hue, on };
  }, [address]);
  return (
    <svg className="avatar" width={size} height={size} viewBox="0 0 7 7" aria-hidden="true" style={{ borderRadius: size / 4 }}>
      <rect width="7" height="7" fill={`hsl(${cells.hue} 45% 14%)`} />
      {cells.on.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x + 1} y={y + 1} width="1.02" height="1.02" fill={`hsl(${cells.hue} 85% 62%)`} />
      ))}
    </svg>
  );
}

/** Avatar + name, linking to the player's public profile. The address shows on hover. */
export function PlayerTag({ address, link = true, size = 22 }: { address: string; link?: boolean; size?: number }) {
  const { nameOf } = usePlayerNames();
  const body = (
    <>
      <Avatar address={address} size={size} />
      <span className="ptag-name">{nameOf(address)}</span>
    </>
  );
  return link ? (
    <a className="ptag" href={`#/player/${address}`} title={address}>
      {body}
    </a>
  ) : (
    <span className="ptag" title={address}>
      {body}
    </span>
  );
}
