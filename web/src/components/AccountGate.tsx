import { useEffect, useState, type ReactNode } from "react";
import { useAccount } from "../account";
import { qorAmount } from "../format";
import { hasQorex } from "../qorex";

/**
 * Shows the next thing a person must do before they can play or add a robot,
 * as one simple step at a time. Renders `children` once everything is ready.
 */
export function AccountGate({
  children,
  purpose,
  requireVerified = true,
}: {
  children: ReactNode;
  purpose: string;
  /** false: signing in with a safety key is enough (e.g. free practice); the one-time payment comes later. */
  requireVerified?: boolean;
}) {
  const acc = useAccount();
  // A wallet's in-app browser may inject window.qorex a moment after the page starts: look again for 3 s.
  const [, rerender] = useState(0);
  useEffect(() => {
    if (hasQorex()) return;
    const t = setInterval(() => hasQorex() && (rerender((n) => n + 1), clearInterval(t)), 300);
    const stop = setTimeout(() => clearInterval(t), 3000);
    return () => (clearInterval(t), clearTimeout(stop));
  }, []);

  const step = (n: number, title: string, body: ReactNode) => (
    <div className="gate">
      <div className="gate-steps" aria-hidden="true">
        {(requireVerified ? [1, 2, 3] : [1, 2]).map((i) => (
          <span key={i} className={i < n ? "dot done" : i === n ? "dot now" : "dot"} />
        ))}
      </div>
      <p className="gate-kicker">
        Before you {purpose}
      </p>
      <h3>{title}</h3>
      {body}
      {acc.busy && <p className="note">{acc.busy}</p>}
      {acc.error && <p className="error-text">{acc.error}</p>}
    </div>
  );

  if (!hasQorex()) {
    // QoreX is a desktop browser extension: phones and tablets can't run it yet.
    const phone = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && !matchMedia("(hover: hover)").matches);
    return step(
      1,
      "Get the QoreX wallet",
      phone ? (
        <>
          <p>RedZone uses the free QoreX wallet as your account. It keeps your bounties safe, even from future quantum computers.</p>
          <p className="note">
            On a phone, RedZone runs inside the QoreX app's own browser. First, in the QoreX app, open Settings and turn on{" "}
            <b>Use testnet</b>. Then tap below: RedZone opens in QoreX and you sign in there.
          </p>
          <a className="btn primary" href={`https://link.qore.network/browse?url=${encodeURIComponent(location.href)}`}>
            Open RedZone in the QoreX app
          </a>{" "}
          <a className="btn" href="#/robots">
            Just look around
          </a>
          <p className="note">
            No QoreX app yet? Get it from{" "}
            <a href="https://play.google.com/store/apps/details?id=network.qore.qorex" target="_blank" rel="noreferrer">
              Google Play
            </a>{" "}
            or the App Store, create a wallet, then come back here.
          </p>
        </>
      ) : (
        <>
          <p>RedZone uses the free QoreX browser extension as your account. It keeps your bounties safe, even from future quantum computers.</p>
          <p className="note">
            Install QoreX in Chrome or <a href="https://addons.mozilla.org/firefox/addon/qorex/" target="_blank" rel="noreferrer">Firefox</a>, create an
            account, switch it to the testnet, then reload this page.
          </p>
          <button className="btn" onClick={() => location.reload()}>
            I've installed it, reload
          </button>
        </>
      ),
    );
  }

  if (!acc.address || !acc.player) {
    return step(
      1,
      "Sign in",
      <>
        <p>Sign in with your QoreX wallet. No email or password needed.</p>
        <button className="btn primary" disabled={!!acc.busy} onClick={acc.signIn}>
          Sign in with QoreX
        </button>
      </>,
    );
  }

  if (!acc.player.pqKeyRegistered) {
    return step(
      2,
      "Turn on your safety key",
      <>
        <p>Your QoreX account needs its quantum-safe (ML-DSA-87) key on QoreChain. There is no switch for it: QoreX adds the key by itself with your first transfer.</p>
        <ol className="note">
          <li>In QoreX (on testnet), send any small amount of QOR, for example 0.01 QOR to a friend's qor1… address. Need QOR? Use the testnet faucet on the QoreChain Dashboard.</li>
          <li>QoreX shows a small one-time key fee on that first send. Approve it.</li>
          <li>In the QoreX app, Settings → Security then shows the ML-DSA-87 key as "Registered on-chain ✓". Come back here and tap below.</li>
        </ol>
        <button className="btn" disabled={!!acc.busy} onClick={acc.refresh}>
          I've done it, check again
        </button>
      </>,
    );
  }

  if (requireVerified && !acc.player.signedUp && acc.player.signup) {
    const fee = qorAmount(acc.player.signup.feeUqor);
    return step(
      2,
      "Verify your account",
      <>
        <p>
          A one-time payment of <strong>{fee}</strong> proves you're a real person and keeps bots out. After this, everything is free.
        </p>
        <button className="btn primary" disabled={!!acc.busy} onClick={acc.verify}>
          Verify for {fee}
        </button>
      </>,
    );
  }

  return <>{children}</>;
}
