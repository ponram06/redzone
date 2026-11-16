# RedZone build progress

Working file for the build. Each item is committed and pushed when done. A new session resumes from
the first unchecked item of the earliest unfinished phase.

Rules: no Claude co-author line in commits. Never commit `.env`, `.referee-key.json`, `.attacker.json`.
Do not spend drill-account QOR or touch the fest website without the owner.

Overall: about **56%** (each phase's weight is in brackets; last updated 2026-11-16).

## Phase 1. Setup and registration (5%): done
- [x] Hackathon registration, Post-Quantum dApp category, project page on build.qorechain.io
- [x] Testnet accounts: main (QoreX) and drill/admin account with a registered ML-DSA-87 key
- [x] Repo, MIT licence, README, credits, AI_USAGE.md

## Phase 2. Smart contracts (20%): done
- [x] PQGuard, PQAdmin, EscrowVault, RobotRegistry, 47 Foundry tests
- [x] Deployed to qorechain-diana (see deployments/testnet.json); demo robot and 1 QOR bounty

## Phase 3. Q-Day Drill (10%): 80%
- [x] Registered for the drill: vault + RobotRegistryV2 (re-registered 16 Nov after the v2 deploy)
- [x] Rehearsal: 22/22 attacks blocked, open-window weak spot fixed (docs/QDAY_DRILL.md)
- [ ] 18 Nov: `npm run window status`, then `npm run window proof` in contracts/
- [ ] Submit the proof hash on the project page by 19 Nov; check vault and balances afterwards

## Phase 4. Backend (`backend/`, Node + TypeScript) (20%): done
- [x] Arena, geometry, referee simulation, route planner
- [x] Brains: rule brain, OpenAI-compatible LLM brain (OpenRouter free models), brain registry by hash
- [x] ML-DSA-87 signer, live parity test against the deployed contracts
- [x] Replays and API: /attempt, /utility, /practice, /brains, /robots, /arena, /replay
- [x] Backup chain: OpenRouter free models, then Groq gpt-oss-120b and gpt-oss-20b, then Deploy GLM-5.3-Flash, then local Ollama gemma4:e4b on D: (`npm run bench`)

## Phase 5. Website (`web/`, React + Vite + TypeScript) (20%): 0%
- [ ] Scaffold and theme
- [ ] Wallet: QoreX / EVM provider on chain 9800, account display, EVM window guidance
- [ ] Arena canvas: map, red zones, animated robot path, replay viewer
- [ ] Practice mode (no wallet) against the demo robots
- [ ] Attack flow: startSession tx, sign instruction, verdict, relay recordResult, claimBounty on breach
- [ ] Leaderboard and robot pages (rating, tier, bounty)
- [ ] Owner flow: publish brain config, register robot, deposit bounty, utility score

## Phase 6. Integration on testnet (5%): 0%
- [ ] End-to-end round with the test attacker account (startSession, attempt, recordResult)
- [ ] Utility score recorded on chain for the demo robot(s)
- [ ] Second demo robot with the LLM brain and a small bounty

## Phase 7. QCAI two-stage audit (8%): 0%
- [ ] Find out how the QCAI audit works (category requirement)
- [ ] Stage 1 audit, fix findings
- [ ] Stage 2 audit, publish reports in `audits/`

## Phase 8. Hosting (4%): 0%
- [ ] Host the backend (needs an account from the owner)
- [ ] Host the website (needs an account from the owner)

## Phase 9. Submission (8%): 30%
- [x] README with deployed addresses and credits; AI_USAGE.md log
- [ ] README: architecture diagram, screenshots, how to play
- [ ] Cover image and demo video (owner, planned for 1 Dec)
- [ ] Final check against the official rules and submit before 2 Dec

## Needs the owner
- Free AI key: done (OpenRouter key in backend/.env, git-ignored)
- Hosting accounts (backend + web)
- Cover image and demo video (planned for 1 Dec)
- Drill day 18 Nov: say "drill day"; the proof is run and the hash handed over
