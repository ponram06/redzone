# Blockhertz AI Gas Optimizer: EscrowVaultV2.sol

Scanned: 2026-11-17, local working tree (with uncommitted fixes), full file with comments.
Copied from a screenshot of the findings list (titles, location and the tool's claimed saving only;
the expanded details were not captured). Not yet triaged or verified with `forge snapshot`.

Tool summary: ~28% estimated savings, 11 findings (High 0, Medium 3, Low 8).

| # | Severity | Finding | Location | Claimed saving |
|---|----------|---------|----------|----------------|
| 1 | Medium | Redundant `registry.breachCount()` call in `_next()` | `_next()` | 2700 gas per `_next()` call (one SLOAD avoided) |
| 2 | Low | Unchecked increment of `nextBountyId` | `depositBounty()`, line with `bountyId = nextBountyId++` | 50-100 gas per deposit |
| 3 | Medium | Multiple storage reads of bounty fields in `claimBounty()` | `claimBounty()` | 100-200 gas per claim |
| 4 | Low | Redundant status check in `finalizeWithdraw()` | `finalizeWithdraw()`, first line after storage read | 0 gas |
| 5 | Low | Use custom error in `_send()` instead of require string | `_send()`, require statement | 0 gas |
| 6 | Low | Multiple reads of `b.withdrawRequestedAt` in `finalizeWithdraw()` | `finalizeWithdraw()` | 200 gas per finalize |
| 7 | Low | Redundant `lastUnpausedAt()` call in `finalizeWithdraw()` | `finalizeWithdraw()` | 0 gas |
| 8 | Medium | Suboptimal struct packing in `Bounty` struct | `Bounty` struct definition | 20000 gas per bounty deposit (one slot saved) |
| 9 | Low | Emit event before external call in `claimBounty()` | `claimBounty()`, emit and `_send` order | 0 gas |
| 10 | Low | Cache `registry.robotOwner()` result in `depositBounty()` | `depositBounty()` | 0 gas |
| 11 | Low | Unchecked increment of `breachCursor` in `claimBounty()` and `skipBreach()` | `claimBounty()`, `skipBreach()` | 100 gas per operation |

## Triage and results (2026-11-17)

Applied: #8 (struct packing: `status` moved next to `owner`/`depositedAt`; the withdrawal fields share a slot that a deposit never writes), #3/#6 (`_next` caches `robotId`, `breachCursor`, `withdrawRequestedAt`), #2 and #11 (unchecked `nextBountyId` and `breachCursor` increments; both provably cannot overflow).

Not applied: #1 (`breachCount` is called once per `_next`), #4 (would let a claimed bounty be withdrawn again; see the auditor triage), #5 (already a custom error), #7 (already cached), #9 (already emits before the call), #10 (already cached).

Gas (median, `forge test --match-path test/v3/RedZoneV3.t.sol --gas-report`):

| Function | Before | After | Change |
|---|---|---|---|
| depositBounty | 155,749 | 133,166 | -22,583 (-14.5%) |
| claimBounty | 123,006 | 122,689 | -317 |
| skipBreach | 74,639 | 74,258 | -381 |
| requestWithdraw | 317,538 | 334,641 | +17,103 |
| finalizeWithdraw | 33,955 | 35,958 | +2,003 |
| Deployment | 3,163,858 | 3,117,628 | -46,230 |

The packing moves one fresh-slot write from deposit (every bounty) to requestWithdraw (only bounties that are withdrawn). Net per bounty: about -23k if claimed, about -3.5k if withdrawn.
Note: the public `bounties()` getter now returns `status` as the 6th value (was 8th). Only the v3 tests read it; they are updated. All 167 tests pass.
