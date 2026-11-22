# AI usage

This file records how AI tools were used to build RedZone, for the Best AI-Native Build award.

## Summary

AI was used in two ways:
- **To build RedZone.** Claude Code wrote most of the code, tests and documents, with the owner
  directing and approving each step.
- **Inside the product.** Free AI models act as robot brains that players try to trick.

## Tools

- Claude Code (Claude Opus 5.5) in VS Code: research, contract design, Solidity, backend, tests, docs.
- Claude in Chrome: end-to-end tests of the live website with the owner signed in to QoreX.
- Free LLMs on OpenRouter as the robot brain inside the product (see below).

## Workflow

1. **The owner sets the goal.** Examples: "a crash-test arena for AI robots",
   "freeze until fixed", "nothing hardcoded".
2. **AI researches first.** It reads the official QoreChain templates and SDKs and checks facts
   on the live testnet before writing code. Examples: that the precompiles are active, the deploy
   gas cap, and the format of QoreX signatures.
3. **AI writes the code and the tests together.** A fix starts with a test that fails before it.
4. **AI attacks its own work.** It wrote Q-Day rehearsals, an attacker playbook, invariant fuzzing
   and adversarial reviews, and fixed what it found.
5. **The owner approves everything that matters.** That covers every wallet signature, every
   transaction that spends QOR, every deployment, and every QCAI audit run (150 QOR each). Nothing
   on chain happened without the owner's QoreX approval.
6. **AI documents it.** It wrote this log, the READMEs, the audit answers and the verification
   verdicts.

## Who did what

| AI (Claude Code) | Owner (human) |
|---|---|
| Solidity contracts and 477 Foundry tests | The idea, the category and the game design |
| Server: referee, brains, relayer, chain reader and 118 tests | Rules that define the product: rating formula, brain reset, bounty required, freeze until fixed |
| Website and 3D arena | Feedback after playing as a player and as a maker; what to fix |
| Deploy scripts, hosting setup | Accounts, wallets, funding, the Azure server, API keys |
| Attack rehearsals, audit answers, verification pass | Every QoreX approval, every deployment, paying for and running QCAI |
| Documentation | Final review and submission |

## Log

