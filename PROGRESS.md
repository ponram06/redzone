# RedZone build progress

Working file for the build. Each item is committed and pushed when done. A new session resumes from
the first unchecked item.

Rules: no Claude co-author line in commits. Never commit `.env`, `.referee-key.json`, `.attacker.json`.
Do not spend drill-account QOR or touch the fest website without the owner.

## Done
- [x] Contracts: PQGuard, PQAdmin, EscrowVault, RobotRegistry, 47 Foundry tests
- [x] Deployed to qorechain-diana (see deployments/testnet.json)
- [x] Q-Day Drill registered; rehearsal 22/22 attacks blocked (docs/QDAY_DRILL.md)

## Backend (`backend/`, Node + TypeScript)
- [ ] Scaffold: package.json, tsconfig, vitest, env example
- [ ] Arena model: map, walls, red-zone polygons, goal, 10 utility tasks
- [ ] Geometry: segment vs polygon, path clamping and limits
- [ ] Brains: rule-based default; OpenAI-compatible connector (Groq / Gemini / OpenRouter / Ollama)
- [ ] Referee: verdict, utility scoring
- [ ] Signing: digests identical to contracts, ML-DSA-87 signatures; parity test against live contracts
- [ ] Replays: storage and replayHash
- [ ] API: GET /arena, POST /attempt, POST /utility/:robotId, GET /replay/:hash, GET /robots
- [ ] Tests green, README section

## Website (`web/`, React + Vite + TypeScript)
- [ ] Scaffold and theme
- [ ] Wallet: QoreX / EVM provider on chain 9800, account display
- [ ] Arena canvas: map, red zones, animated robot path, replay viewer
- [ ] Attack flow: startSession tx, prompt, verdict, relay recordResult, claimBounty on breach
- [ ] Leaderboard and robot pages from RobotRegistry events
- [ ] Owner flow: register robot, deposit bounty

## Integration and docs
- [ ] End-to-end check on testnet (read-only where it would spend drill QOR)
- [ ] README: architecture, run instructions, screenshots
- [ ] AI_USAGE.md log up to date

## Needs the owner
- Free AI key (Groq or Gemini) for the real brain
- Hosting accounts (backend + web)
- Cover image, demo video (planned for 1 Dec)
- Drill day 18 Nov: run `npm run window proof` in contracts/, submit the hash by 19 Nov
