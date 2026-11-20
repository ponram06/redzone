import { RoundedBox } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

/**
 * Every robot gets its own body, modelled on a real kind of plant robot, so players can tell them
 * apart at a glance (in the arena and in the chooser):
 *   guard   - a security patrol pod (tall rounded shell, visor band, beacon on top)
 *   hauler  - a warehouse transport robot (low chassis, lift deck with a crate, lidar mast)
 *   titan   - a tracked industrial service robot with two arms (the biggest)
 *   courier - a six-wheeled delivery robot (cargo box, antenna flag)
 *   dog     - a four-legged inspection robot (legs trot while it moves)
 *   waiter  - a hotel service robot (round base, trays with cups, a face screen)
 * The owner picks the kind and colour (see robotLook.ts).
 */
export type { RobotKind } from "../../robotLook";
export type RState = "idle" | "moving" | "breached" | "defended";

/** Status light colour: blue while working, red on a breach, green when it held. */
export function statusColor(state: RState): THREE.Color {
  return state === "breached" ? new THREE.Color(4, 0.3, 0.3) : state === "defended" ? new THREE.Color(0.4, 3, 1.2) : new THREE.Color(0.4, 1.8, 3.2);
}
const statusHex = (state: RState) => (state === "breached" ? "#ff3b3b" : state === "defended" ? "#3ee08f" : "#36c5ff");

/** A headlight that follows the robot (only on the robot being played). */
function Headlamp({ y, state }: { y: number; state: RState }) {
  const spot = useRef<THREE.SpotLight>(null);
  const target = useMemo(() => new THREE.Object3D(), []);
  useEffect(() => {
    if (spot.current) spot.current.target = target;
  }, [target]);
  return (
    <>
      <spotLight ref={spot} position={[1, y, 0]} angle={0.55} penumbra={0.8} intensity={220} distance={40} decay={2} color={statusHex(state)} />
      <primitive object={target} position={[12, 0, 0]} />
    </>
  );
}

/** Common motion: a little bob while driving, a shake on a breach. */
function useBody(state: RState) {
  const body = useRef<THREE.Group>(null);
  const wheels = useRef<THREE.Group>(null);
  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    if (body.current) {
      body.current.position.y = state === "moving" ? Math.abs(Math.sin(t * 14)) * 0.05 : 0;
      body.current.rotation.x = state === "breached" ? Math.sin(t * 40) * 0.04 : 0;
    }
    if (wheels.current && state === "moving") wheels.current.children.forEach((w) => (w.rotation.y -= dt * 10));
  });
  return { body, wheels };
}

const white = <meshPhysicalMaterial color="#eef1f5" metalness={0.15} roughness={0.3} clearcoat={1} clearcoatRoughness={0.2} />;
const rubber = <meshStandardMaterial color="#15171b" roughness={0.9} />;
const glass = <meshPhysicalMaterial color="#05070a" metalness={0.2} roughness={0.05} clearcoat={1} />;
const steel = <meshStandardMaterial color="#9aa3b2" metalness={0.9} roughness={0.25} />;

// ------------------------------------------------------------------ guard

