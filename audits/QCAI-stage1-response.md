# QCAI Stage 1: findings and responses

- **Report:** [`QCAI-stage1.pdf`](QCAI-stage1.pdf), generated 16 Nov 2026 by the QoreChain AI Smart Contract Auditor (Testnet).
- **Input:** [`RedZone.flat.sol`](RedZone.flat.sol), the contracts deployed for the Q-Day Drill.
- **Result:** 85/100, risk MEDIUM, 5 findings.
- **Quantum readiness:** not scored. The blockchain was auto-detected as "ethereum".

The deployed contracts are frozen until the drill (18 Nov), so every fix is in the next version:
[`contracts/src/v3/`](../contracts/src/v3) (`PQAccess`, `RobotRegistryV3`, `EscrowVaultV2`), bundled as
[`RedZone.v3.flat.sol`](RedZone.v3.flat.sol) for Stage 2. It also fixes the issues from our
[self-review](SELF_REVIEW.md) and from two independent review passes (below).

## The five QCAI findings

| # | QCAI finding | Severity | Was it real? | What v3 does |
|---|---|---|---|---|
| 1 | Missing access control on critical functions (`PQAdmin`) | High | **No.** `setReferee`, `setPaused` and `transferAdmin` already required the admin's ML-DSA-87 signature via `_requireAdminSig`, but inside the function body rather than as a modifier, so the auditor did not see it. | The check is now a named modifier, `onlyAdmin(digest, adminSig)`, on every admin function, with NatSpec saying who may call. Referee calls use a named `onlyReferee` modifier. Admin transfer is now two-step: the new admin accepts with its own ML-DSA signature, and a proposal can be cancelled. |
| 2 | Potential overflow in bounty amount (`EscrowVault`) | Medium | **No.** `depositBounty` reverted with `AmountTooLarge` before casting `msg.value` to `uint128`. | No down-cast anymore: amounts are `uint256` throughout. `MIN_BOUNTY` (1 QOR) keeps dust bounties out. |
| 3 | Unchecked return value in `_send` (`EscrowVault`) | Medium | **No.** It was `if (!ok) revert TransferFailed();`. | Now `require(success, TransferFailed(to, amount))` with NatSpec. A failed payment reverts everything, so the bounty stays open. |
| 4 | Potential replay in session management (`RobotRegistryV2`) | Low | **Partly.** Starts had nonces; results could only be recorded once per session. | The referee's result signature now also binds the robot and the player. Start requests must reach the chain within 10 minutes (`MAX_START_TTL`). |
| 5 | Unbounded loop in name validation | Info | **No.** The length was checked before the loop (max 64). | Same check, with the length cached and NatSpec saying the loop runs at most 64 times. |

## Design fixes in v3 (self-review and independent reviews)

| Issue | Fix |
|---|---|
| A bounty owner could withdraw while a winning attack was still being judged. | Withdrawal is two-step: `requestWithdraw` (owner's ML-DSA signature), then `finalizeWithdraw` after `WITHDRAW_DELAY` = 3 h. Sessions starting up to `START_GRACE` (10 min) after the request can still win, so an owner can't front-run a player's start. The constructor checks that the delay covers start grace + session + result grace + 1 h to claim. |
| Claims depended only on the referee's signature. | `claimBounty(bountyId, sessionId)` needs no signature. It pays only if the registry has a **Breached** session against that robot that started after the deposit, and it always pays that session's player. Anyone can trigger it. One breach wins every open bounty on the robot, which is the game's rule. |
| The admin could swap the referee key instantly. | `proposeReferee`, then `activateReferee` after `REFEREE_DELAY` = 2 days. |
| Pause handling. | A pause stops new rounds and freezes vault payouts. A round that already started still gets its verdict (`recordResult` is not pausable), so a pause never costs a player a win. A pause ends by itself after `MAX_PAUSE` = 7 days, can't be renewed for `PAUSE_COOLDOWN` = 1 day, and after it ends wins get `UNPAUSE_GRACE` = 1 h before any withdrawal. **The admin can delay payouts by at most about 7 days and can never take or redirect funds.** |
| Bounties added from the website were owned by the relayer. | A bounty always belongs to the robot's on-chain owner, whoever funds it. Withdrawal needs that owner's QoreX ML-DSA signature, so the relayer never controls deposited funds. |
| A withdrawal to an address that rejects payment was stuck. | The owner can sign a new request, which replaces the destination and restarts the delay. |
| Verdicts on an old brain counted toward the new brain's stats. | Sessions record the robot's `brainVersion`; old-brain verdicts are kept (and can win bounties) but don't change the new brain's rating. |

## Checks run

- **Foundry: 135 tests pass.** That is 92 tests for the deployed contracts plus 43 v3 attack tests, which include fuzzing and one test for each reviewer finding.
- **Slither 0.11.6 (Trail of Bits):** no High or Medium findings in v3. Its remaining notices are expected by design:
  - `arbitrary-send-eth`: payments go to the session's player or to the address the owner signed.
  - `timestamp`: the time windows are minutes long.
  - `low-level-calls`: native QOR is sent with a low-level call.
  - `unused-return`: the algorithm id from `pqcKeyStatus` isn't used.
  - `incorrect-equality`: the exact `brainVersion` comparison is intended.
- **Independent AI review, two passes:**
  - Pass 1 found 3 Medium, 6 Low and 3 Info.
  - Pass 2 confirmed all of those fixes and found one more Medium: a pause had no time limit. That is now fixed with `MAX_PAUSE`.
  - No High issue was found in either pass.

## Trust assumptions (stated, not hidden)

1. **The referee is trusted to judge rounds honestly.** Its key is ML-DSA-87. A key change takes 2 days, which gives owners time to withdraw. A stolen referee key could only affect sessions that already started (about the last 70 minutes).
2. **The app keeps start requests short.** It signs start requests with a deadline of at most 10 minutes. The contract also enforces this, from the moment the transaction is included.
3. **In an emergency, pause the vault.** Only the vault pause protects money; pausing the registry only stops new rounds.

## Stage 2 plan

1. Submit `RedZone.v3.flat.sol` with **Blockchain = "QoreChain (CosmWasm + PQC)"**, so that quantum readiness is scored.
2. Save the report as `QCAI-stage2.pdf`.
3. After the drill, deploy v3, then move the backend to the new claim and withdrawal flow.
