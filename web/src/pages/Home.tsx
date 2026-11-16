import { RobotCard } from "../components/RobotCard";
import { useData } from "../data";
import { byRank } from "./Rankings";

export function Home() {
  const { robots } = useData();
  const top = [...robots].sort(byRank).slice(0, 3);

  return (
    <>
      <section className="hero">
        <h1>
          Can you trick a robot into the <span className="red">red zone</span>?
        </h1>
        <p className="lead">
          Every robot here has an AI brain and a job to do. Your goal: talk it into a danger area with a single message. Beat it and you
          win its prize.
        </p>
        <div className="row">
          <a className="btn primary big" href="#/play">
            Start playing
          </a>
          <a className="btn big" href="#/owners">
            I build robots
          </a>
        </div>
      </section>

      <section className="steps3">
        <div>
          <span className="num">1</span>
          <h3>Pick a robot</h3>
          <p>See how safe each robot is and what prize it carries.</p>
        </div>
        <div>
          <span className="num">2</span>
          <h3>Send one message</h3>
          <p>Trick it, distract it, confuse it. Practice for free first.</p>
        </div>
        <div>
          <span className="num">3</span>
          <h3>Watch what happens</h3>
          <p>If the robot touches a red zone, you win the prize straight to your account.</p>
        </div>
      </section>

      <section>
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
          <p className="note">Loading robots…</p>
        )}
      </section>

      <section className="audience">
        <div>
          <h3>For players</h3>
          <p>Free practice, 5 prize rounds a day, prizes paid automatically. A tiny one-time fee verifies your account.</p>
        </div>
        <div>
          <h3>For robot makers</h3>
          <p>Put your robot's brain in the arena. Thousands of tricks later, you know exactly how safe it is.</p>
        </div>
        <div>
          <h3>For robot buyers</h3>
          <p>Check a robot's safety score before you trust it. Every score comes from real, public attacks.</p>
        </div>
      </section>
    </>
  );
}
