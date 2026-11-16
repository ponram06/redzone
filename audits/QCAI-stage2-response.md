# QCAI Stage 2: findings and responses

- **Report:** [`QCAI-stage2-try1.pdf`](QCAI-stage2-try1.pdf), generated 16 Nov 2026 for the v3 contracts.
- **Blockchain setting:** QoreChain.
- **Result:** 85/100, risk MEDIUM, **Quantum Readiness: QUANTUM-SAFE**, 5 findings.

None of the five findings from [Stage 1](QCAI-stage1-response.md) came back. The five new ones are answered below.
The updated bundle is [`RedZone.v3.flat.sol`](RedZone.v3.flat.sol). It contains `PQAccess`, `RobotRegistryV3`,
`EscrowVaultV2`, the new `MLDSA87` library and OpenZeppelin `ReentrancyGuard` v5.1.0.

## Findings

| # | QCAI finding | Severity | Was it real? | What changed | Tests |
|---|---|---|---|---|---|
| 1 | Potential ML-DSA-87 signature malleability | High | **No.** ML-DSA signing is hedged (randomised), so one message legitimately has many valid signatures. RedZone never uses signature bytes as a replay key; every digest carries a per-signer nonce. | Two extra layers. **(a)** Every signed digest (admin, user, referee) is recorded in `usedDigests`, so a second, different valid signature over a used digest reverts `DigestUsed`. **(b)** The new `MLDSA87` library enforces the exact format: algorithm id 1, a 2592-byte public key and a 4627-byte signature. These values were checked against `pqcKeyStatus` on qorechain-diana and a real signature. | `test_Stage2_SecondSignatureOverUsedDigestRefused`, `…UserDigestsMarkedUsed`, `…WrongSignatureLengthRefused`, `…NonMLDSA87KeyRefused`, `…RefereeKeyMustBeMLDSA87` |
| 2 | Reentrancy risk in EscrowVaultV2 | Medium | **No.** The hand-written lock and checks-effects-interactions were already in place (and tested). | Now uses OpenZeppelin `ReentrancyGuard` (v5.1.0) on `depositBounty`, `claimBounty` and `finalizeWithdraw`. State is still updated before every transfer. | `test_Stage2_OZGuardBlocksCrossFunctionReentry`, `test_Attack_ReentrancyOnClaim`, invariant suite |
| 3 | Incorrect session expiry handling ("timing differences between nodes") | Medium | **No.** `block.timestamp` is agreed by consensus, so every node sees the same time, and the windows are minutes long. | One source of truth: `sessionExpiresAt(id)` and `resultDeadline(id)`, inclusive everywhere, with NatSpec explaining the timing model. `SessionStarted` and `recordResult` both use them. | `test_Stage2_SessionBoundaries` (last valid second, and one second late), `testFuzz_Stage2_ResultWindow` (5,000 runs) |
| 4 | Missing input validation for chain id | Low | **No.** `QoreXMessage.checkChainId` already limited it to 1–64 characters. | v3 also has a named constant, `MAX_CHAIN_ID_LENGTH = 64`, with an explicit check in the constructor (`BadChainId`). | `test_Stage2_ChainIdLength` (0 and 65 refused, 64 accepted) |
| 5 | Precompile availability assumption | Info | **Intended.** Verification fails closed. Falling back to ECDSA, or skipping the check, would remove the quantum safety. | NatSpec says so. A new `isPQAvailable()` view never reverts, so frontends can show a clear message. | `test_Stage2_PrecompileAvailability`, `test_Attack_PrecompileMissingFailsClosed` |

## Independent review of these changes (third pass)

No new exploitable bug was found. One deployment risk was found and is now closed.

**The risk:** if the strict ML-DSA-87 format checks did not match what the chain really produces, deposits would still work but every signed exit would fail, and funds could be locked.

**The fix:**
- **Deploy-time proof:** both contracts now verify a real ML-DSA-87 signature from the deployer in the constructor, and the registry also verifies one from the referee key, against the live precompile. If the format were wrong, deployment itself fails, before any QOR can be deposited.
- **New referee keys:** a new referee key must also sign its own proposal.
- **Tests:** `test_Deploy_NeedsWorkingDeployerKey` (including a 4595-byte round-3 Dilithium5 signature), `test_Deploy_NeedsWorkingRefereeKey`, `test_Deploy_ProofBoundToDeployerAndChain`, `test_ProposeReferee_NewKeyMustProveItself`.

**Invariant testing was also extended:**
- Rounds are now judged in separate random steps, interleaved with pauses, withdrawal requests and time jumps.
- A new invariant, `invariant_WinsAreNeverBeatenByWithdrawal`, checks that the owner is never paid while a round that could win the bounty is unjudged, or within an hour of a winning verdict.

