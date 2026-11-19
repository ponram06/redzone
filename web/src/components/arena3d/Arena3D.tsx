import { Environment, Html, Lightformer, Line, MeshReflectorMaterial, OrbitControls, RoundedBox, Sparkles } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, Noise, SMAA, ToneMapping, Vignette } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { Arena, Point, Robot, Trace } from "../../api";
import { describeRound, metres } from "../../outcome";

/**
 * RedZone's facility in 3D. Same data as the 2D map: the arena layout from the referee and the
 * route from its replay. The referee's 2D simulation decides every result; this only shows it.
 * Arena units: x right, y down, 0..100. Scene: X = x - 50, Z = y - 50, Y up.
 */

const SPEED = 22; // arena units per second
const WALL_H = 6;
const OUTER_H = 8;
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

// ----------------------------------------------------------------- textures

function canvasTexture(size: number, draw: (x: CanvasRenderingContext2D, s: number) => void, repeat: [number, number], srgb = true) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  draw(c.getContext("2d")!, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(...repeat);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function speckle(x: CanvasRenderingContext2D, s: number, n: number, light: string, dark: string) {
  for (let i = 0; i < n; i++) {
    x.fillStyle = Math.random() > 0.5 ? light : dark;
    x.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
}

/** Industrial floor plates: 2 x 2 panels per tile with seams, bolts and wear. */
const floorTex = () =>
  canvasTexture(
    512,
    (x, s) => {
      x.fillStyle = "#1a1e26";
      x.fillRect(0, 0, s, s);
      speckle(x, s, 9000, "rgba(255,255,255,0.035)", "rgba(0,0,0,0.25)");
      const h = s / 2;
      for (const [px, py] of [
        [0, 0],
        [h, 0],
        [0, h],
        [h, h],
      ]) {
        const g = x.createLinearGradient(px!, py!, px! + h, py! + h);
        g.addColorStop(0, "rgba(255,255,255,0.04)");
        g.addColorStop(1, "rgba(0,0,0,0.12)");
        x.fillStyle = g;
        x.fillRect(px! + 3, py! + 3, h - 6, h - 6);
        x.fillStyle = "#3a4150";
        for (const [bx, by] of [
          [14, 14],
          [h - 14, 14],
          [14, h - 14],
          [h - 14, h - 14],
        ])
          x.beginPath(), x.arc(px! + bx!, py! + by!, 3, 0, 7), x.fill();
      }
      x.strokeStyle = "#07080b";
      x.lineWidth = 5;
      x.strokeRect(0, 0, s, s);
      x.beginPath();
      x.moveTo(h, 0);
      x.lineTo(h, s);
      x.moveTo(0, h);
      x.lineTo(s, h);
      x.stroke();
    },
    [10, 10],
  );

/** Concrete wall panels with vertical seams. */
const wallTex = () =>
  canvasTexture(
    256,
    (x, s) => {
      x.fillStyle = "#4a5160";
      x.fillRect(0, 0, s, s);
      speckle(x, s, 6000, "rgba(255,255,255,0.05)", "rgba(0,0,0,0.18)");
      const g = x.createLinearGradient(0, 0, 0, s);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, "rgba(0,0,0,0.35)");
      x.fillStyle = g;
      x.fillRect(0, 0, s, s);
      x.fillStyle = "#262b35";
      x.fillRect(0, 0, 4, s);
      x.fillRect(0, s * 0.82, s, 6);
    },
    [1, 1],
  );

/** Yellow and black hazard tape. */
const tapeTex = () =>
  canvasTexture(
    128,
    (x, s) => {
      x.fillStyle = "#111";
      x.fillRect(0, 0, s, s);
      x.fillStyle = "#f5c518";
      for (let i = -s; i < s * 2; i += 32) {
        x.beginPath();
        x.moveTo(i, s);
        x.lineTo(i + 16, s);
        x.lineTo(i + 16 + s, 0);
        x.lineTo(i + s, 0);
        x.fill();
      }
    },
    [1, 1],
  );

/** Red hazard hatching for the zone floors. */
const hatchTex = () =>
  canvasTexture(
    128,
    (x, s) => {
      x.fillStyle = "#2a0709";
      x.fillRect(0, 0, s, s);
      x.strokeStyle = "#c81e1e";
      x.lineWidth = 14;
      for (let i = -s; i < s * 2; i += 40) {
        x.beginPath();
        x.moveTo(i, s);
        x.lineTo(i + s, 0);
        x.stroke();
      }
      speckle(x, s, 1500, "rgba(255,255,255,0.05)", "rgba(0,0,0,0.3)");
    },
    [0.2, 0.2],
  );

// ------------------------------------------------------------------ facility

function Wall({ cx, cz, w, d, h, tex }: { cx: number; cz: number; w: number; d: number; h: number; tex: THREE.Texture }) {
  const len = Math.max(w, d);
  const t = useMemo(() => {
    const c = tex.clone();
    c.repeat.set(Math.max(1, Math.round(len / 6)), 1);
    c.needsUpdate = true;
    return c;
  }, [tex, len]);
  const along = w >= d;
  return (
    <group position={[cx, 0, cz]}>
      <mesh position-y={h / 2} castShadow receiveShadow>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial map={t} roughness={0.75} metalness={0.15} />
      </mesh>
      {/* steel base trim */}
      <mesh position-y={0.35}>
        <boxGeometry args={[w + 0.25, 0.7, d + 0.25]} />
        <meshStandardMaterial color="#1b1f27" metalness={0.8} roughness={0.35} />
      </mesh>
      {/* cap */}
      <mesh position-y={h + 0.12} castShadow>
        <boxGeometry args={[w + 0.35, 0.24, d + 0.35]} />
        <meshStandardMaterial color="#2c323e" metalness={0.85} roughness={0.3} />
      </mesh>
      {/* LED strips on both faces */}
      {[-1, 1].map((s) => (
        <mesh key={s} position={along ? [0, h - 0.7, (s * (d + 0.06)) / 2] : [(s * (w + 0.06)) / 2, h - 0.7, 0]}>
          <boxGeometry args={along ? [w - 0.6, 0.12, 0.04] : [0.04, 0.12, d - 0.6]} />
          <meshBasicMaterial color={[0.4, 1.6, 2.4]} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

const Facility = memo(function Facility({ arena, hotZone, labels, low }: { arena: Arena; hotZone: string | null; labels: boolean; low: boolean }) {
  const zoneGeo = useMemo(() => arena.redZones.map((z) => ({ z, g: floorShape(z.polygon) })), [arena]);
  const tex = useMemo(() => ({ floor: floorTex(), wall: wallTex(), tape: tapeTex(), hatch: hatchTex() }), []);

  return (
    <group>
      {/* floor: polished steel plates with live reflections */}
      <mesh rotation-x={-Math.PI / 2} receiveShadow position-y={-0.01}>
        <planeGeometry args={[100, 100]} />
        {low ? (
          <meshStandardMaterial map={tex.floor} roughness={0.6} metalness={0.4} />
        ) : (
          <MeshReflectorMaterial
            map={tex.floor}
            blur={[400, 120]}
            resolution={1024}
            mixBlur={1}
            mixStrength={5}
            mixContrast={1.1}
            roughness={0.65}
            depthScale={1.1}
            minDepthThreshold={0.4}
            maxDepthThreshold={1.3}
            metalness={0.55}
            mirror={0}
          />
        )}
      </mesh>
      {/* the hall around the facility */}
      <mesh rotation-x={-Math.PI / 2} position-y={-0.05}>
        <planeGeometry args={[400, 400]} />
        <meshStandardMaterial color="#07080b" roughness={1} />
      </mesh>

      {/* outer walls, with steel ribs */}
      {[
        [0, -50.75, 101.5, 1.5],
        [0, 50.75, 101.5, 1.5],
        [-50.75, 0, 1.5, 101.5],
        [50.75, 0, 1.5, 101.5],
      ].map(([x, z, w, d], i) => (
        <Wall key={i} cx={x!} cz={z!} w={w!} d={d!} h={OUTER_H} tex={tex.wall} />
      ))}
      {Array.from({ length: 11 }, (_, i) => -50 + i * 10).flatMap((v) =>
        [
          [v, -49.7],
          [v, 49.7],
          [-49.7, v],
          [49.7, v],
        ].map(([x, z], j) => (
          <mesh key={`${v}-${j}`} position={[x!, OUTER_H / 2, z!]} castShadow>
            <boxGeometry args={[0.8, OUTER_H, 0.8]} />
            <meshStandardMaterial color="#232833" metalness={0.9} roughness={0.3} />
          </mesh>
        )),
      )}

      {/* inner walls */}
      {arena.walls.map((w, i) => {
        const b = bounds(w);
        return <Wall key={i} cx={(b.x0 + b.x1) / 2 - 50} cz={(b.y0 + b.y1) / 2 - 50} w={b.x1 - b.x0} d={b.y1 - b.y0} h={WALL_H} tex={tex.wall} />;
      })}

      {/* flood lights in the corners */}
      {[
        [-46, -46],
        [46, -46],
        [-46, 46],
        [46, 46],
      ].map(([x, z], i) => (
        <FloodLight key={i} x={x!} z={z!} />
      ))}

      {zoneGeo.map(({ z, g }) => (
        <Zone key={z.id} id={z.id} name={z.name} poly={z.polygon} geo={g} hatch={tex.hatch} tape={tex.tape} hot={hotZone === z.id} />
      ))}

      {arena.places.map((p) => (
        <Place key={p.id} id={p.id} name={p.name} at={p.at} restricted={arena.redZones.some((z) => z.id === p.id)} label={labels} />
      ))}
    </group>
  );
});

function FloodLight({ x, z }: { x: number; z: number }) {
  const light = useRef<THREE.SpotLight>(null);
  useEffect(() => {
    if (!light.current) return;
    light.current.target.position.set(x * 0.2, 0, z * 0.2);
    light.current.target.updateMatrixWorld();
  }, [x, z]);
  const yaw = Math.atan2(-x, -z);
  return (
    <group>
      <mesh position={[x, 7, z]} castShadow>
        <cylinderGeometry args={[0.35, 0.5, 14, 12]} />
        <meshStandardMaterial color="#1f242d" metalness={0.9} roughness={0.35} />
      </mesh>
      <group position={[x, 14, z]} rotation={[0.7, yaw, 0]}>
        <mesh>
          <boxGeometry args={[3, 1.2, 1]} />
          <meshStandardMaterial color="#2b313c" metalness={0.8} roughness={0.3} />
        </mesh>
        <mesh position-z={0.52}>
          <planeGeometry args={[2.6, 0.9]} />
          <meshBasicMaterial color={[3, 3, 2.6]} toneMapped={false} />
        </mesh>
      </group>
      <spotLight ref={light} position={[x, 14, z]} angle={0.75} penumbra={0.9} intensity={2600} distance={140} decay={2} color="#dfe8ff" />
    </group>
  );
}

// --------------------------------------------------------------- red zones

const barrierShader = {
  uniforms: { uTime: { value: 0 }, uHot: { value: 0 }, uColor: { value: new THREE.Color("#ff2a2a") } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform float uTime; uniform float uHot; uniform vec3 uColor;
    varying vec2 vUv;
    void main() {
      float stripes = step(0.55, fract(vUv.x * 0.6 + vUv.y * 1.2 - uTime * (0.4 + uHot * 1.6)));
      float fade = pow(1.0 - vUv.y, 1.8);
      float scan = 1.0 - smoothstep(0.0, 0.035, abs(fract(vUv.y - uTime * 0.35) - 0.5));
      float base = smoothstep(0.88, 1.0, 1.0 - vUv.y);
      float a = fade * (0.16 + stripes * 0.14 + uHot * 0.35) + base * 0.8 + scan * 0.25 * (1.0 - vUv.y);
      gl_FragColor = vec4(uColor * (1.6 + uHot * 2.5), a);
    }`,
};

/** A loop of quads standing on the polygon's edges: uv.x runs along the edge, uv.y up. */
function edgeWall(poly: Point[], h: number) {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let run = 0;
  poly.forEach((a, i) => {
    const b = poly[(i + 1) % poly.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const k = pos.length / 3;
    pos.push(a.x - 50, 0, a.y - 50, b.x - 50, 0, b.y - 50, b.x - 50, h, b.y - 50, a.x - 50, h, a.y - 50);
    uv.push(run / 3, 0, (run + len) / 3, 0, (run + len) / 3, 1, run / 3, 1);
    idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
    run += len;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Flat tape along the polygon's edges. */
function edgeTape(poly: Point[], w: number) {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  poly.forEach((a, i) => {
    const b = poly[(i + 1) % poly.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = (-(b.y - a.y) / len) * (w / 2);
    const nz = ((b.x - a.x) / len) * (w / 2);
    const k = pos.length / 3;
    const y = 0.05;
    pos.push(a.x - 50 - nx, y, a.y - 50 - nz, b.x - 50 - nx, y, b.y - 50 - nz, b.x - 50 + nx, y, b.y - 50 + nz, a.x - 50 + nx, y, a.y - 50 + nz);
    uv.push(0, 0, len / w / 2, 0, len / w / 2, 1, 0, 1);
    idx.push(k, k + 2, k + 1, k, k + 3, k + 2);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function Zone({
  id,
  name,
  poly,
  geo,
  hatch,
  tape,
  hot,
}: {
  id: string;
  name: string;
  poly: Point[];
  geo: THREE.ShapeGeometry;
  hatch: THREE.Texture;
  tape: THREE.Texture;
  hot: boolean;
}) {
  const barrier = useMemo(() => edgeWall(poly, 5), [poly]);
  const tapeGeo = useMemo(() => edgeTape(poly, 1), [poly]);
  const mat = useMemo(() => new THREE.ShaderMaterial({
        ...barrierShader,
        uniforms: THREE.UniformsUtils.clone(barrierShader.uniforms),
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }), []);
  useFrame(({ clock }, dt) => {
    mat.uniforms.uTime!.value = clock.elapsedTime;
    const h = mat.uniforms.uHot!;
    h.value += ((hot ? 1 : 0) - h.value) * Math.min(1, dt * 4);
  });
  const c = centroid(poly);
  return (
    <group>
      <mesh geometry={geo} position-y={0.03} receiveShadow>
        <meshStandardMaterial map={hatch} emissive="#ff1010" emissiveIntensity={0.18} roughness={0.8} />
      </mesh>
      <mesh geometry={tapeGeo}>
        <meshStandardMaterial map={tape} roughness={0.6} />
      </mesh>
      <mesh geometry={barrier} material={mat} />
      {poly.map((p, i) => (
        <Beacon key={i} at={p} hot={hot} phase={i * 1.3} />
      ))}
      {id === "reactor" ? <ReactorCore at={c} hot={hot} /> : <ChemTanks at={c} />}
      <Html position={[c.x - 50, 9, c.y - 50]} center distanceFactor={95} zIndexRange={[10, 0]}>
        <div className={`a3-tag danger ${hot ? "hot" : ""}`}>⚠ {name}</div>
      </Html>
    </group>
  );
}

/** A rotating warning beacon on a post. */
function Beacon({ at, hot, phase }: { at: Point; hot: boolean; phase: number }) {
  const spin = useRef<THREE.Group>(null);
  const dome = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(({ clock }, dt) => {
    if (spin.current) spin.current.rotation.y += dt * (hot ? 9 : 2.5);
    if (dome.current) {
      const f = 0.6 + 0.4 * Math.sin(clock.elapsedTime * (hot ? 14 : 3) + phase);
      dome.current.color.setRGB(3 * f + (hot ? 2 : 0), 0.25 * f, 0.15 * f);
    }
  });
  return (
    <group position={[at.x - 50, 0, at.y - 50]}>
      <mesh position-y={1.4} castShadow>
        <cylinderGeometry args={[0.18, 0.25, 2.8, 10]} />
        <meshStandardMaterial color="#2a2f38" metalness={0.8} roughness={0.35} />
      </mesh>
      <mesh position-y={3}>
        <sphereGeometry args={[0.42, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshBasicMaterial ref={dome} color={[3, 0.2, 0.1]} toneMapped={false} />
      </mesh>
      <group ref={spin} position-y={3.15}>
        {[0, Math.PI].map((r) => (
          <mesh key={r} rotation={[0, r, Math.PI / 2]} position={[Math.cos(r) * 2.2, 0, -Math.sin(r) * 2.2]}>
            <coneGeometry args={[0.9, 4.4, 16, 1, true]} />
            <meshBasicMaterial color="#ff2a1a" transparent opacity={hot ? 0.22 : 0.1} depthWrite={false} blending={THREE.AdditiveBlending} side={THREE.DoubleSide} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

function ReactorCore({ at, hot }: { at: Point; hot: boolean }) {
  const core = useRef<THREE.MeshStandardMaterial>(null);
  const crystal = useRef<THREE.Mesh>(null);
  const rings = useRef<THREE.Group>(null);
  const light = useRef<THREE.PointLight>(null);
  const [arcs, setArcs] = useState<THREE.Vector3[][]>([]);
  const nextArc = useRef(0);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const pulse = 1 + Math.sin(t * 3) * 0.35 + (hot ? Math.sin(t * 25) * 0.5 : 0);
    if (core.current) core.current.emissiveIntensity = 3.2 * pulse;
    if (light.current) light.current.intensity = 140 * pulse;
    if (crystal.current) (crystal.current.rotation.y = t * 1.4), (crystal.current.rotation.x = t * 0.7);
    if (rings.current) rings.current.children.forEach((r, i) => (r.rotation.z = t * (i ? -1.1 : 0.8)));
    if (t > nextArc.current) {
      nextArc.current = t + 0.08 + Math.random() * 0.25;
      setArcs(
        Array.from({ length: hot ? 4 : 2 }, () => {
          const a = Math.random() * Math.PI * 2;
          const y0 = 1.5 + Math.random() * 3;
          return Array.from({ length: 7 }, (_, k) => {
            const r = 1.1 + (k / 6) * 1.5;
            return new THREE.Vector3(Math.cos(a + (Math.random() - 0.5) * 0.4) * r, y0 + (Math.random() - 0.5) * 0.8, Math.sin(a + (Math.random() - 0.5) * 0.4) * r);
          });
        }),
      );
    }
  });
  const pipes = useMemo(
    () =>
      [0, 1, 2, 3].map((i) => {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const c = new THREE.CatmullRomCurve3([
          new THREE.Vector3(Math.cos(a) * 2.3, 5.6, Math.sin(a) * 2.3),
          new THREE.Vector3(Math.cos(a) * 4.2, 5.2, Math.sin(a) * 4.2),
          new THREE.Vector3(Math.cos(a) * 5.2, 2.5, Math.sin(a) * 5.2),
          new THREE.Vector3(Math.cos(a) * 5.4, 0.3, Math.sin(a) * 5.4),
        ]);
        return new THREE.TubeGeometry(c, 24, 0.32, 10, false);
      }),
    [],
  );
  return (
    <group position={[at.x - 50, 0, at.y - 50]}>
      {/* platform with ribs */}
      <mesh position-y={0.35} castShadow receiveShadow>
        <cylinderGeometry args={[4.4, 4.8, 0.7, 40]} />
        <meshStandardMaterial color="#20252e" metalness={0.85} roughness={0.3} />
      </mesh>
      {Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * Math.PI * 2;
        return (
          <mesh key={i} position={[Math.cos(a) * 4.5, 0.9, Math.sin(a) * 4.5]} rotation-y={-a}>
            <boxGeometry args={[0.5, 0.5, 0.25]} />
            <meshStandardMaterial color="#3a414e" metalness={0.9} roughness={0.25} />
          </mesh>
        );
      })}
      {/* plasma core and spinning crystal */}
      <mesh position-y={3.3}>
        <cylinderGeometry args={[1.05, 1.05, 4.6, 32]} />
        <meshStandardMaterial ref={core} color="#ff5a2e" emissive="#ff3300" emissiveIntensity={3.2} toneMapped={false} />
      </mesh>
      <mesh ref={crystal} position-y={3.3}>
        <icosahedronGeometry args={[0.75, 0]} />
        <meshBasicMaterial color={[6, 3, 1.5]} toneMapped={false} />
      </mesh>
      {/* glass containment */}
      <mesh position-y={3.3}>
        <cylinderGeometry args={[2.2, 2.2, 4.8, 40, 1, true]} />
        <meshPhysicalMaterial color="#ffd0c0" transparent opacity={0.18} roughness={0.05} metalness={0} clearcoat={1} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      {/* caps */}
      {[0.95, 5.75].map((y) => (
        <mesh key={y} position-y={y} castShadow>
          <cylinderGeometry args={[2.6, 2.6, 0.5, 40]} />
          <meshStandardMaterial color="#2e3440" metalness={0.9} roughness={0.25} />
        </mesh>
      ))}
      <group ref={rings}>
        {[2, 4.6].map((y) => (
          <mesh key={y} position-y={y} rotation-x={Math.PI / 2}>
            <torusGeometry args={[2.45, 0.12, 10, 64]} />
            <meshBasicMaterial color={[4, 1.4, 0.6]} toneMapped={false} />
          </mesh>
        ))}
      </group>
      {pipes.map((g, i) => (
        <mesh key={i} geometry={g} castShadow>
          <meshStandardMaterial color="#5a6272" metalness={0.9} roughness={0.25} />
        </mesh>
      ))}
      {arcs.map((pts, i) => (
        <Line key={i} points={pts} color="#ffd2a0" lineWidth={1.6} toneMapped={false} />
      ))}
      <pointLight ref={light} position-y={4} color="#ff4a1a" intensity={140} distance={30} decay={2} />
    </group>
  );
}

function ChemTanks({ at }: { at: Point }) {
  const puddle = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(({ clock }) => {
    if (puddle.current) puddle.current.opacity = 0.55 + Math.sin(clock.elapsedTime * 2.2) * 0.15;
  });
  const tanks: [number, number][] = [
    [-3.2, -2.2],
    [2.8, -2.6],
    [0, 2.8],
  ];
  const pipes = useMemo(
    () =>
      tanks.map(([x, z], i) => {
        const [x2, z2] = tanks[(i + 1) % tanks.length]!;
        const c = new THREE.CatmullRomCurve3([new THREE.Vector3(x, 3.2, z), new THREE.Vector3((x + x2) / 2, 4.6, (z + z2) / 2), new THREE.Vector3(x2, 3.2, z2)]);
        return new THREE.TubeGeometry(c, 16, 0.2, 8, false);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  return (
    <group position={[at.x - 50, 0, at.y - 50]}>
      {tanks.map(([x, z], i) => (
        <group key={i} position={[x, 0, z]}>
          <mesh position-y={2.4} castShadow receiveShadow>
            <capsuleGeometry args={[1.35, 2.4, 8, 24]} />
            <meshStandardMaterial color="#c3cbd6" metalness={0.75} roughness={0.25} />
          </mesh>
          <mesh position-y={2.2}>
            <cylinderGeometry args={[1.38, 1.38, 0.45, 32]} />
            <meshStandardMaterial color="#f5c518" roughness={0.5} />
          </mesh>
          <mesh position={[1.45, 1.6, 0]} rotation-z={Math.PI / 2}>
            <torusGeometry args={[0.35, 0.07, 8, 20]} />
            <meshStandardMaterial color="#d12f2f" metalness={0.5} roughness={0.4} />
          </mesh>
          {[0, 1, 2, 3].map((k) => (
            <mesh key={k} position={[Math.cos((k * Math.PI) / 2) * 1, 0.4, Math.sin((k * Math.PI) / 2) * 1]}>
              <boxGeometry args={[0.25, 0.8, 0.25]} />
              <meshStandardMaterial color="#2a2f38" metalness={0.8} />
            </mesh>
          ))}
        </group>
      ))}
      {pipes.map((g, i) => (
        <mesh key={i} geometry={g}>
          <meshStandardMaterial color="#8c96a6" metalness={0.9} roughness={0.25} />
        </mesh>
      ))}
      <mesh position={[0.4, 0.07, -0.2]} rotation-x={-Math.PI / 2}>
        <circleGeometry args={[2.2, 32]} />
        <meshBasicMaterial ref={puddle} color={[0.4, 2.2, 0.6]} transparent opacity={0.6} toneMapped={false} />
      </mesh>
      <pointLight position={[0, 1.2, 0]} color="#5dff7a" intensity={30} distance={12} decay={2} />
      <pointLight position-y={6} color="#ff3b3b" intensity={40} distance={18} decay={2} />
    </group>
  );
}

// -------------------------------------------------------------- places/props

function Place({ id, name, at, restricted, label }: { id: string; name: string; at: Point; restricted: boolean; label: boolean }) {
  if (restricted) return null;
  return (
    <group position={[at.x - 50, 0, at.y - 50]}>
      {id === "dock" && <ChargingPad />}
      {id === "lab" && <Benches color="#5fa8ff" />}
      {id === "control" && <Desks />}
      {(id === "storage" || id === "loading") && <Crates seed={id === "storage" ? 1 : 2} />}
      {id === "office" && <Benches color="#9aa4b8" />}
      {id === "exit" && <ExitDoor />}
      <mesh position-y={0.06} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[0.9, 1.2, 32]} />
        <meshBasicMaterial color={[0.6, 0.9, 1.4]} transparent opacity={0.7} toneMapped={false} />
      </mesh>
      {label && (
        <Html position={[0, 8, 0]} center distanceFactor={95} zIndexRange={[10, 0]}>
          <div className="a3-tag">{name}</div>
        </Html>
      )}
    </group>
  );
}

function ChargingPad() {
  const ring = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (ring.current) ring.current.rotation.y = clock.elapsedTime * 0.8;
  });
  return (
    <group>
      <mesh position-y={0.12} receiveShadow castShadow>
        <cylinderGeometry args={[3.2, 3.4, 0.24, 48]} />
        <meshStandardMaterial color="#1a1f29" metalness={0.85} roughness={0.3} />
      </mesh>
      <group ref={ring} position-y={0.26}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <mesh key={i} rotation={[-Math.PI / 2, 0, (i / 6) * Math.PI * 2]}>
            <ringGeometry args={[2.3, 2.8, 16, 1, 0, Math.PI / 4.5]} />
            <meshBasicMaterial color={[0.4, 2.6, 1.2]} toneMapped={false} />
          </mesh>
        ))}
      </group>
      <pointLight position-y={1.5} color="#3ee08f" intensity={20} distance={10} decay={2} />
    </group>
  );
}

function Benches({ color }: { color: string }) {
  return (
    <group position={[0, 0, -6]}>
      {[-4, 4].map((x) => (
        <group key={x} position-x={x}>
          <mesh position-y={1.1} castShadow receiveShadow>
            <boxGeometry args={[6, 0.25, 2.4]} />
            <meshStandardMaterial color="#d9dee6" metalness={0.6} roughness={0.25} />
          </mesh>
          <mesh position={[-1.2, 1.65, 0]} castShadow>
            <boxGeometry args={[1.4, 0.85, 1]} />
            <meshStandardMaterial color="#2a303b" metalness={0.6} roughness={0.35} />
          </mesh>
          <mesh position={[-0.49, 1.7, 0]} rotation-y={Math.PI / 2}>
            <planeGeometry args={[0.8, 0.5]} />
            <meshBasicMaterial color={new THREE.Color(color).multiplyScalar(2.2)} toneMapped={false} />
          </mesh>
          {[0.8, 1.6, 2.2].map((bx) => (
            <mesh key={bx} position={[bx, 1.55, 0]} castShadow>
              <cylinderGeometry args={[0.18, 0.22, 0.7, 12]} />
              <meshPhysicalMaterial color={color} transparent opacity={0.6} roughness={0.05} />
            </mesh>
          ))}
          {[-2.7, 2.7].map((lx) => (
            <mesh key={lx} position={[lx, 0.5, 0]}>
              <boxGeometry args={[0.15, 1, 2.1]} />
              <meshStandardMaterial color="#3a404c" metalness={0.8} roughness={0.3} />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

function Desks() {
  const screen = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(({ clock }) => {
    if (screen.current) screen.current.color.setRGB(0.3, 1.4 + Math.sin(clock.elapsedTime * 5) * 0.3, 2.2);
  });
  return (
    <group position={[0, 0, -5]}>
      <RoundedBox args={[14, 1.8, 2.4]} radius={0.2} position-y={0.9} castShadow receiveShadow>
        <meshStandardMaterial color="#232a36" metalness={0.7} roughness={0.3} />
      </RoundedBox>
      <mesh position={[0, 1.82, 0.4]} rotation-x={-0.4}>
        <boxGeometry args={[13, 0.06, 1.2]} />
        <meshBasicMaterial color={[0.15, 0.4, 0.6]} toneMapped={false} />
      </mesh>
      {[-4.5, 0, 4.5].map((x) => (
        <group key={x} position={[x, 3, -0.6]} rotation-x={-0.15}>
          <mesh castShadow>
            <boxGeometry args={[3.8, 2.2, 0.2]} />
            <meshStandardMaterial color="#14181f" metalness={0.6} roughness={0.4} />
          </mesh>
          <mesh position-z={0.11}>
            <planeGeometry args={[3.5, 1.9]} />
            <meshBasicMaterial ref={x === 0 ? screen : undefined} color={[0.3, 1.4, 2.2]} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function Crates({ seed }: { seed: number }) {
  const spots = seed === 1 ? [[-5, 4, 2.4], [-2.2, 5, 2], [4, 4.5, 2.6], [4, 4.5, 1.6]] : [[-5, 3, 2.2], [5, 2, 2.6], [5, 2, 1.8], [-2, 5, 1.8]];
  let stack = 0;
  return (
    <group>
      {/* pallet */}
      <mesh position={[0, 0.15, 4]} receiveShadow>
        <boxGeometry args={[13, 0.3, 4]} />
        <meshStandardMaterial color="#5b4630" roughness={0.9} />
      </mesh>
      {spots.map(([x, z, s], i) => {
        const prev = spots[i - 1];
        stack = prev && prev[0] === x && prev[1] === z ? stack + prev[2]! : 0;
        return (
          <group key={i} position={[x!, 0.3 + stack + s! / 2, z!]} rotation-y={i * 0.4}>
            <RoundedBox args={[s!, s!, s!]} radius={0.08} castShadow receiveShadow>
              <meshStandardMaterial color={i % 2 ? "#7d5e34" : "#a07a42"} roughness={0.85} />
            </RoundedBox>
            {[-1, 1].map((k) => (
              <mesh key={k} position-y={(k * s!) / 3}>
                <boxGeometry args={[s! + 0.04, 0.12, s! + 0.04]} />
                <meshStandardMaterial color="#3a3f48" metalness={0.8} roughness={0.4} />
              </mesh>
            ))}
          </group>
        );
      })}
    </group>
  );
}

function ExitDoor() {
  return (
    <group position={[4.5, 0, 0]}>
      <mesh position-y={3}>
        <boxGeometry args={[0.6, 6, 8]} />
        <meshStandardMaterial color="#1e2a26" metalness={0.7} roughness={0.35} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[-0.32, 3, s * 0.02]}>
          <boxGeometry args={[0.04, 5.6, 0.06]} />
          <meshBasicMaterial color={[0.3, 2.4, 1]} toneMapped={false} />
        </mesh>
      ))}
      <mesh position={[-0.4, 6.6, 0]}>
        <boxGeometry args={[0.2, 0.9, 3.2]} />
        <meshBasicMaterial color={[0.3, 2.6, 1.1]} toneMapped={false} />
      </mesh>
      <pointLight position={[-2, 5, 0]} color="#3ee08f" intensity={25} distance={12} decay={2} />
    </group>
  );
}

// -------------------------------------------------------------------- robots

type RState = "idle" | "moving" | "breached" | "defended";

/** A tracked service robot: treads, torso with chest light, two arms, head with a scanning visor. */
function RobotModel({ color, state, lamp = false }: { color: string; state: RState; lamp?: boolean }) {
  const head = useRef<THREE.Group>(null);
  const tip = useRef<THREE.MeshBasicMaterial>(null);
  const body = useRef<THREE.Group>(null);
  const wheels = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const eyeBar = useRef<THREE.Mesh>(null);
  const spot = useRef<THREE.SpotLight>(null);
  const spotTarget = useMemo(() => new THREE.Object3D(), []);
  const eye = state === "breached" ? new THREE.Color(4, 0.3, 0.3) : state === "defended" ? new THREE.Color(0.4, 3, 1.2) : new THREE.Color(0.4, 1.8, 3.2);
  const eyeHex = state === "breached" ? "#ff3b3b" : state === "defended" ? "#3ee08f" : "#36c5ff";

  useEffect(() => {
    if (spot.current) spot.current.target = spotTarget;
  }, [spotTarget]);

  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    if (head.current) head.current.rotation.y = state === "idle" ? Math.sin(t * 0.9) * 0.7 : state === "breached" ? Math.sin(t * 30) * 0.2 : 0;
    if (body.current) body.current.position.y = state === "moving" ? Math.abs(Math.sin(t * 12)) * 0.08 : Math.sin(t * 2) * 0.04;
    if (tip.current) tip.current.color.copy(Math.sin(t * 6) > 0 ? eye : new THREE.Color("#222"));
    if (eyeBar.current) eyeBar.current.position.z = Math.sin(t * 3) * 0.4;
    if (wheels.current && state === "moving") wheels.current.children.forEach((w) => (w.rotation.y -= dt * 8));
    const swing = state === "moving" ? Math.sin(t * 7) * 0.45 : 0;
    const want = state === "breached" ? [-2.6 + Math.sin(t * 20) * 0.3, -2.6 + Math.cos(t * 20) * 0.3] : state === "defended" ? [0, -2.3 + Math.sin(t * 6) * 0.4] : [swing, -swing];
    if (armL.current) armL.current.rotation.z += (want[0]! - armL.current.rotation.z) * 0.15;
    if (armR.current) armR.current.rotation.z += (want[1]! - armR.current.rotation.z) * 0.15;
  });

  const paint = <meshPhysicalMaterial color={color} metalness={0.55} roughness={0.28} clearcoat={1} clearcoatRoughness={0.15} />;
  const steel = <meshStandardMaterial color="#9aa3b2" metalness={0.95} roughness={0.22} />;
  const dark = <meshStandardMaterial color="#1a1d23" metalness={0.6} roughness={0.5} />;

  const arm = (side: 1 | -1, ref: React.RefObject<THREE.Group | null>) => (
    <group ref={ref} position={[0, 3.35, side * 1.3]}>
      <mesh>
        <sphereGeometry args={[0.42, 20, 16]} />
        {steel}
      </mesh>
      <mesh position-y={-0.7}>
        <capsuleGeometry args={[0.22, 0.8, 6, 12]} />
        {paint}
      </mesh>
      <mesh position-y={-1.25}>
        <sphereGeometry args={[0.24, 14, 12]} />
        {steel}
      </mesh>
      <mesh position={[0.45, -1.35, 0]} rotation-z={Math.PI / 2.4}>
        <capsuleGeometry args={[0.18, 0.7, 6, 12]} />
        {dark}
      </mesh>
      {[-0.12, 0.12].map((z) => (
        <mesh key={z} position={[0.95, -1.15, z]} rotation-z={-0.3}>
          <boxGeometry args={[0.35, 0.08, 0.08]} />
          {steel}
        </mesh>
      ))}
    </group>
  );

  return (
    <group>
      {/* treads */}
      {[-1.15, 1.15].map((z) => (
        <group key={z} position-z={z}>
          <RoundedBox args={[3.3, 0.95, 0.75]} radius={0.35} position-y={0.5} castShadow>
            <meshStandardMaterial color="#121418" roughness={0.95} />
          </RoundedBox>
          <mesh position={[0, 0.5, z > 0 ? 0.39 : -0.39]}>
            <boxGeometry args={[2.2, 0.35, 0.02]} />
            <meshStandardMaterial color={color} metalness={0.4} roughness={0.4} />
          </mesh>
        </group>
      ))}
      <group ref={wheels}>
        {[-1.15, 0, 1.15].flatMap((x) =>
          [-1.15, 1.15].map((z) => (
            <mesh key={`${x}${z}`} position={[x, 0.5, z]} rotation-x={Math.PI / 2}>
              <cylinderGeometry args={[0.36, 0.36, 0.8, 16]} />
              {steel}
            </mesh>
          )),
        )}
      </group>
      <RoundedBox args={[2.8, 0.55, 2.0]} radius={0.15} position-y={1.15} castShadow>
        {dark}
      </RoundedBox>

      <group ref={body}>
        <mesh position-y={1.65}>
          <cylinderGeometry args={[0.55, 0.7, 0.5, 20]} />
          {steel}
        </mesh>
        <RoundedBox args={[2.1, 1.85, 2.0]} radius={0.4} smoothness={6} position-y={2.75} castShadow>
          {paint}
        </RoundedBox>
        {/* chest light and vents */}
        <mesh position={[1.06, 3.0, 0]}>
          <boxGeometry args={[0.04, 0.55, 1.0]} />
          <meshBasicMaterial color={eye} toneMapped={false} />
        </mesh>
        {[2.35, 2.2, 2.05].map((y) => (
          <mesh key={y} position={[1.04, y, 0]}>
            <boxGeometry args={[0.04, 0.06, 0.9]} />
            {dark}
          </mesh>
        ))}
        {/* backpack */}
        <RoundedBox args={[0.7, 1.3, 1.4]} radius={0.15} position={[-1.2, 2.9, 0]} castShadow>
          {dark}
        </RoundedBox>
        <mesh position={[-1.56, 3.3, 0.4]}>
          <sphereGeometry args={[0.08, 8, 8]} />
          <meshBasicMaterial color={[3, 0.6, 0.2]} toneMapped={false} />
        </mesh>
        {arm(1, armL)}
        {arm(-1, armR)}
        <mesh position-y={3.85}>
          <cylinderGeometry args={[0.3, 0.38, 0.4, 16]} />
          {steel}
        </mesh>
        <group ref={head} position-y={4.55}>
          <RoundedBox args={[1.5, 1.05, 1.5]} radius={0.35} smoothness={6} castShadow>
            <meshPhysicalMaterial color="#e9edf3" metalness={0.3} roughness={0.25} clearcoat={1} />
          </RoundedBox>
          <RoundedBox args={[0.3, 0.55, 1.25]} radius={0.12} position={[0.66, 0.02, 0]}>
            <meshPhysicalMaterial color="#05070a" metalness={0.2} roughness={0.05} clearcoat={1} />
          </RoundedBox>
          <mesh ref={eyeBar} position={[0.82, 0.04, 0]}>
            <boxGeometry args={[0.03, 0.14, 0.38]} />
            <meshBasicMaterial color={eye} toneMapped={false} />
          </mesh>
          {[-0.78, 0.78].map((z) => (
            <mesh key={z} position-z={z} rotation-x={Math.PI / 2}>
              <cylinderGeometry args={[0.28, 0.28, 0.12, 20]} />
              {steel}
            </mesh>
          ))}
          <mesh position={[-0.2, 0.95, 0.4]}>
            <cylinderGeometry args={[0.04, 0.04, 0.9, 8]} />
            {steel}
          </mesh>
          <mesh position={[-0.2, 1.45, 0.4]}>
            <sphereGeometry args={[0.13, 12, 12]} />
            <meshBasicMaterial ref={tip} color={eye} toneMapped={false} />
          </mesh>
        </group>
        <pointLight position={[1.4, 3.4, 0]} color={eyeHex} intensity={6} distance={8} decay={2} />
        {lamp && (
          <>
            <spotLight ref={spot} position={[1, 4.4, 0]} angle={0.55} penumbra={0.8} intensity={260} distance={40} decay={2} color={eyeHex} />
            <primitive object={spotTarget} position={[12, 0, 0]} />
          </>
        )}
      </group>
    </group>
  );
}

/** Sparks from the breach point. */
function Sparks({ at }: { at: THREE.Vector3 }) {
  const N = 160;
  const ref = useRef<THREE.Points>(null);
  const vel = useMemo(() => Array.from({ length: N }, () => new THREE.Vector3((Math.random() - 0.5) * 16, Math.random() * 16 + 4, (Math.random() - 0.5) * 16)), []);
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
      <pointsMaterial color={[5, 2.4, 0.8]} size={0.45} transparent toneMapped={false} />
    </points>
  );
}

/** A red shock ring rolling out over the floor from the breach. */
function Shockwave({ at }: { at: THREE.Vector3 }) {
  const ref = useRef<THREE.Mesh>(null);
  const age = useRef(0);
  useFrame((_, dt) => {
    age.current += dt;
    const k = (age.current % 1.4) / 1.4;
    if (ref.current) {
      ref.current.scale.setScalar(1 + k * 22);
      (ref.current.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.8;
    }
  });
  return (
    <mesh ref={ref} position={[at.x, 0.12, at.z]} rotation-x={-Math.PI / 2}>
      <ringGeometry args={[0.8, 1, 48]} />
      <meshBasicMaterial color={[4, 0.3, 0.2]} transparent depthWrite={false} toneMapped={false} />
    </mesh>
  );
}

/** A pulsing red alarm light over the breach. */
function AlarmLight({ at }: { at: THREE.Vector3 }) {
  const ref = useRef<THREE.PointLight>(null);
  useFrame(({ clock }) => {
    if (ref.current) ref.current.intensity = 120 + Math.sin(clock.elapsedTime * 14) * 100;
  });
  return <pointLight ref={ref} position={[at.x, 7, at.z]} color="#ff2a2a" intensity={120} distance={50} decay={2} />;
}

type Run = { p: Point; heading: number; done: boolean; driven: Point[] };
type Target = { p: Point; heading: number; done: boolean };

function ActiveRobot({ path, trace, runKey, color, say, onMove }: { path: Point[]; trace: Trace | null; runKey: number; color: string; say?: string; onMove: (r: Run) => void }) {
  const g = useRef<THREE.Group>(null);
  const total = useMemo(() => pathLength(path), [path]);
  const start = useRef(0);
  const [state, setState] = useState<RState>("idle");
  const lastEmit = useRef(0);

  useEffect(() => {
    start.current = performance.now();
    setState(trace ? "moving" : "idle");
    g.current?.position.copy(to3(path[0]!));
  }, [runKey, trace, path]);

  useFrame(() => {
    const d = trace ? Math.min(total, ((performance.now() - start.current) / 1000) * SPEED) : 0;
    const { p, heading } = pointAt(path, d);
    const done = !trace || d >= total;
    if (g.current) {
      g.current.position.lerp(to3(p), 0.5);
      let diff = -heading - g.current.rotation.y;
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
      <group scale={1.5}>
        <RobotModel color={color} state={state} lamp />
      </group>
      {/* glow ring under the active robot */}
      <mesh position-y={0.08} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[3.4, 3.9, 48]} />
        <meshBasicMaterial color={state === "breached" ? [4, 0.3, 0.3] : state === "defended" ? [0.4, 3, 1.2] : [2.6, 2, 0.3]} transparent opacity={0.8} toneMapped={false} />
      </mesh>
      {say && state !== "idle" && (
        <Html position={[0, state === "moving" ? 12 : 17, 0]} center zIndexRange={[100, 50]}>
          <div className="a3-say">“{say.length > 90 ? `${say.slice(0, 88)}…` : say}”</div>
        </Html>
      )}
      {state !== "moving" && state !== "idle" && (
        <Html position={[0, 11, 0]} center zIndexRange={[100, 50]}>
          <div className={`a3-verdict ${state}`}>{state === "breached" ? "BREACHED" : "DEFENDED"}</div>
        </Html>
      )}
    </group>
  );
}

const ParkedRobots = memo(function ParkedRobots({ robots, labels }: { robots: Robot[]; labels: boolean }) {
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
        <group key={r.id} position={to3(bays[i]!)}>
          {/* bay markings */}
          <mesh position-y={0.06} rotation-x={-Math.PI / 2}>
            <ringGeometry args={[2.6, 2.9, 4, 1, Math.PI / 4]} />
            <meshBasicMaterial color={[2.2, 1.8, 0.2]} toneMapped={false} />
          </mesh>
          <group rotation-y={Math.PI / 2} scale={0.8}>
            <RobotModel color={robotColor(r.id)} state="idle" />
          </group>
          {labels && (
            <Html position={[0, 6.5, 0]} center distanceFactor={95} zIndexRange={[10, 0]}>
              <a className="a3-tag robot" href={`#/robots/${r.id}`}>
                {r.name}
              </a>
            </Html>
          )}
        </group>
      ))}
    </>
  );
});

