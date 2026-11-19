# QCAI v4 stage 2: answers

Report: [QCAI-v4-stage2.pdf](QCAI-v4-stage2.pdf) (19 Nov 2026), run with **Blockchain: qorechain**.
Contracts: RobotRegistryV4 and EscrowVaultV3, flattened in [RedZone.v4.flat.sol](RedZone.v4.flat.sol).

**Score 87/100 (stage 1: 85), Quantum Readiness: QUANTUM-SAFE**, 5 findings.

Each finding was checked against the code. None needs a contract change; each answer points to the
code that handles it and the tests that prove it (`contracts/test/v4/RedZoneV4.t.sol`, all passing).

| # | Finding | Severity | Verdict |
|---|---|---|---|
| 1 | Missing ML-KEM implementation | High | Not applicable: nothing on chain is encrypted |
| 2 | Potential reentrancy in EscrowVaultV3 | Medium | Not an issue: every payout is under OpenZeppelin `nonReentrant`, state is updated first |
| 3 | Inadequate play pass validation | Medium | Not an issue: the operator is named in the player's ML-DSA signature and checked on every start |
| 4 | Missing input validation for large values | Low | Already bounded |
| 5 | Precompile availability check | Info | Intended: fails closed |

## 1. Missing ML-KEM implementation (High): not applicable

ML-KEM is a key-encapsulation (encryption) scheme. These contracts keep no secrets: everything on
chain is public, so there is nothing to encrypt. Every authorisation is an ML-DSA-87 signature
checked through `pqcVerify` (0x0A01) and `pqcKeyStatus` (0x0A02), and QoreChain itself uses
ML-KEM-1024 at the network layer. The same report rates the contracts QUANTUM-SAFE. (Same answer as
the v3 stage 2 run: [QCAI-stage2-response.md](QCAI-stage2-response.md).)

## 2. Potential reentrancy in EscrowVaultV3 (Medium): not an issue

The only native-value transfer is `_send`
([EscrowVaultV3.sol:280-286](../contracts/src/v4/EscrowVaultV3.sol#L281-L286)). It is called only from
`claimBounty` and `finalizeWithdraw`, both `nonReentrant` (OpenZeppelin `ReentrancyGuard`, imported
at line 4), and both set `status`, `amount` and `totalLocked` before the transfer
(checks-effects-interactions). The inline assembly is a plain `call` that does not copy return data
(so a payee can't grief with a huge return payload) and reverts on failure. Solidity's
`transfer`/`send` forward only 2300 gas, which breaks smart-contract wallets and is not a reentrancy
defence anyone should rely on. Tests: `test_Attack_ReentrancyOnClaim`,
`test_Stage2_OZGuardBlocksCrossFunctionReentry`, and the vault invariant test (random call sequences).

`buyTries` in the registry forwards the payment to the treasury after crediting the tries; the
treasury is set only by the admin's ML-DSA signature and cannot gain anything by re-entering
(it would just pay for more tries). `test_Tries_RefusingTreasuryRevertsThePurchase`.

## 3. Inadequate play pass validation (Medium): not an issue

The operator is authorised by the player, not assumed:

- `openPassFor` ([RobotRegistryV4.sol:342-352](../contracts/src/v4/RobotRegistryV4.sol#L342-L352))
  requires the player's own ML-DSA-87 signature over a digest that names the `operator`, `validUntil`
  (at most 10 minutes ahead), `maxRounds` (1 to 20), the player's nonce and a deadline. The signature
  is single use, and the operator can't be zero.
- `startSessionWithPass` ([RobotRegistryV4.sol:364](../contracts/src/v4/RobotRegistryV4.sol#L364))
  checks on every call that `msg.sender` is that operator, that the pass hasn't expired and that
  rounds are left, then decrements `roundsLeft`. Each round still uses one of the player's tries and
  can only be won by that player. A pass can never move funds or record a result.

Tests: `test_Pass_OnlyOperatorAndOnlyInTime`, `test_Pass_BoundsAndSignature`,
`test_Pass_OneSignatureManyRounds`, `test_Pass_CannotAttackOwnRobotOrBeatDailyLimit`.

## 4. Missing input validation for large values (Low): already bounded

| Input | Bound |
|---|---|
| Pass `validUntil` / `maxRounds` | `(now, now + 10 min]` / 1 to 20 (`BadPass`) |
| Session start `deadline` | at most 10 minutes ahead (`StartRequestTooLong`) |
| `buyTries` count | 1 to 1000 (`BadTryCount`); exact payment required (`WrongPayment`) |
| `setTryPrice` price | at most 10 QOR (`BadTryPrice`) |
| Robot name | 1 to 64 bytes (`BadName`) |
| Bounty deposit | at least 1 QOR |
| ML-DSA public key / signature | exact lengths (`BadPubkeyLength`, `BadSignatureLength`) |

All arithmetic is Solidity 0.8 checked, apart from the two documented `unchecked` increments (bounty
id and breach cursor) that can't overflow. Tests: `test_Pass_BoundsAndSignature`,
`test_Tries_PriceIsAdminOnlyAndBounded`, `test_Utility_ReplayAndBounds`.

## 5. Precompile availability check (Info): intended

If `pqcVerify` or `pqcKeyStatus` is missing or returns anything unexpected, every state-changing
action reverts (fails closed). A fallback to ECDSA, or skipping the check, would remove the quantum
safety, so there is deliberately none. `isPQAvailable()` is a read-only view that frontends use to
show a clear message, and both v4 contracts verify a real ML-DSA-87 signature against the live
precompile in their constructors, so they could not have been deployed on a chain without it.
Tests: `test_Attack_PrecompileMissingFailsClosed`, `test_Stage2_PrecompileAvailability`.
