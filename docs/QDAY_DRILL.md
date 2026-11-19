# Q-Day Drill: threat model and rehearsal

On 18 Nov 2026 a bot gets the classical ECDSA key of our drill account and tries everything that key
alone can do. We ran the same attacks against ourselves on 16 Nov with `npm run attack`
([contracts/scripts/qday-attack.ts](../contracts/scripts/qday-attack.ts)), which uses only `PRIVATE_KEY`.

| | |
|---|---|
| Drill account | `qor1g4xu64wuhy25y9h7lvtncz6mf5nt4q9ze87qvv` (`0x454DCD55DCB9154216fEfb173C0B5B4D26bA80A2`) |
| Contracts (registered for the drill) | RobotRegistryV3 `0x69564de848d807ea895e1987b53749e1648cadbf`, EscrowVaultV2 `0x16cc5efcda75a788f597dd0c785862db1bdbeb7f` |
| Older contracts (also held by the drill account's admin key) | EscrowVault v1 `0xcD9AAd1ad2D7981699f256e73F2780dac86f0266` (1 QOR bounty), RobotRegistryV2 `0x354f71Da76314Cd74A18524899Aeb43611d86448`, RobotRegistry v1 `0x7733d4f2D707c2F8160831e2e0ca2b6B90Ef4940` |

## Rehearsal result: 17 of 17 attacks blocked

| Attack (ECDSA key only) | Result | Why |
|---|---|---|
| Native transfer, classical signature | Blocked | Chain: account has a PQC key, must include the hybrid signature (pqc code 20) |
| Native transfer, hybrid with attacker's own ML-DSA key | Blocked | Chain: PQC signature verification failed (pqc code 21) |
| Open an EVM window (classical, or hybrid with own key) | Blocked | Same as above: opening a window is hybrid-signed |
| Register a new ML-DSA key (key takeover) | Blocked | Chain: key already registered; rotation needs the old key (pqc code 234) |
| Close our window (denial of service) | Blocked | Hybrid-signed, same as above |
| EVM transfer / contract call with no window open | Blocked | Chain: the EVM window does not admit the transaction |
| Vault `withdrawBounty`, empty or forged 4627-byte sig | Blocked | Contract: `PQCSignatureInvalid` (0x060cadce) from the live `pqcVerify` precompile |
| Vault `claimBounty` with forged referee verdict | Blocked | Contract: referee ML-DSA signature required |
| Vault `setReferee`, `transferAdmin`, `setPaused` | Blocked | Contract: admin ML-DSA signature required |
| Plain QOR transfer into the vault | Blocked | Contract: `receive()` reverts |
| Registry `updateBrain`, forged `recordResult` | Blocked | Contract: owner / referee ML-DSA signature required |

## Advanced rehearsal: 5 of 5 attacks blocked

The real bot also has its own funded accounts. `npm run attack:advanced`
([contracts/scripts/qday-attack-advanced.ts](../contracts/scripts/qday-attack-advanced.ts)) creates an
attacker account with its own ML-DSA key and EVM window, then uses only the drill account's ECDSA key:

| Attack | Result | Why |
|---|---|---|
| `MsgExecuteCosmos` meta-transaction: ECDSA-signed spend of 1 QOR, relayed by the attacker | Blocked | The drill account has 0 linked authenticators, so no classical key can authorise spends for it |
| `MsgExecuteEVM` meta-transaction: ECDSA-signed EVM transfer, relayed by the attacker | Blocked | Same |
| EIP-7702: stolen key signs an authorization tuple, attacker sponsors the type-4 tx | Blocked | Chain: account has not consented to delegating its code (consent needs a hybrid-signed `MsgAuthorizeEVMDelegation`) |
| Real tx from the attacker's window: `claimBounty(1)` with forged referee sig | Reverted on chain | `0x0fdf406dd720dbcb5bd1670fb148ce8fff802c56a42c70a46f08c3723dacfabb` |
| Real tx from the attacker's window: `withdrawBounty(1)` with forged owner sig | Reverted on chain | `0x62580ffcad3ecb74eaf45305f0b837b0cc9b28003ca515c820a01be0897931f6` |

After both runs the vault still holds its 1 QOR bounty and the drill account has no code installed.

Not applicable to our account: ERC-20 approvals and permits (the drill account holds no tokens),
staking, authz and fee grants, IBC transfers (all native messages, which need the hybrid signature
shown above).

## Weak spot found and fixed

**An open EVM window can be spent with the ECDSA key alone.** After deploying we had left a window
open (1 transaction, 1.2 QOR left). With only the ECDSA key we sent a 0.1 QOR EVM transfer and it
succeeded (`0xa5428fb6da1282781b9e2af03ecdbc537e7852865e98728c5de43b0304a46046`, sent back to the same
account). A window's scope does not limit where transactions go; it only limits blocks, count and value.

Fixes:

1. `npm run window close` (added to the template's helper) closes the window with a hybrid-signed
   `MsgCloseEVMWindow` right after use. Tested: `6569F705C2594BB76325C7A012EF3EBD2577C3D7C4E93EB46C07C43A323F1989`.
2. `npm run window proof` sends the drill-day "still works" proof as a hybrid-signed native
   self-transfer, so no window is opened at all on drill day. Tested:
   `11D610B9C37BFFD6D59E2C13D08CA6962FC7B799F211073C9A8428578D38F179`.
3. Money that matters sits in the vault, which never trusts `msg.sender`; even inside an open window
   the contracts refuse every drain.

## RobotRegistryV2 (deployed 16 Nov)

Players and owners now sign requests with their ML-DSA-87 key in QoreX; anyone relays them and the
contract checks the signature on chain with `pqcVerify`. v2 has a 45-test attacker playbook
([contracts/test/RobotRegistryV2.t.sol](../contracts/test/RobotRegistryV2.t.sol)): replay, identity
swap, retargeting, cross-contract / cross-chain / action-label / type confusion, phishing reuse,
stolen ECDSA keys (admin, owner, player), daily-limit bypass, front-running, forged and late
verdicts, and a missing or junk precompile (fails closed). One weak spot found while attacking it
(an owner-signed brain change could be held back for days) was fixed: every signed request now
expires within one hour. A real QoreX signature over the exact v2 message was accepted by the live
`pqcVerify` precompile, and refused with one digest character changed or the mainnet chain id.

Deployed with a window of 200 blocks, 2 transactions and a 0.8 QOR cap, closed right after
(`025BD558…`). Total cost 0.81 QOR.

## Drill-day procedure (18 Nov)

1. `npm run window status` must show `window: none`. If not, `npm run window close`.
2. `npm run window proof` and submit the hash on the project page by 19 Nov.
3. Do not open an EVM window during the drill.

## Drill result (18 Nov)

| Check | Before the drill (block 10280600) | After it ended (19 Nov, block 10353953) |
|---|---|---|
| Balance | 4.013710224992227284 QOR | 3.913710224992227284 QOR (the proof's 0.1 QOR fee only) |
| Nonce | 24 | 25 (the proof) |
| Code on the account (EIP-7702) | none | none |
| EVM window | none | none |
| v3 vault / v1 vault | 0 / 1 QOR | 0 / 1 QOR |
| Registry | no pending referee change | no pending referee change |

- Proof: hybrid-signed (ECDSA + ML-DSA-87) native self-transfer
  `4CD4CBB800E8F8E7786F6A18B939A445B6C53DB99AAEC56D29C0CF910B4638D8` at height 10302476
  (18 Nov 07:19 UTC), accepted on the project page.
- It is the only transaction from the account since the pre-drill snapshot: no attack got through and
  nothing was taken.
- The organisers publish the full attack log after the drill. Q-Day Survivor winners are announced
  on 16 Dec.
