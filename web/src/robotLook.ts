/**
 * What a robot looks like: its body (what kind of real robot it is) and its colour. The owner
 * chooses both on the "Build a robot" page (signed in QoreX, with the job description); robots
 * whose owner hasn't chosen get a default from their id, so every robot always has a look.
 *
 * Kind ids are stored with the profile: never rename one (the backend keeps the same list).
 */
export const ROBOT_KINDS = [
  { id: "hauler", label: "Warehouse robot", hint: "Moves boxes and pallets between storage and loading" },
  { id: "dog", label: "Robot dog", hint: "Four-legged inspection robot for plants, sites and patrols" },
  { id: "waiter", label: "Hotel service robot", hint: "Carries trays, room service and deliveries indoors" },
  { id: "guard", label: "Security patrol robot", hint: "Patrols corridors and watches restricted areas" },
  { id: "courier", label: "Delivery robot", hint: "Six-wheeled courier for parts, mail and parcels" },
  { id: "titan", label: "Industrial robot", hint: "Tracked robot with two arms for heavy plant work" },
] as const;

export type RobotKind = (typeof ROBOT_KINDS)[number]["id"];

export const KIND_LABEL = Object.fromEntries(ROBOT_KINDS.map((k) => [k.id, k.label])) as Record<RobotKind, string>;

/** The colours an owner can pick. */
export const ROBOT_COLORS = ["#f5b400", "#36c5ff", "#a78bfa", "#3ee08f", "#ff7ab6", "#f97316", "#ef4444", "#e5e7eb"] as const;

const DEFAULT_KINDS: RobotKind[] = ["guard", "hauler", "titan", "courier"];
const DEFAULT_COLORS = ["#d99a00", "#36c5ff", "#a78bfa", "#3ee08f", "#ff7ab6", "#f97316"];

export const isKind = (k: unknown): k is RobotKind => ROBOT_KINDS.some((x) => x.id === k);

export type Look = { kind: RobotKind; color: string };

/** A robot's look: the owner's choice, or the default for its id. */
export function lookOf(r: { id: number; look?: { kind?: string | null; color?: string | null } | null }): Look {
  const kind = isKind(r.look?.kind) ? r.look!.kind : DEFAULT_KINDS[(r.id - 1) % DEFAULT_KINDS.length]!;
  const color = r.look?.color && /^#[0-9a-f]{6}$/i.test(r.look.color) ? r.look.color : DEFAULT_COLORS[(r.id - 1) % DEFAULT_COLORS.length]!;
  return { kind, color };
}
