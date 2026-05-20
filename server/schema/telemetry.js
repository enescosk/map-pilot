// Canonical Telemetry schema (Phase 3).
//
// The shape is intentionally JSDoc + a constructor instead of a TypeScript file,
// because the rest of server/ is plain ESM. The frontend gets a mirrored type
// declaration in src/types/telemetry.ts when Phase 5 lands.
//
// Conventions:
//   - Numeric leaves use { value, unit } envelopes so the consumer never has to
//     guess units. The legacy adapter unwraps these back to plain numbers for
//     the existing dashboard.
//   - Optional fields are omitted entirely (not set to null/zero) so the store
//     can distinguish "never reported" from "reported as 0".

/**
 * @typedef {{ value: number, unit: string }} ValueWithUnit
 *
 * @typedef {object} Vec3
 * @property {number} x
 * @property {number} y
 * @property {number} z
 *
 * @typedef {object} ThrottleState
 * @property {"targetSpeed"|"pedalPercent"|"command"|"unknown"} kind - what the signal actually is
 * @property {"cruise"|"pedal"} [source] - origin tag (optional context)
 * @property {number} [setSpeedKmh]
 * @property {boolean} [cruiseActive]
 * @property {number} [pedalPercent]
 * @property {number} [targetSpeedKmh]
 *
 * @typedef {object} DrivetrainState
 * @property {number} [rpm]
 * @property {number} [gear]
 * @property {number} [tripDistance]
 *
 * @typedef {object} VehicleStateSummary
 * @property {"Manual"|"Autonomous"|"Teleoperated"|"Emergency"|string} [mode]
 * @property {number} [gear]
 * @property {boolean} [ignition]
 * @property {boolean} [emergency]
 * @property {boolean} [handbrake]
 * @property {boolean} [leftSignal]
 * @property {boolean} [rightSignal]
 * @property {number} [batterySoc]
 * @property {number} [batteryVoltage]
 *
 * @typedef {object} BrakeState
 * @property {number} [pressureBar]
 * @property {number} [targetPressureBar]
 * @property {number} [pedalRaw]
 * @property {number} [percent]
 * @property {boolean} [parking]
 * @property {number} [faultLevel]
 * @property {boolean} [active]
 *
 * @typedef {object} VehicleCanonical
 * @property {ValueWithUnit} [speedMps]
 * @property {ValueWithUnit} [speedKmh]
 * @property {ValueWithUnit} [steeringAngleDeg]
 * @property {ValueWithUnit} [targetSteeringAngleDeg]
 * @property {ValueWithUnit} [steeringTorqueNm]
 * @property {boolean} [epsWork]
 * @property {boolean} [epsFault]
 * @property {number} [epsTempC]
 * @property {ThrottleState} [throttle]
 * @property {BrakeState} [brake]
 * @property {DrivetrainState} [drivetrain]
 * @property {VehicleStateSummary} [state]
 *
 * @typedef {object} CanonicalTelemetry
 * @property {1} schemaVersion
 * @property {string} sourceName
 * @property {string} sourceTopic
 * @property {number} monoTimestampMs
 * @property {string} [sensorTimestamp]
 * @property {VehicleCanonical} [vehicle]
 * @property {{ acceleration?: Vec3, angularVelocity?: Vec3, magneticField?: Vec3 }} [imu]
 * @property {{ latitude?: number, longitude?: number, altitude?: number }} [gps]
 * @property {{ topics: object, sources: object }} health
 * @property {{ fields: string[], invalid: Array<{ field: string, reason: string }> }} validity
 */

export function createEmptyTelemetry() {
  return {
    schemaVersion: 1,
    sourceName: "",
    sourceTopic: "",
    monoTimestampMs: 0,
    sensorTimestamp: undefined,
    vehicle: undefined,
    imu: undefined,
    gps: undefined,
    health: { topics: {}, sources: {} },
    validity: { fields: [], invalid: [] },
  };
}

// Range guards. Numbers outside these bounds are flagged in validity.invalid
// but still stored / forwarded so the UI can show them rather than silently
// dropping a value.
export const RANGE_GUARDS = {
  "vehicle.speedMps":         { min: -5,    max: 80 },
  "vehicle.speedKmh":         { min: -20,   max: 300 },
  "vehicle.steeringAngleDeg": { min: -720,  max: 720 },
  "vehicle.steeringTorqueNm": { min: -50,   max: 50 },
  "vehicle.epsTempC":         { min: -40,   max: 200 },
  "vehicle.brake.pressureBar":      { min: 0, max: 200 },
  "vehicle.brake.targetPressureBar":{ min: 0, max: 200 },
  "vehicle.brake.percent":          { min: 0, max: 100 },
  "vehicle.throttle.setSpeedKmh":   { min: 0, max: 300 },
  "vehicle.throttle.pedalPercent":  { min: 0, max: 100 },
  "vehicle.throttle.targetSpeedKmh":{ min: 0, max: 300 },
  "vehicle.drivetrain.rpm":         { min: -100, max: 20000 },
  "vehicle.drivetrain.gear":        { min: -2,   max: 10 },
  "vehicle.state.batterySoc":       { min: 0,   max: 100 },
  "vehicle.state.batteryVoltage":   { min: 0,   max: 100 },
};
