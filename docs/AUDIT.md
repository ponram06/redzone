# RedZone: QCAI audit

**In short:** the two contracts that hold RedZone's money were audited twice by the QoreChain AI
Smart Contract Auditor (QCAI, dashboard.qorechain.io/audit). Stage 1 found issues, we answered every
one, and stage 2 audited the result. The live pair scored **85/100 in both stages on the same
Ethereum setting** (21 and 22 Nov), and **82/100, QUANTUM-SAFE** on the QoreChain setting, which
scores quantum readiness.
Every finding was either already handled in the code (with the line and the test that proves it)
or did not apply, so no contract change was needed. Two earlier versions went through the same
process.

The dated reports are in [docs/audit/](audit/); the full written answers are in [audits/](../audits/).
After the audits, a separate verification pass ran Slither, coverage and deeper fuzzing, and
reviewed the server ([audits/verification/TRIAGE.md](../audits/verification/TRIAGE.md)).

| Date | Stage | Contracts (one flattened bundle) | Setting | Score | Report |
|---|---|---|---|---|---|
| 16 Nov 2026 | 1 | RobotRegistryV3 + EscrowVaultV2 ([bundle](../audits/RedZone.flat.sol)) | ethereum (auto) | 85/100 | [PDF](audit/2026-11-16-QCAI-stage1-RobotRegistryV3-EscrowVaultV2.pdf) |
| 16 Nov 2026 | 2 | v3 after every stage 1 finding ([bundle](../audits/RedZone.v3.flat.sol)) | qorechain | 85/100, QUANTUM-SAFE | [PDF](audit/2026-11-16-QCAI-stage2-RobotRegistryV3-EscrowVaultV2.pdf) |
| 19 Nov 2026 | 1 | **RobotRegistryV4** (live) + EscrowVaultV3 ([bundle](../audits/RedZone.v4.flat.sol)) | ethereum (auto) | 85/100 | [PDF](audit/2026-11-19-QCAI-stage1-RobotRegistryV4-EscrowVaultV3.pdf) |
| 19 Nov 2026 | 2 | the same, after every stage 1 finding | qorechain | **87/100, QUANTUM-SAFE** | [PDF](audit/2026-11-19-QCAI-stage2-RobotRegistryV4-EscrowVaultV3.pdf) |
| 21 Nov 2026 | 1 | **RobotRegistryV4 + EscrowVaultV5** (both live) ([bundle](../audits/RedZone.v6.flat.sol)) | ethereum (auto) | 85/100 | [PDF](audit/2026-11-21-QCAI-stage1-RobotRegistryV4-EscrowVaultV5.pdf), [answers](../audits/QCAI-v5-stage1-response.md) |
| 21 Nov 2026 | 2 | the same, after every stage 1 finding | qorechain | **82/100, QUANTUM-SAFE** | [PDF](audit/2026-11-21-QCAI-stage2-RobotRegistryV4-EscrowVaultV5.pdf), [answers](../audits/QCAI-v5-stage2-response.md) |
| 22 Nov 2026 | 2 | the same bundle, rerun on the stage 1 setting so both stages match | ethereum | **85/100** | [PDF](audit/2026-11-22-QCAI-stage2-ethereum-RobotRegistryV4-EscrowVaultV5.pdf), [answers](../audits/QCAI-v5-stage2-ethereum-response.md) |

## What is live, and what each audit covers

| Contract | Address (diana, EVM 9800) | Audited |
|---|---|---|
| RobotRegistryV4 | `0xef521a3a178a344a5cdd6854271e1fca466fa115` | Yes: stage 1 and stage 2 on 19 Nov (85, then 87/100, QUANTUM-SAFE) and again with the V5 vault on 21 Nov; unchanged since |
| EscrowVaultV5 (prize pools; freeze until fixed) | `0x241767f1d799149060d133001cf4728d85ac41b7` | Yes: stage 1 on 21 Nov (85/100, ethereum), stage 2 on 22 Nov on the same ethereum setting (**85/100**), and stage 2 on the QoreChain setting on 21 Nov (**82/100, QUANTUM-SAFE**); every finding answered, no contract change needed ([stage 1](../audits/QCAI-v5-stage1-response.md), [stage 2 ethereum](../audits/QCAI-v5-stage2-ethereum-response.md), [stage 2 qorechain](../audits/QCAI-v5-stage2-response.md)). It is the audited vault design (EscrowVaultV3, 19 Nov) plus prize pools and one changed rule; bundle with the live registry: [audits/RedZone.v6.flat.sol](../audits/RedZone.v6.flat.sol). 477 Foundry tests pass (445 at the audit, plus 32 branch tests from the verification pass), including 97 on this vault (invariants: money is conserved, no payout above the prize, an open pool never pays a player twice, a once-per-brain pool never pays the same brain version twice) |

