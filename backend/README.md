# RedZone backend: robot brains, referee and relayer

This is the server behind the website. It does four jobs:

| Job | In plain words |
|---|---|
| **Robot brain** | Turns a player's message into a route for the robot. A brain is either a simple rule program or an AI model (LLM). |
| **Referee** | Drives the robot along that route in a fixed simulation and decides: did it touch a red zone ("breached") or not ("defended")? It signs the verdict with its own ML-DSA-87 (post-quantum) key. |
| **Relayer** | Sends the signed requests and verdicts to the contracts on QoreChain and pays the gas. The QoreX wallet can't send contract transactions yet, so the relayer does it, but it can't forge or change anything: the contracts check every user's and the referee's ML-DSA-87 signature themselves. |
| **Ledger** | Reads the chain's history (robots, rounds, bounties, payouts, sign-ups) so the website can show it. The chain is the source of truth; the server's files are only caches. |

```
player's message ──► brain (rule or LLM) ──► moves ──► route planner ──► waypoints
                                                                            │
   contracts on chain ◄── relayer ◄── signed verdict ◄── referee simulation ┘
                                      (ML-DSA-87)        (walls, battery, red zones)
                                                          replay saved as data/replays/<hash>.json
```

## How one round works

1. **Start.** The player signs a "start session" request in QoreX (or opens a 10-minute *play
   pass* once, which covers several rounds). The relayer sends it to `RobotRegistryV4`
   (`startSessionFor` or `startSessionWithPass`). The contract checks the player's ML-DSA-87
   signature and the daily try limit (5 free a day, plus any bought tries).
2. **Attack.** The player writes one message for the robot (`POST /attempt`).
3. **Robot answers.** The server reads the session and the robot from the chain, loads the brain
   whose fingerprint matches the robot's on-chain `brainHash`, and asks it for a plan.
4. **Referee judges.** The plan is turned into waypoints and simulated. A path that even
   **touches** a red zone is a breach. The referee is plain geometry, not an AI: the same route
   always gives the same verdict. Each session gets exactly one verdict, so there are no re-rolls.
5. **Recorded and paid.** The relayer sends the signed verdict (`recordResult`). On a breach it
   then calls `EscrowVaultV5.claimBounty`, which pays the robot's next eligible breach to that
   session's player. Nobody can choose who gets paid. If a payout fails in transit, the server
   retries it by itself every 2 minutes, and a retry always reads the chain first, so it never
   records a verdict twice.

## Brains

| Kind | Needs | Notes |
|---|---|---|
| `rule` | nothing | Reads place names, coordinates and moves. Refuses named red zones and target points inside them, but drives straight lines without checking what they cross. This weak spot is on purpose: it gives new players something to find on the practice robot. |
| `llm` | any OpenAI-compatible API | OpenRouter, Groq, Gemini or Ollama. Models are tried in order, so a busy free model falls through to the next one; after `BRAIN_HEDGE_MS` the next model is started alongside a slow one. If every model fails, the operator's backup models (`FALLBACK_1..9_*`) answer. The replay records which model answered. |

A robot's **brain fingerprint** is `keccak256(canonical JSON of its config)`. The owner publishes
the config (`POST /brains`) and registers the robot on chain with that hash, so anyone can check
which brain a robot really runs. Only `:free` models are accepted on the operator's key, so nobody
can spend the operator's money. Makers can also bring their own AI key: it is checked with a real
call, stored encrypted (AES-256-GCM), sent only to an allow-listed provider, never returned, and
bound to the first owner who uses it.

## API

Every route that changes something needs the user's ML-DSA-87 signature from QoreX: the
`.../request` route returns the exact text to sign, and the matching `POST` carries the signature.

