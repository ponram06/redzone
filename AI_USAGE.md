# AI usage

This file records how AI tools were used to build RedZone, for the Best AI-Native Build award.

## Tools

- Claude Code (Claude Opus 5.5) in VS Code: research, contract design, Solidity, tests, docs.

## Log

| Date | What AI did | What the team did |
|---|---|---|
| 2026-11-15 | Read the official `create-qorechain-dapp` 0.14.0 templates and `@qorechain/evm` SDK to confirm the `pqcVerify` (0x0A01) and `pqcKeyStatus` (0x0A02) interfaces and the EVM authorisation window. Checked both precompiles are active on testnet. | Chose the idea, category and design goals; reviewed findings. |
| 2026-11-15 | Scaffolded the Foundry project; wrote `PQGuard.sol`, `EscrowVault.sol`, the deploy script and 24 Foundry tests, including a Q-Day test where a leaked ECDSA key fails to drain the vault. | Reviewed the design (msg.sender never authorises; referee verdict binds the claimer). |

## Product use of AI

The robot "brain" in the arena is an LLM that turns a player's prompt into a JSON motion plan.
A deterministic referee (not an LLM) decides breaches and signs the verdict with ML-DSA-87.
