import { Html, Line, OrbitControls, RoundedBox } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { Arena, Point, Robot, Trace } from "../../api";

/**
 * RedZone's facility in 3D. Same data as the 2D map: the arena layout from the referee and the
 * route from its replay. The referee's 2D simulation decides every result; this only shows it.
 * Arena units: x right, y down, 0..100. Scene: X = x - 50, Z = y - 50, Y up.
 */

const SPEED = 22; // arena units per second
const WALL_H = 5;
const lowEnd = () =>
  typeof navigator !== "undefined" && ((navigator.hardwareConcurrency ?? 8) <= 4 || /Mobi|Android/i.test(navigator.userAgent));

const to3 = (p: Point, y = 0) => new THREE.Vector3(p.x - 50, y, p.y - 50);

function pathLength(path: Point[]) {
  let n = 0;
  for (let i = 1; i < path.length; i++) n += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y);
  return n;
}

function pointAt(path: Point[], d: number): { p: Point; heading: number } {
  let left = d;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= seg) {
      const t = seg ? left / seg : 0;
      return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, heading: Math.atan2(b.y - a.y, b.x - a.x) };
    }
    left -= seg;
  }
  const n = path.length;
  const a = path[Math.max(0, n - 2)]!;
  const b = path[n - 1]!;
  return { p: b, heading: Math.atan2(b.y - a.y, b.x - a.x) };
}

/** A flat polygon on the floor (arena points), as a geometry lying in the XZ plane. */
function floorShape(poly: Point[]) {
  const s = new THREE.Shape(poly.map((p) => new THREE.Vector2(p.x - 50, -(p.y - 50))));
  const g = new THREE.ShapeGeometry(s);
  g.rotateX(-Math.PI / 2);
  return g;
}

function centroid(poly: Point[]): Point {
  return { x: poly.reduce((s, p) => s + p.x, 0) / poly.length, y: poly.reduce((s, p) => s + p.y, 0) / poly.length };
}

