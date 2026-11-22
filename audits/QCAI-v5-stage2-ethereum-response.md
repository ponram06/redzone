# QCAI v5 stage 2 (Ethereum setting): answers

Report: [docs/audit/2026-11-22-QCAI-stage2-ethereum-RobotRegistryV4-EscrowVaultV5.pdf](../docs/audit/2026-11-22-QCAI-stage2-ethereum-RobotRegistryV4-EscrowVaultV5.pdf)
(22 Nov 2026). Contracts: the live RobotRegistryV4 and EscrowVaultV5, flattened in
[RedZone.v6.flat.sol](RedZone.v6.flat.sol), the same file as stage 1.

**Why this run exists:** the hackathon rules ask for both stages on the same EVM/Solidity setting.
Stage 1 (21 Nov) ran on "ethereum" (auto); the first stage 2 ran on "qorechain"
([QCAI-v5-stage2-response.md](QCAI-v5-stage2-response.md), 82/100, QUANTUM-SAFE). This run repeats
stage 2 on **"ethereum"**, so both stages match. The contracts have not changed since stage 1.

**Score 85/100 (stage 1: 85), risk Medium, 6 findings.** Quantum readiness is not scored on this
setting; it was scored QUANTUM-SAFE on the QoreChain setting.

Each finding was checked against the code. None needs a contract change: each answer points to the
code that handles it and the tests that prove it (477 Foundry tests, all passing). The report's line
numbers do not match the source files; the links below go to the actual code.

| # | Finding | Severity | Verdict |
|---|---|---|---|
| 1 | Reentrancy in `claimBounty` and `finalizeWithdraw` | High | Not an issue: both are `nonReentrant` and write all state before the single transfer |
| 2 | Missing access control on `activateReferee` | Medium | By design: it only activates a key the admin already signed for, after the 2-day wait |
| 3 | Overflow in `depositPool` | Low | Not reachable: Solidity 0.8 checks the arithmetic; the one `unchecked` id can't overflow |
| 4 | Unchecked return value in `_send` | Medium | Already checked: a failed payment reverts with `TransferFailed(to, amount)` |
| 5 | Front-running in session management | Low | Not possible: sessions and passes are bound to the player's ML-DSA signature and named operator |
| 6 | Unbounded loop in breach list handling | Info | No loop: one breach per call, through a cursor |

## 1. Reentrancy in `claimBounty` and `finalizeWithdraw` (High): not an issue

The recommendation is Checks-Effects-Interactions. Both functions already follow it, and also carry
OpenZeppelin's `nonReentrant`:

- `claimBounty` ([EscrowVaultV5.sol:203-224](../contracts/src/v5/EscrowVaultV5.sol#L203-L224)):
  checks the bounty and the breach, then lowers `b.amount`, sets the status, marks `hasWon`, raises
  `minBrainVersion`, advances the cursor and lowers `totalLocked`. Only then does it call `_send`,
  the last line.
- `finalizeWithdraw` ([EscrowVaultV5.sol:275-293](../contracts/src/v5/EscrowVaultV5.sol#L275-L293)):
  sets the status to `Withdrawn`, the amount to 0 and lowers `totalLocked`, then calls `_send` last.

A payee that calls back in hits the reentrancy guard. Even without the guard, it would find the
bounty already paid or closed. The vault pays native QOR only; there are no token callbacks.
Tests: `test_Attack_ReentrancyOnClaim`, `test_Stage2_OZGuardBlocksCrossFunctionReentry` (a payee
that tries to claim again from inside the payment is refused, and the books still balance), and the
vault invariant tests (money in = money locked + money paid, under random call sequences).

## 2. Missing access control on `activateReferee` (Medium): by design

`activateReferee` ([RobotRegistryV4.sol:271-279](../contracts/src/v4/RobotRegistryV4.sol#L271-L279))
can only make active a key that is already pending, and only after `REFEREE_DELAY` (2 days). A key
becomes pending only through `proposeReferee`, which needs the admin's ML-DSA-87 signature and a
signature from the new key itself over the same proposal
([RobotRegistryV4.sol:237-253](../contracts/src/v4/RobotRegistryV4.sol#L237-L253)). The caller
chooses nothing: no key, no time, no address. Anyone may call it so the change happens on schedule
without one more admin signature. During the 2 days, players can see the proposed key on chain and
the admin can still `cancelReferee`.
Tests: `test_RefereeChange_IsTimeLocked` (refused before the delay, works after, refused when
nothing is pending), `test_ProposeReferee_NewKeyMustProveItself`, `test_Audit3_CancelRefereeProposal`,
`test_Branch_CancelWithNothingPendingRefused`.

## 3. Overflow in `depositPool` (Low): not reachable

The contracts use Solidity 0.8.28, which checks every addition and subtraction and reverts on
overflow, so SafeMath is not needed. In `depositPool`
([EscrowVaultV5.sol:168-196](../contracts/src/v5/EscrowVaultV5.sol#L168-L196)) `totalLocked += msg.value`
is checked. The one `unchecked` increment is the bounty id, and each id needs a deposit of at least
1 QOR, so 2^256 ids can never be reached. Amounts are `uint256`, never down-cast.
Tests: the vault invariant tests and `test_Pool_LastPrizeIsTheRemainder`.

## 4. Unchecked return value in `_send` (Medium): already checked

`_send` ([EscrowVaultV5.sol:327-333](../contracts/src/v5/EscrowVaultV5.sol#L327-L333)) ends with
`require(success, TransferFailed(to, amount))`. A failed payment reverts the whole transaction, so a
bounty is never marked paid without the money arriving. It does not copy return data, so a payee
can't grief with a huge return payload.
Tests: `test_FailedPaymentRevertsEverything`, `test_Tries_RefusingTreasuryRevertsThePurchase`.

## 5. Front-running in session management (Low): not possible

A round starts only with the player's own ML-DSA-87 signature, which covers the robot, the player,
the nonce and a deadline (`startSessionFor`,
[RobotRegistryV4.sol:321](../contracts/src/v4/RobotRegistryV4.sol#L321)). A play pass names its
operator inside the player's signature, and `startSessionWithPass`
([RobotRegistryV4.sol:364-372](../contracts/src/v4/RobotRegistryV4.sol#L364-L372)) first checks
`msg.sender == p.operator`. Someone watching the mempool can't start a round for another player, use
their pass, or change which robot they attack. Only sessions started after a bounty's deposit can
win it, and the earliest breach is paid, so there is no ordering to race for.
Tests: `test_Pass_OnlyOperatorAndOnlyInTime`, `test_Pass_BoundsAndSignature`,
`test_Attack_OwnerFrontRunsStartWithWithdraw`, `test_SessionAfterWithdrawRequestCannotClaim`.

## 6. Unbounded loop in breach list handling (Info): no loop

No function loops over a robot's breaches. Each bounty keeps a cursor (`breachCursor`);
`claimBounty` pays the breach at the cursor and `skipBreach`
([EscrowVaultV5.sol:227-236](../contracts/src/v5/EscrowVaultV5.sol#L227-L236)) moves past one that
can never be paid. Each handles exactly one breach, so gas per call is the same however many breaches
exist. That is the pagination the recommendation asks for.
Tests: the vault invariant tests and `test_Audit3_StockpiledBreachExpires`.