const COLORS = ["#d99a00", "#36c5ff", "#a78bfa", "#3ee08f", "#ff7ab6", "#f97316"];
export const robotColor = (id: number) => COLORS[(id - 1) % COLORS.length]!;

// -------------------------------------------------------------------- camera

export type CamMode = "overview" | "follow" | "top";

/** Aim a little in front of the middle, so the arena sits higher on screen, clear of the message dock. */
const OVERVIEW_LOOK = new THREE.Vector3(0, 0, 14);

function overviewPos(aspect: number): THREE.Vector3 {
  // tall screens step back to fit the width; wide screens come a little closer
  const k = aspect < 1 ? 1 / aspect : aspect > 1.5 ? 0.86 : 1;
  return new THREE.Vector3(0, 84 * k, 96 * k + 14);
}

/**
 * Overview: a short fly-in, then free orbit. Follow: a chase camera behind the robot's heading.
 * Top: straight down. A breach shakes the camera.
 */
function CameraRig({ mode, target, shakeAt, onIntroDone }: { mode: CamMode; target: React.RefObject<Target>; shakeAt: React.RefObject<number>; onIntroDone: () => void }) {
  const { camera, size } = useThree();
  const want = useRef(new THREE.Vector3());
  const look = useRef(new THREE.Vector3());
  const lookNow = useRef(new THREE.Vector3());
  const heading = useRef(0);
  const intro = useRef<number | null>(performance.now());

  useFrame(() => {
    const t = target.current!;
    if (intro.current !== null && mode === "overview") {
      const k = Math.min(1, (performance.now() - intro.current) / 2600);
      const e = 1 - Math.pow(1 - k, 3);
      const a = -0.9 + e * 0.9;
      const end = overviewPos(size.width / Math.max(1, size.height));
      const r = THREE.MathUtils.lerp(70, Math.hypot(end.x, end.z), e);
      camera.position.set(Math.sin(a) * r, THREE.MathUtils.lerp(26, end.y, e), Math.cos(a) * r);
      camera.lookAt(OVERVIEW_LOOK);
      if (k >= 1) {
        intro.current = null;
        onIntroDone();
      }
      return;
    }
    intro.current = null;
    if (mode === "follow" && t.done) {
      // the round is over: circle the robot slowly, robot in the middle of the frame
      heading.current += 0.004;
      want.current.set(t.p.x - 50 - Math.cos(heading.current) * 17, 11, t.p.y - 50 - Math.sin(heading.current) * 17);
      look.current.set(t.p.x - 50, 5, t.p.y - 50);
    } else if (mode === "follow") {
      let d = t.heading - heading.current;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      heading.current += d * 0.04;
      const bx = Math.cos(heading.current);
      const bz = Math.sin(heading.current);
      want.current.set(t.p.x - 50 - bx * 20, 15, t.p.y - 50 - bz * 20);
      look.current.set(t.p.x - 50 + bx * 6, 2.5, t.p.y - 50 + bz * 6);
    } else if (mode === "top") {
      want.current.set(0, 128, 0.01);
      look.current.set(0, 0, 0);
    } else return;
    camera.position.lerp(want.current, 0.06);
    lookNow.current.lerp(look.current, 0.12);
    const since = performance.now() - (shakeAt.current ?? 0);
    if (since < 900) {
      const s = (1 - since / 900) * 0.9;
      camera.position.add(new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s));
    }
    camera.lookAt(lookNow.current);
  });

  useEffect(() => {
    if (mode === "overview" && intro.current === null) {
      camera.position.copy(overviewPos(size.width / Math.max(1, size.height)));
      camera.lookAt(OVERVIEW_LOOK);
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
  say,
}: {
  arena: Arena;
  trace: Trace | null;
  runKey: number;
  robotId?: number;
  others?: Robot[];
  say?: string;
}) {
  const path = useMemo(() => trace?.path ?? [arena.start], [trace, arena.start]);
  const [mode, setMode] = useState<CamMode>("overview");
  const [introDone, setIntroDone] = useState(false);
  const [run, setRun] = useState<Run>({ p: path[0]!, heading: 0, done: true, driven: [] });
  const target = useRef<Target>({ p: path[0]!, heading: 0, done: true });
  const shakeAt = useRef(0);
  const low = useMemo(lowEnd, []);
  const parked = useMemo(() => others.filter((r) => r.id !== robotId), [others, robotId]);
  const hotZone = useMemo(() => {
    if (!trace?.breached || !run.done) return null;
    return arena.redZones.find((z) => z.name === trace.zone || z.id === trace.zone)?.id ?? arena.redZones[0]?.id ?? null;
  }, [trace, run.done, arena]);

  useEffect(() => {
    if (trace) setMode((m) => (m === "top" ? m : "follow"));
  }, [runKey, trace]);

  const breachAt = trace?.breached && run.done && trace.contact ? to3(trace.contact, 0.5) : null;
  // On a defended round: how close the robot came to a red zone, drawn as a measured gap.
  const story = useMemo(() => (trace ? describeRound(arena, trace) : null), [arena, trace]);
  const gap = trace && run.done && story && !story.breached && !story.stayed && story.zone && story.zone.distance < 45 ? story.zone : null;
  const breachKey = breachAt ? `${runKey}` : "";
  useEffect(() => {
    if (breachKey) shakeAt.current = performance.now();
  }, [breachKey]);

  const onMove = (r: Run) => {
    target.current = { p: r.p, heading: r.heading, done: r.done };
    setRun(r);
  };

  return (
    <div className={`arena3d ${breachAt ? "alarm" : ""}`}>
      <Canvas shadows={!low} dpr={low ? 1 : [1, 1.75]} camera={{ position: [0, 26, 70], fov: 45, near: 0.5, far: 700 }} gl={{ antialias: false, powerPreference: "high-performance" }}>
        <color attach="background" args={["#050609"]} />
        <fog attach="fog" args={["#050609", 120, 300]} />
        <hemisphereLight args={["#8fa6ff", "#08090d", 0.35]} />
        <ambientLight intensity={0.12} />
        <directionalLight
          position={[40, 90, 30]}
          intensity={1.1}
          color="#cfd8ff"
          castShadow={!low}
          shadow-mapSize={[2048, 2048]}
          shadow-bias={-0.0004}
          shadow-camera-left={-62}
          shadow-camera-right={62}
          shadow-camera-top={62}
          shadow-camera-bottom={-62}
        />
        {/* soft studio reflections for the metal, built locally (no downloads) */}
        <Environment resolution={256} frames={1}>
          <Lightformer intensity={2} position={[0, 30, 0]} rotation-x={Math.PI / 2} scale={[80, 80, 1]} color="#9fb2ff" />
          <Lightformer intensity={3} position={[-40, 10, 0]} rotation-y={Math.PI / 2} scale={[60, 6, 1]} color="#36c5ff" />
          <Lightformer intensity={3} position={[40, 10, 0]} rotation-y={-Math.PI / 2} scale={[60, 6, 1]} color="#ff5a3a" />
          <Lightformer intensity={1.5} position={[0, 10, 40]} scale={[60, 8, 1]} color="#ffffff" />
        </Environment>

        <Facility arena={arena} hotZone={hotZone} labels={mode !== "follow"} low={low} />
        <ParkedRobots robots={parked} labels={mode !== "follow"} />
        {!low && <Sparkles count={160} scale={[100, 18, 100]} position-y={9} size={2.2} speed={0.25} opacity={0.35} color="#b8c8ff" />}

        {trace && <Line points={path.map((p) => to3(p, 0.15))} color="#5b6375" lineWidth={1.2} dashed dashSize={1} gapSize={1} />}
        {run.driven.length > 1 && <Line points={run.driven.map((p) => to3(p, 0.2))} color={breachAt ? new THREE.Color(4, 0.4, 0.4) : new THREE.Color(3, 2.2, 0.4)} lineWidth={4} toneMapped={false} />}
        <ActiveRobot path={path} trace={trace} runKey={runKey} color={robotColor(robotId ?? 1)} say={say} onMove={onMove} />
        {gap && (
          <group key={`gap-${runKey}`}>
            <Line points={[to3(gap.from, 0.35), to3(gap.to, 0.35)]} color={new THREE.Color(3, 0.5, 0.5)} lineWidth={2.5} dashed dashSize={0.8} gapSize={0.6} toneMapped={false} />
            <mesh position={to3(gap.to, 0.3)} rotation-x={-Math.PI / 2}>
              <ringGeometry args={[0.7, 1.1, 24]} />
              <meshBasicMaterial color={[4, 0.5, 0.5]} toneMapped={false} />
            </mesh>
            <Html position={to3({ x: (gap.from.x + gap.to.x) / 2, y: (gap.from.y + gap.to.y) / 2 }, 3)} center zIndexRange={[60, 40]}>
              <div className="a3-tag gap">
                closest: {metres(gap.distance)} from {gap.name}
              </div>
            </Html>
          </group>
        )}
        {breachAt && (
          <group key={runKey}>
            <Sparks at={breachAt} />
            <Shockwave at={breachAt} />
            <AlarmLight at={breachAt} />
          </group>
        )}

        <CameraRig mode={mode} target={target} shakeAt={shakeAt} onIntroDone={() => setIntroDone(true)} />
        {mode === "overview" && introDone && (
          <OrbitControls target={OVERVIEW_LOOK} maxPolarAngle={Math.PI / 2.2} minDistance={25} maxDistance={220} enablePan={false} enableDamping />
        )}

        {!low && (
          // multisampling > 0 renders black with three 0.187 here; SMAA smooths the edges instead
          <EffectComposer multisampling={0}>
            <Bloom mipmapBlur intensity={1.1} luminanceThreshold={1} luminanceSmoothing={0.2} radius={0.75} />
            <Vignette offset={0.25} darkness={0.75} />
            <Noise opacity={0.025} />
            <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
            <SMAA />
          </EffectComposer>
        )}
      </Canvas>
      <div className="a3-cams" role="group" aria-label="Camera">
        {(["overview", "follow", "top"] as const).map((m) => (
          <button key={m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
            {m === "overview" ? "Overview" : m === "follow" ? "Follow robot" : "Top-down"}
          </button>
        ))}
      </div>
      {mode === "overview" && introDone && <p className="a3-hint">Drag to rotate · scroll to zoom</p>}
    </div>
  );
}
