# RedZone build progress

Working file for the build. Each item is committed and pushed when done. A new session resumes from
the first unchecked item of the earliest unfinished phase.

Rules: no Claude co-author line in commits. Never commit `.env`, `.referee-key.json`, `.attacker.json`.
Do not spend drill-account QOR or touch the fest website without the owner.

Overall: about **88%** (each phase's weight is in brackets; last updated 2026-11-19).

## Phase 1. Setup and registration (5%): done
- [x] Hackathon registration, Post-Quantum dApp category, project page on build.qorechain.io
- [x] Testnet accounts: main (QoreX) and drill/admin account with a registered ML-DSA-87 key
- [x] Repo, MIT licence, README, credits, AI_USAGE.md

## Phase 2. Smart contracts (20%): done
- [x] PQGuard, PQAdmin, EscrowVault, RobotRegistry, 47 Foundry tests
- [x] Deployed to qorechain-diana (see deployments/testnet.json); demo robot and 1 QOR bounty
- [x] v3 (RobotRegistryV3 + EscrowVaultV2, ML-DSA-only access, earliest-breach payouts): fixed the adversarial audit findings, redeployed 16 Nov; 167 Foundry tests
- [x] Blockhertz gas findings applied to EscrowVaultV2 source (gas only; goes live with the next deploy)
- [x] v4 (19 Nov): RobotRegistryV4 = v3 + 10-minute play pass (one QoreX approval for many rounds) + paid tries (0.1 QOR each, no cap, paid straight to the treasury = main account); EscrowVaultV3 = the gas-optimised vault. 253 Foundry tests. Deployed: registry 0xef521a3a…a115, vault 0xf436fde0…2bc2 (QoreChain caps a deployment at ~5M gas, so v4 was trimmed to 20 KB)
- [x] Demo robot #1 on v4 with a 1 QOR bounty and a 10/10 skills score
- [x] EscrowVaultV4 (19 Nov): prize pools, a fixed prize per win, one per player, once per brain version by default; terms from the maker's signed payment memo. 348 Foundry tests (incl. pool tests and a one-prize-per-player invariant). Deployed 0xb0a270a8…ece8 (tx 0xf2d71671…5b2c); the demo bounty was taken back from EscrowVaultV3 and locked as a 1 QOR pool at 0.5 QOR per win (0xd4c35502…7625)

## Phase 3. Q-Day Drill (10%): done
- [x] Registered for the drill: RobotRegistryV3 + EscrowVaultV2
- [x] Rehearsal: 22/22 attacks blocked, open-window weak spot fixed (docs/QDAY_DRILL.md)
- [x] 18 Nov: window none, proof `4CD4CBB8…` (hybrid self-transfer) sent and accepted on the project page
- [x] 19 Nov: account unchanged apart from the proof fee; nothing taken (docs/QDAY_DRILL.md, "Drill result")
- Results: attack log after the drill; Q-Day Survivor winners on 16 Dec

## Phase 4. Backend (`backend/`, Node + TypeScript) (20%): done
- [x] Arena, geometry, referee simulation, route planner
- [x] Brains: rule brain, OpenAI-compatible LLM brain (OpenRouter free models), brain registry by hash
- [x] ML-DSA-87 signer, live parity test against the deployed contracts
- [x] Replays and API: /attempt, /utility, /practice, /brains, /robots, /arena, /replay
- [x] Backup chain: OpenRouter free models, then Groq gpt-oss-120b and gpt-oss-20b, then Deploy GLM-5.3-Flash, then local Ollama gemma4:e4b on D: (`npm run bench`)

## Phase 5. Website (`web/`, React + Vite + TypeScript) (20%): 90%
- [x] Scaffold and theme
- [x] Wallet: QoreX connect (native lane), ML-DSA signArbitrary for sessions and attempts
- [x] Arena canvas: map, red zones, animated robot path, replay viewer
- [x] Practice mode (no wallet) against the demo robots
- [x] Attack flow: QoreX-signed StartSession relayed to RobotRegistryV2, signed instruction, verdict, auto recordResult + claimBounty
- [x] Relayer account: funded with 3 QOR from the main account, PQC key registered (tx 92C274AE…98FC)
- [x] One-time player sign-up (0.1 QOR native payment from QoreX, verified by the referee)
- [x] Simple redesign for non-crypto users: Home, Play, Rankings, robot pages, For robot makers, Help (plain language; technical details tucked away in Help)
- [x] Owner flow: choose a brain (AI guard with own rules, or simple guard), register the robot (QoreX-signed, relayed registerRobotFor), change brain (relayed updateBrain), automatic skills test recorded on chain (recordUtility)
- [x] Robot makers page simplified to 3 steps (write rules, test, name and add); own AI account is an optional fold-out; starting rules blocked 6/6 sample tricks
- [x] Leaderboard: safest robots and top players (wins, rounds, prizes won)
- [x] Owners can bring their own AI: provider allowlist (OpenAI, Gemini, Groq, OpenRouter, Mistral, DeepSeek, Together), key checked with a real call, stored AES-256-GCM encrypted, never returned, bound to the first owner who uses it
- [x] Bounty is required when adding a robot (min 1 QOR): paid from QoreX to the relayer, checked on chain, locked with depositBounty by the relayer; makers can take unwon bounties back (relayer ML-DSA withdrawBounty). QoreX limitation explained in the README
- [x] Website says "bounty" everywhere (was "prize")
- [x] Chain is the source of truth: leaderboard from contract events, sign-ups and bounties from chain payments + vault events, game rules from contract constants, chain id from the deployment record; no numbers typed into the website (README "Where the data comes from")
- [x] Backend and website moved to v3 (19 Nov): new digests and ABIs, verdicts bound to robot + player, bounties settled through the vault's earliest-breach queue, take-back = signed requestWithdraw then finalizeWithdraw after 3 h, relayer reopens its window when scoped to old contracts; 74 tests + live parity against v3
- [x] Demo robot #1 "Sentinel-01" on v3 (19 Nov) with the rule brain's real fingerprint and a 1 QOR bounty paid like a maker would (admin -> relayer with memo, relayer depositBounty; `backend/scripts/demo-robot.ts`): register 0x2d05c43c…, payment 0783348A…, deposit 0x5fcac388…

## Phase 6. Integration on testnet (5%): 0%
- [ ] End-to-end round from the website with the main QoreX account: verify, start, attack, verdict (planned after 19 Nov, after the drill)
- [x] Utility score recorded on chain for robot #1: 10/10
- [x] AI robots (19 Nov, owner funded 20 QOR admin + 10 QOR relayer): #2 Atlas (OpenRouter free models, Groq backup), #3 Titan-120B (Groq gpt-oss-120b), #4 Spark-20B (Groq gpt-oss-20b); each a 5 QOR pool at 1 QOR per win (`scripts/demo-robot.ts --name --brain --pool --prize`)
- [x] Skills test for robots #2-#4: all 10/10, recorded on chain 19 Nov (tx 0x0b6323…, 0x188dc7… for #3, #4)
- [x] Owner page: removed the "Try to trick it yourself" step (owners test their own brains; the site is for players to find the weak spots)

## Phase 7. Audits (8%): 85% (v3 and v4 audited; the prize-pool vault still to run)
- [x] Found it: QCAI Smart Contract Auditor at dashboard.qorechain.io/audit, a main requirement of the Post-Quantum dApp bounty; 150 QOR per audit
- [x] Self-review before paying (audits/SELF_REVIEW.md); one-file bundle audits/RedZone.flat.sol so one run covers both contracts
- [x] Server fix for finding 1: no bounty take-back while a win can still be recorded or paid
- [x] QCAI stage 1 and stage 2 (two runs on the deployed v3), with written answers (audits/QCAI-stage*-response.md)
- [x] Adversarial audit of v3 (audits/ADVERSARIAL_AUDIT.md), fixed and redeployed; Blockhertz reports triaged
- [x] QCAI stage 1 (85/100) and stage 2 (87/100, QUANTUM-SAFE) on v4, answers in audits/QCAI-v4-stage*-response.md; no contract change needed
- [ ] QCAI stage 1 and stage 2 on EscrowVaultV4 (bundle ready: audits/RedZone.v5.flat.sol; owner runs it, 150 QOR each)
- [x] Solidity PQC checks: the site can't auto-verify them; README section "Solidity PQC checks: where to look" for jurors

## Phase 8. Hosting (4%): 0%
- [ ] Host the backend (needs an account from the owner)
- [ ] Host the website (needs an account from the owner)

## Phase 9. Submission (8%): 30%
- [x] README with deployed addresses and credits; AI_USAGE.md log
- [x] README: architecture diagram, how to play, v3 addresses and protections
- [ ] README: screenshots
- [ ] Cover image and demo video (owner, planned for 1 Dec)
- [ ] Final check against the official rules and submit before 2 Dec

## Checkpoint 19 Nov (resume here)
- Done today: EscrowVaultV4 docs + QCAI bundle audits/RedZone.v5.flat.sol (de8bb18); realistic 3D arena (ce13624); Sentinel-01 pool 1 QOR / 0.5 per win; AI robots #2-#4 funded
- [x] New Play flow (19 Nov): Start → sign in → choose opponent (hover record: job, recent attacks, skills, AI brain, bounty) → full-screen arena with docked message box and a "What happened" card; `/robots/:id/record`, signed robot job (`/owner/profile`), `scripts/set-job.ts`
- [x] Power plant arena v2 (160x100, reactor, chemical store, substation, crane; workshop, canteen) with substation, gantry crane, truck, workers in 3D; compact game panels; home page with a live 3D arena hero, robot picker, header Play-now button (19 Nov)
- Skills scores on chain were measured on the old arena; rerun `POST /utility/<id>` later if wanted (each run needs the next utilityNonce)
- [x] Player profiles (20 Nov): readable names + pixel avatars instead of hashes everywhere (generated, or a nickname signed in QoreX, `/player/name`), header profile chip and menu, `#/me` and `#/player/<address>`: wallet balance, GPay-style activity, prizes with proofs, rounds, stats, achievements (`/player/:address/profile`)
- Next: owner tries a real bounty round in the new arena; owner runs QCAI stage 1 + 2 on RedZone.v5.flat.sol
- Servers (local): backend `cd backend && npx tsx --env-file-if-exists=.env src/server.ts` on :8787, web `cd web && npx vite --port 5173`

## Needs the owner
- Free AI key: done (OpenRouter key in backend/.env, git-ignored)
- Hosting accounts (backend + web)
- Cover image and demo video (planned for 1 Dec)
- End-to-end round: play from the website with the main QoreX account (sign-up 0.1 QOR), ideally add the second robot (AI brain, 1 QOR bounty)
