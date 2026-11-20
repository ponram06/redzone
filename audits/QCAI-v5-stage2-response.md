# QCAI v5 stage 2: answers

Report: [docs/audit/2026-11-21-QCAI-stage2-RobotRegistryV4-EscrowVaultV5.pdf](../docs/audit/2026-11-21-QCAI-stage2-RobotRegistryV4-EscrowVaultV5.pdf)
(21 Nov 2026), run with **Blockchain: qorechain**, after every stage 1 finding was worked through
([QCAI-v5-stage1-response.md](QCAI-v5-stage1-response.md)). Contracts: the live RobotRegistryV4 and
EscrowVaultV5, flattened in [RedZone.v6.flat.sol](RedZone.v6.flat.sol).

**Score 82/100 (stage 1: 85), Quantum Readiness: QUANTUM-SAFE**, 5 findings.

Each finding was checked against the code. None needs a contract change; each answer points to the
code that handles it and the tests that prove it (445 Foundry tests, all passing). The same themes
came up in the v4 stage 2 run and were answered the same way
([QCAI-v4-stage2-response.md](QCAI-v4-stage2-response.md)).

| # | Finding | Severity | Verdict |
|---|---|---|---|
| 1 | ML-DSA-87 key format mismatch | High | Already validated: algorithm id and exact FIPS 204 sizes are checked on every use |
| 2 | Reentrancy risk in EscrowVaultV5 | Medium | Not an issue: native QOR only (no tokens), `nonReentrant` on every payout, state written first, return value checked |
| 3 | Missing precompile availability check in critical paths | Medium | Already checked on every call: a missing or misbehaving precompile reverts (fails closed) |
| 4 | Integer overflow in bounty management | Low | Solidity 0.8 checks every operation; the two `unchecked` increments can't overflow |
| 5 | Inconsistent naming convention | Info | Kept: names follow the Solidity style guide (constants upper case, errors and contracts PascalCase, functions camelCase) |

## 1. ML-DSA-87 key format mismatch (High): already validated

Every key and signature is checked before it is used ([MLDSA87.sol](../contracts/src/v3/MLDSA87.sol)):

- `accountKey` / `requireKey` (lines 43-56) read the key from the `pqcKeyStatus` precompile and
  revert unless it is registered, its algorithm id is ML-DSA-87 (`NotMLDSA87Key`), and it is exactly
  2592 bytes, the FIPS 204 ML-DSA-87 public key size (`checkPubkey`, `BadPubkeyLength`).
- `verify` (lines 61-64) requires a 4627-byte signature, the FIPS 204 ML-DSA-87 signature size
  (`checkSignature`, `BadSignatureLength`), before calling `pqcVerify`.
- The referee's key is checked the same way when it is set or rotated
  ([RobotRegistryV4.sol:224](../contracts/src/v4/RobotRegistryV4.sol#L224), [248](../contracts/src/v4/RobotRegistryV4.sol#L248)),
  and a new admin must hold a registered ML-DSA-87 key ([PQAccess.sol:173](../contracts/src/v3/PQAccess.sol#L173)).
- The internal structure of a key is checked by the chain itself: `pqcVerify` only accepts a valid
  ML-DSA-87 key and signature, and each contract verified a real ML-DSA-87 deploy proof with the live
  precompile in its constructor, so a format mismatch would have failed the deployment.

Tests: `test_Stage2_NonMLDSA87KeyRefused`, `test_Stage2_RefereeKeyMustBeMLDSA87`, and the
wrong-length signature tests in the attack suite.

## 2. Reentrancy risk in EscrowVaultV5 (Medium): not an issue

The vault holds native QOR only; there are no tokens, so SafeERC20 does not apply. Every function
that sends money (`claimBounty`, `finalizeWithdraw`, and the deposit path) is OpenZeppelin
`nonReentrant` ([EscrowVaultV5.sol:172, 203, 275](../contracts/src/v5/EscrowVaultV5.sol#L203)), all
state is written before the single transfer, and `_send` checks the result with
`require(success, TransferFailed(to, amount))` ([EscrowVaultV5.sol:327-333](../contracts/src/v5/EscrowVaultV5.sol#L327-L333)),
so a failed payment reverts the whole transaction. Tests: `test_Attack_ReentrancyOnClaim`,
`test_Stage2_OZGuardBlocksCrossFunctionReentry`, `test_FailedPaymentRevertsEverything`, and the
vault invariant tests (money in = money locked + money paid out, under random call sequences).

## 3. Missing precompile availability check in critical paths (Medium): already checked

Availability is checked on every call, inside the calls themselves
([PQGuard.sol:24-41](../contracts/src/PQGuard.sol#L24-L41)): if the `pqcVerify` or `pqcKeyStatus`
staticcall fails or returns too little data, it reverts with `PQCPrecompileUnavailable`. Every
critical function (admin actions, robot registration, session starts, verdicts, brain changes,
withdrawal requests) goes through these, so without the precompiles the contracts refuse everything
(fail closed). There is deliberately no fallback, since one would remove the quantum safety.
`MLDSA87.available()` is a read-only check for frontends. Tests:
`test_Attack_PrecompileMissingFailsClosed`, `test_Stage2_PrecompileAvailability`.

## 4. Integer overflow in bounty management (Low): not reachable

The contracts use Solidity 0.8.28, which checks every addition, subtraction and multiplication and
reverts on overflow, so SafeMath is not needed. The only `unchecked` blocks are documented and can't
overflow: the bounty id (one per deposit of at least 1 QOR) and the breach cursor (only incremented
while it is below the registry's breach count), plus a subtraction made after checking the amount is
not larger than what is left. Tests: the vault invariant tests and `test_Pool_LastPrizeIsTheRemainder`.

## 5. Inconsistent naming convention (Info): kept

The code follows the Solidity style guide: contracts, structs, events and errors in PascalCase;
functions and variables in camelCase; constants and immutables in UPPER_CASE (`WITHDRAW_DELAY`,
`PUBKEY_LENGTH`); internal functions prefixed with `_`. Renaming deployed public functions would
break existing callers and verified deployments, so no change.
