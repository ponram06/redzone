# Verification findings: verdicts

One row per finding from Slither, coverage gaps, QCAI or manual review. Verdicts: **real** (fixed,
with the test that proves it), **not reachable** (why, with the line), **by design** (why).

| Source | Finding | Location | Verdict | Evidence |
|---|---|---|---|---|
| Slither (High) | arbitrary-send-eth: `buyTries` sends to `treasury` | RobotRegistryV4.sol:388 | to check | |
| Slither (Medium) | incorrect-equality: `s.brainVersion == r.brainVersion` | RobotRegistryV4.sol:449 | to check | |
| Slither (Low ×12) | timestamp comparisons (deadlines, delays, pause) | PQAccess, RobotRegistryV4, EscrowVaultV5 | to check | |
| Server review | deposits into the previous vault counted against new payments | backend/src/chain.ts `depositFromReceipt` | **real, fixed 21 Nov** | test/deposit.test.ts |
| npm audit | @fastify/static path traversal / route guard bypass (High) | backend dependency | **real, fixed 21 Nov** (10.1.12) | test "the website folder can't be escaped" |