export function GuardBot({ color, state, lamp }: { color: string; state: RState; lamp?: boolean }) {
  const { body } = useBody(state);
  const beacon = useRef<THREE.Group>(null);
  const flash = useRef<THREE.MeshBasicMaterial>(null);
  const eye = statusColor(state);
  useFrame(({ clock }, dt) => {
    if (beacon.current) beacon.current.rotation.y += dt * (state === "breached" ? 14 : 4);
    if (flash.current) flash.current.color.copy(Math.sin(clock.elapsedTime * 8) > 0 ? eye : new THREE.Color("#3a2a00"));
  });
  const paint = <meshPhysicalMaterial color={color} metalness={0.4} roughness={0.3} clearcoat={1} />;
  return (
    <group ref={body}>
      {/* wide skirt that hides the wheels */}
      <mesh position-y={0.55} castShadow>
        <cylinderGeometry args={[1.55, 1.7, 1.1, 32]} />
        {paint}
      </mesh>
      <mesh position-y={0.06}>
        <cylinderGeometry args={[1.62, 1.62, 0.12, 32]} />
        {rubber}
      </mesh>
      {/* egg shaped shell */}
      <mesh position-y={2.4} castShadow>
        <cylinderGeometry args={[1.15, 1.5, 2.6, 32]} />
        {white}
      </mesh>
      <mesh position-y={3.7} scale={[1, 0.75, 1]} castShadow>
        <sphereGeometry args={[1.15, 32, 20, 0, Math.PI * 2, 0, Math.PI / 2]} />
        {white}
      </mesh>
      {/* tinted visor band with a status strip */}
      <mesh position-y={3.15}>
        <cylinderGeometry args={[1.2, 1.24, 0.6, 32, 1, true]} />
        {glass}
      </mesh>
      <mesh position={[1.22, 3.15, 0]}>
        <boxGeometry args={[0.05, 0.12, 0.9]} />
        <meshBasicMaterial color={eye} toneMapped={false} />
      </mesh>
      {/* colour band and side cameras */}
      <mesh position-y={1.6}>
        <cylinderGeometry args={[1.47, 1.5, 0.3, 32]} />
        {paint}
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[0.3, 2.3, s * 1.32]} rotation-x={Math.PI / 2}>
          <cylinderGeometry args={[0.18, 0.18, 0.2, 12]} />
          {glass}
        </mesh>
      ))}
      {/* rotating beacon */}
      <mesh position-y={4.62}>
        <cylinderGeometry args={[0.32, 0.38, 0.2, 16]} />
        {steel}
      </mesh>
      <group ref={beacon} position-y={4.95}>
        <mesh>
          <cylinderGeometry args={[0.3, 0.3, 0.45, 16]} />
          <meshBasicMaterial ref={flash} color={eye} toneMapped={false} transparent opacity={0.9} />
        </mesh>
      </group>
      {lamp && <Headlamp y={3.2} state={state} />}
    </group>
  );
}

// ------------------------------------------------------------------ hauler

export function HaulerBot({ color, state, lamp }: { color: string; state: RState; lamp?: boolean }) {
  const { body, wheels } = useBody(state);
  const lidar = useRef<THREE.Mesh>(null);
  const deck = useRef<THREE.Group>(null);
  const eye = statusColor(state);
  useFrame(({ clock }, dt) => {
    if (lidar.current) lidar.current.rotation.y += dt * 9;
    // the lift deck rises while carrying, drops the crate on a breach
    if (deck.current) {
      const want = state === "breached" ? 0.1 : 0.45 + Math.sin(clock.elapsedTime * 1.5) * 0.04;
      deck.current.position.y += (want - deck.current.position.y) * 0.1;
    }
  });
  const paint = <meshPhysicalMaterial color={color} metalness={0.35} roughness={0.35} clearcoat={0.8} />;
  return (
    <group ref={body}>
      <group ref={wheels}>
        {[-1.4, 1.4].flatMap((x) =>
          [-1.25, 1.25].map((z) => (
            <mesh key={`${x}${z}`} position={[x, 0.42, z]} rotation-x={Math.PI / 2}>
              <cylinderGeometry args={[0.42, 0.42, 0.4, 18]} />
              {rubber}
            </mesh>
          )),
        )}
      </group>
      {/* low chassis */}
      <RoundedBox args={[4.4, 1.0, 2.8]} radius={0.25} smoothness={4} position-y={1.0} castShadow>
        {paint}
      </RoundedBox>
      {/* black bumpers front and back */}
      {[-2.25, 2.25].map((x) => (
        <RoundedBox key={x} args={[0.3, 0.55, 2.7]} radius={0.12} position={[x, 0.85, 0]}>
          {rubber}
        </RoundedBox>
      ))}
      {/* front light bar */}
      <mesh position={[2.41, 1.15, 0]}>
        <boxGeometry args={[0.04, 0.12, 2.0]} />
        <meshBasicMaterial color={eye} toneMapped={false} />
      </mesh>
      {/* safety stripe */}
      {[-1, 1].map((s) => (
        <mesh key={s} position={[0, 1.0, s * 1.41]}>
          <boxGeometry args={[3.6, 0.18, 0.02]} />
          <meshStandardMaterial color="#f5c518" roughness={0.5} />
        </mesh>
      ))}
      {/* lift deck with a cardboard crate */}
      <group ref={deck} position-y={0.45}>
        <mesh position-y={1.1} castShadow>
          <boxGeometry args={[3.2, 0.15, 2.4]} />
          {steel}
        </mesh>
        <mesh position={[0.2, 1.95, 0]} castShadow>
          <boxGeometry args={[2.2, 1.55, 1.8]} />
          <meshStandardMaterial color="#b88a52" roughness={0.9} />
        </mesh>
        <mesh position={[0.2, 1.95, 0]}>
          <boxGeometry args={[2.22, 0.18, 1.82]} />
          <meshStandardMaterial color="#d8c39b" roughness={0.8} />
        </mesh>
      </group>
      {/* lidar mast at the back */}
      <mesh position={[-1.85, 2.2, 0]} castShadow>
        <boxGeometry args={[0.3, 2.4, 0.3]} />
        <meshStandardMaterial color="#23262d" metalness={0.6} roughness={0.4} />
      </mesh>
      <mesh ref={lidar} position={[-1.85, 3.55, 0]}>
        <cylinderGeometry args={[0.32, 0.32, 0.35, 16]} />
        <meshStandardMaterial color="#111" metalness={0.5} roughness={0.2} />
      </mesh>
      <mesh position={[-1.85, 3.8, 0]}>
        <sphereGeometry args={[0.12, 10, 10]} />
        <meshBasicMaterial color={eye} toneMapped={false} />
      </mesh>
      {lamp && <Headlamp y={1.6} state={state} />}
    </group>
  );
}

