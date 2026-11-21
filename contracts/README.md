# RedZone contracts

These Solidity contracts hold RedZone's money and its public record. Every action that moves
money or changes a record must carry a **post-quantum ML-DSA-87 signature**. The contracts check it
on chain with QoreChain's `pqcVerify` and `pqcKeyStatus` precompiles. A stolen or quantum-broken
ECDSA key alone can't move anything.

## The two live contracts

| Contract | What it does |
|---|---|
| **RobotRegistryV4** ([src/v4/RobotRegistryV4.sol](src/v4/RobotRegistryV4.sol)) | The public record. It stores each robot (owner, name, brain fingerprint) and starts rounds. It gives 5 free tries a day, sells extra tries and opens 10-minute play passes. It records the referee's signed verdicts and computes each robot's safety rating and badge. |
| **EscrowVaultV5** ([src/v5/EscrowVaultV5.sol](src/v5/EscrowVaultV5.sol)) | The money. It holds bounties and prize pools in native QOR and pays a breach only to the player of the session that breached. It enforces "freeze until fixed": a breached robot pays again only after its owner updates the brain. A bounty owner can take an unwon bounty back after a 3-hour delay, and never while a win is unpaid. |

Both are built on three shared parts in [src/v3/](src/v3/) and [src/](src/):

| Part | Role |
|---|---|
| [PQGuard.sol](src/PQGuard.sol) | Calls the precompiles: `pqcVerify` at `0x…0a01` and `pqcKeyStatus` at `0x…0a02` |
| [MLDSA87.sol](src/v3/MLDSA87.sol) | Checks keys and signatures against the exact FIPS 204 ML-DSA-87 sizes; anything unexpected fails closed |
| [PQAccess.sol](src/v3/PQAccess.sol) | Signed requests: digest = contract tag + chain id + contract address + request, plus a nonce and a deadline per signer. Admin actions need the admin's ML-DSA-87 signature; admin handover takes two steps |
| [QoreXMessage.sol](src/QoreXMessage.sol) | Rebuilds the exact text the QoreX wallet shows and signs, so a signature for one action can't authorise another |

The other files in `src/` are earlier versions (v1 to v4 vaults and registries). They are kept
because their addresses appear in the project's history and the Q-Day Drill. None of them holds
money that matters any more.

## Tests

```sh
npm install
npm run forge-std      # forge-std and OpenZeppelin v5.1.0 into lib/
forge test             # everyday depth: 477 tests
FOUNDRY_PROFILE=strict forge test   # 10,000 fuzz runs, 1,000 x 200-call invariant campaigns
```

Tests run on Foundry's local EVM with mock precompiles ([test/mocks/](test/mocks/)) and need no
network.

| Folder | Covers |
|---|---|
| [test/v6/](test/v6/) | **The live pair.** VaultV5.t.sol covers pools, freezing, take-backs and payouts. VaultInvariant.t.sol checks that money in equals money locked plus paid out, that nobody but the session's player gains, and that no payout exceeds the prize. Branches.t.sol has one test for every branch the other suites didn't reach, including misbehaving precompiles, which must fail closed. |
| [test/v4/](test/v4/), [test/v5/](test/v5/) | Play pass, paid tries, prize pools, and the registry's audit findings |
| [test/v3/](test/v3/) | ML-DSA-only access, attack proofs-of-concept from the adversarial audit, vault invariants |
| `test/*.t.sol` | v1 and v2, including the 45-test attacker playbook for RobotRegistryV2 |

The full pass runs from the repo root with `STRICT=1 bash scripts/verify-all.sh`. It runs:
- build and tests;
- coverage;
- Slither;
- backend tests;
- npm audit.

Every result has a verdict in
[../audits/verification/TRIAGE.md](../audits/verification/TRIAGE.md).

## QoreChain's EVM window (needed before any deploy)

QoreChain admits an EVM transaction only from an account that has:
- a registered ML-DSA-87 key;
- an open **EVM authorisation window**.

Both are set up with native messages signed by the post-quantum key. The ECDSA key in
`PRIVATE_KEY` can never authorise spending on its own. The helper
[scripts/window.ts](scripts/window.ts) comes from `create-qorechain-dapp`; RedZone added `close` and
`proof`.

```sh
cp .env.example .env       # PRIVATE_KEY and QORE_PQC_RECOVERY_CODE (or QORE_MNEMONIC)
npm run window status      # account, PQC key, window
npm run window register    # once per account: register its ML-DSA-87 key
npm run window open        # open a window (blocks, transaction count and value are capped)
npm run window close       # close it right after use
```

Close the window as soon as you're done. While it's open, the ECDSA key alone can spend within its
limits; we found this during the Q-Day rehearsal ([../docs/QDAY_DRILL.md](../docs/QDAY_DRILL.md)).
The RedZone relayer's window is also **scoped**: it only admits calls to the two RedZone contracts.

## Deploy

Foundry can't simulate QoreChain's precompiles, so the deploy scripts use viem. Each constructor
checks an ML-DSA-87 deploy proof with the live `pqcVerify`. A deployment can therefore only succeed
on a chain whose post-quantum checks work.

```sh
npm run referee-key        # creates the referee's ML-DSA-87 key (.referee-key.json, git-ignored)
forge build
npm run v4-proofs          # the deploy-time proofs the constructors check
TREASURY=0x... npm run deploy:v4 -- --dry-run
npm run window open
TREASURY=0x... npm run deploy:v4            # RobotRegistryV4
npx tsx --env-file=.env scripts/deploy-vault-v5.ts   # EscrowVaultV5, pointed at the registry
npm run window close
```

QoreChain caps a contract creation at about 5M gas, roughly 20 KB of code. That's why a few
admin-only helpers are internal; the tests compute them the same way. Addresses and transactions
are recorded in [../deployments/testnet.json](../deployments/testnet.json).

Never commit `.env`, `.referee-key.json` or `.attacker.json`.
