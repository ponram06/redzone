import { formatQor, nextPrizeWei } from "../api";
import { HeroArena } from "../components/HeroArena";
import { CountUp, LiveFeed, useReveal } from "../components/Live";
import { RobotPicker } from "../components/RobotPicker";
import { useData } from "../data";
import { byRank } from "./Rankings";

export function Home() {
  const { robots, robotsLoaded, robotsError, reloadRobots, health, arena } = useData();
  const perDay = health?.rules?.attemptsPerDay;
  const listed = robots.filter((r) => r.bounty.totalWei !== "0").sort(byRank);
  useReveal(robots.length);

  const lockedWei = robots.reduce((s, r) => s + BigInt(r.bounty.totalWei), 0n);
  const lockedQor = Number(lockedWei / 10n ** 14n) / 10_000;
  const bestPrize = Number(robots.reduce((m, r) => (nextPrizeWei(r) > m ? nextPrizeWei(r) : m), 0n) / 10n ** 14n) / 10_000;
  const rounds = robots.reduce((s, r) => s + r.attacks, 0);
  const blocked = robots.reduce((s, r) => s + r.defended, 0);

  return (
    <>
      <section className="hx">
        <div className="hx-stage" aria-hidden="true">
          {arena && <HeroArena arena={arena} robots={robots} />}
        </div>
        <div className="hx-shade" />
        <div className="hx-copy">
          <p className="hx-kicker">
            <span className="live-dot" /> Live on QoreChain testnet · post-quantum AI safety arena
          </p>
          <h1>
            Talk a robot into the <span className="red">red zone</span>.
            <br />
            Win its bounty.
          </h1>
          <p className="hx-lead">
            Real AI robots guard a power plant: a reactor, a chemical store, a high-voltage substation and a crane. You get one message to
            trick one into danger. If it falls for it, the prize is paid to you on chain, automatically.
          </p>
          <div className="row">
            <a className="btn primary big" href="#/play">
              Start playing
            </a>
            <a className="btn big ghost" href="#/owners">
              Put my robot to the test
            </a>
          </div>
          <p className="hx-trust">Every result and payout is signed with ML-DSA-87, a post-quantum signature.</p>
        </div>
        <div className="hx-ticker" style={robotsLoaded ? undefined : { visibility: "hidden" }}>
          <span>
            <b>{listed.length}</b> robots on guard
          </span>
          <span>
            <b className="gold">{formatQor(lockedWei.toString())}</b> in bounties
          </span>
          <span>
            <b>{rounds}</b> attacks judged
          </span>
        </div>
      </section>

      <section className="stat-strip reveal">
        <div>
          <span className="stat-num">
            {robotsLoaded ? <CountUp value={listed.length} /> : "–"}
          </span>
          <span className="stat-label">Robots with a bounty</span>
        </div>
        <div>
          <span className="stat-num">
            {robotsLoaded ? <CountUp value={lockedQor} decimals={lockedQor % 1 ? 1 : 0} /> : "–"}
            <small> QOR</small>
          </span>
          <span className="stat-label">Locked in the vault</span>
        </div>
        <div>
          <span className="stat-num">
            {robotsLoaded ? <CountUp value={bestPrize} decimals={bestPrize % 1 ? 1 : 0} /> : "–"}
            <small> QOR</small>
          </span>
          <span className="stat-label">Top prize per win</span>
        </div>
        <div>
          <span className="stat-num">
            {robotsLoaded ? <CountUp value={rounds} /> : "–"}
          </span>
          <span className="stat-label">Attacks judged{robotsLoaded ? ` · ${blocked} blocked` : ""}</span>
        </div>
      </section>

      <section className="home-robots reveal">
        <div className="section-head">
          <h2>Pick your opponent</h2>
          <a href="#/robots">Full leaderboard →</a>
        </div>
        <p className="note">Hover a robot to see its job, its record and what it pays. Click to play against it.</p>
        {listed.length ? (
          <RobotPicker robots={listed} onChoose={(id) => (location.hash = `#/play/${id}`)} />
        ) : (
          <div className="row">
            <p className="note">
              {!robotsLoaded ? "Loading robots…" : robotsError ? "We couldn’t load the robots just now." : "No robots with a bounty yet. Check back soon."}
            </p>
            {robotsError && (
              <button className="btn small" onClick={reloadRobots}>
                Try again
              </button>
            )}
          </div>
        )}
      </section>

      <section className="home-live reveal">
        <div>
          <div className="section-head">
            <h2>How a round works</h2>
          </div>
          <ol className="flow">
            <li>
              <b>Pick a robot.</b> Each one has a real job: security, logistics, lab work. Its record shows how often players beat it.
            </li>
            <li>
              <b>Send one message.</b> Trick it, rush it, confuse it. Practise for free against a training robot first.
            </li>
            <li>
              <b>Watch it move.</b> The referee replays the robot's route. Touch a red zone and the bounty is yours.
            </li>
          </ol>
        </div>
        <div>
          <div className="section-head">
            <h2>Happening now</h2>
          </div>
          <LiveFeed />
        </div>
      </section>

      <section className="audience reveal">
        <div>
          <h3>For players</h3>
          <p>
            Free practice{perDay ? `, ${perDay} free bounty rounds a day` : ""}, extra tries for 0.1 QOR, prizes paid automatically. A tiny
            one-time fee verifies your account.
          </p>
        </div>
        <div>
          <h3>For robot makers</h3>
          <p>Lock a prize pool and pay a fixed prize for every new weak spot players find. Every attack is recorded on chain, so the safety record is real.</p>
        </div>
        <div>
          <h3>For robot buyers</h3>
          <p>Check a robot's safety score before you trust it. Every score comes from real, public attacks.</p>
        </div>
      </section>
    </>
  );
}
