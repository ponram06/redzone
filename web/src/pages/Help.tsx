import { useData } from "../data";
import { shortHash } from "../format";

const FAQ: [string, string][] = [
  [
    "What is RedZone?",
    "A game and a safety test in one. Robot makers put their robot's AI brain in a virtual building. Players try to trick it into a dangerous area with one message. Every attempt shows how safe the robot really is.",
  ],
  ["Do I need to know about crypto?", "No. You need the free QoreX wallet as your account. RedZone does the rest in the background."],
  [
    "Why pay to verify my account?",
    "A tiny one-time payment (0.1 QOR) stops people from making thousands of fake accounts. It also covers the cost of running your rounds. After that, playing is free.",
  ],
  ["How many times can I play?", "Practice is unlimited. Prize rounds: 5 per day. Each round gives you 10 minutes to send one message."],
  [
    "How do I get paid when I win?",
    "Automatically. The prize goes straight from the vault to your QoreX account. Nobody can stop or redirect it.",
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
    "Yes. On “For robot makers” choose “Your own AI”, pick your provider (OpenAI, Gemini, Groq and others), the model, and paste an API key. We check that it works, store it encrypted, and only ever send it to that provider. Nobody else can put your brain on their robot. Use a key with a spending limit: every round against your robot uses it. No key? Pick “AI guard” and it runs on free models.",
  ],
  [
    "What does “quantum-safe” mean?",
    "Future quantum computers could break the locks most crypto wallets use today. RedZone only accepts approvals made with a newer kind of lock (ML-DSA-87) that they can't break.",
  ],
];

export function Help() {
  const { health } = useData();
  return (
    <>
      <h1 className="page-title">Help</h1>
      <div className="faq">
        {FAQ.map(([q, a]) => (
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
            stolen or quantum-broken ECDSA key can't start sessions, register robots or move prizes.
          </li>
          <li>
            The referee signs every verdict with its own ML-DSA-87 key. RobotRegistryV2 and EscrowVault verify it before recording a result or
            paying a prize.
          </li>
          <li>
            A relayer pays gas, inside a QoreChain EVM window limited to the two RedZone contracts. The one-time sign-up fee funds it.
          </li>
          {health && (
            <>
              <li>
                RobotRegistryV2: <code>{health.registry}</code>
              </li>
              <li>
                EscrowVault: <code>{health.vault}</code>
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