// ------------------------------------------------------------------ courier

export function CourierBot({ color, state, lamp }: { color: string; state: RState; lamp?: boolean }) {
  const { body, wheels } = useBody(state);
  const flag = useRef<THREE.Mesh>(null);
  const lid = useRef<THREE.Group>(null);
  const eye = statusColor(state);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (flag.current) flag.current.rotation.y = Math.sin(t * (state === "moving" ? 9 : 2)) * 0.35;
    // the lid pops open when it is tricked
    if (lid.current) lid.current.rotation.z += ((state === "breached" ? 1.1 : 0) - lid.current.rotation.z) * 0.12;
  });
  const paint = <meshPhysicalMaterial color={color} metalness={0.3} roughness={0.35} clearcoat={0.8} />;
  return (
    <group ref={body}>
      <group ref={wheels}>
        {[-1.1, 0, 1.1].flatMap((x) =>
          [-1.05, 1.05].map((z) => (
            <mesh key={`${x}${z}`} position={[x, 0.42, z]} rotation-x={Math.PI / 2}>
              <cylinderGeometry args={[0.42, 0.42, 0.32, 18]} />
              {rubber}
            </mesh>
          )),
        )}
      </group>
      {/* cargo body */}
      <RoundedBox args={[3.0, 1.7, 2.0]} radius={0.4} smoothness={5} position-y={1.55} castShadow>
        {white}
      </RoundedBox>
      {/* coloured lid, hinged at the back */}
      <group ref={lid} position={[-1.3, 2.45, 0]}>
        <RoundedBox args={[2.9, 0.35, 2.02]} radius={0.15} smoothness={4} position={[1.3, 0, 0]} castShadow>
          {paint}
        </RoundedBox>
      </group>
      {/* sensor face with two eyes */}
      <RoundedBox args={[0.2, 0.7, 1.5]} radius={0.08} position={[1.48, 1.7, 0]}>
        {glass}
      </RoundedBox>
      {[-0.35, 0.35].map((z) => (
        <mesh key={z} position={[1.6, 1.75, z]}>
          <boxGeometry args={[0.03, 0.12, 0.3]} />
          <meshBasicMaterial color={eye} toneMapped={false} />
        </mesh>
      ))}
      {/* antenna with a flag so people see it coming */}
      <mesh position={[-1.1, 3.9, 0.7]}>
        <cylinderGeometry args={[0.035, 0.035, 2.8, 6]} />
        {steel}
      </mesh>
      <mesh ref={flag} position={[-1.1, 5.0, 0.7]}>
        <planeGeometry args={[0.9, 0.55]} />
        <meshStandardMaterial color={color} side={THREE.DoubleSide} emissive={color} emissiveIntensity={0.4} />
      </mesh>
      {lamp && <Headlamp y={1.8} state={state} />}
    </group>
  );
}

