# Full verification pass (21 Nov 2026)

Goal: check every part of RedZone that holds or moves money, or decides who gets it, against
written rules, with evidence for each. "Bug-free" cannot be proven; what we can do is make every
known class of mistake fail a test, a tool or a checklist item, and write down what is left.

## Rules for the pass

1. **No change without a failing test first.** Every fix starts as a test that fails on the current
   code, then passes.
2. **Every tool finding gets a verdict** in [audits/verification/TRIAGE.md](../audits/verification/TRIAGE.md):
   *real (fixed, with the test)*, *not reachable (why, with the line)*, or *by design (why)*.
   Nothing is ignored silently.
3. **Live contracts are fixed only for real, reachable bugs.** RobotRegistryV4 holds every robot
   and its history, and redeploying it means re-registering robots. A vault redeploy means moving
   the pools again (3-hour take-back). Anything smaller goes into the docs as a known limitation.
4. **Same compiler settings as the deployment** (solc 0.8.28, optimizer 200 runs). The strict
   profile only raises fuzz and invariant depth.
5. **Nothing is sent on chain** without the owner's go-ahead. The verification itself is read-only.
6. **Results are written down**: dated outputs in `audits/verification/<date>/`, and a summary in
   docs/AUDIT.md at the end.

## How to run

```bash
bash scripts/verify-all.sh            # everyday depth
STRICT=1 bash scripts/verify-all.sh   # 10,000 fuzz runs, 1,000 x 200-call invariant campaigns
```

It builds the contracts, runs Foundry tests, coverage of the live contracts, Slither, backend
typecheck, tests and `npm audit`, and the web build and `npm audit`, then writes a summary.

## Baseline (21 Nov, before the pass)

| Check | Result |
|---|---|
| Foundry tests | 445 passing |
| Backend tests | 114 passing |
| Coverage, RobotRegistryV4 | lines 100%, statements 97%, **branches 84% (38/45)** |
| Coverage, EscrowVaultV5 | lines 99%, statements 94%, **branches 66% (21/32)** |
| Coverage, PQAccess | 100% everywhere |
| Coverage, MLDSA87 / PQGuard | branches **50% / 14%** (tests use a mock precompile, so the real-precompile error paths are not hit) |
| Slither (live contracts, no informational) | 1 High `arbitrary-send-eth` (buyTries -> treasury), 1 Medium `incorrect-equality` (brainVersion), 12 Low `timestamp` |
| npm audit | backend 0, web 0 (after upgrading @fastify/static on 21 Nov) |
| QCAI | registry + V5 vault: 85, then 82/100 QUANTUM-SAFE, all findings answered |

Fixed on 21 Nov while preparing this: a server bug where deposits into the previous vault were
subtracted from new payments (pools locked short; no money lost, test added), and the
@fastify/static path-traversal advisories (upgrade, test added).

## Work list

### A. Contracts (live: RobotRegistryV4, EscrowVaultV5, with PQAccess, MLDSA87, PQGuard, QoreXMessage)

- [x] **Branch coverage to 100%** on EscrowVaultV5 and RobotRegistryV4: list each uncovered branch
      (`forge coverage --report lcov`), write a test that reaches it or explain why it can't be.
- [x] **PQGuard / MLDSA87 error paths** with a mock that returns short or malformed data, reverts,
      or is missing: every case must revert (fail closed), never return true.
- [x] **Triage all 14 Slither results** (rule 2). Re-check the High: who can set `treasury`, and can a
      buyer ever pay someone else.
- [x] **Strict invariant run** (`STRICT=1`) with these properties, adding any that are missing:
  - money in = locked + paid to players + paid to owners (vault balance never below `totalLocked`);
  - no payout larger than the pool's prize, none to anyone but the session's player;
  - an open pool never pays a player twice; a once-per-brain pool never pays the same brain
    version twice, and pays nothing after a win until the brain version goes up;
  - a take-back never beats a win that was recorded in time;
  - the admin can never move funds; a pause ends by itself;
  - every state change needs a valid, unused ML-DSA-87 signature (no ECDSA-only path).
- [x] **Signature domain review**: every digest includes chain id, contract address, nonce and
      deadline; no two actions share a typehash; QoreX message format matches the server.
- [x] **Line-by-line read** of EscrowVaultV5 `_next`, `claimBounty`, `skipBreach`, `finalizeWithdraw`
      and RobotRegistryV4 `_applyResult`, `startSessionFor`, `recordResult`, against the rules above.
- [x] **Fuzz the edge values**: prize = pool, prize = MIN_PRIZE, pool = MIN_BOUNTY, deadlines at
      exactly now / now + TTL, brain updates in the same block as a result.

### B. Server (referee, relayer, API)

- [x] **Referee**: the same instruction and brain answer always give the same verdict; a verdict is
      signed only for the session's robot, player and the current deadline; one verdict per session.
- [x] **Relayer**: only sends to the registry and the live vault; never signs a user's action for
      them; deposits only paid minus deposited (checked again after the V4 -> V5 bug); nonce queue.
- [x] **Freeze**: a frozen robot refuses every way of starting a paid round (QoreX, play pass);
      a fix reopens it; the demo robot never freezes.
- [x] **Input limits and rate limits** on every route; error messages never leak keys or paths.
- [x] **Secrets**: never logged, never in git, file permissions on the server, `.env` not served.
- [ ] Live tests (`npm run test:live`) against the deployed contracts.

### C. Website

- [x] What the site shows matches the chain for every robot (prize per win, frozen, totals).
- [ ] Every QoreX signature request shows what it authorises; errors are readable.
- [x] Build passes; npm audit clean.

### D. Live end-to-end on testnet (with the owner)

- [ ] As a new player: sign up, breach Sentinel-01, get paid 1 QOR.
- [ ] Breach an AI robot (or a test robot): it freezes; paid rounds are refused; the owner fixes it
      with "Fix this robot"; it reopens; the earlier winner can win again.
- [ ] Re-add robot #5's 2 QOR from kira; take-back of a pool still works on V5.

## Results (21 Nov)

Every item above is done except the live end-to-end run (D), which needs the owner, and the
`test:live` suite. Verdicts and evidence: [audits/verification/TRIAGE.md](../audits/verification/TRIAGE.md).
Found and fixed in this pass (server, not contracts): a payout retry could never pay once the verdict
was on chain (two paths), and a failed payout was only retried if the player pressed "Try again"; the
server now retries by itself every 2 minutes. No contract bug was found; the contracts are unchanged.

## Exit criteria

All tests pass in the strict profile; every Slither and QCAI finding has a verdict; branch
coverage gaps are tested or explained; the live end-to-end run passes; docs/AUDIT.md updated with
the results and the known limitations that remain (for example: no paid human audit, AI brains
depend on free model limits).
