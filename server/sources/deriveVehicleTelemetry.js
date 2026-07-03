// Derive vehicle (CAN/DBW-shaped) telemetry from standard motion sensors.
//
// Some bags are pure sensor recordings (ZED2i, RSLidar, GNSS, IMU) with NO
// CAN / vehicle-control topics — so the cockpit gauges (speed, steering, RPM,
// throttle/brake) stay empty. This module reconstructs those gauges from the
// motion data the vehicle *did* record, so the dashboard animates in sync with
// the real drive instead of staying blank.
//
// Grounding (real data, not invented):
//   - speed         <- /gnss_1/velocity twist (ground speed = hypot(vx, vy))
//                      fallback: /ekf/odometry_earth twist
//   - steeringAngle <- bicycle model: atan(L * yawRate / v), yawRate from IMU
//   - steeringSpeed <- d(steeringAngle)/dt
//   - rpm           <- speed * fixed final-drive ratio (kinematic estimate)
//   - throttle/brake<- longitudinal accel (IMU linear_acceleration.x): + => throttle, - => brake
//   - turn signals  <- steeringAngle past a threshold, held for a debounce time
//                      (a sustained turn lights the matching blinker; small lane
//                       corrections don't flicker it)
//   - heading       <- /heading (passed through, not invented)
//
// Everything emitted carries `synthetic: true` so the UI / downstream consumers
// can flag it as derived rather than measured. Battery / signals / mode / gear
// are NOT produced here — they have no sensor ground truth.

import { numberOrUndefined } from "../normalizers/helpers.js";

// Tunables. Sensible defaults for a small autonomous EV platform; override via opts.
const DEFAULTS = {
  wheelbaseM: 2.5,          // L for the bicycle model
  maxSteerDeg: 35,          // clamp derived steering to a believable range
  minSpeedForSteer: 1.0,    // m/s — below this the bicycle model is noise-dominated
  wheelRadiusM: 0.3,
  finalDriveRatio: 8.0,     // wheel rev -> motor rev (lumped gearbox + diff)
  maxAccel: 2.0,            // m/s^2 mapped to 100% throttle
  maxDecel: 3.0,            // m/s^2 mapped to 100% brake
  accelDeadbandMps2: 0.2,   // ignore tiny accel noise around 0
  emitIntervalMs: 66,       // throttle output to ~15 Hz
  // Speed source freshness: a higher-priority source (GNSS velocity > GPS
  // position > odometry) is used only while it has produced a sample within this
  // window; once it goes silent the next source takes over. Prevents both the
  // "frozen at last sample" bug and stale sources masking a live one.
  speedStaleMs: 1500,
  gpsSpeedSmoothing: 0.4,   // low-pass weight for new GPS-derived speed (0..1)
  // Turn signals are driven by how fast the heading is changing (deg/s), which
  // tracks real cornering far more reliably than the small derived steering
  // angle (real bags show only a few degrees of derived steer through a 90°+
  // turn). steeringAngle is kept only as a weak fallback.
  signalHeadingRateDps: 12, // |d(heading)/dt| past this (deg/s) counts as turning —
                            // raised so only a real corner lights the blinker, not
                            // small steering/lane corrections.
  signalSteerDeg: 15,       // fallback: |steeringAngle| past this counts as a turn
  signalHoldMs: 350,        // intent must persist this long before the blinker lights
  signalReleaseMs: 900,     // keep the blinker on this long after the turn ends
};

// ─── pure helpers (exported for tests) ────────────────────────────────────────

// Ground speed (m/s) from a TwistWithCovarianceStamped-style linear vector.
export function speedFromTwist(twistLinear) {
  const x = numberOrUndefined(twistLinear?.x) || 0;
  const y = numberOrUndefined(twistLinear?.y) || 0;
  return Math.hypot(x, y);
}