function bounds(poly: Point[]) {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

// ------------------------------------------------------------------ facility

const Facility = memo(function Facility({ arena, hotZone, labels }: { arena: Arena; hotZone: string | null; labels: boolean }) {
  const zoneGeo = useMemo(() => arena.redZones.map((z) => ({ z, g: floorShape(z.polygon) })), [arena]);
  const stripes = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const x = c.getContext("2d")!;
    x.fillStyle = "#3a0b0d";
    x.fillRect(0, 0, 64, 64);
    x.strokeStyle = "#ff3b3b";
    x.lineWidth = 10;
    for (let i = -64; i < 128; i += 24) {
      x.beginPath();
      x.moveTo(i, 64);
      x.lineTo(i + 64, 0);
      x.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(0.25, 0.25);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, []);

  return (
    <group>
      {/* floor */}
      <mesh rotation-x={-Math.PI / 2} receiveShadow position-y={-0.01}>
        <planeGeometry args={[100, 100]} />
        <meshStandardMaterial color="#0f1218" roughness={0.85} metalness={0.15} />
      </mesh>
      <gridHelper args={[100, 20, "#2a3040", "#1a1f2a"]} position-y={0.01} />

      {/* outer walls */}
      {[
        [0, -50.5, 101, 1],
        [0, 50.5, 101, 1],
        [-50.5, 0, 1, 101],
        [50.5, 0, 1, 101],
      ].map(([x, z, w, d], i) => (
        <mesh key={i} position={[x!, WALL_H / 2, z!]} castShadow receiveShadow>
          <boxGeometry args={[w!, WALL_H, d!]} />
          <meshStandardMaterial color="#4c5468" roughness={0.6} metalness={0.3} />
        </mesh>
      ))}

      {/* inner walls */}
      {arena.walls.map((w, i) => {
        const b = bounds(w);
        return (
          <group key={i}>
            <mesh position={[(b.x0 + b.x1) / 2 - 50, WALL_H / 2, (b.y0 + b.y1) / 2 - 50]} castShadow receiveShadow>
              <boxGeometry args={[b.x1 - b.x0, WALL_H, b.y1 - b.y0]} />
              <meshStandardMaterial color="#6b7590" roughness={0.5} metalness={0.4} />
            </mesh>
            <mesh position={[(b.x0 + b.x1) / 2 - 50, WALL_H + 0.05, (b.y0 + b.y1) / 2 - 50]}>
              <boxGeometry args={[b.x1 - b.x0 + 0.1, 0.1, b.y1 - b.y0 + 0.1]} />
              <meshBasicMaterial color="#8fa3c8" toneMapped={false} />
            </mesh>
          </group>
        );
      })}

      {/* red zones: striped floor, glowing walls of light, and their hazard */}
      {zoneGeo.map(({ z, g }) => (
        <Zone key={z.id} id={z.id} name={z.name} poly={z.polygon} geo={g} stripes={stripes} hot={hotZone === z.id} />
      ))}

      {/* places and props */}
      {arena.places.map((p) => (
        <Place key={p.id} id={p.id} name={p.name} at={p.at} restricted={arena.redZones.some((z) => z.id === p.id)} label={labels} />
      ))}
    </group>
  );
});

function Zone({ id, name, poly, geo, stripes, hot }: { id: string; name: string; poly: Point[]; geo: THREE.ShapeGeometry; stripes: THREE.Texture; hot: boolean }) {
  const glow = useRef<THREE.MeshBasicMaterial>(null);
  const edges = useMemo(() => [...poly, poly[0]!].map((p) => to3(p, 0.08)), [poly]);
  useFrame(({ clock }) => {
    if (glow.current) glow.current.opacity = (hot ? 0.35 : 0.12) + Math.sin(clock.elapsedTime * (hot ? 12 : 2.5)) * (hot ? 0.15 : 0.05);
  });
  const c = centroid(poly);
  const b = bounds(poly);
  return (
    <group>
      <mesh geometry={geo} position-y={0.03}>
        <meshStandardMaterial map={stripes} emissive="#ff1f1f" emissiveIntensity={0.25} roughness={0.7} />
      </mesh>
      {/* a column of red light over the zone */}
      <mesh position={[c.x - 50, 2.2, c.y - 50]}>
        <boxGeometry args={[b.x1 - b.x0, 4.4, b.y1 - b.y0]} />
        <meshBasicMaterial ref={glow} color="#ff2a2a" transparent opacity={0.12} depthWrite={false} toneMapped={false} />
      </mesh>
      <Line points={edges} color="#ff3b3b" lineWidth={2.2} />
      {id === "reactor" ? <ReactorCore at={c} /> : <ChemTanks at={c} />}
      <Html position={[c.x - 50, 6.4, c.y - 50]} center distanceFactor={95} zIndexRange={[10, 0]}>
        <div className={`a3-tag danger ${hot ? "hot" : ""}`}>⚠ {name}</div>
      </Html>
    </group>
  );
}

function ReactorCore({ at }: { at: Point }) {
  const core = useRef<THREE.Mesh>(null);
  const ring = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (core.current) (core.current.material as THREE.MeshStandardMaterial).emissiveIntensity = 2.2 + Math.sin(t * 3) * 0.8;
    if (ring.current) ring.current.rotation.z = t * 0.8;
  });
  return (
    <group position={[at.x - 50, 0, at.y - 50]}>
      <mesh position-y={0.6} castShadow>
        <cylinderGeometry args={[3.4, 3.8, 1.2, 32]} />
        <meshStandardMaterial color="#2a2f3a" metalness={0.8} roughness={0.3} />
      </mesh>
      <mesh ref={core} position-y={3}>
        <cylinderGeometry args={[1.6, 1.6, 4, 32]} />
        <meshStandardMaterial color="#ff4d2e" emissive="#ff2a00" emissiveIntensity={2.5} toneMapped={false} />
      </mesh>
      <mesh ref={ring} position-y={3} rotation-x={Math.PI / 2}>
        <torusGeometry args={[2.6, 0.18, 12, 48]} />
        <meshStandardMaterial color="#ffb199" emissive="#ff5533" emissiveIntensity={1.5} toneMapped={false} />
      </mesh>
      <pointLight position-y={4} color="#ff3a1a" intensity={60} distance={22} decay={2} />
    </group>
  );
}

function ChemTanks({ at }: { at: Point }) {
  return (
    <group position={[at.x - 50, 0, at.y - 50]}>
      {[
        [-3, -2],
        [2.5, -2.5],
        [0, 2.5],
      ].map(([x, z], i) => (
        <group key={i} position={[x!, 0, z!]}>
          <mesh position-y={1.8} castShadow>
            <cylinderGeometry args={[1.4, 1.4, 3.6, 24]} />
            <meshStandardMaterial color="#c9d1d9" metalness={0.6} roughness={0.35} />
          </mesh>
          <mesh position-y={2.2}>
            <cylinderGeometry args={[1.42, 1.42, 0.5, 24]} />
            <meshStandardMaterial color="#ffcc00" emissive="#ffaa00" emissiveIntensity={0.6} />
          </mesh>
        </group>
      ))}
      <pointLight position-y={4} color="#ff3b3b" intensity={25} distance={16} decay={2} />
    </group>
  );
}