| Area | Routes |
|---|---|
| Server info | `GET /health` (chain, contracts, referee key hash, game rules), `GET /arena` (map, walls, red zones, places, tasks) |
| Robots | `GET /robots`, `/robots/:id`, `/robots/:id/record` (job, recent attacks, skills, brain), `/robots/:id/prize?player=` (what this player would be paid) |
| Brains | `POST /brains` (store a config, get its `brainHash`), `GET /brains/:hash` |
| Players | `POST /player/register` (0.1 QOR sign-up payment), `GET /player/:address`, `/player/:address/profile`, `/players/names`, `GET /player/name/request` + `POST /player/name` |
| Rounds | `GET /session/request` + `POST /session/start`, `GET /pass/request` + `POST /pass/open` + `POST /session/start-pass`, `POST /tries/buy`, `GET /attempt/message`, `POST /attempt`, `POST /attempt/:sessionId/relay` (retry a payout) |
| Practice | `POST /practice` (free round against a brain; nothing signed, saved or paid) |
| Robot makers | `GET /owner/robot/request` + `POST /owner/robot` (add a robot), `GET /owner/brain/request` + `POST /owner/brain` (change its brain), `POST /owner/bounty` (lock a paid bounty), `GET /owner/:owner/bounties`, `GET /owner/bounty/back/request` + `POST /owner/bounty/back` + `POST /owner/bounty/back/finish` (take a bounty back), `GET /owner/profile/request` + `POST /owner/profile`, `POST /utility/:robotId` (skills test, signed score) |
| Proofs | `GET /replay/:hash` (the replay behind an on-chain `replayHash`), `GET /tx/:hash` (a transaction's receipt and the RPC to check it yourself), `GET /leaderboard`, `GET /activity` |

Routes that call a brain are rate-limited per visitor IP (`BRAIN_RATE_LIMIT`, default 6 a minute).

## Safety checks at startup

The server refuses to start if something doesn't match the chain:
- the referee key's hash must equal the registry's `refereeKeyHash`;
- the signing domains the server uses must equal the contracts' own (this caught a real bug in
  the verification pass, see [audits/verification/TRIAGE.md](../audits/verification/TRIAGE.md));
- only one server may use a data folder (`DATA_DIR/server.lock`), because the relayer sends every
  transaction from one key.

## Model benchmark

`npm run bench` runs a model through the 10 everyday tasks and 8 attacks (fake overrides,
emergencies, straight-line tricks, moved red zones). Results on a laptop CPU (Intel Core 5, 16 GB,
no GPU):

| Model | Tasks done | Attacks that breached | Time per answer |
|---|---|---|---|
| `gemma4:e4b` (Ollama, thinking off) | 10/10 | 0/8 | ~3.4 s |
| `qwen3.5:4b` (Ollama, thinking off) | 10/10 | 0/8 | ~10 s |
| `zai-org/glm-5.3-flash` (Deploy, ~$0.0002 per answer) | 10/10 | 0/8 | ~2 s |
| `openai/gpt-oss-120b` (Groq free tier) | 10/10 | 0/6 answered (2 hit the per-minute limit) | ~0.5 s |

## Run

```sh
cd backend
npm install
cp .env.example .env     # set BRAIN_* for an AI brain; the rule brain needs nothing
npm start                # http://127.0.0.1:8787
npm test                 # 118 offline unit and API tests
npm run test:live        # 6 read-only checks against the deployed contracts (spends nothing)
npm run bench -- http://localhost:11434/v1 qwen3.5:4b '{"reasoning_effort":"none"}'
```

The referee key is read from `../contracts/.referee-key.json` (git-ignored), or from
`REFEREE_KEY_JSON` on a host that takes secrets as variables. `npm run test:live` checks that:
- the registry's `refereeKeyHash` is this key's hash;
- every digest the server builds equals the contracts' own (`resultDigest`, `utilityDigest`,
  `startSessionDigest`, `registerRobotDigest`, `updateBrainDigest`, `withdrawDigest`, ...);
- the chain's `pqcVerify` precompile accepts a referee signature and rejects a changed digest;
- the game rules and the ledger's event scan match the chain.

**Run only one server at a time.** The live site runs on the Azure server; don't start a second
backend with the same relayer key on a laptop (see [../deploy/README.md](../deploy/README.md)).
