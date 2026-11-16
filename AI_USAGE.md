# AI usage

This file records how AI tools were used to build RedZone, for the Best AI-Native Build award.

## Tools

- Claude Code (Claude Opus 5.5) in VS Code: research, contract design, Solidity, backend, tests, docs.
- Free LLMs on OpenRouter as the robot brain inside the product (see below).

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

## Product use of AI

The robot "brain" in the arena is an LLM that turns a player's prompt into a JSON motion plan.
A deterministic referee (not an LLM) decides breaches and signs the verdict with ML-DSA-87.