// Ground speed (m/s) between two GPS fixes via the haversine great-circle
// distance over the elapsed time. This tracks the real drive far better than the
// /ekf/odometry_earth twist, whose magnitude runs ~2–3× the true ground speed.
export function speedFromGps(prevLat, prevLon, lat, lon, dtSec) {
  const a1 = numberOrUndefined(prevLat);
  const o1 = numberOrUndefined(prevLon);
  const a2 = numberOrUndefined(lat);
  const o2 = numberOrUndefined(lon);
  if (a1 === undefined || o1 === undefined || a2 === undefined || o2 === undefined || !(dtSec > 0)) {
    return 0;
  }
  const R = 6371000; // Earth radius (m)
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(a2 - a1);
  const dLon = toRad(o2 - o1);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a1)) * Math.cos(toRad(a2)) * Math.sin(dLon / 2) ** 2;
  return (2 * R * Math.asin(Math.min(1, Math.sqrt(s)))) / dtSec;
}

// Bicycle-model steering angle (deg) from yaw rate (rad/s) and speed (m/s).
// Returns 0 below minSpeed (formula explodes / is noise at a standstill).
export function steeringAngleFromYaw(yawRateRadps, speedMps, opts = DEFAULTS) {
  const yaw = numberOrUndefined(yawRateRadps);
  const v = numberOrUndefined(speedMps);
  if (yaw === undefined || v === undefined || v < opts.minSpeedForSteer) return 0;
  const deg = Math.atan((opts.wheelbaseM * yaw) / v) * (180 / Math.PI);
  return Math.max(-opts.maxSteerDeg, Math.min(opts.maxSteerDeg, Number(deg.toFixed(2))));
}

// Kinematic motor RPM estimate from ground speed.
export function rpmFromSpeed(speedMps, opts = DEFAULTS) {
  const v = numberOrUndefined(speedMps);
  if (v === undefined || v <= 0) return 0;
  const wheelRevPerSec = v / (2 * Math.PI * opts.wheelRadiusM);
  return Math.round(wheelRevPerSec * 60 * opts.finalDriveRatio);
}

// Map longitudinal accel (m/s^2) to throttle/brake percentages (0..100).
// Positive accel => throttle, negative => brake; one is always 0.
export function pedalsFromAccel(accelXMps2, opts = DEFAULTS) {
  const a = numberOrUndefined(accelXMps2);
  if (a === undefined || Math.abs(a) < opts.accelDeadbandMps2) {
    return { throttlePercent: 0, brakePercent: 0 };
  }
  if (a > 0) {
    return { throttlePercent: Math.min(100, Math.round((a / opts.maxAccel) * 100)), brakePercent: 0 };
  }
  return { throttlePercent: 0, brakePercent: Math.min(100, Math.round((-a / opts.maxDecel) * 100)) };
}

// Which way the steering angle points, ignoring magnitudes inside the deadband.
// Positive steeringAngle = turning right (matches steeringAngleFromYaw); returns
// "left" | "right" | null. Debounce/hold is layered on top by the deriver.
export function turnIntentFromSteering(steeringDeg, opts = DEFAULTS) {
  const s = numberOrUndefined(steeringDeg);
  if (s === undefined || Math.abs(s) < opts.signalSteerDeg) return null;
  return s > 0 ? "right" : "left";
}

// Signed heading change rate (deg/s) between two compass readings, wrap-safe.
// Result is normalized to (-180, 180]/dt so a 359°→1° step reads as +2°, not -358°.
// Positive = heading increasing (clockwise = turning right). Returns 0 if dt<=0.
export function headingRateDps(prevDeg, nextDeg, dtSec) {
  const a = numberOrUndefined(prevDeg);
  const b = numberOrUndefined(nextDeg);
  if (a === undefined || b === undefined || !(dtSec > 0)) return 0;
  let delta = ((b - a + 540) % 360) - 180; // shortest signed arc, (-180,180]
  return delta / dtSec;
}

// Turn direction from heading rate: clockwise (heading increasing) = right.
// Returns "left" | "right" | null when below the rate threshold.
export function turnIntentFromHeadingRate(rateDps, opts = DEFAULTS) {
  const r = numberOrUndefined(rateDps);
  if (r === undefined || Math.abs(r) < opts.signalHeadingRateDps) return null;
  return r > 0 ? "right" : "left";
}

// ─── stateful deriver ─────────────────────────────────────────────────────────

