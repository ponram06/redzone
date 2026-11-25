import { useData } from "../data";
import { qorAmount, shortHash } from "../format";

type Facts = { fee: string; perDay: string; minutes: string };

const faq = ({ fee, perDay, minutes }: Facts): [string, string][] => [
  [
    "What is RedZone?",
    "A game and a safety test in one. Robot makers put their robot's AI brain in a virtual building. Players try to trick it into a dangerous area with one message. Every attempt shows how safe the robot really is.",
  ],
  ["Do I need to know about crypto?", "No. You need the free QoreX wallet as your account. RedZone does the rest in the background."],
  [
    "Can I play on my phone?",
    "Yes, inside the QoreX app. Install QoreX from Google Play or the App Store, create a wallet, and in its Settings turn on Use testnet. Then open RedZone on your phone and tap Open RedZone in the QoreX app (or type the address into QoreX's dApp browser). Ordinary phone browsers can't sign for you; on a computer use the QoreX extension for Chrome or Firefox.",
  ],
  [
    "Why pay to verify my account?",
    `A tiny one-time payment (${fee}) makes fake accounts costly, and it pays the blockchain fees for your rounds. After that, your daily bounty rounds are free.`,
  ],
  ["How many times can I play?", `Practice is unlimited. Bounty rounds: ${perDay} free per day, and you can buy extra tries (0.1 QOR each) that never expire. Each round gives you ${minutes} to send one message.`],
  [
    "How do I get paid when I win?",
    "Automatically. The vault pays the round's player straight to their QoreX account: nobody can redirect it. If the admin pauses the vault in an emergency, wins made during the pause are paid when it ends. A robot can have several prize pools, and one breach is paid by each of them. After a paid breach, a maker's robot is frozen until its owner fixes it; the next breach after the fix is paid to anyone, earlier winners too. The practice robot pays every new player once.",
  ],
  [
    "Is it fair?",
    "Yes. The referee replays the robot's route step by step, the same way every time. Results are signed and saved publicly, so anyone can check them.",
  ],
  [
    "Why does QoreX ask me to approve things?",
    "Every important action (verifying, starting a round, sending your message, adding a robot) is approved by you with your quantum-safe key. Nobody else can act for you.",
  ],
  [
    "I build robots. Can I use my own AI?",
    "Yes, but you don’t have to. By default your robot runs on our free AI. If you want, open “Use my own AI account” in step 1, pick your AI company (OpenAI, Gemini, Groq and others), the model, and paste an API key. We check that it works, keep it encrypted, and only ever send it to that company. Nobody else can use it. Pick a key with a spending limit: every round against your robot uses it.",
  ],
  [
    "What does “quantum-safe” mean?",
    "Future quantum computers could break the locks most crypto wallets use today. RedZone only accepts approvals made with a newer kind of lock (ML-DSA-87) that they can't break.",
  ],
];

export function Help() {
  const { health } = useData();
  const facts: Facts = {
    fee: health?.signupFeeUqor ? qorAmount(health.signupFeeUqor) : "a small amount of QOR",
    perDay: health?.rules ? String(health.rules.attemptsPerDay) : "a few",
    minutes: health?.rules ? `${Math.round(health.rules.sessionTtl / 60)} minutes` : "a few minutes",
  };
  return (
    <>
      <h1 className="page-title">Help</h1>
      <div className="faq">
        {faq(facts).map(([q, a]) => (
          <details key={q}>
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
      </div>

      <details className="tech panel">
        <summary>Technical details (for developers and judges)</summary>
        <ul>
          <li>Runs on QoreChain testnet{health ? ` (EVM chain ${health.chainId})` : ""}.</li>
          <li>
            Player and owner requests are signed in QoreX with ML-DSA-87 and checked on chain by the <code>pqcVerify</code> precompile, so a
            stolen or quantum-broken ECDSA key can't start sessions, register robots or move bounties.
          </li>
          <li>
            The referee signs every verdict with its own ML-DSA-87 key. RobotRegistryV4 checks it before recording a result, and{" "}
            {health?.vaultName ?? "the vault"} pays the earliest recorded win: the whole bounty, or a fixed prize per win, one per version of
            the robot (it freezes after a win until its owner fixes it). Nobody, not even the admin, can pick the winner or move the money.
          </li>
          <li>
            Known limitation: QoreX can’t send transactions to contracts yet. So makers pay their bounty to the RedZone relayer as a normal
            QoreX transfer, and the relayer locks exactly that amount in the vault for their robot. The vault records the maker as the bounty’s
            owner, so only the maker’s own QoreX signature can ask for an unwon bounty back, and it unlocks 3 hours later, after every round
            already running has been judged. When QoreX supports contract calls, makers will deposit directly.
          </li>
          <li>
            A relayer pays gas, inside a QoreChain EVM window limited to the two RedZone contracts. The one-time sign-up fee funds it.
          </li>
          {health && (
            <>
              <li>
                RobotRegistryV4: <code>{health.registry}</code>
              </li>
              <li>
                {health.vaultName ?? "EscrowVaultV4"}: <code>{health.vault}</code>
              </li>
              <li>
                Referee key hash: <code>{shortHash(health.refereePubkeyHash)}</code>
              </li>
              {health.relayer && (
                <li>
                  Relayer: <code>{health.relayer.address}</code>
                </li>
              )}
            </>
          )}
        </ul>
      </details>
    </>
  );
}