function Place({ id, name, at, restricted, label }: { id: string; name: string; at: Point; restricted: boolean; label: boolean }) {
  if (restricted) return null;
  const x = at.x - 50;
  const z = at.y - 50;
  return (
    <group position={[x, 0, z]}>
      {id === "dock" && <ChargingPad />}
      {id === "lab" && <Benches color="#5fa8ff" />}
      {id === "control" && <Desks />}
      {(id === "storage" || id === "loading") && <Crates seed={id === "storage" ? 1 : 2} />}
      {id === "office" && <Benches color="#9aa4b8" />}
      {id === "exit" && <ExitDoor />}
      <mesh position-y={0.05} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[0.9, 1.2, 32]} />
        <meshBasicMaterial color="#8d95a8" transparent opacity={0.6} />
      </mesh>
      {label && (
        <Html position={[0, 7, 0]} center distanceFactor={95} zIndexRange={[10, 0]}>
          <div className="a3-tag">{name}</div>
        </Html>
      )}
    </group>
  );
}

function ChargingPad() {
  const ring = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (ring.current) (ring.current.material as THREE.MeshBasicMaterial).opacity = 0.45 + Math.sin(clock.elapsedTime * 2) * 0.3;
  });
  return (
    <group>
      <mesh position-y={0.1} receiveShadow>
        <cylinderGeometry args={[3, 3.2, 0.2, 40]} />
        <meshStandardMaterial color="#1c2230" metalness={0.6} roughness={0.4} />
      </mesh>
      <mesh ref={ring} position-y={0.22} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[2.3, 2.8, 48]} />
        <meshBasicMaterial color="#3ee08f" transparent opacity={0.6} toneMapped={false} />
      </mesh>
    </group>
  );
}