// ------------------------------------------------------------------ robot dog

/** A four-legged inspection robot: legs walk while it moves, it crouches on a breach. */
export function DogBot({ color, state, lamp }: { color: string; state: RState; lamp?: boolean }) {
  const root = useRef<THREE.Group>(null);
  const legs = useRef<(THREE.Group | null)[]>([]);
  const head = useRef<THREE.Group>(null);
  const eye = statusColor(state);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const walk = state === "moving";
    legs.current.forEach((leg, i) => {
      if (!leg) return;
      // diagonal pairs move together, like a trot
      const phase = i === 0 || i === 3 ? 0 : Math.PI;
      leg.rotation.z = walk ? Math.sin(t * 11 + phase) * 0.45 : 0;
    });
    if (root.current) {
      const crouch = state === "breached" ? -0.7 : 0;
      root.current.position.y += (crouch + (walk ? Math.abs(Math.sin(t * 11)) * 0.12 : Math.sin(t * 2) * 0.04) - root.current.position.y) * 0.2;
      root.current.rotation.x = state === "breached" ? Math.sin(t * 35) * 0.05 : 0;
    }
    if (head.current) head.current.rotation.y = state === "idle" ? Math.sin(t * 0.8) * 0.5 : 0;
  });
  const paint = <meshPhysicalMaterial color={color} metalness={0.35} roughness={0.35} clearcoat={0.8} />;
  const joint = <meshStandardMaterial color="#1c1f24" metalness={0.6} roughness={0.4} />;
  const corners: [number, number][] = [
    [1.35, 0.75],
    [1.35, -0.75],
    [-1.35, 0.75],
    [-1.35, -0.75],
  ];
  return (
    <group ref={root}>
      {/* legs: hip joint, upper leg, knee, lower leg, foot */}
      {corners.map(([x, z], i) => (
        <group key={i} ref={(g) => void (legs.current[i] = g)} position={[x, 2.15, z]}>
          <mesh>
            <sphereGeometry args={[0.32, 14, 12]} />
            {joint}
          </mesh>
          <mesh position={[0.18, -0.55, 0]} rotation-z={0.35}>
            <boxGeometry args={[0.32, 1.1, 0.3]} />
            {paint}
          </mesh>
          <mesh position={[0.36, -1.1, 0]}>
            <sphereGeometry args={[0.2, 12, 10]} />
            {joint}
          </mesh>
          <mesh position={[0.18, -1.6, 0]} rotation-z={-0.35}>
            <boxGeometry args={[0.2, 1.05, 0.2]} />
            {joint}
          </mesh>
          <mesh position={[0.02, -2.08, 0]}>
            <sphereGeometry args={[0.17, 12, 10]} />
            {rubber}
          </mesh>
        </group>
      ))}
      {/* body */}
      <RoundedBox args={[3.4, 0.85, 1.55]} radius={0.3} smoothness={4} position-y={2.45} castShadow>
        {paint}
      </RoundedBox>
      <RoundedBox args={[2.4, 0.3, 1.2]} radius={0.12} position-y={2.98} castShadow>
        <meshStandardMaterial color="#23262d" metalness={0.5} roughness={0.5} />
      </RoundedBox>
      {/* sensor head at the front */}
      <group ref={head} position={[1.85, 2.5, 0]}>
        <RoundedBox args={[0.55, 0.6, 1.2]} radius={0.15}>
          {white}
        </RoundedBox>
        <mesh position={[0.29, 0.02, 0]}>
          <boxGeometry args={[0.04, 0.3, 0.9]} />
          {glass}
        </mesh>
        {[-0.25, 0.25].map((z) => (
          <mesh key={z} position={[0.32, 0.03, z]}>
            <boxGeometry args={[0.02, 0.08, 0.18]} />
            <meshBasicMaterial color={eye} toneMapped={false} />
          </mesh>
        ))}
      </group>
      {/* status light on the back */}
      <mesh position={[-1.2, 3.2, 0]}>
        <sphereGeometry args={[0.12, 10, 10]} />
        <meshBasicMaterial color={eye} toneMapped={false} />
      </mesh>
      {lamp && <Headlamp y={2.6} state={state} />}
    </group>
  );
}

