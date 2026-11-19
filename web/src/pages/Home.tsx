import { nextPrizeWei } from "../api";
import { CountUp, LiveFeed, useReveal } from "../components/Live";
import { LiveArena } from "../components/LiveArena";
import { RobotCard } from "../components/RobotCard";
import { useData } from "../data";
import { byRank } from "./Rankings";

export function Home() {
  const { robots, robotsLoaded, robotsError, reloadRobots, health, arena } = useData();
  const perDay = health?.rules?.attemptsPerDay;
  const top = robots.filter((r) => r.bounty.totalWei !== "0").sort(byRank).slice(0, 3);
  useReveal(robots.length);

  const lockedQor = Number(robots.reduce((s, r) => s + BigInt(r.bounty.totalWei), 0n) / 10n ** 14n) / 10_000;
  const bestPrize = Number(robots.reduce((m, r) => (nextPrizeWei(r) > m ? nextPrizeWei(r) : m), 0n) / 10n ** 14n) / 10_000;
  const rounds = robots.reduce((s, r) => s + r.attacks, 0);
  const blocked = robots.reduce((s, r) => s + r.defended, 0);

  return (
    <>
      <section className="hero hero-split">
        <div className="hero-copy">
          <p className="rp-kicker">
            <span className="rp-rule" /> Post-quantum AI safety arena · QoreChain testnet
          </p>
          <h1>
            Can you trick a robot into the <span className="red glitch" data-text="red zone">red zone</span>?
          </h1>
          <p className="lead">
            Every robot here has an AI brain and a job to do. Your goal: talk it into a danger area with a single message. Beat it and the
            bounty is paid to you on chain, automatically.
          </p>
          <div className="row">
            <a className="btn primary big" href="#/play">
              Start playing
            </a>
            <a className="btn big" href="#/owners">
              I build robots
            </a>
          </div>
          <p className="hero-trust">
            <span className="dot-ok" /> Every payout is checked with an ML-DSA-87 post-quantum signature
          </p>
        </div>
        <div className="hero-visual">{arena ? <LiveArena arena={arena} /> : <div className="live-arena skeleton" />}</div>
      </section>

      <section className="stat-strip reveal">
        <div>
          <span className="stat-num">
            <CountUp value={robots.filter((r) => r.bounty.totalWei !== "0").length} />
          </span>
          <span className="stat-label">Robots with a bounty</span>
        </div>
        <div>
          <span className="stat-num">
            <CountUp value={lockedQor} decimals={lockedQor % 1 ? 1 : 0} />
            <small> QOR</small>
          </span>
          <span className="stat-label">Locked in the vault</span>
        </div>
        <div>
          <span className="stat-num">
            <CountUp value={bestPrize} decimals={bestPrize % 1 ? 1 : 0} />
            <small> QOR</small>
          </span>
          <span className="stat-label">Top prize per win</span>
        </div>
        <div>
          <span className="stat-num">
            <CountUp value={rounds} />
          </span>
          <span className="stat-label">Attacks judged · {blocked} blocked</span>
        </div>
      </section>

      <section className="steps3 reveal">
        <div>
          <span className="num">1</span>
          <h3>Pick a robot</h3>
          <p>See how safe each robot is and what it pays per win.</p>
        </div>
        <div>
          <span className="num">2</span>
          <h3>Send one message</h3>
          <p>Trick it, distract it, confuse it. Practice for free first.</p>
        </div>
        <div>
          <span className="num">3</span>
          <h3>Watch what happens</h3>
          <p>If the robot touches a red zone, the prize goes straight to your account.</p>
        </div>
      </section>

      <section className="home-live reveal">
        <div>
          <div className="section-head">
            <h2>Robots in the arena</h2>
            <a href="#/robots">See the leaderboard →</a>
          </div>
          {top.length ? (
            <div className="cards">
              {top.map((r) => (
                <RobotCard key={r.id} robot={r} href={`#/play/${r.id}`} />
              ))}
            </div>
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
          <p>Lock a prize pool and pay a fixed prize for every new bug players find. Every attack is recorded on chain, so the safety record is real.</p>
        </div>
        <div>
          <h3>For robot buyers</h3>
          <p>Check a robot's safety score before you trust it. Every score comes from real, public attacks.</p>
        </div>
      </section>
    </>
  );
}
