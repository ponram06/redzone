import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";

/**
 * People, not hashes: every player shows as a name and a picture. A player can choose both on
 * their profile (signed in QoreX, stored by RedZone against their wallet); everyone else gets a
 * stable generated name, like "Crimson Falcon", and a pixel picture made from their address.
 *
 * Everything is keyed by the wallet's 0x address, and qor1… addresses are converted to it, so a
 * player looks the same on every page and after every sign-in.
 */

// ------------------------------------------------------------- addresses

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/** The lower-case 0x form of a 0x… or qor1… address (the same 20 bytes either way). */
export function toEvm(address: string): string {
  const a = address.trim().toLowerCase();
  if (a.startsWith("0x")) return a;
  const sep = a.lastIndexOf("1");
  if (sep < 1) return a;
  const data: number[] = [];
  for (const ch of a.slice(sep + 1, -6)) {
    const v = BECH32.indexOf(ch);
    if (v < 0) return a;
    data.push(v);
  }
  // 5-bit groups -> bytes
  let acc = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const v of data) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  if (bytes.length !== 20) return a;
  return `0x${bytes.map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ------------------------------------------------------------- names

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

/** The generated name for an address (stable: the same wallet always gets the same name). */
export function generatedName(address: string): string {
  const h = hash(toEvm(address));
  return `${ADJ[h % ADJ.length]} ${NOUN[(h >>> 8) % NOUN.length]}`;
}

// ------------------------------------------------------------- pictures

/** The pictures a player can choose. Ids are stored, so never rename one. */
export const PICTURES: { id: string; emoji: string; hue: number; label: string }[] = [
  { id: "robot", emoji: "🤖", hue: 210, label: "Robot" },
  { id: "alien", emoji: "👾", hue: 280, label: "Space invader" },
  { id: "arm", emoji: "🦾", hue: 30, label: "Robot arm" },
  { id: "ufo", emoji: "🛸", hue: 170, label: "UFO" },
  { id: "fox", emoji: "🦊", hue: 20, label: "Fox" },
  { id: "wolf", emoji: "🐺", hue: 220, label: "Wolf" },
  { id: "eagle", emoji: "🦅", hue: 40, label: "Eagle" },
  { id: "dragon", emoji: "🐉", hue: 140, label: "Dragon" },
  { id: "ghost", emoji: "👻", hue: 260, label: "Ghost" },
  { id: "skull", emoji: "💀", hue: 0, label: "Skull" },
  { id: "brain", emoji: "🧠", hue: 330, label: "Brain" },
  { id: "bolt", emoji: "⚡", hue: 50, label: "Lightning" },
  { id: "fire", emoji: "🔥", hue: 10, label: "Fire" },
  { id: "shark", emoji: "🦈", hue: 195, label: "Shark" },
  { id: "octopus", emoji: "🐙", hue: 300, label: "Octopus" },
  { id: "ninja", emoji: "🥷", hue: 240, label: "Ninja" },
  { id: "target", emoji: "🎯", hue: 355, label: "Target" },
  { id: "key", emoji: "🔑", hue: 45, label: "Key" },
  { id: "satellite", emoji: "🛰️", hue: 200, label: "Satellite" },
  { id: "crown", emoji: "👑", hue: 48, label: "Crown" },
];
const PICTURE = new Map(PICTURES.map((p) => [p.id, p]));

// ------------------------------------------------------------- shared state

type Chosen = Record<string, { name?: string; avatar?: string }>;
type Players = {
  nameOf: (address: string) => string;
  custom: (address: string) => string | null;
  pictureOf: (address: string) => string | null;
  refresh: () => Promise<void>;
};
const Ctx = createContext<Players>({ nameOf: generatedName, custom: () => null, pictureOf: () => null, refresh: async () => {} });

const CACHE = "redzone.players";
function readCache(): Chosen {
  try {
    return JSON.parse(localStorage.getItem(CACHE) ?? "{}") as Chosen;
  } catch {
    return {};
  }
}

export function PlayerNamesProvider({ children }: { children: ReactNode }) {
  // Start from the last list this browser saw, so names never flash as placeholders.
  const [chosen, setChosen] = useState<Chosen>(readCache);
  const refresh = useCallback(async () => {
    try {
      const r = await api.playerNames();
      setChosen(r);
      try {
        localStorage.setItem(CACHE, JSON.stringify(r));
      } catch {
        // storage blocked: fine, it just reloads next time
      }
    } catch {
      // generated names still work
    }
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [refresh]);
  const value = useMemo<Players>(
    () => ({
      nameOf: (a) => chosen[toEvm(a)]?.name ?? generatedName(a),
      custom: (a) => chosen[toEvm(a)]?.name ?? null,
      pictureOf: (a) => chosen[toEvm(a)]?.avatar ?? null,
      refresh,
    }),
    [chosen, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const usePlayerNames = () => useContext(Ctx);

/** The player's picture: the one they chose, or a pixel pattern unique to their wallet. */
export function Avatar({ address, size = 28, picture }: { address: string; size?: number; picture?: string | null }) {
  const { pictureOf } = usePlayerNames();
  const chosen = PICTURE.get(picture === undefined ? (pictureOf(address) ?? "") : (picture ?? ""));
  const cells = useMemo(() => {
    const key = toEvm(address);
    const h1 = hash(key);
    const h2 = hash(`${key}#`);
    const hue = h1 % 360;
    const on: [number, number][] = [];
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 3; x++) {
        const i = y * 3 + x;
        const bit = (i < 16 ? h2 >>> i : h1 >>> (i - 16)) & 1;
        if (bit) {
          on.push([x, y]);
          if (x < 2) on.push([4 - x, y]);
        }
      }
    return { hue, on };
  }, [address]);

  if (chosen) {
    return (
      <span
        className="avatar emoji"
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          borderRadius: size / 4,
          fontSize: size * 0.58,
          background: `linear-gradient(140deg, hsl(${chosen.hue} 70% 30%), hsl(${(chosen.hue + 40) % 360} 60% 14%))`,
        }}
      >
        {chosen.emoji}
      </span>
    );
  }
  return (
    <svg className="avatar" width={size} height={size} viewBox="0 0 7 7" aria-hidden="true" style={{ borderRadius: size / 4 }}>
      <rect width="7" height="7" fill={`hsl(${cells.hue} 45% 14%)`} />
      {cells.on.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x + 1} y={y + 1} width="1.02" height="1.02" fill={`hsl(${cells.hue} 85% 62%)`} />
      ))}
    </svg>
  );
}

/** Picture + name, linking to the player's public profile. The address shows on hover. */
export function PlayerTag({ address, link = true, size = 22 }: { address: string; link?: boolean; size?: number }) {
  const { nameOf } = usePlayerNames();
  const body = (
    <>
      <Avatar address={address} size={size} />
      <span className="ptag-name">{nameOf(address)}</span>
    </>
  );
  return link ? (
    <a className="ptag" href={`#/player/${toEvm(address)}`} title={address}>
      {body}
    </a>
  ) : (
    <span className="ptag" title={address}>
      {body}
    </span>
  );
}
