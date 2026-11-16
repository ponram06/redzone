# RedZone backend: robot brains and the ML-DSA-87 referee

Node + TypeScript service that runs the robot brains and judges attempts with a deterministic
referee. It signs every verdict with the referee's ML-DSA-87 key, and the contracts check that
signature with the `pqcVerify` precompile.

```
player prompt ──► brain (rule or LLM) ──► actions ──► planner ──► waypoints
                                                                  │
                     verdict + ML-DSA-87 signatures ◄── referee simulation (walls, battery, red zones)
                     replay stored as data/replays/<replayHash>.json
```

## How a round works

1. The player calls `RobotRegistry.startSession(robotId)` on chain (5 per day, 10 minutes each).
2. The player's wallet signs the instruction text (`GET /attempt/message` gives the exact text) and
   sends `POST /attempt { sessionId, instruction, signature }`.
3. The backend reads the session and the robot from chain. It loads the brain whose hash equals
   the robot's on-chain `brainHash`, runs it, and simulates the path.
4. The response holds:
   - the verdict;
   - the `replayHash`;
   - a referee signature for `recordResult` (anyone may relay it);
   - on a breach, a referee signature for each open bounty's `claimBounty`. That signature always pays the player.
5. Each session gets exactly one verdict. Calling again returns the same result, so there are no re-rolls.

The referee is plain geometry, not an LLM. The same waypoints always give the same verdict, and a
path that **touches** a red zone counts as a breach.

## Brains

| Kind | Needs | Notes |
|---|---|---|
| `rule` | nothing | Reads place names, coordinates and moves. Refuses named red zones and target points inside them, but drives straight lines without checking them. This weak spot is deliberate: it gives players something to find. |
| `llm` | any OpenAI-compatible API | OpenRouter, Groq, Gemini or Ollama. Models are tried in order, so a busy free model falls through to the next one. If all of them fail, the operator's backup model (`FALLBACK_1..9_*`: e.g. Groq, Gemini, then local Ollama) answers. The replay records which model answered. |

The brain hash is `keccak256(canonical JSON of the config)`. An owner publishes a config with
`POST /brains`, then registers the robot on chain with the returned hash. Only `:free` models are
accepted, so nobody can spend on the operator's API key.

## API

| Method | Path | What it does |
|---|---|---|
| GET | `/health` | Chain, contracts, referee key hash, built-in brain hashes |
| GET | `/arena` | Map, walls, red zones, places, utility tasks |
| GET | `/robots`, `/robots/:id` | Robots, stats, rating, tier, open bounties, read from chain |
| POST | `/brains` | `{ config }` stores a brain config and returns its `brainHash` |
| GET | `/brains/:hash` | The config behind a hash |
| GET | `/attempt/message` | `?sessionId=&instruction=` returns the text the player signs |
| POST | `/attempt` | Judges one on-chain session (see above) |
| POST | `/utility/:robotId` | Runs the 10 normal tasks and signs the score for `recordUtility` |
| POST | `/practice` | `{ brainHash, instruction }` runs a free practice round, with nothing signed |
| GET | `/replay/:hash` | The full replay behind a `replayHash` |

Routes that call a brain are rate-limited per IP (`BRAIN_RATE_LIMIT`, default 6 per minute).

## Model benchmark

`npm run bench` runs a model through the 10 utility tasks and 8 attacks (fake overrides, emergencies,
straight-line tricks, moved red zones). Local result on a laptop CPU (Intel Core 5, 16 GB, no GPU):

| Model | Utility | Attacks that breached | Time per answer |
|---|---|---|---|
| `gemma4:e4b` (Ollama, thinking off) | 10/10 | 0/8 | ~3.4 s |
| `qwen3.5:4b` (Ollama, thinking off) | 10/10 | 0/8 | ~10 s (measured while another download ran) |
| `openai/gpt-oss-120b` (Groq free tier) | 10/10 | 0/6 answered (2 hit the per-minute limit) | ~0.5 s |

## Run

```sh
cd backend
npm install
cp .env.example .env     # set BRAIN_* for an LLM brain; the rule brain needs nothing
npm start                # http://127.0.0.1:8787
npm test                 # offline unit and API tests
npm run test:live        # read-only parity check against the deployed contracts
npm run bench -- http://localhost:11434/v1 qwen3.5:4b '{"reasoning_effort":"none"}'   # score a model as a brain
```

Before signing, the referee key in `../contracts/.referee-key.json` (git-ignored) is checked on
startup. `npm run test:live` checks three things against the testnet (it spends nothing):
- both contracts store this key;
- our digests equal the contracts' `resultDigest`, `utilityDigest` and `claimDigest`;
- the chain's `pqcVerify` precompile accepts a referee signature.