| Date | What AI did | What the team did |
|---|---|---|
| 2026-11-15 | Read the official `create-qorechain-dapp` 0.14.0 templates and `@qorechain/evm` SDK to confirm the `pqcVerify` (0x0A01) and `pqcKeyStatus` (0x0A02) interfaces and the EVM authorisation window. Checked both precompiles are active on testnet. | Chose the idea, category and design goals; reviewed findings. |
| 2026-11-15 | Scaffolded the Foundry project; wrote `PQGuard.sol`, `EscrowVault.sol`, the deploy script and 24 Foundry tests, including a Q-Day test where a leaked ECDSA key fails to drain the vault. | Reviewed the design (msg.sender never authorises; referee verdict binds the claimer). |
| 2026-11-15 | Moved shared ML-DSA admin logic into `PQAdmin.sol`; wrote `RobotRegistry.sol` (robots, 5 sessions per player per day, referee-signed results and utility scores, rating and tiers, brain changes reset stats) with 23 tests. 47 tests pass in total. | Agreed the rating formula and the brain-reset rule. |
| 2026-11-16 | Created the drill account and referee ML-DSA key locally, registered the PQ key, opened an EVM window, live-tested `pqcVerify`/`pqcKeyStatus` on testnet, deployed EscrowVault and RobotRegistry, registered a demo robot and locked a 1 QOR bounty. Requested faucet tokens through Claude in Chrome (rate-limited). | Funded the drill account from QoreX. |
| 2026-11-16 | Wrote and ran a Q-Day attack rehearsal (`qday-attack.ts`) using only the ECDSA key: 17/17 attacks blocked. Found that an open EVM window can be spent with ECDSA alone; added `window close` and a window-free `window proof` command and documented the drill-day procedure. | Asked for the self-attack before the real drill. |
| 2026-11-16 | Wrote an advanced rehearsal (`qday-attack-advanced.ts`) with a separate attacker account: ECDSA-signed meta-transactions, an EIP-7702 delegation sponsored by the attacker, and real drain transactions. 5/5 blocked. | Asked for every possible attack. |
| 2026-11-16 | Built the backend: arena, geometry, a deterministic referee and an A* route planner; a rule brain and an OpenAI-compatible LLM brain that falls back between models; a brain registry keyed by hash; an ML-DSA-87 signer with a live parity test against the deployed contracts; and the HTTP API (attempt, utility, practice, replays). 43 offline tests. Live check: the LLM brain did an errand and refused a fake "system override" prompt. | Chose free models through OpenRouter and supplied the API key, kept in the git-ignored `.env`. |
| 2026-11-16 | Benchmarked candidate brain models on 10 tasks and 8 attacks and built a backup chain across providers: OpenRouter, Groq (gpt-oss-120b, gpt-oss-20b), Deploy (GLM-5.3-Flash) and local Ollama (gemma4:e4b). Each was tested by breaking the providers before it. | Supplied the Groq and Deploy keys; asked for Ollama as the last backup. |
| 2026-11-16 | Found that QoreX cannot sign EVM transactions yet; reverse-checked the QoreX signArbitrary ML-DSA message format against a real wallet signature; wrote RobotRegistryV2 (QoreX-signed relayable sessions), a 45-test attacker playbook, fixed one weak spot, verified a real QoreX signature with the live pqcVerify precompile, deployed v2 and closed the window. | Approved the wallet test signatures and the deployment; asked for every possible attack. |
| 2026-11-16 | Added the owner flow to the backend (relayed registerRobotFor and updateBrain, checked against the live contract digests) and automatic on-chain skills scores; redesigned the website for people who don't know blockchain: Home, Play, Rankings, robot pages, For robot makers and Help, with sign-in as three simple steps. Registered the relayer's ML-DSA-87 key. 59 offline backend tests. | Asked for a very simple, friendly website for players, robot owners and buyers; funded the relayer from the main account. |
| 2026-11-16 | Added a player leaderboard and "bring your own AI" brains for robot makers: keys are checked with a real call, stored encrypted (AES-256-GCM), sent only to an allowlisted provider, never returned, and bound to the first owner who uses them. 67 offline backend tests. | Asked for a leaderboard and for robot makers to use their own API keys. |
| 2026-11-16 | Made a bounty required when a maker adds a robot. QoreX can't call contracts yet, so the maker pays the bounty to the relayer, the referee checks the payment on chain, and the relayer locks it with depositBounty (with a no-double-deposit check). Makers can take unwon bounties back through an ML-DSA-signed request. Documented the limitation in the README. 71 offline backend tests, plus a live withdrawDigest parity check. | Chose "pay at the same time as adding the robot", asked for the QoreX limitation to be written down, and asked for "bounty" instead of "prize". |
| 2026-11-16 | Audited for anything hardcoded or kept only on the server. The leaderboard now comes from contract events, sign-ups and bounty records from chain payments and vault events (so a lost server database recovers everything), game rules from contract constants, and the chain id from the deployment record. Removed numbers typed into the website and an unsupported marketing claim. Added live tests that read real chain history. 72 offline tests and 6 live tests pass. | Asked for nothing hardcoded or faked, with everything connected to the chain. |
| 2026-11-20 | Ran a full end-to-end test in the browser with the owner signed in to QoreX: sign-up, practice and paid rounds, a real breach paid on chain, buying tries, adding a robot with a prize pool, skills test, brain update, bounty take-back. Fixed what it found (prizes shown now match what the vault pays the signed-in player, rate limits per route, one server per data folder, faster pages, phone layout, error pages). | Approved every QoreX popup; chose what to fix. |
| 2026-11-20 | Put the project online on a free-credit Azure for Students server: one Docker container serves the API, referee, relayer and website, behind Caddy with automatic HTTPS; scripts to install, upload secrets and data, and update. Found and fixed a missing runtime dependency on the first deploy. | Created the student account and the server, chose region and size within the credit. |
| 2026-11-20 | Made the site explain itself to judges: "Paid to you" with the real once-per-wallet rule instead of "Nothing now", and a plain "free AI limit used up" message and banner when a robot's free AI provider refuses (HTTP 429/402/quota), instead of "busy". | Asked for both after testing as a player. |
| 2026-11-21 | Designed with the owner and built "freeze until fixed": EscrowVaultV5 (one changed rule: a once-per-brain pool pays the first breach of each version to anyone, earlier winners included), 97 new contract tests with invariants (445 in all), freeze detection and enforcement on the server, Frozen/Fixed badges, and an owner "Fix this robot" editor with a free "Test my fix". Deployed V5, moved the pools from V4 through the live server, wrote docs/AUDIT.md and the QCAI bundle for V5. | Defined the rule (a breach freezes the robot until its owner fixes it, then anyone can win again), approved moving the funds. |

| 2026-11-21 | Wrote the QCAI bundle for the live pair (RobotRegistryV4 + EscrowVaultV5) and answered every stage 1 and stage 2 finding with code links and tests (85/100, then 82/100, QUANTUM-SAFE; no contract change needed). | Paid for and ran both QCAI stages. |
| 2026-11-21/22 | Full verification pass: Slither, coverage, 10,000-run fuzzing and 1,000 x 200-call invariants, server review, npm audit. Found and fixed three server bugs, each with a test that failed before the fix. The worst was that take-backs on V5 were signed for the previous vault, so the vault would have refused them. Added 32 branch tests (477 in all); no contract bug found. Each result has a verdict in audits/verification/TRIAGE.md. | Asked for "the most secure contract and a perfectly working app"; approved the commit and deploy. |
| 2026-11-22 | Rewrote the READMEs and the audit summary in plain language for judges and new readers, checked against the official rules. | Asked for documents anyone can understand. |
| 2026-11-22 | Checked each of the 6 findings from the QCAI stage 2 rerun on the Ethereum setting against the code and wrote the answers with code links and tests (85/100; no contract change needed). | Paid for and ran the rerun so both stages use the same setting, as the rules require. |

## Product use of AI

The robot "brain" in the arena is an LLM that turns a player's prompt into a JSON motion plan.
A deterministic referee (not an LLM) decides breaches and signs the verdict with ML-DSA-87.