## Where the post-quantum checks are, what they protect, and the tests

Both precompiles are called from one place, [PQGuard.sol](../contracts/src/PQGuard.sol), through the
ML-DSA-87 wrapper [MLDSA87.sol](../contracts/src/v3/MLDSA87.sol). The wrapper checks the exact
FIPS 204 sizes and fails closed on anything unexpected.

| Call | Protects | Code | Tests |
|---|---|---|---|
| `pqcKeyStatus` (`0x…0a02`) | Finds the ML-DSA-87 key registered for the signer's account. A request from an account with no key, or with a key of another algorithm, is refused. | [PQGuard.sol:31-41](../contracts/src/PQGuard.sol#L31-L41), [MLDSA87.sol:43-57](../contracts/src/v3/MLDSA87.sol#L43-L57) | `test_Stage2_NonMLDSA87KeyRefused`, `test_Stage2_PrecompileAvailability`, `test_Branch_KeyStatusShortAnswerFailsClosed`, `test_Branch_KeyStatusRevertFailsClosed` |
| `pqcVerify` (`0x…0a01`), user requests | Registering a robot, changing its brain, starting a round, opening a play pass, taking a bounty back. Each request is bound to the contract, chain, nonce and deadline. | [PQAccess.sol:252-257](../contracts/src/v3/PQAccess.sol#L252-L257) | Forged, replayed and wrong-length signatures in [RedZoneV4.t.sol](../contracts/test/v4/RedZoneV4.t.sol) and [VaultV5.t.sol](../contracts/test/v6/VaultV5.t.sol), `test_NoEcdsaShortcuts` |
| `pqcVerify`, admin actions | Pause, admin handover, referee change (with a 2-day wait), try price | [PQAccess.sol:104-110](../contracts/src/v3/PQAccess.sol#L104-L110) | `test_Attack_AdminActionsNeedAdminSignature`, `test_Attack_AdminSigReplay`, `test_Audit3_AcceptBoundToProposal` |
| `pqcVerify`, referee verdicts | Every recorded result, and with it every payout, carries the referee's signature. It is bound to the session, robot, player and replay. | [RobotRegistryV4.sol:198-202](../contracts/src/v4/RobotRegistryV4.sol#L198-L202) | `test_Stage2_RefereeKeyMustBeMLDSA87`, `test_Branch_MisbehavingPrecompileNeverPays`, `testFuzz_Stage2_ResultWindow` |
| `pqcVerify`, deploy proofs | Each constructor checks an ML-DSA-87 proof with the live precompile, so a deployment only succeeds on a chain whose post-quantum checks work | Constructors of RobotRegistryV4 and EscrowVaultV5 | The deploy transactions on testnet (README, "Solidity PQC checks") |

If the precompile is missing, reverts, or returns a short or garbage answer, every signed action
reverts, so nothing can be paid: `test_Branch_VerifyRevertFailsClosed`,
`test_Branch_VerifyEmptyAnswerFailsClosed`, `test_Branch_VerifyGarbageAnswerFailsClosed`,
`test_Attack_PrecompileMissingFailsClosed`.

## Stage 2 on the stage 1 setting (live registry + EscrowVaultV5, 22 Nov): 85/100

The rules ask for both stages on the same EVM/Solidity setting, so stage 2 was rerun on "ethereum",
the setting stage 1 used, with the same bundle. Full answers:
[audits/QCAI-v5-stage2-ethereum-response.md](../audits/QCAI-v5-stage2-ethereum-response.md).
Reentrancy in `claimBounty`/`finalizeWithdraw` (`nonReentrant`, all state written before the one
transfer), `activateReferee` open to anyone (by design: it only activates a key the admin signed
for, after the 2-day wait), overflow (Solidity 0.8 checked arithmetic), `_send` return value
(checked, reverts with `TransferFailed`), front-running (every round is bound to the player's
ML-DSA signature) and the breach list (a cursor, no loop): none needed a contract change.

## Stage 2 on the QoreChain setting (live registry + EscrowVaultV5, 21 Nov): 82/100, QUANTUM-SAFE

Full answers: [audits/QCAI-v5-stage2-response.md](../audits/QCAI-v5-stage2-response.md). ML-DSA-87 key
format (already checked: algorithm id and exact FIPS 204 sizes), reentrancy (native QOR only,
`nonReentrant`, state first, checked transfer), precompile availability (checked on every call, fails
closed), overflow (Solidity 0.8 checked arithmetic) and naming (Solidity style guide): none needed a
contract change.

## Stage 1 findings and what was done (live registry + EscrowVaultV5, 21 Nov)

Full answers with code links: [audits/QCAI-v5-stage1-response.md](../audits/QCAI-v5-stage1-response.md).

| # | Finding | Severity | Verdict | Where it is handled | Tests |
|---|---|---|---|---|---|
| 1 | Privilege escalation via admin transfer | High | Not an issue: the proposal id is not a secret; acceptance needs the new admin's single-use ML-DSA-87 signature over it | [PQAccess.sol:168-185](../contracts/src/v3/PQAccess.sol#L168-L185) | `test_Attack_AdminSigReplay`, `test_Audit3_AcceptBoundToProposal` |
| 2 | Overflow in bounty deposit | Medium | Not reachable: each id costs at least 1 QOR | [EscrowVaultV5.sol:180-183](../contracts/src/v5/EscrowVaultV5.sol#L180-L183) | vault invariant tests |
| 3 | Unchecked return value in `_send` | Medium | Already checked: `require(success, TransferFailed(to, amount))`, the whole tx reverts | [EscrowVaultV5.sol:327-333](../contracts/src/v5/EscrowVaultV5.sol#L327-L333) | `test_FailedPaymentRevertsEverything` |
| 4 | Front-running in the play pass | Low | Not possible: only the operator named in the player's signature can use it | [RobotRegistryV4.sol:364-372](../contracts/src/v4/RobotRegistryV4.sol#L364-L372) | `test_Pass_OnlyOperatorAndOnlyInTime`, `test_Pass_BoundsAndSignature` |
| 5 | Unbounded loop in breach processing | Info | No loop: one breach per call through a cursor | [EscrowVaultV5.sol:203-233](../contracts/src/v5/EscrowVaultV5.sol#L203-L233) | invariant tests, `test_Audit3_StockpiledBreachExpires` |

## Stage 1 findings and what was done (live registry, 19 Nov)

Full answers with code links: [audits/QCAI-v4-stage1-response.md](../audits/QCAI-v4-stage1-response.md).

| # | Finding | Severity | Verdict | Where it is handled | Tests |
|---|---|---|---|---|---|
| 1 | Privilege escalation via admin transfer | High | Not an issue: both steps are single-use ML-DSA-87 signatures (nonce + used digest), and an acceptance is bound to one proposal | [PQAccess.sol:168](../contracts/src/v3/PQAccess.sol#L168), [182-189](../contracts/src/v3/PQAccess.sol#L182-L189) | `test_Attack_AdminSigReplay`, `test_Audit3_AcceptBoundToProposal`, `test_Attack_AdminActionsNeedAdminSignature` |
| 2 | Overflow of `nextBountyId` | Medium | Not reachable: each id needs a deposit of at least 1 QOR | EscrowVaultV3/V5 `depositPool` (`MIN_BOUNTY`) | vault invariant tests |
| 3 | Race condition in the play pass | Medium | Not an issue: expiry is exact and checked on every start; the operator is named in the player's signature | [RobotRegistryV4.sol:364](../contracts/src/v4/RobotRegistryV4.sol#L364) | `test_Pass_OnlyOperatorAndOnlyInTime`, `test_Pass_BoundsAndSignature` |
| 4 | Unbounded loop in breach tracking | Low | No such loop: the vault reads one breach per call through a cursor | `breachAt` / `claimBounty` / `skipBreach` | `test_Audit3_StockpiledBreachExpires`, `test_Audit3_EarliestBreachWinsWhoeverCalls` |
| 5 | Missing ERC standards | Info | Not applicable: robots and bounties are records, bounties are native QOR | n/a | n/a |

Stage 2 (87/100, QUANTUM-SAFE) found nothing new that needed a contract change; answers in
[audits/QCAI-v4-stage2-response.md](../audits/QCAI-v4-stage2-response.md).

## Stage 1 findings and what was done (v3, 16 Nov)

Full answers: [audits/QCAI-stage1-response.md](../audits/QCAI-stage1-response.md).

| # | Finding | Severity | Was it real? | What changed |
|---|---|---|---|---|
| 1 | Missing access control on admin functions | High | No (the ML-DSA check was in the body) | Named `onlyAdmin` / `onlyReferee` modifiers; two-step admin transfer |
| 2 | Overflow in bounty amount | Medium | No (checked before the cast) | `uint256` amounts throughout, `MIN_BOUNTY` |
| 3 | Unchecked return value in `_send` | Medium | No | `require(success, TransferFailed(to, amount))` |
| 4 | Replay in session management | Low | Partly | Result signature binds robot and player; start requests expire in 10 minutes |
| 5 | Unbounded loop in name validation | Info | No (length checked first, max 64) | Length cached, documented bound |

## Other reviews

[Self-review](../audits/SELF_REVIEW.md), an [adversarial audit](../audits/ADVERSARIAL_AUDIT.md) of v3
(all findings fixed before v4), and Blockhertz reports on the vault ([1](../audits/Blockhertz-1-EscrowVaultV2.md),
[gas](../audits/Blockhertz-gas-EscrowVaultV2.md)).
