# AI usage

This file records how AI tools were used to build RedZone, for the Best AI-Native Build award.

## Tools

- Claude Code (Claude Opus 5.5) in VS Code: research, contract design, Solidity, tests, docs.

## Log

| Date | What AI did | What the team did |
|---|---|---|
| 2026-11-15 | Read the official `create-qorechain-dapp` 0.14.0 templates and `@qorechain/evm` SDK to confirm the `pqcVerify` (0x0A01) and `pqcKeyStatus` (0x0A02) interfaces and the EVM authorisation window. Checked both precompiles are active on testnet. | Chose the idea, category and design goals; reviewed findings. |
| 2026-11-15 | Scaffolded the Foundry project; wrote `PQGuard.sol`, `EscrowVault.sol`, the deploy script and 24 Foundry tests, including a Q-Day test where a leaked ECDSA key fails to drain the vault. | Reviewed the design (msg.sender never authorises; referee verdict binds the claimer). |
| 2026-11-15 | Moved shared ML-DSA admin logic into `PQAdmin.sol`; wrote `RobotRegistry.sol` (robots, 5 sessions per player per day, referee-signed results and utility scores, rating and tiers, brain changes reset stats) with 23 tests. 47 tests pass in total. | Agreed the rating formula and the brain-reset rule. |
| 2026-11-16 | Created the drill account and referee ML-DSA key locally, registered the PQ key, opened an EVM window, live-tested `pqcVerify`/`pqcKeyStatus` on testnet, deployed EscrowVault and RobotRegistry, registered a demo robot and locked a 1 QOR bounty. Requested faucet tokens through Claude in Chrome (rate-limited). | Funded the drill account from QoreX. |
| 2026-11-16 | Wrote and ran a Q-Day attack rehearsal (`qday-attack.ts`) using only the ECDSA key: 17/17 attacks blocked. Found that an open EVM window can be spent with ECDSA alone; added `window close` and a window-free `window proof` command and documented the drill-day procedure. | Asked for the self-attack before the real drill. |

## Product use of AI

The robot "brain" in the arena is an LLM that turns a player's prompt into a JSON motion plan.
A deterministic referee (not an LLM) decides breaches and signs the verdict with ML-DSA-87.
