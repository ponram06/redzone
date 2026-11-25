/** The signed-in QoreX account, shared by every page. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type PlayerStatus } from "./api";
import { connect, explainQorexError, hasQorex, payNative } from "./qorex";

type Account = {
  address: string | null;
  player: PlayerStatus | null;
  busy: string | null;
  error: string | null;
  /** Ready to play or own robots: signed in, safety key on, account verified. */
  ready: boolean;
  signIn(): Promise<void>;
  signOut(): void;
  verify(): Promise<void>;
  refresh(): Promise<void>;
  setAttemptsLeft(n: number): void;
};

const Ctx = createContext<Account | null>(null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The signed-in address survives a page reload. It is public (the same address shows on every
 * result), so keeping it is harmless; anything that moves money or signs still asks QoreX.
 */
const SIGNED_IN = "redzone.signedIn";
const remembered = (): string | null => {
  try {
    const a = localStorage.getItem(SIGNED_IN);
    return a && /^qor1[0-9a-z]{38,58}$/.test(a) ? a : null;
  } catch {
    return null;
  }
};
const remember = (a: string | null) => {
  try {
    if (a) localStorage.setItem(SIGNED_IN, a);
    else localStorage.removeItem(SIGNED_IN);
  } catch {
    // private window or blocked storage: the player just signs in again after a reload
  }
};

export function AccountProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(remembered);
  const [player, setPlayer] = useState<PlayerStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(explainQorexError(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const load = useCallback(async (a: string) => setPlayer(await api.player(a)), []);

  const signIn = useCallback(
    () =>
      run("Waiting for QoreX…", async () => {
        if (!hasQorex()) throw new Error("Install the QoreX wallet first (Chrome or Firefox on a computer, or open RedZone inside the QoreX phone app).");
        const a = await connect();
        setAddress(a);
        remember(a);
        await load(a);
      }),
    [run, load],
  );

  // After a reload: load the remembered account's status (tries, sign-up) without asking QoreX.
  useEffect(() => {
    const a = remembered();
    if (a) load(a).catch(() => {});
  }, [load]);

  const refresh = useCallback(async () => {
    if (address) await run("Checking…", () => load(address));
  }, [address, run, load]);

  const verify = useCallback(
    () =>
      run("Approve the one-time payment in QoreX…", async () => {
        if (!address || !player?.signup) return;
        const tx = await payNative(address, player.signup.payTo, player.signup.feeUqor, player.signup.memo);
        setBusy("Confirming your payment…");
        for (let i = 0; ; i++) {
          try {
            await api.registerPlayer(address, tx);
            break;
          } catch (e) {
            if (i >= 8 || !/not found/i.test((e as Error).message)) throw e;
            await sleep(3000);
          }
        }
        await load(address);
      }),
    [address, player, run, load],
  );

  const value = useMemo<Account>(
    () => ({
      address,
      player,
      busy,
      error,
      ready: !!(address && player?.pqKeyRegistered && player.signedUp),
      signIn,
      signOut: () => {
        remember(null);
        setAddress(null);
        setPlayer(null);
        setError(null);
      },
      verify,
      refresh,
      setAttemptsLeft: (n) => setPlayer((p) => (p ? { ...p, attemptsLeft: n } : p)),
    }),
    [address, player, busy, error, signIn, verify, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAccount(): Account {
  const a = useContext(Ctx);
  if (!a) throw new Error("useAccount outside AccountProvider");
  return a;
}

export const shortAddress = (a: string) => `${a.slice(0, 8)}…${a.slice(-4)}`;