// ------------------------------------------------------------------ hotel service robot

/** A tray-carrying service robot (hotels, restaurants): round base, trays, a face on a screen. */
export function WaiterBot({ color, state, lamp }: { color: string; state: RState; lamp?: boolean }) {
  const { body } = useBody(state);
  const face = useRef<THREE.Group>(null);
  const cups = useRef<THREE.Group>(null);
  const eye = statusColor(state);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (face.current) face.current.rotation.y = state === "idle" ? Math.sin(t * 0.7) * 0.4 : 0;
    // the cups slide off the tray when it is tricked
    if (cups.current) {
      const want = state === "breached" ? 0.9 : 0;
      cups.current.position.z += (want - cups.current.position.z) * 0.08;
      cups.current.rotation.x += ((state === "breached" ? 0.9 : 0) - cups.current.rotation.x) * 0.08;
    }
  });
  const paint = <meshPhysicalMaterial color={color} metalness={0.3} roughness={0.35} clearcoat={0.9} />;
  const tray = (y: number) => (
    <mesh position-y={y} castShadow>
      <cylinderGeometry args={[1.15, 1.15, 0.12, 28]} />
      <meshStandardMaterial color="#d9dee6" metalness={0.4} roughness={0.35} />
    </mesh>
  );
  return (
    <group ref={body}>
      {/* round base with a coloured bumper */}
      <mesh position-y={0.45} castShadow>
        <cylinderGeometry args={[1.3, 1.4, 0.9, 32]} />
        {white}
      </mesh>
      <mesh position-y={0.2}>
        <torusGeometry args={[1.38, 0.12, 10, 36]} />
        {paint}
      </mesh>
      {/* slim column between the trays */}
      <mesh position-y={2.3} castShadow>
        <cylinderGeometry args={[0.32, 0.4, 3.4, 16]} />
        {paint}
      </mesh>
      {tray(1.4)}
      {tray(2.6)}
      {/* a cup, a plate and a bottle on the top tray */}
      <group ref={cups} position-y={2.66}>
        <mesh position={[0.5, 0.28, 0.4]}>
          <cylinderGeometry args={[0.2, 0.16, 0.45, 12]} />
          <meshStandardMaterial color="#f4f1ea" roughness={0.3} />
        </mesh>
        <mesh position={[-0.4, 0.05, -0.3]}>
          <cylinderGeometry args={[0.45, 0.45, 0.06, 20]} />
          <meshStandardMaterial color="#f4f1ea" roughness={0.3} />
        </mesh>
        <mesh position={[0.1, 0.4, -0.55]}>
          <cylinderGeometry args={[0.13, 0.15, 0.75, 10]} />
          <meshStandardMaterial color="#2f7a4a" roughness={0.2} metalness={0.2} transparent opacity={0.85} />
        </mesh>
      </group>
      {/* head with a face screen */}
      <group ref={face} position-y={4.35}>
        <RoundedBox args={[1.1, 0.95, 1.3]} radius={0.35} smoothness={5} castShadow>
          {white}
        </RoundedBox>
        <RoundedBox args={[0.1, 0.62, 0.95]} radius={0.08} position={[0.52, 0, 0]}>
          {glass}
        </RoundedBox>
        {[-0.22, 0.22].map((z) => (
          <mesh key={z} position={[0.58, 0.08, z]}>
            <boxGeometry args={[0.02, 0.16, 0.16]} />
            <meshBasicMaterial color={eye} toneMapped={false} />
          </mesh>
        ))}
        <mesh position={[0.58, -0.14, 0]}>
          <boxGeometry args={[0.02, 0.04, 0.26]} />
          <meshBasicMaterial color={eye} toneMapped={false} />
        </mesh>
        {/* little ears */}
        {[-0.45, 0.45].map((z) => (
          <mesh key={z} position={[0, 0.55, z]} rotation-x={z > 0 ? -0.3 : 0.3}>
            <coneGeometry args={[0.18, 0.35, 12]} />
            {paint}
          </mesh>
        ))}
      </group>
      {lamp && <Headlamp y={4.3} state={state} />}
    </group>
  );
}