export function createVehicleDeriver(options = {}) {
  const opts = { ...DEFAULTS, ...options };

  const state = {
    // Speed is drawn from the freshest high-priority source (see pickSpeed):
    //   GNSS velocity  >  GPS-position haversine  >  odometry twist.
    speedMps: undefined,      // last emitted/selected speed (also read by tests)
    speedGnssMps: undefined,
    speedGnssMs: -Infinity,
    speedGpsMps: undefined,
    speedGpsMs: -Infinity,
    speedOdomMps: undefined,
    speedOdomMs: -Infinity,
    lastGpsLat: undefined,    // previous fix, for haversine speed
    lastGpsLon: undefined,
    lastGpsMs: undefined,
    yawRateRadps: undefined,
    accelXMps2: undefined,
    heading: undefined,
    lastSteerDeg: undefined,
    lastSteerMs: undefined,
    lastEmitMs: -Infinity,
    // Heading-rate tracking for turn detection (primary signal source).
    lastHeading: undefined,
    lastHeadingMs: undefined,
    headingRateDps: 0,
    // Turn-signal debounce: which way intent currently points, since when, and
    // the last time it was active (for the release/linger window).
    signalIntent: null,       // "left" | "right" | null — candidate direction
    signalIntentSinceMs: undefined,
    signalOn: null,           // "left" | "right" | null — what's actually lit
    signalActiveUntilMs: -Infinity,
  };

  // Update internal state from one raw ROS message. Topic/type drive routing.
  function update(topic, type, msg, nowMs = Date.now()) {
    const t = String(topic || "").toLowerCase();
    const ty = String(type || "").toLowerCase();

    if (t.endsWith("/velocity") || ty.includes("twistwithcovariance")) {
      const linear = msg?.twist?.twist?.linear ?? msg?.twist?.linear;
      if (linear) {
        state.speedGnssMps = speedFromTwist(linear);
        state.speedGnssMs = nowMs;
      }
      return;
    }
    if (ty.includes("navsatfix") || t.endsWith("/navsatfix") || t.endsWith("/fix")) {
      // GPS-position ground speed — the trustworthy fallback when GNSS velocity
      // isn't published. Low-passed to tame per-fix jitter.
      const lat = numberOrUndefined(msg?.latitude);
      const lon = numberOrUndefined(msg?.longitude);
      const status = msg?.status?.status; // sensor_msgs/NavSatStatus: -1 = no fix
      if (lat !== undefined && lon !== undefined && !(status !== undefined && status < 0)) {
        if (state.lastGpsLat !== undefined && state.lastGpsMs !== undefined) {
          const dt = (nowMs - state.lastGpsMs) / 1000;
          if (dt > 0 && dt < 2) {
            const raw = speedFromGps(state.lastGpsLat, state.lastGpsLon, lat, lon, dt);
            const k = opts.gpsSpeedSmoothing;
            state.speedGpsMps = state.speedGpsMps === undefined ? raw : (1 - k) * state.speedGpsMps + k * raw;
            state.speedGpsMs = nowMs;
          }
        }
        state.lastGpsLat = lat;
        state.lastGpsLon = lon;
        state.lastGpsMs = nowMs;
      }
      return;
    }
    if (ty.includes("odometry") || t.includes("odom")) {
      // Last-resort speed source. The /ekf/odometry_earth twist magnitude runs
      // ~2–3× true ground speed here, so it's only used when neither GNSS
      // velocity nor GPS position is available (see pickSpeed priority).
      const linear = msg?.twist?.twist?.linear;
      if (linear) {
        state.speedOdomMps = speedFromTwist(linear);
        state.speedOdomMs = nowMs;
      }
      return;
    }
    if (ty.includes("imu") || t.includes("imu")) {
      const yaw = numberOrUndefined(msg?.angular_velocity?.z);
      const ax = numberOrUndefined(msg?.linear_acceleration?.x);
      if (yaw !== undefined) state.yawRateRadps = yaw;
      if (ax !== undefined) state.accelXMps2 = ax;
      return;
    }
    if (ty.includes("float64") || t.endsWith("/heading")) {
      const h = numberOrUndefined(msg?.data ?? msg?.value ?? msg);
      if (h !== undefined) {
        const norm = ((h % 360) + 360) % 360;
        if (state.lastHeading !== undefined && state.lastHeadingMs !== undefined) {
          const dt = (nowMs - state.lastHeadingMs) / 1000;
          if (dt > 0 && dt < 2) {
            // Low-pass the rate a little so GNSS heading jitter doesn't flicker the blinker.
            const raw = headingRateDps(state.lastHeading, norm, dt);
            state.headingRateDps = 0.5 * state.headingRateDps + 0.5 * raw;
          }
        }
        state.heading = norm;
        state.lastHeading = norm;
        state.lastHeadingMs = nowMs;
      }
    }
  }

  // Choose ground speed from the freshest high-priority source. GNSS velocity is
  // best when present; GPS-position haversine is the trustworthy fallback; the
  // odometry twist (biased high) is only a last resort. A source counts only
  // while it produced a sample within speedStaleMs, so a source going silent
  // hands off instead of freezing the reading.
  function pickSpeed(nowMs) {
    const fresh = (ms) => nowMs - ms <= opts.speedStaleMs;
    if (state.speedGnssMps !== undefined && fresh(state.speedGnssMs)) return state.speedGnssMps;
    if (state.speedGpsMps !== undefined && fresh(state.speedGpsMs)) return state.speedGpsMps;
    if (state.speedOdomMps !== undefined && fresh(state.speedOdomMs)) return state.speedOdomMps;
    return undefined;
  }

  // Build a legacy-shaped telemetry patch from current state, or null if we
  // don't have enough yet / it's too soon since the last emit.
  function buildPatch(nowMs) {
    const speedMps = pickSpeed(nowMs);
    if (speedMps === undefined) return null;
    if (nowMs - state.lastEmitMs < opts.emitIntervalMs) return null;
    state.lastEmitMs = nowMs;
    state.speedMps = speedMps;
    const vehicle = {
      synthetic: true,
      speedKmh: Number((speedMps * 3.6).toFixed(2)),
      rpm: rpmFromSpeed(speedMps, opts),
    };

    const steerDeg = steeringAngleFromYaw(state.yawRateRadps, speedMps, opts);
    vehicle.steeringAngle = steerDeg;
    if (state.lastSteerDeg !== undefined && state.lastSteerMs !== undefined) {
      const dt = (nowMs - state.lastSteerMs) / 1000;
      if (dt > 0) vehicle.steeringSpeed = Number(((steerDeg - state.lastSteerDeg) / dt).toFixed(2));
    }
    state.lastSteerDeg = steerDeg;
    state.lastSteerMs = nowMs;

    // Turn-signal debounce. A sustained turn (intent held >= signalHoldMs) lights
    // the blinker; once lit it lingers signalReleaseMs after the turn ends, so a
    // brief straightening mid-corner doesn't drop it. Heading rate is the primary
    // cue (tracks real cornering); derived steering angle is a weak fallback.
    const intent = turnIntentFromHeadingRate(state.headingRateDps, opts)
      ?? turnIntentFromSteering(steerDeg, opts);
    if (intent !== state.signalIntent) {
      state.signalIntent = intent;
      state.signalIntentSinceMs = intent ? nowMs : undefined;
    }
    if (intent && nowMs - state.signalIntentSinceMs >= opts.signalHoldMs) {
      state.signalOn = intent;
      state.signalActiveUntilMs = nowMs + opts.signalReleaseMs;
    } else if (state.signalOn && nowMs >= state.signalActiveUntilMs) {
      state.signalOn = null;
    }
    vehicle.leftSignal = state.signalOn === "left";
    vehicle.rightSignal = state.signalOn === "right";

    if (state.accelXMps2 !== undefined) {
      const { throttlePercent, brakePercent } = pedalsFromAccel(state.accelXMps2, opts);
      vehicle.throttlePedalPercent = throttlePercent;
      vehicle.brakePercent = brakePercent;
    }

    const telemetry = { synthetic: true, speed: Number(speedMps.toFixed(3)), vehicle };
    if (state.heading !== undefined) telemetry.heading = Number(state.heading.toFixed(2));
    return telemetry;
  }

  // Ingest one message; returns a telemetry patch when ready, else null.
  function ingest(topic, type, msg, nowMs = Date.now()) {
    update(topic, type, msg, nowMs);
    return buildPatch(nowMs);
  }

  return { ingest, update, _state: state };
}
