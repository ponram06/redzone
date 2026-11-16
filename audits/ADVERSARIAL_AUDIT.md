# Adversarial audit (exploit-driven), 16 Nov 2026

An independent AI auditor reviewed the deployed v3 contracts as an attacker. Every claimed bug
had to be proven with a working Foundry exploit test.

**Result:** no Critical or High issues. One Medium and two Lows were proven with exploit tests,
and all three are fixed. The contracts were then redeployed:

| Contract | Address (qorechain-diana) |
|---|---|
| RobotRegistryV3 | `0x69564de848d807ea895e1987b53749e1648cadbf` |
| EscrowVaultV2 | `0x16cc5efcda75a788f597dd0c785862db1bdbeb7f` |

The first v3 deployment (`0x5398…5308` and `0x26b9…c638`) was replaced the same day and never used.

## Proven findings, all fixed

| # | Severity | Finding | Fix | Regression tests |
|---|---|---|---|---|
| M-01 | Medium | Whoever called `claimBounty` chose which breach got paid, and breaches never expired. A robot owner could have a second account "breach" their own robot, keep that breach, and later front-run an honest winner's claim. That was effectively an instant withdrawal. | The registry keeps each robot's breaches in recording order. Each bounty has a cursor, and `claimBounty(bountyId)` always pays the **earliest eligible** breach, so the caller has no choice. Breaches expire `CLAIM_WINDOW` (1 day) after the verdict, or after the pause they were recorded in. `skipBreach` moves past breaches that can never be paid. `finalizeWithdraw` is refused while any breach is still claimable or waiting. | `test_Audit3_StockpiledBreachExpires`, `test_Audit3_EarliestBreachWinsWhoeverCalls`, `test_Audit3_WithdrawWaitsForPendingWin`, `test_Audit3_ExpiredWinCanBeSkippedThenWithdraw`, `test_Audit3_PauseExtendsClaimWindow` |
| L-01 | Low | `registerRobot` and `startSession` trusted `msg.sender` (an ECDSA key). A stolen ECDSA key could use up a player's daily attempts. | Both removed. Every action now needs the user's ML-DSA-87 signature. | `test_NoEcdsaShortcuts` |
| L-02 | Low | A withdrawal request that was never finalised left an open bounty that nobody could win. | Requests lapse `WITHDRAW_EXPIRY` (7 days) after unlocking. | `test_Audit3_StaleWithdrawRequestLapses` |

## Informational findings

- **I-02 (fixed):** `cancelReferee` cancels a pending referee proposal. Test: `test_Audit3_CancelRefereeProposal`.
- **I-04 (fixed):** an `acceptAdmin` signature is bound to one specific proposal (`adminProposalId`). Test: `test_Audit3_AcceptBoundToProposal`.
- **Gas (fixed):** payouts no longer copy return data, so a payee cannot grief the sender with a huge return payload.
- **I-01, I-03, I-05 (documented trust assumptions):**
  - The admin controls who the referee is; changes are time-locked for 2 days, and owners can withdraw meanwhile.
  - Referee rotation can void verdicts that were signed but not yet relayed; the new referee re-signs them.
  - If QoreChain changed its ML-DSA precompile, signed actions would fail closed.

## Test status after the fixes

| Check | Result |
|---|---|
| Foundry | **167 tests pass**, with 5,000 fuzz runs per fuzz test |
| Invariants | 4 invariants × 100,000 random calls, 0 violations |
| Coverage of `src/v3` | 99.7% of lines |
| Slither | No High or Medium findings |
| Real chain | Both constructors verified the ML-DSA-87 deploy proofs against the live precompile |