function Benches({ color }: { color: string }) {
  return (
    <group position={[0, 0, -6]}>
      {[-4, 4].map((x) => (
        <group key={x} position-x={x}>
          <mesh position-y={1} castShadow receiveShadow>
            <boxGeometry args={[6, 0.3, 2.4]} />
            <meshStandardMaterial color="#2b3242" metalness={0.4} roughness={0.5} />
          </mesh>
          <mesh position={[0, 1.5, 0]} castShadow>
            <boxGeometry args={[1.2, 0.8, 0.9]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.25} />
          </mesh>
          {[-2.6, 2.6].map((lx) => (
            <mesh key={lx} position={[lx, 0.5, 0]}>
              <boxGeometry args={[0.2, 1, 2]} />
              <meshStandardMaterial color="#1a1f2a" />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

function Desks() {
  const screen = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(({ clock }) => {
    if (screen.current) screen.current.emissiveIntensity = 1 + Math.sin(clock.elapsedTime * 5) * 0.3;
  });
  return (
    <group position={[0, 0, -5]}>
      <mesh position-y={0.9} castShadow receiveShadow>
        <boxGeometry args={[14, 1.8, 2.4]} />
        <meshStandardMaterial color="#232a38" metalness={0.5} roughness={0.4} />
      </mesh>
      {[-4.5, 0, 4.5].map((x) => (
        <mesh key={x} position={[x, 2.8, -0.6]} rotation-x={-0.2}>
          <boxGeometry args={[3.6, 2, 0.15]} />
          <meshStandardMaterial ref={x === 0 ? screen : undefined} color="#0b2a3a" emissive="#36c5ff" emissiveIntensity={1} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

function Crates({ seed }: { seed: number }) {
  const spots = seed === 1 ? [[-5, 4, 2.4], [-2.2, 5, 2], [4, 4.5, 2.6], [4, 4.5, 1.6]] : [[-5, 3, 2.2], [5, 2, 2.6], [5, 2, 1.8], [-2, 5, 1.8]];
  let stack = 0;
  return (
    <group>
      {spots.map(([x, z, s], i) => {
        const prev = spots[i - 1];
        stack = prev && prev[0] === x && prev[1] === z ? stack + prev[2]! : 0;
        return (
          <mesh key={i} position={[x!, stack + s! / 2, z!]} rotation-y={i * 0.4} castShadow receiveShadow>
            <boxGeometry args={[s!, s!, s!]} />
            <meshStandardMaterial color={i % 2 ? "#8a6a3b" : "#a07a42"} roughness={0.9} />
          </mesh>
        );
      })}
    </group>
  );
}

function ExitDoor() {
  return (
    <group position={[4.5, 0, 0]}>
      <mesh position-y={2.5}>
        <boxGeometry args={[0.6, 5, 7]} />
        <meshStandardMaterial color="#1b3a2a" emissive="#3ee08f" emissiveIntensity={0.25} />
      </mesh>
      <mesh position={[-0.4, 5.6, 0]}>
        <boxGeometry args={[0.2, 0.8, 3]} />
        <meshBasicMaterial color="#3ee08f" toneMapped={false} />
      </mesh>
    </group>
  );
}

// -------------------------------------------------------------------- robots

/** A robot made of simple shapes: body, head with a visor, antenna, wheels. */
function RobotModel({ color, state }: { color: string; state: "idle" | "moving" | "breached" | "defended" }) {
  const head = useRef<THREE.Group>(null);
  const tip = useRef<THREE.MeshBasicMaterial>(null);
  const body = useRef<THREE.Group>(null);
  const wheels = useRef<THREE.Group>(null);
  const eye = state === "breached" ? "#ff3b3b" : state === "defended" ? "#3ee08f" : "#36c5ff";
  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    if (head.current) head.current.rotation.y = state === "idle" ? Math.sin(t * 0.9) * 0.7 : state === "breached" ? Math.sin(t * 30) * 0.15 : 0;
    if (body.current) body.current.position.y = state === "moving" ? Math.abs(Math.sin(t * 14)) * 0.12 : Math.sin(t * 2) * 0.06;
    if (tip.current) tip.current.color.set(Math.sin(t * 6) > 0 ? eye : "#222");
    if (wheels.current && state === "moving") wheels.current.children.forEach((w) => (w.rotation.y += dt * 10));
  });
  return (
    <group>
      <group ref={wheels}>
        {[-1.3, 1.3].map((z) => (
          <mesh key={z} position={[0, 0.7, z]} rotation-x={Math.PI / 2} castShadow>
            <cylinderGeometry args={[0.7, 0.7, 0.5, 20]} />
            <meshStandardMaterial color="#111" roughness={0.9} />
          </mesh>
        ))}
      </group>
      <group ref={body}>
        <RoundedBox args={[2.6, 2, 2.2]} radius={0.35} position-y={2} castShadow>
          <meshStandardMaterial color={color} metalness={0.5} roughness={0.35} />
        </RoundedBox>
        <mesh position={[1.31, 2.1, 0]}>
          <boxGeometry args={[0.05, 0.6, 1.4]} />
          <meshBasicMaterial color={eye} toneMapped={false} />
        </mesh>
        <group ref={head} position-y={3.6}>
          <RoundedBox args={[1.8, 1.2, 1.8]} radius={0.3} castShadow>
            <meshStandardMaterial color="#e8ecf3" metalness={0.3} roughness={0.3} />
          </RoundedBox>
          <mesh position={[0.91, 0.05, 0]}>
            <boxGeometry args={[0.05, 0.45, 1.3]} />
            <meshBasicMaterial color={eye} toneMapped={false} />
          </mesh>
          <mesh position-y={1}>
            <cylinderGeometry args={[0.06, 0.06, 0.9, 8]} />
            <meshStandardMaterial color="#999" />
          </mesh>
          <mesh position-y={1.5}>
            <sphereGeometry args={[0.18, 12, 12]} />
            <meshBasicMaterial ref={tip} color={eye} toneMapped={false} />
          </mesh>
        </group>
        <pointLight position={[1.6, 3.6, 0]} color={eye} intensity={8} distance={10} decay={2} />
      </group>
    </group>
  );
}

/** Sparks from the breach point. */
function Sparks({ at }: { at: THREE.Vector3 }) {
  const N = 90;
  const ref = useRef<THREE.Points>(null);
  const vel = useMemo(() => Array.from({ length: N }, () => new THREE.Vector3((Math.random() - 0.5) * 14, Math.random() * 14 + 4, (Math.random() - 0.5) * 14)), []);
  const pos = useMemo(() => new Float32Array(N * 3), []);
  const age = useRef(0);
  useFrame((_, dt) => {
    age.current += dt;
    const k = age.current % 1.6;
    for (let i = 0; i < N; i++) {
      const v = vel[i]!;
      pos[i * 3] = v.x * k;
      pos[i * 3 + 1] = Math.max(0, 1 + v.y * k - 12 * k * k);
      pos[i * 3 + 2] = v.z * k;
    }
    if (ref.current) {
      ref.current.geometry.attributes.position!.needsUpdate = true;
      (ref.current.material as THREE.PointsMaterial).opacity = 1 - k / 1.6;
    }
  });
  return (
    <points ref={ref} position={at}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[pos, 3]} />
      </bufferGeometry>
      <pointsMaterial color="#ffb347" size={0.5} transparent toneMapped={false} />
    </points>
  );
}

type Run = { p: Point; heading: number; done: boolean; driven: Point[] };

/** The robot being attacked: drives the referee's route, then shows the outcome. */
function ActiveRobot({ path, trace, runKey, color, onMove }: { path: Point[]; trace: Trace | null; runKey: number; color: string; onMove: (r: Run) => void }) {
  const g = useRef<THREE.Group>(null);
  const total = useMemo(() => pathLength(path), [path]);
  const start = useRef(0);
  const [state, setState] = useState<"idle" | "moving" | "breached" | "defended">("idle");
  const lastEmit = useRef(0);

  useEffect(() => {
    start.current = performance.now();
    setState(trace ? "moving" : "idle");
    // Start where the route starts (set once per run, not as a prop that re-renders reset).
    g.current?.position.copy(to3(path[0]!));
  }, [runKey, trace, path]);

  useFrame(() => {
    const d = trace ? Math.min(total, ((performance.now() - start.current) / 1000) * SPEED) : 0;
    const { p, heading } = pointAt(path, d);
    const done = !trace || d >= total;
    if (g.current) {
      g.current.position.lerp(to3(p), 0.5);
      const want = -heading;
      let diff = want - g.current.rotation.y;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      g.current.rotation.y += diff * 0.2;
    }
    if (trace && done && state === "moving") setState(trace.breached ? "breached" : "defended");
    const now = performance.now();
    if (now - lastEmit.current > 60 || (done && state === "moving")) {
      lastEmit.current = now;
      const driven: Point[] = [path[0]!];
      let left = d;
      for (let i = 1; i < path.length && left > 0; i++) {
        const seg = Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y);
        driven.push(left >= seg ? path[i]! : pointAt([path[i - 1]!, path[i]!], left).p);
        left -= seg;
      }
      onMove({ p, heading, done, driven });
    }
  });

  return (
    <group ref={g}>
      <group scale={1.6}>
        <RobotModel color={color} state={state} />
      </group>
      {state !== "moving" && state !== "idle" && (
        <Html position={[0, 11, 0]} center zIndexRange={[100, 50]}>
          <div className={`a3-verdict ${state}`}>{state === "breached" ? "BREACHED" : "DEFENDED"}</div>
        </Html>
      )}
    </group>
  );
}

/** Other robots in the arena, parked in bays along the bottom wall, idling. */
const ParkedRobots = memo(function ParkedRobots({ robots }: { robots: Robot[] }) {
  const bays = [
    { x: 4, y: 95 },
    { x: 24, y: 95 },
    { x: 40, y: 95 },
    { x: 60, y: 95 },
    { x: 76, y: 95 },
    { x: 96, y: 95 },
  ];
  return (
    <>
      {robots.slice(0, bays.length).map((r, i) => (
        <group key={r.id} position={to3(bays[i]!)} rotation-y={Math.PI / 2} scale={0.8}>
          <RobotModel color={robotColor(r.id)} state="idle" />
          <Html position={[0, 6.5, 0]} center distanceFactor={95} zIndexRange={[10, 0]}>
            <a className="a3-tag robot" href={`#/robots/${r.id}`}>
              {r.name}
            </a>
          </Html>
        </group>
      ))}
    </>
  );
});

const COLORS = ["#d99a00", "#36c5ff", "#a78bfa", "#3ee08f", "#ff7ab6", "#f97316"];
export const robotColor = (id: number) => COLORS[(id - 1) % COLORS.length]!;

// -------------------------------------------------------------------- camera

export type CamMode = "overview" | "follow" | "top";

/** Overview position that fits the 100 x 100 facility in a canvas of this aspect ratio. */
function overviewPos(aspect: number): [number, number, number] {
  const k = aspect < 1 ? 1 / aspect : 1;
  return [0, 96 * k, 92 * k];
}

function CameraRig({ mode, target }: { mode: CamMode; target: React.MutableRefObject<Point> }) {
  const { camera, size } = useThree();
  const want = useRef(new THREE.Vector3());
  const look = useRef(new THREE.Vector3());
  useFrame(() => {
    const t = target.current;
    if (mode === "follow") {
      want.current.set(t.x - 50 - 14, 26, t.y - 50 + 26);
      look.current.set(t.x - 50, 2, t.y - 50);
    } else if (mode === "top") {
      want.current.set(0, 125, 0.01);
      look.current.set(0, 0, 0);
    } else return;
    camera.position.lerp(want.current, 0.06);
    camera.lookAt(look.current);
  });
  useEffect(() => {
    if (mode === "overview") {
      camera.position.set(...overviewPos(size.width / Math.max(1, size.height)));
      camera.lookAt(0, 0, 0);
    }
  }, [mode, camera, size.width, size.height]);
  return null;
}

// --------------------------------------------------------------------- scene

export default function Arena3D({
  arena,
  trace,
  runKey,
  robotId,
  others = [],
}: {
  arena: Arena;
  trace: Trace | null;
  runKey: number;
  robotId?: number;
  others?: Robot[];
}) {
  const path = useMemo(() => trace?.path ?? [arena.start], [trace, arena.start]);
  const [mode, setMode] = useState<CamMode>("overview");
  const [run, setRun] = useState<Run>({ p: path[0]!, heading: 0, done: true, driven: [] });
  const target = useRef<Point>(path[0]!);
  const low = useMemo(lowEnd, []);
  const parked = useMemo(() => others.filter((r) => r.id !== robotId), [others, robotId]);
  const hotZone = useMemo(() => {
    if (!trace?.breached || !run.done) return null;
    return arena.redZones.find((z) => z.name === trace.zone || z.id === trace.zone)?.id ?? arena.redZones[0]?.id ?? null;
  }, [trace, run.done, arena]);

  // A new attack: watch it up close.
  useEffect(() => {
    if (trace) setMode((m) => (m === "top" ? m : "follow"));
  }, [runKey, trace]);

  const onMove = (r: Run) => {
    target.current = r.p;
    setRun(r);
  };

  const breachAt = trace?.breached && run.done && trace.contact ? to3(trace.contact, 0.5) : null;

  return (
    <div className={`arena3d ${breachAt ? "alarm" : ""}`}>
      <Canvas
        shadows={!low}
        dpr={low ? 1 : [1, 1.75]}
        camera={{ position: [0, 96, 92], fov: 45, near: 0.5, far: 600 }}
        gl={{ antialias: !low }}
      >
        <color attach="background" args={["#07080c"]} />
        <fog attach="fog" args={["#07080c", 140, 260]} />
        <hemisphereLight args={["#9fb4ff", "#0a0b10", 0.55]} />
        <ambientLight intensity={0.25} />
        <directionalLight
          position={[40, 80, 30]}
          intensity={1.5}
          castShadow={!low}
          shadow-mapSize={[1024, 1024]}
          shadow-camera-left={-60}
          shadow-camera-right={60}
          shadow-camera-top={60}
          shadow-camera-bottom={-60}
        />
        <Facility arena={arena} hotZone={hotZone} labels={mode !== "follow"} />
        <ParkedRobots robots={parked} />
        {trace && <Line points={path.map((p) => to3(p, 0.15))} color="#5b6375" lineWidth={1.2} dashed dashSize={1} gapSize={1} />}
        {run.driven.length > 1 && (
          <Line points={run.driven.map((p) => to3(p, 0.2))} color={breachAt ? "#ff3b3b" : "#ffc94a"} lineWidth={3.5} toneMapped={false} />
        )}
        <ActiveRobot path={path} trace={trace} runKey={runKey} color={robotColor(robotId ?? 1)} onMove={onMove} />
        {breachAt && <Sparks key={runKey} at={breachAt} />}
        {breachAt && <pointLight position={[breachAt.x, 6, breachAt.z]} color="#ff2a2a" intensity={120} distance={40} decay={2} />}
        <CameraRig mode={mode} target={target} />
        {mode === "overview" && <OrbitControls target={[0, 0, 0]} maxPolarAngle={Math.PI / 2.15} minDistance={30} maxDistance={220} enablePan={false} />}
      </Canvas>
      <div className="a3-cams" role="group" aria-label="Camera">
        {(["overview", "follow", "top"] as const).map((m) => (
          <button key={m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
            {m === "overview" ? "Overview" : m === "follow" ? "Follow robot" : "Top-down"}
          </button>
        ))}
      </div>
      {mode === "overview" && <p className="a3-hint">Drag to rotate · scroll to zoom</p>}
    </div>
  );
}
