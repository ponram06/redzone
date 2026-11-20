import { memo, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { Arena, Point } from "../../api";

/**
 * The things a real plant floor has, so the arena reads like a place and not a game board:
 * pipe runs on the walls, yellow bollards and DANGER signs at every restricted area, fire
 * extinguisher stations, drums, pallets and a parked forklift. All static; repeated parts are
 * instanced so this costs a handful of draw calls.
 */
export const PlantDetails = memo(function PlantDetails({ arena }: { arena: Arena }) {
  const ox = arena.width / 2;
  const oz = arena.height / 2;
  const w = (p: Point, y = 0) => new THREE.Vector3(p.x - ox, y, p.y - oz);
  return (
    <group>
      <PipeRuns ox={ox} oz={oz} />
      <Bollards arena={arena} at={w} />
      {arena.redZones.map((z) => (
        <DangerSign key={z.id} poly={z.polygon} name={z.name} corridorY={arena.start.y} at={w} />
      ))}
      <FireStations ox={ox} oz={oz} />
      {arena.width >= 150 && (
        <>
          <Drums at={w({ x: 124, y: 34 })} />
          <Pallets at={w({ x: 116, y: 95 })} />
          <Forklift at={w({ x: 100, y: 90 })} turn={-0.3} />
        </>
      )}
    </group>
  );
});

// ------------------------------------------------------------------ helpers

type Inst = { p: THREE.Vector3; r?: THREE.Euler; s?: THREE.Vector3 };

/** One instanced mesh from a list of placements. */
function Instances({ items, geo, mat, shadow = false }: { items: Inst[]; geo: THREE.BufferGeometry; mat: THREE.Material; shadow?: boolean }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    items.forEach((it, i) => {
      q.setFromEuler(it.r ?? new THREE.Euler());
      m.compose(it.p, q, it.s ?? new THREE.Vector3(1, 1, 1));
      ref.current!.setMatrixAt(i, m);
    });
    ref.current!.instanceMatrix.needsUpdate = true;
    ref.current!.computeBoundingSphere();
  }, [items]);
  return <instancedMesh ref={ref} args={[geo, mat, items.length]} castShadow={shadow} receiveShadow />;
}

function centroid(poly: Point[]): Point {
  return { x: poly.reduce((s, p) => s + p.x, 0) / poly.length, y: poly.reduce((s, p) => s + p.y, 0) / poly.length };
}

// ------------------------------------------------------------------ pipes

const PIPES = [
  { y: 5.0, r: 0.3, color: "#d9a400" }, // gas
  { y: 5.9, r: 0.26, color: "#2f6fd6" }, // water
  { y: 6.8, r: 0.38, color: "#b9c0ca" }, // insulated steam
];

/** Three colour-coded pipes along the long walls, on brackets every 8 units. */
function PipeRuns({ ox, oz }: { ox: number; oz: number }) {
  const len = ox * 2 - 2;
  const brackets = useMemo(() => {
    const out: Inst[] = [];
    for (let x = -ox + 4; x <= ox - 4; x += 8)
      for (const z of [-oz + 0.9, oz - 0.9]) out.push({ p: new THREE.Vector3(x, 5.9, z), s: new THREE.Vector3(0.25, 2.6, 1.0) });
    return out;
  }, [ox, oz]);
  const box = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  const bracketMat = useMemo(() => new THREE.MeshStandardMaterial({ color: "#3b4250", metalness: 0.8, roughness: 0.4 }), []);
  return (
    <group>
      {[-oz + 1.0, oz - 1.0].map((z) =>
        PIPES.map((p) => (
          <mesh key={`${z}-${p.y}`} position={[0, p.y, z]} rotation-z={Math.PI / 2}>
            <cylinderGeometry args={[p.r, p.r, len, 14]} />
            <meshStandardMaterial color={p.color} metalness={0.55} roughness={0.35} />
          </mesh>
        )),
      )}
      <Instances items={brackets} geo={box} mat={bracketMat} />
    </group>
  );
}

// ------------------------------------------------------------------ bollards

