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
};

// ─── pure helpers (exported for tests) ────────────────────────────────────────

// Ground speed (m/s) from a TwistWithCovarianceStamped-style linear vector.
export function speedFromTwist(twistLinear) {
  const x = numberOrUndefined(twistLinear?.x) || 0;
  const y = numberOrUndefined(twistLinear?.y) || 0;
  return Math.hypot(x, y);
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

// ─── stateful deriver ─────────────────────────────────────────────────────────

export function createVehicleDeriver(options = {}) {
  const opts = { ...DEFAULTS, ...options };

  const state = {
    speedMps: undefined,
    yawRateRadps: undefined,
    accelXMps2: undefined,
    heading: undefined,
    lastSteerDeg: undefined,
    lastSteerMs: undefined,
    lastEmitMs: -Infinity,
  };

  // Update internal state from one raw ROS message. Topic/type drive routing.
  function update(topic, type, msg) {
    const t = String(topic || "").toLowerCase();
    const ty = String(type || "").toLowerCase();

    if (t.endsWith("/velocity") || ty.includes("twistwithcovariance")) {
      const linear = msg?.twist?.twist?.linear ?? msg?.twist?.linear;
      if (linear) state.speedMps = speedFromTwist(linear);
      return;
    }
    if (ty.includes("odometry") || t.includes("odom")) {
      // Fallback speed source only if GNSS velocity hasn't been seen.
      if (state.speedMps === undefined) {
        const linear = msg?.twist?.twist?.linear;
        if (linear) state.speedMps = speedFromTwist(linear);
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
      if (h !== undefined) state.heading = ((h % 360) + 360) % 360;
    }
  }

  // Build a legacy-shaped telemetry patch from current state, or null if we
  // don't have enough yet / it's too soon since the last emit.
  function buildPatch(nowMs) {
    if (state.speedMps === undefined) return null;
    if (nowMs - state.lastEmitMs < opts.emitIntervalMs) return null;
    state.lastEmitMs = nowMs;

    const speedMps = state.speedMps;
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
    update(topic, type, msg);
    return buildPatch(nowMs);
  }

  return { ingest, update, _state: state };
}
