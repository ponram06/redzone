import type { ReactNode } from "react";
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
    return step(
      1,
      "Get the QoreX wallet",
      <>
        <p>RedZone uses the free QoreX browser extension as your account. It keeps your bounties safe, even from future quantum computers.</p>
        <p className="note">Install QoreX in Chrome, create an account, switch it to the testnet, then reload this page.</p>
        <button className="btn" onClick={() => location.reload()}>
          I've installed it, reload
        </button>
      </>,
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
        <p>Your QoreX account needs its quantum-safe key switched on. You only do this once, inside QoreX.</p>
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