/** Yellow steel posts with a black band, just outside every restricted area's corners and edges. */
function Bollards({ arena, at }: { arena: Arena; at: (p: Point, y?: number) => THREE.Vector3 }) {
  const items = useMemo(() => {
    const out: Inst[] = [];
    for (const z of arena.redZones) {
      const c = centroid(z.polygon);
      const n = z.polygon.length;
      for (let i = 0; i < n; i++) {
        const a = z.polygon[i]!;
        const b = z.polygon[(i + 1) % n]!;
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const steps = Math.max(1, Math.round(len / 6));
        for (let k = 0; k < steps; k++) {
          const p = { x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps };
          const d = Math.hypot(p.x - c.x, p.y - c.y) || 1;
          const out1 = { x: p.x + ((p.x - c.x) / d) * 1.4, y: p.y + ((p.y - c.y) / d) * 1.4 };
          out.push({ p: at(out1, 0.75) });
        }
      }
    }
    return out;
  }, [arena, at]);
  const bands = useMemo(() => items.map((i) => ({ p: i.p.clone().setY(1.15) })), [items]);
  const post = useMemo(() => new THREE.CylinderGeometry(0.32, 0.32, 1.5, 12), []);
  const band = useMemo(() => new THREE.CylinderGeometry(0.335, 0.335, 0.22, 12), []);
  const yellow = useMemo(() => new THREE.MeshStandardMaterial({ color: "#f2c200", roughness: 0.45, metalness: 0.3 }), []);
  const black = useMemo(() => new THREE.MeshStandardMaterial({ color: "#121212", roughness: 0.6 }), []);
  return (
    <group>
      <Instances items={items} geo={post} mat={yellow} shadow />
      <Instances items={bands} geo={band} mat={black} />
    </group>
  );
}

// ------------------------------------------------------------------ signs