## Full test results (16 Nov 2026)

| Check | Result |
|---|---|
| Foundry tests | **158 passed, 0 failed** (5 suites: the deployed contracts' 92 tests, plus 66 v3 tests) |
| Fuzzing | 5,000 runs per fuzz test, all passing |
| Invariant testing | 4 invariants × 1,000 runs × 100 random calls = **100,000 calls**, 0 violations. Random sequences of deposits, rounds, verdicts, claims, withdrawals, pauses and time jumps (up to 8 days) were checked for:<br>• the vault balance always covers `totalLocked`;<br>• money in = money locked + money paid out;<br>• `totalLocked` = the sum of open bounties;<br>• a win is never beaten by the owner's withdrawal.<br>A sanity test confirms the random calls really reach both payout paths. |
| Coverage of `src/v3` | **99.68% of lines** (309/310), 97.2% of statements, 84.7% of branches, 98.5% of functions |
| Slither 0.11.6 | No High or Medium findings. The remaining notices are by design: `arbitrary-send-eth` (payees come from the registry or the owner's signature), `timestamp`, `low-level-calls` (native QOR payment), `incorrect-equality` (exact brain-version comparison), and `pragma`. |
| Backend tests | 73 passed (unchanged; the deployed contracts are untouched) |

Run them with:

```sh
cd contracts
pnpm forge-std                                   # forge-std and OpenZeppelin v5.1.0 into lib/
FOUNDRY_FUZZ_RUNS=5000 FOUNDRY_INVARIANT_RUNS=1000 FOUNDRY_INVARIANT_DEPTH=100 forge test
forge coverage --match-path "test/v3/*" --no-match-coverage "test|script|lib|src/[A-Z]"
python -m slither src/v3/EscrowVaultV2.sol --exclude-dependencies
```

## About the score

QCAI is an AI auditor: each run lists about five observations, and the score stayed at 85. The same score appears on QoreChain's public sample reports. What matters for the drill is that every finding is checked, either fixed or explained, and covered by a test. Across both stages, that is true for all ten findings, and the contracts are rated **QUANTUM-SAFE**.

## Re-run on the deployed contracts (try 2)

- **Report:** [`QCAI-stage2-try2.pdf`](QCAI-stage2-try2.pdf), for the code deployed at RobotRegistryV3 `0x5398b7983ac5c1b9818c51298c4886cf9bef5308` and EscrowVaultV2 `0x26b9e47adf2e8e239729c0e3354998e06aa2c638`.
- **Result:** 85/100, **QUANTUM-SAFE**, 5 new observations. None of the previous five came back, and none of these five is a code defect.

| QCAI finding | Severity | Answer |
|---|---|---|
| Missing ML-KEM implementation | High | Not applicable. ML-KEM is a key-encapsulation (encryption) scheme. These contracts hold no secrets; all on-chain data is public, so there is nothing to encrypt. Every authorisation uses ML-DSA-87 signatures, and the chain itself provides ML-KEM-1024 at the network layer. The report rates the contracts QUANTUM-SAFE. |
| Reentrancy risk in claimBounty | Medium | Not an issue. `claimBounty` updates the status, amount and `totalLocked` before the single value transfer, under OpenZeppelin `ReentrancyGuard`. The only earlier external call is a view call to the immutable registry. The suggested "external calls before state modifications" is the reverse of the checks-effects-interactions pattern. Tested by `test_Attack_ReentrancyOnClaim`, `test_Stage2_OZGuardBlocksCrossFunctionReentry` and the invariant suite. |
| Precompile availability check flaw | Medium | `isPQAvailable()` is a read-only hint for frontends. Every state-changing action fully decodes and checks precompile results (`PQGuard.verify`/`keyStatus` length checks plus `abi.decode`) and fails closed. Tested by `test_Stage2_PrecompileAvailability` and `test_Attack_PrecompileMissingFailsClosed`. |
| Session expiry calculation inconsistency | Low | Not an issue. Timestamps are stored as `uint64` (good for ~5.8e11 years) and widened explicitly with `uint256(...)` before arithmetic. There is one source of truth (`sessionExpiresAt`/`resultDeadline`), with boundary and fuzz tests. |
| Missing chain id validation in the constructor | Info | Already present. The `PQAccess` constructor checks the length (`MAX_CHAIN_ID_LENGTH`) and then calls `QoreXMessage.checkChainId` for the character set (`test_Stage2_ChainIdLength`, `test_Constructor_RejectsBadChainIds`). |

Across three QCAI runs the score stayed at 85 with five different observations each time, which suggests the score reflects the auditor's format, not open defects. Every observation has been answered or fixed.
