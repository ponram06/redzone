import { KIND_LABEL, robotKind } from "./arena3d/RobotKinds";

/**
 * A flat drawing of a robot's body (the same kind as its 3D model), in its own colour:
 * guard = patrol pod, hauler = transport robot with a crate, titan = tracked robot with arms,
 * courier = six-wheel delivery robot.
 */
export function RobotIcon({ id, color, size = 64, className = "" }: { id: number; color: string; size?: number; className?: string }) {
  const kind = robotKind(id);
  const ink = "#0d0f14";
  const shell = "#eef1f5";
  const eye = "#36c5ff";
  return (
    <svg className={`robot-icon ${className}`} width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={KIND_LABEL[kind]}>
      {kind === "guard" && (
        <g>
          <rect x="29" y="5" width="6" height="5" rx="1.5" fill={color} />
          <path d="M20 26c0-9 5-15 12-15s12 6 12 15v6H20z" fill={shell} />
          <rect x="19" y="23" width="26" height="7" rx="3.5" fill={ink} />
          <rect x="34" y="25.5" width="8" height="2" rx="1" fill={eye} />
          <path d="M19 32h26l3 16H16z" fill={shell} />
          <rect x="17" y="38" width="30" height="4" fill={color} />
          <path d="M14 48h36l2 7H12z" fill={color} />
          <rect x="12" y="55" width="40" height="3" rx="1.5" fill={ink} />
        </g>
      )}
      {kind === "hauler" && (
        <g>
          <rect x="10" y="16" width="3" height="22" fill={ink} />
          <rect x="8" y="12" width="7" height="5" rx="2" fill={ink} />
          <circle cx="11.5" cy="11" r="1.6" fill={eye} />
          <rect x="22" y="14" width="28" height="20" rx="1.5" fill="#b88a52" />
          <rect x="22" y="22" width="28" height="3" fill="#d8c39b" />
          <rect x="18" y="34" width="36" height="3" rx="1" fill="#9aa3b2" />
          <rect x="6" y="37" width="52" height="12" rx="4" fill={color} />
          <rect x="6" y="42" width="52" height="2" fill="#f5c518" />
          <rect x="54" y="39" width="3" height="5" rx="1" fill={eye} />
          <circle cx="16" cy="52" r="5" fill={ink} />
          <circle cx="48" cy="52" r="5" fill={ink} />
        </g>
      )}
      {kind === "titan" && (
        <g>
          <rect x="31" y="4" width="2" height="7" fill="#9aa3b2" />
          <circle cx="32" cy="4" r="2" fill="#ff5a5a" />
          <rect x="22" y="10" width="20" height="13" rx="5" fill={shell} />
          <rect x="26" y="14" width="12" height="5" rx="2.5" fill={ink} />
          <rect x="28" y="15.5" width="8" height="2" rx="1" fill={eye} />
          <rect x="18" y="25" width="28" height="19" rx="5" fill={color} />
          <rect x="29" y="29" width="6" height="8" rx="1.5" fill={eye} opacity="0.9" />
          <rect x="9" y="26" width="7" height="16" rx="3.5" fill={color} />
          <rect x="48" y="26" width="7" height="16" rx="3.5" fill={color} />
          <path d="M8 42h9l-2 5H10zM47 42h9l-2 5h-5z" fill="#9aa3b2" />
          <rect x="14" y="46" width="36" height="12" rx="6" fill={ink} />
          <circle cx="21" cy="52" r="3" fill="#9aa3b2" />
          <circle cx="32" cy="52" r="3" fill="#9aa3b2" />
          <circle cx="43" cy="52" r="3" fill="#9aa3b2" />
        </g>
      )}
      {kind === "courier" && (
        <g>
          <rect x="15" y="8" width="1.6" height="22" fill="#9aa3b2" />
          <path d="M16.6 8h12l-3 4 3 4h-12z" fill={color} />
          <rect x="10" y="26" width="44" height="7" rx="3.5" fill={color} />
          <rect x="10" y="31" width="44" height="16" rx="5" fill={shell} />
          <rect x="44" y="34" width="9" height="8" rx="2" fill={ink} />
          <rect x="46" y="36.5" width="2" height="3" rx="1" fill={eye} />
          <rect x="50" y="36.5" width="2" height="3" rx="1" fill={eye} />
          <circle cx="17" cy="51" r="5" fill={ink} />
          <circle cx="32" cy="51" r="5" fill={ink} />
          <circle cx="47" cy="51" r="5" fill={ink} />
        </g>
      )}
    </svg>
  );
}
