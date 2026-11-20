# RedZone: QCAI audit

Two-stage audits with the QoreChain AI Smart Contract Auditor (dashboard.qorechain.io/audit). The
dated reports are in [docs/audit/](audit/); the full written answers are in [audits/](../audits/).

| Date | Stage | Contracts (one flattened bundle) | Setting | Score | Report |
|---|---|---|---|---|---|
| 16 Nov 2026 | 1 | RobotRegistryV3 + EscrowVaultV2 ([bundle](../audits/RedZone.flat.sol)) | ethereum (auto) | 85/100 | [PDF](audit/2026-11-16-QCAI-stage1-RobotRegistryV3-EscrowVaultV2.pdf) |
| 16 Nov 2026 | 2 | v3 after every stage 1 finding ([bundle](../audits/RedZone.v3.flat.sol)) | qorechain | 85/100, QUANTUM-SAFE | [PDF](audit/2026-11-16-QCAI-stage2-RobotRegistryV3-EscrowVaultV2.pdf) |
| 19 Nov 2026 | 1 | **RobotRegistryV4** (live) + EscrowVaultV3 ([bundle](../audits/RedZone.v4.flat.sol)) | ethereum (auto) | 85/100 | [PDF](audit/2026-11-19-QCAI-stage1-RobotRegistryV4-EscrowVaultV3.pdf) |
| 19 Nov 2026 | 2 | the same, after every stage 1 finding | qorechain | **87/100, QUANTUM-SAFE** | [PDF](audit/2026-11-19-QCAI-stage2-RobotRegistryV4-EscrowVaultV3.pdf) |

## What is live, and what each audit covers

| Contract | Address (diana, EVM 9800) | Audited |
|---|---|---|
| RobotRegistryV4 | `0xef521a3a178a344a5cdd6854271e1fca466fa115` | Yes: the 19 Nov stage 1 and stage 2 above, unchanged since |
| EscrowVaultV5 (prize pools; freeze until fixed) | `0x241767f1d799149060d133001cf4728d85ac41b7` | Not yet by QCAI. It is the audited vault design (EscrowVaultV3, 19 Nov) plus prize pools and one changed rule; bundle with the live registry: [audits/RedZone.v6.flat.sol](../audits/RedZone.v6.flat.sol). 445 Foundry tests pass, including 97 on this vault (invariants: money is conserved, no payout above the prize, an open pool never pays a player twice, a once-per-brain pool never pays the same brain version twice) |

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
