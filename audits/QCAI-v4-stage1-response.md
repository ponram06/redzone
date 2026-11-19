# QCAI v4 stage 1: answers

Report: [QCAI-v4-stage1.pdf](QCAI-v4-stage1.pdf) (19 Nov 2026). Contracts: RobotRegistryV4 and
EscrowVaultV3, flattened in [RedZone.v4.flat.sol](RedZone.v4.flat.sol). Score 85/100, 5 findings.

Note on the run: the report says "Blockchain: ethereum" and "Quantum Readiness: not scored for this
setting". The contracts only work on QoreChain (they call the `pqcVerify` 0x0A01 and `pqcKeyStatus`
0x0A02 precompiles), so stage 2 is run with the QoreChain setting, where quantum readiness is scored.

Each finding was checked against the code. None needs a contract change; each answer points to the
line that handles it and the test that proves it (`contracts/test/v4/RedZoneV4.t.sol`, 86 v4 tests,
all passing).

| # | Finding | Severity | Verdict |
|---|---|---|---|
| 1 | Privilege escalation via admin transfer | High | Not an issue: both steps consume a nonce and a used-digest flag |
| 2 | Overflow of `nextBountyId` | Medium | Not reachable |
| 3 | Race condition in the play pass | Medium | Not an issue: expiry is exact and checked on every start |
| 4 | Unbounded loop in breach tracking | Low | No such loop: breaches are processed one per call |
| 5 | Missing ERC standards | Info | Not applicable |

## 1. Privilege escalation via admin transfer (High): not an issue

Both steps of the admin transfer are single-use ML-DSA signatures:

- `transferAdmin` ([PQAccess.sol:168](../contracts/src/v3/PQAccess.sol#L168)) runs `onlyAdmin`, which
  verifies the admin's ML-DSA signature over a digest that includes `nonces[admin]`, marks the digest
  used and increments the nonce before the body runs. It also bumps `adminProposalId`.
- `acceptAdmin` ([PQAccess.sol:182-189](../contracts/src/v3/PQAccess.sol#L182-L189)) needs the
  pending admin's own ML-DSA signature over `acceptAdminDigest(p, adminProposalId, nonces[p], deadline)`,
  consumed by `_useUserSig` (digest marked used, `nonces[p]` incremented).

So no signature can be used twice, and an acceptance signed for one proposal can't complete a later
one. Tests: `test_Attack_AdminSigReplay`, `test_Audit3_AcceptBoundToProposal` (an old acceptance is
refused after the proposal is cancelled and re-made), `test_Attack_AdminActionsNeedAdminSignature`.

## 2. Overflow in bounty management (Medium): not reachable

`nextBountyId = bountyId + 1` is in an `unchecked` block
([EscrowVaultV3.sol:145-147](../contracts/src/v4/EscrowVaultV3.sol#L145-L147)) on purpose: each id
needs a deposit of at least `MIN_BOUNTY` (1 QOR), so reaching 2^256 would need more QOR than can
exist. Every other counter uses Solidity 0.8 checked arithmetic.

## 3. Race condition in the play pass (Medium): not an issue

`startSessionWithPass` ([RobotRegistryV4.sol:364](../contracts/src/v4/RobotRegistryV4.sol#L364))
checks, on every call, that the caller is the pass's operator, that `block.timestamp <= validUntil`
(inclusive, the same convention as every other deadline in the contracts) and that rounds are left,
then decrements `roundsLeft` before starting the session. `openPassFor` only accepts a `validUntil`
in `(now, now + 10 minutes]` and at most 20 rounds, signed by the player (single use).

There is nothing to race: the pass only lets its operator start the player's own rounds, each round
still uses one of the player's tries and can only be won by that player, and a pass can never move
funds. A grace period would only make a pass last longer than the player signed for. Tests:
`test_Pass_OnlyOperatorAndOnlyInTime` (expires at `validUntil + 1`), `test_Pass_BoundsAndSignature`,
`test_Pass_OneSignatureManyRounds`, `test_Pass_CannotAttackOwnRobotOrBeatDailyLimit`.

## 4. Unbounded loop in breach tracking (Low): no such loop

No function loops over a robot's breaches. The registry appends each breach to `_breaches[robotId]`
and exposes `breachCount` / `breachAt(i)`. The vault reads exactly one entry per call (the bounty's
cursor): `claimBounty` pays it, `skipBreach` moves past one that can never be paid. Gas per call is
constant however many breaches exist. The only loop in RobotRegistryV4 is the name check
([RobotRegistryV4.sol:652](../contracts/src/v4/RobotRegistryV4.sol#L652)), bounded by
`MAX_NAME_LENGTH` (64). Tests: `test_Audit3_StockpiledBreachExpires`,
`test_Audit3_EarliestBreachWinsWhoeverCalls`, and the vault invariant test (random call sequences).

## 5. Missing ERC standards (Info): not applicable

RobotRegistryV4 and EscrowVaultV3 are not tokens: robots and bounties are records, and bounties are
native QOR. No ERC-20/721/1155 interface applies.
