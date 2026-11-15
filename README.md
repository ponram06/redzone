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
| `backend/` robot brain + ML-DSA referee | Planned |
| `web/` arena + leaderboard | Planned |
| `audits/` two-stage QCAI audit | Planned |

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
npm run window open
npm run deploy:vault
npm run deploy:registry
```

## Credits

Built during the QoreChain Developer Fest (4 Nov – 2 Dec 2026). Third-party code and tools used:

| What | Used for | Licence |
|---|---|---|
| [create-qorechain-dapp](https://www.npmjs.com/package/create-qorechain-dapp) 0.14.0, `foundry` template | Project scaffold and the EVM window helper (`contracts/scripts/window.ts`) | Apache-2.0 |
| [@qorechain/sdk](https://www.npmjs.com/package/@qorechain/sdk) 0.14.0 | ML-DSA-87 keys and hybrid-signed native transactions | Apache-2.0 |
| [@qorechain/evm](https://www.npmjs.com/package/@qorechain/evm) 0.14.0 | Precompile addresses and ABIs (`pqcVerify`, `pqcKeyStatus`) | Apache-2.0 |
| [Foundry](https://github.com/foundry-rs/foundry) and [forge-std](https://github.com/foundry-rs/forge-std) | Build, tests, deploy scripts | MIT / Apache-2.0 |
| [viem](https://viem.sh), [CosmJS](https://github.com/cosmos/cosmjs) | Chain clients used by the window helper | MIT / Apache-2.0 |

AI assistance is documented in [AI_USAGE.md](AI_USAGE.md).

## License

MIT
