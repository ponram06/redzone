# Verification findings: verdicts

One row per finding from Slither, coverage gaps, QCAI or manual review. Verdicts: **real** (fixed,
with the test that proves it), **not reachable** (why, with the line), **by design** (why).
Pass run on 21 Nov 2026; outputs in [2026-11-21/](2026-11-21/).

## Real bugs (all fixed, each with a test that failed before the fix)

| Source | Finding | Location | Fix | Test |
|---|---|---|---|---|
| Server review | Deposits into the previous vault (V4) were counted against new V5 payments, so pools were locked short. No money lost: the rest stayed with the relayer. | backend/src/chain.ts `depositFromReceipt` | Only the live vault's events count; the short pools were topped up (V5 holds 64.5 QOR = totalLocked) | test/deposit.test.ts |
| npm audit | @fastify/static path traversal / route guard bypass (High) | backend dependency | 10.1.12 | api.test.ts "the website folder can't be escaped"; live site returns 404 for every escape attempt |
| Server review | A payout retry after the verdict was already on chain re-sent `recordResult`, which the registry refuses (`AlreadyRecorded`), so the claim was never retried. A winner whose first payout transaction failed in transit could lose the prize after the 1-day claim window. | backend/src/game.ts `relayAgain` / `relayVerdict` | A retry reads the session from chain; if the result is recorded it only settles the bounties | api.test.ts "a retry after the verdict landed but the payout failed pays the prize" |
| Server review | Same path when the `recordResult` receipt was lost (timeout): no hash stored, the retry re-recorded and failed forever | same | same (the chain, not the stored hash, decides) | api.test.ts "a retry after a recordResult whose receipt was lost pays the prize" |
| Live tests (`npm run test:live`) | The server built take-back digests with the previous vault's signing domain (`RedZone.EscrowVault.v4`); EscrowVaultV5 uses `RedZone.EscrowVault.v5`, so every take-back started from the website on V5 would be refused. Fail closed: no money at risk, but owners couldn't take a pool back from the site. The unit tests signed and checked with the same function, so they could not see it. | backend/src/signer.ts `VAULT_DOMAIN` | The domain follows the live vault (`vaultDomain(VAULT_NAME)`); the server now compares its digests with the contracts' own at startup and refuses to run on a mismatch | signer.test.ts "signing domains are the contracts' own tags" (reads the tags from the Solidity sources); live test "local digests equal the contract digests" |
| Server review | A failed payout was retried only when the player pressed "Try again"; a player who left could lose the prize after the claim window | backend/src/game.ts | The server retries unfinished verdicts every 2 minutes (`retryFailedRelays`); the site says so | api.test.ts "the server retries a failed payout by itself" |

No contract bug was found. The contracts are unchanged.

## Slither (live contracts, informational excluded)

The 21 Nov run ([2026-11-21/slither.txt](2026-11-21/slither.txt)) scans every contract in `src/` and
reports 32 results: the 14 below for the live contracts (unchanged from the baseline) and 18 in
retired contracts that hold no funds (EscrowVault, RobotRegistry, RobotRegistryV2, V3 and V4
vaults/registries), which are not triaged further.

| Finding | Location | Verdict | Evidence |
|---|---|---|---|
| High `arbitrary-send-eth`: `buyTries` sends to `treasury` | RobotRegistryV4.sol:388 | **by design** | `treasury` is set only in the constructor or by `setTryPrice`, which needs the admin's ML-DSA-87 signature (`onlyAdmin`); it can't be zero while a price is set (line 404). The buyer pays exactly `price * count` (`WrongPayment` otherwise), so a price change in between makes the purchase revert, never overcharge. State is written before the call and a failed transfer reverts everything. Live: treasury is the project's own account. Tests: `test_Tries_PaymentGoesStraightToTreasury`, `test_Tries_PriceIsAdminOnlyAndBounded`, `test_Tries_RefusingTreasuryRevertsThePurchase` |
| Medium `incorrect-equality`: `s.brainVersion == r.brainVersion` | RobotRegistryV4.sol:449 | **by design** | The detector targets equality on values an attacker can push (balances). Both sides are counters only the contract changes (`updateBrain` increments by one, sessions copy it at start), and equality is exactly the rule: a verdict counts for the stats of the brain it was played against. Payouts don't use this line (the vault uses `minBrainVersion`). Test: `test_OldBrainVerdictNotCounted` |
| Low `timestamp` ×12 | PQAccess 154, 159, 201, 209, 274, 275; RobotRegistryV4 274, 327, 347, 367, 444; EscrowVaultV5 246, 275-280, 313-315 | **by design** | Every comparison is a window of minutes to days (session 10 min, result grace 1 h, withdraw delay 3 h, claim window 1 day, pause at most 7 days). A block producer can shift a timestamp by seconds, which can't move a result across these windows in any way that pays the wrong person. Bounds are inclusive and fuzzed: `testFuzz_Stage2_ResultWindow`, `test_Branch_ResultAfterItsDeadlineRefused` |

## Coverage gaps (before: vault 66% branches, registry 84%, PQGuard 14%, MLDSA87 50%)

Every branch the suites did not reach now has a test in
[contracts/test/v6/Branches.t.sol](../../contracts/test/v6/Branches.t.sol) (32 tests), except the
three below, which can't be reached:

| Branch | Verdict | Why |
|---|---|---|
| RobotRegistryV4.sol:517 `_sessionExpiresAt` unknown session | **not reachable** | Called only from `_resultDeadline` after `_applyResult` already refused an unknown session (line 442, tested), and from `_startSession` right after the session is written |
| EscrowVaultV5.sol:153 `CLAIM_WINDOW < MIN_CLAIM_WINDOW` | **not reachable** | Both are constants (1 day, 1 hour); the check guards future edits. `test_Branch_VaultTimingsFitTheLiveRegistry` asserts the sums |
| EscrowVaultV5.sol:332 `require(success, ...)` both arms; 151 | **covered (tool artifact)** | With `--ir-minimum` forge does not attribute `require` with a custom error, or some `if` arms, to a branch. Line counts prove both are hit: line 151 runs 119 times and line 152 118 times (one test stops at 151); `test_FailedPaymentRevertsEverything` expects `TransferFailed` |

After (strict run, [2026-11-21/coverage.txt](2026-11-21/coverage.txt)): PQGuard, QoreXMessage,
PQAccess, MLDSA87 100% branches; RobotRegistryV4 97.8% (44/45, the unreachable one above);
EscrowVaultV5 87.5% as the tool counts it (28/32: the unreachable constant check and the three
tool artifacts above), so every reachable branch is tested. Lines 99-100% on all six.

## Precompile misbehaviour (fail closed)

A missing, reverting, short-answering or garbage-answering `pqcVerify` / `pqcKeyStatus` makes every
signed action revert, and no verdict can be recorded, so nothing can be paid:
`test_Branch_KeyStatusShortAnswerFailsClosed`, `..._KeyStatusRevertFailsClosed`,
`..._VerifyRevertFailsClosed`, `..._VerifyEmptyAnswerFailsClosed`, `..._VerifyGarbageAnswerFailsClosed`,
`..._MisbehavingPrecompileNeverPays`, and the earlier `test_Attack_PrecompileMissingFailsClosed`.
A precompile that answers "valid" to everything can't be defended against in a contract; that is
the chain's own trust base.

## Signature review

| Check | Result |
|---|---|
| Domain | Every digest is `keccak256(domainTag, chainid, address(this), keccak256(struct))` (PQAccess.sol:244): a signature for one contract, chain or deployment is useless on another |
| Distinct types | 14 typehashes, all different strings. The registry and the vault both use `SetPaused`, but their domain tags and addresses differ |
| Nonce + deadline | Every user and admin action includes the signer's nonce and a deadline, checked by `validDeadline` (not in the past, at most `MAX_REQUEST_TTL` ahead). Every used digest is also stored (`usedDigests`), so a second, different signature over the same digest is refused |
| Verdicts | `Result` has no nonce: it is bound to the session id, robot and player, recorded at most once (`AlreadyRecorded`) and only within the session's window |
| QoreX format | `qorechain-msg-v1|<chain id>|RedZone authorisation\naction: <Action>\ndigest: 0x<hex>`. The contract builds the text with its own action name, so a signature shown in the wallet as one action can't authorise another. The raw-digest form is 32 bytes and the wallet form never is, so they can't collide |
| No ECDSA-only path | `test_NoEcdsaShortcuts`; every state change checks an ML-DSA-87 signature |

## Invariants at strict depth

1,000 random campaigns of 200 calls each (200,000 calls per property), 10,000 runs per fuzz test:
vault balance never below `totalLocked`; money in = locked + paid to players + paid to owners;
`totalLocked` = sum of open bounties; a win is never beaten by a take-back; an open pool never pays
a player twice; a once-per-brain pool never pays the same brain version twice; no payout above the
prize; **added in this pass:** only the session's player gains from a payout (nobody else). Plus
fuzzed pools of every legal size: exactly `ceil(pool / prize)` winners, the total paid is exactly
the pool, the last prize is the remainder (`testFuzz_Edge_OpenPoolPaysExactlyThePool`,
`testFuzz_Edge_OncePerBrainPaysOncePerVersion`, `test_Edge_MinimumPoolAndPrize`).

## Server, live

| Check | Result |
|---|---|
| Relayer targets | Sends only to the registry and the live vault (`ChainRelayer.send` refuses anything else; the chain's EVM window is scoped to the same two) |
| Relayer powers | Can't sign for players (every action carries the player's ML-DSA-87 signature, checked in the contract) and can't take a pool back (the vault makes the robot's owner the pool's owner) |
| Deposits | Paid minus already deposited, both read from the chain, so a retry never locks twice (re-checked after the V4 to V5 bug) |
| Freeze | Refused before any signature on every start path (QoreX start, play pass); the contract pays once per brain version regardless, so money safety does not depend on the server |
| Referee | Deterministic: same brain answer, same verdict; walls are solid 2-unit blocks with gaps, a red zone behind a wall never counts; one verdict per session, stored before relaying; signed only for that session's robot and player and its own deadline |
| Referee key | Live server's key hash = registry's `refereeKeyHash`; no pending key change |
| Chain vs site | All 7 pools on the site match the vault to the wei; vault balance 64.5 QOR = `totalLocked` |
| Secrets | Server key files mode 600; only ports 22/80/443 open (8787 internal); SSH key only, no passwords; `.env`, key files and source return 404 on the live site; no key ever committed (git history checked); errors show HTTP status and model name, never keys |

## Known limitations (documented, not bugs)

- No paid human audit; the QCAI reports and this pass are the review.
- AI robots depend on free model limits; the site says so when a limit is reached.
- Read-only routes that query the chain (`/tx/:hash`, `/robots/:id/prize`) are not rate limited; they
  only read public data from a public RPC.
- If a skills-test receipt is lost, the next request reports "already tested" (the score is on chain).
