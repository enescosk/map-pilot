import type { TelemetryState } from "../types/telemetry";
import tubitakLogo from "../assets/tubitak-dikey-beyaz.png";

// Top-view vehicle drawn as a single SVG. Signals/brake/headlights are driven by
// the (possibly derived) telemetry so the car animates in sync with the drive.
export function VehicleTopView({ vehicle }: { vehicle: TelemetryState["vehicle"] }) {
  const brakeActive =
    Number(vehicle.brakePercent || 0) > 0 ||
    Number(vehicle.brakePressure || 0) > 0.2 ||
    Boolean(vehicle.handbrake);
  const hazard =
    Boolean(vehicle.emergency) ||
    (Boolean(vehicle.leftSignal) && Boolean(vehicle.rightSignal));
  const leftOn = Boolean(vehicle.leftSignal) || hazard;
  const rightOn = Boolean(vehicle.rightSignal) || hazard;
  const lightsOn = Boolean(vehicle.ignition);

  return (
    <section className="vehicle-visual-card" aria-label="Vehicle signal visualization">
      <div className="vehicle-stage">
        <svg
          className="vehicle-svg"
          viewBox="0 0 160 240"
          role="img"
          aria-label="Top view of the vehicle"
        >
          {/* ground shadow */}
          <ellipse cx="80" cy="224" rx="58" ry="12" fill="rgba(0,0,0,0.45)" />

          {/* wheels */}
          {[
            { x: 18, y: 56 },
            { x: 122, y: 56 },
            { x: 18, y: 156 },
            { x: 122, y: 156 },
          ].map((w, i) => (
            <rect
              key={i}
              x={w.x}
              y={w.y}
              width="20"
              height="48"
              rx="6"
              fill="#0b1220"
              stroke="rgba(148,163,184,0.35)"
            />
          ))}

          {/* body */}
          <defs>
            <linearGradient id="carBody" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#39495f" />
              <stop offset="50%" stopColor="#202c3e" />
              <stop offset="100%" stopColor="#141d2b" />
            </linearGradient>
            <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="rgba(186,230,253,0.55)" />
              <stop offset="100%" stopColor="rgba(15,23,42,0.85)" />
            </linearGradient>
          </defs>

          <rect
            x="30"
            y="20"
            width="100"
            height="200"
            rx="46"
            fill="url(#carBody)"
            stroke="rgba(148,163,184,0.5)"
            strokeWidth="1.5"
          />

          {/* hood + windshield */}
          <path
            d="M44 64 q36 -22 72 0 l-6 26 q-30 -14 -60 0 z"
            fill="url(#glass)"
            stroke="rgba(125,211,252,0.3)"
          />
          {/* roof with the real TÜBİTAK logo */}
          <rect x="44" y="98" width="72" height="50" rx="16" fill="#16203a" stroke="rgba(148,163,184,0.25)" />
          <image
            href={tubitakLogo}
            x="52"
            y="104"
            width="56"
            height="38"
            preserveAspectRatio="xMidYMid meet"
            className="vehicle-emblem"
          />
          {/* rear window */}
          <path
            d="M44 176 q36 22 72 0 l-6 -26 q-30 14 -60 0 z"
            fill="url(#glass)"
            stroke="rgba(125,211,252,0.3)"
          />

          {/* side mirrors */}
          <rect x="22" y="84" width="14" height="10" rx="4" fill="#26344a" />
          <rect x="124" y="84" width="14" height="10" rx="4" fill="#26344a" />

          {/* headlights */}
          <rect x="44" y="22" width="22" height="9" rx="4" className={lightsOn ? "veh-headlight on" : "veh-headlight"} />
          <rect x="94" y="22" width="22" height="9" rx="4" className={lightsOn ? "veh-headlight on" : "veh-headlight"} />

          {/* brake lights */}
          <rect x="44" y="209" width="22" height="9" rx="4" className={brakeActive ? "veh-brake on" : "veh-brake"} />
          <rect x="94" y="209" width="22" height="9" rx="4" className={brakeActive ? "veh-brake on" : "veh-brake"} />

          {/* turn signals (corners) */}
          <circle cx="34" cy="34" r="6" className={leftOn ? "veh-signal blink" : "veh-signal"} />
          <circle cx="34" cy="206" r="6" className={leftOn ? "veh-signal blink" : "veh-signal"} />
          <circle cx="126" cy="34" r="6" className={rightOn ? "veh-signal blink" : "veh-signal"} />
          <circle cx="126" cy="206" r="6" className={rightOn ? "veh-signal blink" : "veh-signal"} />
        </svg>
      </div>
    </section>
  );
}