function signTexture(name: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 320;
  const x = c.getContext("2d")!;
  x.fillStyle = "#f4f4f2";
  x.fillRect(0, 0, 512, 320);
  x.fillStyle = "#d61f1f";
  x.fillRect(0, 0, 512, 110);
  x.fillStyle = "#fff";
  x.font = "bold 78px Arial, sans-serif";
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillText("DANGER", 256, 58);
  x.fillStyle = "#111";
  let size = 46;
  x.font = `bold ${size}px Arial, sans-serif`;
  while (x.measureText(name.toUpperCase()).width > 470 && size > 24) x.font = `bold ${(size -= 2)}px Arial, sans-serif`;
  x.fillText(name.toUpperCase(), 256, 170);
  x.font = "bold 30px Arial, sans-serif";
  x.fillText("AUTHORISED PERSONNEL ONLY", 256, 250);
  x.strokeStyle = "#111";
  x.lineWidth = 8;
  x.strokeRect(4, 4, 504, 312);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** A DANGER sign on a post, on the side of the restricted area that faces the main corridor. */
function DangerSign({ poly, name, corridorY, at }: { poly: Point[]; name: string; corridorY: number; at: (p: Point, y?: number) => THREE.Vector3 }) {
  const tex = useMemo(() => signTexture(name), [name]);
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const facesDown = corridorY > Math.max(...ys) || Math.abs(corridorY - Math.max(...ys)) < Math.abs(corridorY - Math.min(...ys));
  const y = facesDown ? Math.max(...ys) + 2.2 : Math.min(...ys) - 2.2;
  const pos = at({ x: cx + 3.5, y });
  return (
    <group position={pos} rotation-y={facesDown ? 0 : Math.PI}>
      <mesh position-y={1.7} castShadow>
        <cylinderGeometry args={[0.08, 0.08, 3.4, 8]} />
        <meshStandardMaterial color="#5b6270" metalness={0.8} roughness={0.4} />
      </mesh>
      <mesh position={[0, 3.6, 0.1]}>
        <planeGeometry args={[3.2, 2]} />
        <meshStandardMaterial map={tex} roughness={0.6} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

// ------------------------------------------------------------------ fire stations

/** Red extinguisher cabinets on the long walls, every 40 units. */
function FireStations({ ox, oz }: { ox: number; oz: number }) {
  const spots = useMemo(() => {
    const out: { x: number; z: number; face: number }[] = [];
    for (let x = -ox + 20; x < ox - 10; x += 40) {
      out.push({ x, z: -oz + 0.6, face: 0 });
      out.push({ x: x + 20, z: oz - 0.6, face: Math.PI });
    }
    return out;
  }, [ox, oz]);
  return (
    <group>
      {spots.map((s, i) => (
        <group key={i} position={[s.x, 0, s.z]} rotation-y={s.face}>
          <mesh position={[0, 2.2, 0.25]}>
            <boxGeometry args={[1.2, 1.9, 0.5]} />
            <meshStandardMaterial color="#c81e1e" roughness={0.45} metalness={0.2} />
          </mesh>
          <mesh position={[0, 2.2, 0.51]}>
            <planeGeometry args={[0.9, 1.5]} />
            <meshStandardMaterial color="#e8ecf2" roughness={0.2} metalness={0.1} transparent opacity={0.35} />
          </mesh>
          <mesh position={[0, 0.65, 0.45]} castShadow>
            <cylinderGeometry args={[0.28, 0.28, 1.3, 14]} />
            <meshStandardMaterial color="#d62020" roughness={0.35} metalness={0.3} />
          </mesh>
          <mesh position={[0, 3.6, 0.05]}>
            <boxGeometry args={[0.9, 0.5, 0.06]} />
            <meshBasicMaterial color={[2.2, 0.25, 0.25]} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// ------------------------------------------------------------------ drums, pallets, forklift

function Drums({ at }: { at: THREE.Vector3 }) {
  const items = useMemo(() => {
    const out: Inst[] = [];
    [
      [0, 0],
      [1.4, 0],
      [2.8, 0],
      [0.7, 1.25],
      [2.1, 1.25],
      [0, 2.5],
    ].forEach(([x, z]) => out.push({ p: new THREE.Vector3(at.x + x!, 1.0, at.z + z!) }));
    return out;
  }, [at]);
  const geo = useMemo(() => new THREE.CylinderGeometry(0.62, 0.62, 2.0, 18), []);
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color: "#1f4f9c", roughness: 0.5, metalness: 0.5 }), []);
  return (
    <group>
      <Instances items={items} geo={geo} mat={mat} shadow />
      {/* spill tray */}
      <mesh position={[at.x + 1.4, 0.08, at.z + 1.25]}>
        <boxGeometry args={[5, 0.16, 4.4]} />
        <meshStandardMaterial color="#e0b400" roughness={0.6} />
      </mesh>
    </group>
  );
}

function Pallets({ at }: { at: THREE.Vector3 }) {
  return (
    <group position={at}>
      {[0, 3.6, 7.2].map((x, i) => (
        <group key={x} position-x={x}>
          <mesh position-y={0.2}>
            <boxGeometry args={[3.0, 0.4, 2.4]} />
            <meshStandardMaterial color="#9b7546" roughness={0.95} />
          </mesh>
          <mesh position-y={0.4 + (i === 1 ? 1.4 : 0.9)} castShadow>
            <boxGeometry args={[2.8, i === 1 ? 2.8 : 1.8, 2.2]} />
            <meshStandardMaterial color={i === 2 ? "#cfd6df" : "#b88a52"} roughness={0.9} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function Forklift({ at, turn }: { at: THREE.Vector3; turn: number }) {
  const yellow = <meshStandardMaterial color="#f2b300" roughness={0.45} metalness={0.3} />;
  const dark = <meshStandardMaterial color="#1c1f24" roughness={0.7} metalness={0.4} />;
  return (
    <group position={at} rotation-y={turn}>
      <mesh position={[-0.4, 1.3, 0]} castShadow>
        <boxGeometry args={[3.2, 1.6, 2.2]} />
        {yellow}
      </mesh>
      {/* counterweight */}
      <mesh position={[-2.1, 1.2, 0]} castShadow>
        <boxGeometry args={[0.8, 1.6, 2.1]} />
        {dark}
      </mesh>
      {/* overhead guard */}
      {[-1, 1].flatMap((s) =>
        [-1.4, 0.6].map((x) => (
          <mesh key={`${s}${x}`} position={[x, 3.0, s * 0.95]}>
            <boxGeometry args={[0.12, 2.0, 0.12]} />
            {dark}
          </mesh>
        )),
      )}
      <mesh position={[-0.4, 4.0, 0]}>
        <boxGeometry args={[2.2, 0.12, 2.0]} />
        {dark}
      </mesh>
      {/* seat */}
      <mesh position={[-0.6, 2.4, 0]}>
        <boxGeometry args={[0.8, 0.6, 1.0]} />
        {dark}
      </mesh>
      {/* mast and forks */}
      <mesh position={[1.35, 2.4, 0]} castShadow>
        <boxGeometry args={[0.25, 4.2, 1.6]} />
        {dark}
      </mesh>
      {[-0.5, 0.5].map((z) => (
        <mesh key={z} position={[2.3, 0.35, z]}>
          <boxGeometry args={[1.9, 0.1, 0.25]} />
          <meshStandardMaterial color="#8a9099" metalness={0.9} roughness={0.3} />
        </mesh>
      ))}
      {/* wheels */}
      {[-1.4, 0.8].flatMap((x) =>
        [-1.05, 1.05].map((z) => (
          <mesh key={`${x}${z}`} position={[x, 0.5, z]} rotation-x={Math.PI / 2}>
            <cylinderGeometry args={[0.5, 0.5, 0.4, 16]} />
            {dark}
          </mesh>
        )),
      )}
    </group>
  );
}
