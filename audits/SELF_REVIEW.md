# RedZone pre-audit self-review

Reviewed 16 Nov 2026, before the QCAI audit, against the contracts deployed on qorechain-diana:
`EscrowVault` (`0xcD9AAd1ad2D7981699f256e73F2780dac86f0266`) and `RobotRegistryV2`
(`0x354f71Da76314Cd74A18524899Aeb43611d86448`), with their libraries `PQGuard`, `PQAdmin` and
`QoreXMessage`. The file submitted to the QCAI auditor is [`RedZone.flat.sol`](RedZone.flat.sol)
(`forge flatten` of both contracts, unmodified).

Both contracts are registered for the Q-Day Drill (18 Nov), so they are not redeployed before then.
Each finding below says whether it is fixed now (server side) or planned for the next contract
version (after the drill).

## Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | Medium | **Withdrawal can race a payout.** `withdrawBounty` doesn't know about sessions, so a bounty owner who sees a `Breached` result could withdraw before `claimBounty` is sent. | Mitigated now: the referee refuses take-back requests while a round against the robot can still be recorded, or while a recorded win is unpaid (`checkNoPendingWin`, tested). Planned in the next vault: a withdrawal time-lock longer than `SESSION_TTL + RESULT_GRACE`, and claims bound to a recorded breach. |
| 2 | Medium | **One trusted referee.** Claims and results are authorised only by the referee's ML-DSA key, and the admin can replace that key with `setReferee`. A compromised admin and referee could pay any open bounty to themselves. | By design for the hackathon; both keys are ML-DSA-87, so a stolen ECDSA key can't do this. Planned: a time-lock on `setReferee` so owners can withdraw before a new referee takes effect. |
| 3 | Low | **Pause blocks claims but not withdrawals.** This protects owners, but during a pause a winner can't claim while the owner can withdraw. | Planned with #1: claims for results recorded before a pause stay claimable. |
| 4 | Low | **Bounties added from the website are held by the relayer.** QoreX can't call contracts yet, so the relayer deposits on makers' behalf and is the on-chain bounty owner. | Documented in the README ("Known limitation"). Deposits are worked out from chain payments and vault events (no double deposit). Withdrawals go only to the robot's on-chain owner after their QoreX ML-DSA signature. |
| 5 | Info | `_requireUserSig` accepts a signature over the QoreX wallet message or over the raw digest. | Both are domain-separated (chain id, contract, action, nonce, deadline). Covered by the 45-test attacker playbook. |
| 6 | Info | A session whose result isn't recorded within `SESSION_TTL + RESULT_GRACE` still uses up one of the player's daily attempts. | Accepted: it prevents players from retrying until they get a favourable model answer. |
| 7 | Info | The arena's rule brain has a deliberate straight-line weak spot (off chain). | Intended as the demo robot's weakness; not a contract issue. |

## Already checked (attacker playbook, 92 Foundry tests)

Signature replay across contracts, chains, actions and nonces; expired and far-future deadlines;
forged referee and owner signatures; reentrancy on claim and withdraw; plain QOR sent to the vault;
self-attacks; daily attempt limit; name spoofing (control and right-to-left characters); utility
score replay; double recording of results.

## QCAI audit

Stage 1 is done: [report](QCAI-stage1.pdf) (85/100) and [our response to every finding](QCAI-stage1-response.md).
All the "planned" items above are implemented in `contracts/src/v3/` and tested.

- Stage 1: submit `RedZone.flat.sol` to the QCAI Smart Contract Auditor, save the report here, and
  answer every finding (fix or explain).
- Stage 2: after the drill, deploy the fixed contracts, audit them again, and save the second report.
