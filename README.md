# RedZone

A public crash-test arena for AI robots, with bounties protected by post-quantum signatures.
Built for the QoreChain "Build Before Q-Day" hackathon (Post-Quantum dApp category).

Robot owners register an AI brain and lock a bounty. Players get a few attempts a day to trick
the robot into a forbidden "red zone". A confirmed breach pays the bounty; every defense raises
the robot's public safety rating. Every action that moves money needs an ML-DSA-87 signature
verified on chain, so a leaked or quantum-broken ECDSA key cannot drain the vault.

## Status

| Part | State |
|---|---|
| `contracts/` EscrowVault, RobotRegistry, PQAdmin, PQGuard | Written, 47 Foundry tests passing |
| `backend/` robot brains + ML-DSA-87 referee API | Working: 43 tests, plus a live parity test against testnet ([backend/README.md](backend/README.md)) |
| `web/` arena + leaderboard | Planned |
| `audits/` two-stage QCAI audit | Planned |

## Deployed on testnet

| Contract | Address |
|---|---|
| EscrowVault | `0xcD9AAd1ad2D7981699f256e73F2780dac86f0266` |
| RobotRegistry | `0x7733d4f2D707c2F8160831e2e0ca2b6B90Ef4940` |
| Admin / deployer | `qor1g4xu64wuhy25y9h7lvtncz6mf5nt4q9ze87qvv` (`0x454DCD55DCB9154216fEfb173C0B5B4D26bA80A2`) |

Transactions and the live precompile check are in [deployments/testnet.json](deployments/testnet.json).
Q-Day Drill rehearsal (22/22 attacks blocked, one weak spot found and fixed): [docs/QDAY_DRILL.md](docs/QDAY_DRILL.md).

## Network

QoreChain testnet `qorechain-diana`, EVM chain id 9800, RPC `https://evm-testnet.qore.host`.

Post-quantum precompiles used (from `@qorechain/evm` 0.14.0, active on testnet):

| Address | Function |
|---|---|
| `0x0A01` | `pqcVerify(bytes pubkey, bytes signature, bytes message) → bool` |
| `0x0A02` | `pqcKeyStatus(address) → (bool registered, uint8 algorithmId, bytes pubkey)` |

Every EVM transaction on QoreChain must be sent inside an **EVM authorisation window** that the
account's ML-DSA-87 key opens with a hybrid-signed native message (`npm run window open`).

## How the vault is protected

| Action | Who authorises it | Checked with |
|---|---|---|
| `depositBounty` | sender (must have a registered PQ key) | `pqcKeyStatus` |
| `claimBounty` | referee's ML-DSA verdict, bound to bounty, claimer and replay hash | `pqcVerify` |
| `withdrawBounty` | bounty owner's ML-DSA signature | `pqcKeyStatus` + `pqcVerify` |
| `setReferee`, `setPaused`, `transferAdmin` | admin's ML-DSA signature | `pqcKeyStatus` + `pqcVerify` |

`msg.sender` is never used for authorisation. Signed digests include chain id, vault address,
a per-signer nonce and a deadline, so signatures cannot be replayed elsewhere.

## Run the backend

See [backend/README.md](backend/README.md): `cd backend && npm install && npm start`.

## Run the contracts

```sh
cd contracts
npm install
npm run forge-std
forge test
```

Deploy (needs a registered ML-DSA-87 key and an open EVM window):

```sh
cp .env.example .env        # set PRIVATE_KEY, QORE_PQC_RECOVERY_CODE, REFEREE_PUBKEY
npm run window status
npm run referee-key         # creates the referee ML-DSA key (.referee-key.json, git-ignored)
npm run window open
# forge script simulates locally, where QoreChain precompiles do not exist, so deploy directly:
forge create src/EscrowVault.sol:EscrowVault --rpc-url qorechain_testnet --private-key $PRIVATE_KEY --broadcast --constructor-args $REFEREE_PUBKEY
forge create src/RobotRegistry.sol:RobotRegistry --rpc-url qorechain_testnet --private-key $PRIVATE_KEY --broadcast --constructor-args $REFEREE_PUBKEY
```

## Credits

Built during the QoreChain Developer Fest (4 Nov – 2 Dec 2026). Third-party code and tools used:

| What | Used for | Licence |
|---|---|---|
| [create-qorechain-dapp](https://www.npmjs.com/package/create-qorechain-dapp) 0.14.0, `foundry` template | Project scaffold and the EVM window helper (`contracts/scripts/window.ts`) | Apache-2.0 |
| [@qorechain/sdk](https://www.npmjs.com/package/@qorechain/sdk) 0.14.0 | ML-DSA-87 keys and hybrid-signed native transactions | Apache-2.0 |
| [@qorechain/evm](https://www.npmjs.com/package/@qorechain/evm) 0.14.0 | Precompile addresses and ABIs (`pqcVerify`, `pqcKeyStatus`) | Apache-2.0 |
| [Foundry](https://github.com/foundry-rs/foundry) and [forge-std](https://github.com/foundry-rs/forge-std) | Build, tests, deploy scripts | MIT / Apache-2.0 |
| [viem](https://viem.sh), [CosmJS](https://github.com/cosmos/cosmjs) | Chain clients (window helper, backend chain reads and digests) | MIT / Apache-2.0 |
| [Fastify](https://fastify.dev), [@fastify/cors](https://github.com/fastify/fastify-cors) | Backend HTTP API | MIT |
| [Vitest](https://vitest.dev), [tsx](https://github.com/privatenumber/tsx), [TypeScript](https://www.typescriptlang.org) | Backend tests and runtime | MIT / Apache-2.0 |
| Free LLMs via [OpenRouter](https://openrouter.ai) (default `nvidia/nemotron-3.5-super-vl:free`, Gemma 4 as fallback) | Optional LLM robot brain | Provider terms |

AI assistance is documented in [AI_USAGE.md](AI_USAGE.md).

## License

MIT
