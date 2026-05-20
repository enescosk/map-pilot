// Legacy adapter: canonical CanonicalTelemetry -> today's WS telemetry envelope.
//
// The dashboard (src/App.tsx, see L2129-2199) does shallow merges like
//   setTelemetry(prev => ({ ...prev, ...packet.telemetry, vehicle: { ...prev.vehicle, ...packet.telemetry.vehicle } }))
// and treats every numeric leaf as a plain number. The adapter therefore
// unwraps the canonical { value, unit } envelopes and emits the same field
// names the existing UI already binds to (speedKmh, steeringAngle, brakePressure, ...).
//
// Two outputs are returned via the dispatcher in normalizers/index.js:
//   - the inner `telemetry` payload (this file)
//   - the outer envelope { type: "telemetry", source, topic, time, telemetry }
//
// Once Phase 5 lands the v2 protocol, callers can opt into the canonical shape
// instead and this adapter is deleted.

function unwrap(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "object" && "value" in value && "unit" in value) {
    return Number.isFinite(value.value) ? value.value : undefined;
  }
  return value;
}

export function toLegacyTelemetry(canonical, invalid, _meta) {
  if (!canonical || typeof canonical !== "object") return undefined;
  const v = canonical.vehicle || {};

  const telemetry = {};
  const vehicle = {};

  // Speed (also exposed at the top level for legacy compatibility — App.tsx
  // reads telemetry.speed for charts).
  const speedMps = unwrap(v.speedMps);
  const speedKmh = unwrap(v.speedKmh);
  if (speedMps !== undefined) telemetry.speed = Number(speedMps.toFixed(3));
  if (speedKmh !== undefined) vehicle.speedKmh = Number(speedKmh.toFixed(2));

  // Steering
  const steerAngle = unwrap(v.steeringAngleDeg);
  const targetSteerAngle = unwrap(v.targetSteeringAngleDeg);
  const steerSpeed = unwrap(v.steeringSpeedDegPerSec);
  const targetSteerSpeed = unwrap(v.targetSteeringSpeedDegPerSec);
  const steerTorque = unwrap(v.steeringTorqueNm);
  if (steerAngle !== undefined) vehicle.steeringAngle = steerAngle;
  if (targetSteerAngle !== undefined) vehicle.targetSteeringAngle = targetSteerAngle;
  if (steerSpeed !== undefined) vehicle.steeringSpeed = steerSpeed;
  if (targetSteerSpeed !== undefined) vehicle.targetSteeringSpeed = targetSteerSpeed;
  if (steerTorque !== undefined) vehicle.steeringTorque = steerTorque;
  if (v.epsTempC !== undefined) vehicle.epsTemperature = v.epsTempC;
  if (typeof v.epsWork === "boolean") vehicle.epsWork = v.epsWork;
  if (typeof v.epsFault === "boolean") vehicle.epsFault = v.epsFault;
  if (typeof v.epsWorkCommand === "boolean") vehicle.epsWorkCommand = v.epsWorkCommand;

  // Brake. Field order intentionally matches the legacy normalizer so the
  // emitted JSON is byte-for-byte identical to the pre-refactor output.
  if (v.brake) {
    const brake = v.brake;
    if (brake.pressureBar !== undefined) vehicle.brakePressure = brake.pressureBar;
    if (brake.targetPressureBar !== undefined) vehicle.targetBrakePressure = brake.targetPressureBar;
    if (brake.pedalRaw !== undefined) vehicle.brakePedal = brake.pedalRaw;
    if (brake.faultLevel !== undefined) vehicle.brakeFaultLevel = brake.faultLevel;
    if (brake.percent !== undefined) vehicle.brakePercent = brake.percent;
    if (typeof brake.parking === "boolean") vehicle.parkingBrake = brake.parking;
    if (typeof brake.active === "boolean") vehicle.brakeSystemActive = brake.active;
    if (brake.brakingEnable !== undefined) vehicle.brakingEnable = brake.brakingEnable;
  }

  // VCU command path (separate from EHB feedback)
  const commandedSpeedKmh = unwrap(v.commandedSpeedKmh);
  if (commandedSpeedKmh !== undefined) vehicle.commandedVehicleSpeedKmh = commandedSpeedKmh;

  // Throttle
  if (v.throttle) {
    const t = v.throttle;
    if (t.setSpeedKmh !== undefined) vehicle.throttleSetSpeedKmh = t.setSpeedKmh;
    if (typeof t.cruiseActive === "boolean") vehicle.cruiseActive = t.cruiseActive;
    if (t.pedalPercent !== undefined) vehicle.throttlePedalPercent = t.pedalPercent;
    if (t.targetSpeedKmh !== undefined) vehicle.throttleTargetSpeedKmh = t.targetSpeedKmh;
    if (t.kind) vehicle.throttleKind = t.kind;
    if (t.source) vehicle.throttleSource = t.source;
  }

  // Drivetrain
  if (v.drivetrain) {
    const d = v.drivetrain;
    if (d.rpm !== undefined) vehicle.rpm = d.rpm;
    if (d.gear !== undefined) vehicle.gear = d.gear;
    if (d.tripDistance !== undefined) vehicle.tripDistance = d.tripDistance;
  }

  // Vehicle state summary (battery / signals / mode / ignition)
  if (v.state) {
    const s = v.state;
    if (s.mode !== undefined) vehicle.mode = s.mode;
    if (s.gear !== undefined && vehicle.gear === undefined) vehicle.gear = s.gear;
    if (s.batterySoc !== undefined) vehicle.batterySoc = s.batterySoc;
    if (s.batteryVoltage !== undefined) vehicle.batteryVoltage = s.batteryVoltage;
    if (typeof s.ignition === "boolean") vehicle.ignition = s.ignition;
    if (typeof s.leftSignal === "boolean") vehicle.leftSignal = s.leftSignal;
    if (typeof s.rightSignal === "boolean") vehicle.rightSignal = s.rightSignal;
    if (typeof s.emergency === "boolean") vehicle.emergency = s.emergency;
    if (typeof s.handbrake === "boolean") vehicle.handbrake = s.handbrake;
  }

  // Invalid fields are surfaced so the UI can show "stale/bad" indicators.
  if (Array.isArray(invalid) && invalid.length > 0) {
    telemetry.invalidFields = invalid.map((entry) => entry.field);
  }

  if (Object.keys(vehicle).length > 0) {
    telemetry.vehicle = vehicle;
  }

  if (Object.keys(telemetry).length === 0) {
    return undefined;
  }
  return telemetry;
}
