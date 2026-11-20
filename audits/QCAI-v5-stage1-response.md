# QCAI v5 stage 1: answers

Report: [docs/audit/2026-11-21-QCAI-stage1-RobotRegistryV4-EscrowVaultV5.pdf](../docs/audit/2026-11-21-QCAI-stage1-RobotRegistryV4-EscrowVaultV5.pdf)
(21 Nov 2026). Contracts: the live RobotRegistryV4 and EscrowVaultV5, flattened in
[RedZone.v6.flat.sol](RedZone.v6.flat.sol). **Score 85/100**, risk Medium, 5 findings. Setting:
"ethereum" (auto-detected; quantum readiness is scored in stage 2 with the QoreChain setting).

Each finding was checked against the code. None needs a contract change: each answer points to the
line that handles it and the tests that prove it (`contracts/test/v6/VaultV5.t.sol` and
`contracts/test/v4/RedZoneV4.t.sol`, 445 Foundry tests, all passing). Line numbers in the report are
positions in the flattened file; the links below go to the source files.

| # | Finding | Severity | Verdict |
|---|---|---|---|
| 1 | Privilege escalation via admin transfer | High | Not an issue: the proposal id is not a secret; acceptance needs the new admin's single-use ML-DSA-87 signature over that id |
| 2 | Overflow in bounty deposit (`nextBountyId`) | Medium | Not reachable: each id costs a deposit of at least 1 QOR |
| 3 | Unchecked return value in `_send` | Medium | Already checked: a failed payment reverts with `TransferFailed(to, amount)` |
| 4 | Front-running in the play pass | Low | Not possible: only the operator named in the player's signature can use the pass |
| 5 | Unbounded loop in breach list processing | Info | No loop: one breach per call, through a cursor |

## 1. Privilege escalation via admin transfer (High): not an issue

The recommendation is to make the proposal id "cryptographically secure and unpredictable". It does
not need to be: `adminProposalId` is a counter that only separates one proposal from the next, and
knowing it gives no power. Taking over the admin role needs two ML-DSA-87 signatures, each used once:

- `transferAdmin` ([PQAccess.sol:168](../contracts/src/v3/PQAccess.sol#L168)) runs `onlyAdmin`: the
  current admin's ML-DSA signature over a digest with `nonces[admin]`, marked used and the nonce
  bumped before the body runs. It records the pending admin and increments `adminProposalId`
  ([PQAccess.sol:175](../contracts/src/v3/PQAccess.sol#L175)).
- `acceptAdmin` ([PQAccess.sol:182-185](../contracts/src/v3/PQAccess.sol#L182-L185)) needs the
  pending admin's own ML-DSA signature over `acceptAdminDigest(p, adminProposalId, nonces[p], deadline)`,
  consumed by `_useUserSig`. A signature made for one proposal can't complete another, and a new
  admin must hold a registered ML-DSA-87 key.

Even the admin can't move funds: the vault has no admin path to take, redirect or pay out money.
Tests: `test_Attack_AdminSigReplay`, `test_Audit3_AcceptBoundToProposal` (an old acceptance is refused
after the proposal is cancelled and made again), `test_Attack_AdminActionsNeedAdminSignature`.

## 2. Overflow in bounty deposit (Medium): not reachable

`nextBountyId = bountyId + 1` is `unchecked` on purpose
([EscrowVaultV5.sol:180-183](../contracts/src/v5/EscrowVaultV5.sol#L180-L183), with the reason in the
comment): every id needs a deposit of at least `MIN_BOUNTY` (1 QOR), so reaching 2^256 ids would need
more QOR than can ever exist. Every other counter and every amount uses Solidity 0.8 checked
arithmetic; amounts are `uint256` throughout, with no down-casting of `msg.value`.

## 3. Unchecked return value in `_send` (Medium): already checked

`_send` ([EscrowVaultV5.sol:327-333](../contracts/src/v5/EscrowVaultV5.sol#L327-L333)) makes the call
without copying return data (so a payee can't grief with a huge return payload) and then runs
`require(success, TransferFailed(to, amount))`. The custom error names the payee and the amount, and
the whole transaction reverts, so a bounty is never marked paid without the money arriving.
Tests: `test_FailedPaymentRevertsEverything` and the withdrawal-to-a-refusing-address test (both expect
`TransferFailed(address, 1 ether)`), plus the reentrancy test (`nonReentrant`, state written first).

## 4. Front-running in the play pass (Low): not possible

`startSessionWithPass` ([RobotRegistryV4.sol:364-372](../contracts/src/v4/RobotRegistryV4.sol#L364-L372))
first checks `msg.sender == p.operator`. The operator is named inside the player's own ML-DSA
signature (`openPassFor`, [RobotRegistryV4.sol:342-349](../contracts/src/v4/RobotRegistryV4.sol#L342-L349)),
so nobody watching the mempool can use someone else's pass. A pass lasts at most 10 minutes and 20
rounds, each round still uses one of the player's tries and can only be won by that player, and a pass
can never move funds. A delay would only make the pass harder to use without stopping anything.
Tests: `test_Pass_OnlyOperatorAndOnlyInTime`, `test_Pass_BoundsAndSignature`,
`test_Pass_OneSignatureManyRounds`, `test_Pass_CannotAttackOwnRobotOrBeatDailyLimit`.

## 5. Unbounded loop in breach list processing (Info): no loop

No function loops over a robot's breaches. Each bounty keeps a cursor into the registry's breach list
(`breachCursor`). `claimBounty` ([EscrowVaultV5.sol:203](../contracts/src/v5/EscrowVaultV5.sol#L203))
pays the breach at the cursor and `skipBreach` ([EscrowVaultV5.sol:227](../contracts/src/v5/EscrowVaultV5.sol#L227))
moves past one that can never be paid; both handle exactly one breach, so gas per call is constant
however many breaches exist. That is the batching the recommendation asks for. Tests: the vault
invariant tests (random call sequences) and `test_Audit3_StockpiledBreachExpires`.

## What changed in V5, for the reviewer

V5 is the audited vault design with one changed rule (in `_next`): a once-per-brain pool now pays the
first breach of each brain version to any player, including one who won an earlier version; open
pools still pay each player once. 97 tests cover it, including invariants that a frozen pool never
pays the same brain version twice and an open pool never pays a player twice.
