// Topic mapping (Phase 3 scope: 4 target signals).
//
// Each entry declares:
//   - id:       human label for logs/diagnostics
//   - topic:    regex matched against the ROS topic name (case-insensitive)
//   - type:     regex matched against the message _type (case-insensitive)
//   - extract:  raw msg -> DeepPartial<CanonicalTelemetry.vehicle/...>
//
// Numeric leaves are emitted as { value, unit } envelopes per the canonical
// schema. The legacy adapter unwraps them for today's dashboard.

import { numberOrUndefined, scaledNumberOrUndefined } from "../normalizers/helpers.js";
import { modeLabel } from "../normalizers/vehicle.js";

function vu(value, unit) {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? { value: n, unit } : undefined;
}

export const TOPIC_MAP = [
  {
    id: "velocity",
    topic: /\/VelocityInformation$/i,
    type: /VelocityInformation/i,
    extract: (msg) => {
      const speedMps = scaledNumberOrUndefined(msg.VelocityMS, 0.01);
      // VelocityKMH has inconsistent CAN DBC scale — derive km/h from VelocityMS only.
      // Ignore zero values: CAN bus sends empty frames (0) between real updates.
      if (!speedMps || speedMps <= 0) return undefined;
      const speedKmh = Number((speedMps * 3.6).toFixed(2));
      return {
        vehicle: {
          speedMps: vu(speedMps, "m/s"),
          speedKmh: vu(speedKmh, "km/h"),
        },
        speed: speedMps,
      };
    },
  },
  {
    id: "eps_response",
    topic: /\/eps_response$/i,
    type: /eps_response/i,
    extract: (msg) => {
      const vehicle = {};
      const steerAngle = numberOrUndefined(msg.EPS_StrAng);
      const steerSpeed = numberOrUndefined(msg.EPS_StrAngSpdStat);
      const steerTorque = scaledNumberOrUndefined(msg.EPS_InputTq, 0.1);
      const tempC = numberOrUndefined(msg.EPS_MCUTemp);
      if (steerAngle !== undefined) vehicle.steeringAngleDeg = vu(steerAngle, "deg");
      if (steerSpeed !== undefined) vehicle.steeringSpeedDegPerSec = vu(steerSpeed, "deg/s");
      if (steerTorque !== undefined) vehicle.steeringTorqueNm = vu(steerTorque, "Nm");
      if (tempC !== undefined) vehicle.epsTempC = tempC;
      vehicle.epsWork = Boolean(msg.EPS_WorkStat);
      vehicle.epsFault = Boolean(
        msg.EPS_FltStat || msg.EPS_CANFltStat || msg.EPS_FltLv1Stat || msg.EPS_FltLv2Stat || msg.EPS_FltLv3Stat,
      );
      return { vehicle };
    },
  },
  {
    id: "ehb_brake",
    topic: /\/EHB_BrakingResponse$/i,
    type: /EHB_BrakingResponse/i,
    extract: (msg) => {
      const brake = {};
      const pressure = scaledNumberOrUndefined(msg.EHB_ActualPressure, 0.125);
      const pedalRaw = numberOrUndefined(msg.EHB_BrkPedallStk);
      const faultLevel = numberOrUndefined(msg.EHB_EHBFaultLevel);
      if (pressure !== undefined) brake.pressureBar = pressure;
      if (pedalRaw !== undefined) brake.pedalRaw = pedalRaw;
      if (faultLevel !== undefined) brake.faultLevel = faultLevel;
      brake.parking = Boolean(msg.EHB_ParkingBrakeRequest);
      brake.active = Boolean(msg.EHB_EHBStatus);
      return { vehicle: { brake } };
    },
  },
  {
    id: "throttle_control",
    topic: /\/throttle_control$/i,
    type: /CruiseControlSignals/i,
    extract: (msg) => {
      // /throttle_control carries a cruise *target speed* (km/h), NOT a pedal
      // percent. Tag the discriminant so consumers don't conflate the two.
      const setSpeed = numberOrUndefined(msg.setSpeed_kmh);
      const throttle = { kind: "targetSpeed", source: "cruise" };
      if (setSpeed !== undefined) throttle.setSpeedKmh = setSpeed;
      throttle.cruiseActive = Boolean(msg.cruiseActive);
      return { vehicle: { throttle } };
    },
  },
  {
    id: "vcu_eps_control",
    topic: /\/vcu_eps_control$/i,
    type: /vcu_eps_control/i,
    extract: (msg) => {
      const vehicle = {};
      const targetAngle = numberOrUndefined(msg.Target_Angle_st);
      const targetSpeed = numberOrUndefined(msg.Angle_speed_st);
      if (targetAngle !== undefined) vehicle.targetSteeringAngleDeg = vu(targetAngle, "deg");
      if (targetSpeed !== undefined) vehicle.targetSteeringSpeedDegPerSec = vu(targetSpeed, "deg/s");
      vehicle.epsWorkCommand = Boolean(msg.VCU_EPSWorkMode);
      return { vehicle };
    },
  },
  {
    id: "steer_control",
    topic: /\/steer_control$/i,
    type: /steercontrol/i,
    extract: (msg) => {
      const vehicle = {};
      const targetAngle = numberOrUndefined(msg.desired_angle);
      const targetSpeed = numberOrUndefined(msg.desired_angle_speed);
      if (targetAngle !== undefined) vehicle.targetSteeringAngleDeg = vu(targetAngle, "deg");
      if (targetSpeed !== undefined) vehicle.targetSteeringSpeedDegPerSec = vu(targetSpeed, "deg/s");
      return Object.keys(vehicle).length ? { vehicle } : undefined;
    },
  },
  {
    id: "vcu_ehb_control",
    topic: /\/vcu_ehb_control$/i,
    type: /vcu_ehb_control/i,
    extract: (msg) => {
      const brake = {};
      const target = scaledNumberOrUndefined(msg.VCU_BrkAimPressure, 0.125);
      if (target !== undefined) brake.targetPressureBar = target;
      const enable = numberOrUndefined(msg.VCU_BrakingEnable);
      if (enable !== undefined) brake.brakingEnable = enable;
      const cmdSpeed = scaledNumberOrUndefined(msg.VCU_VehicleSpeed, 0.1);
      const vehicle = { brake };
      if (cmdSpeed !== undefined) vehicle.commandedSpeedKmh = vu(cmdSpeed, "km/h");
      return { vehicle };
    },
  },
  {
    id: "brake_control",
    topic: /\/brake_control$/i,
    type: /brakecontrol/i,
    extract: (msg) => {
      const percent = numberOrUndefined(msg.brake_percent);
      if (percent === undefined) return undefined;
      return { vehicle: { brake: { percent } } };
    },
  },
  {
    id: "fb_motor_driver_report",
    topic: /\/fb_motor_driver_report$/i,
    type: /fb_motordriver/i,
    extract: (msg) => {
      const drivetrain = {};
      const rpm = numberOrUndefined(msg.VehicleRPM);
      const gear = numberOrUndefined(msg.GEAR_STATUS_FROM_MOTOR);
      const trip = numberOrUndefined(msg.PlusTripDistance);
      if (rpm !== undefined) drivetrain.rpm = rpm;
      if (gear !== undefined) drivetrain.gear = gear;
      if (trip !== undefined) drivetrain.tripDistance = trip;
      if (Object.keys(drivetrain).length === 0) return undefined;
      return { vehicle: { drivetrain } };
    },
  },
  {
    id: "rc_unit_report",
    topic: /\/rc_unit_report$/i,
    type: /fb_omux_to_autonomous/i,
    extract: (msg) => {
      const state = {};
      const soc = numberOrUndefined(msg.FB_BatterySOC);
      const volt = numberOrUndefined(msg.FB_BatteryVoltage);
      if (soc !== undefined) state.batterySoc = soc;
      if (volt !== undefined) state.batteryVoltage = volt;
      state.ignition = Boolean(msg.FB_IGNITION);
      state.leftSignal = Boolean(msg.FB_LeftSignal);
      state.rightSignal = Boolean(msg.FB_RightSignal);
      state.emergency = Boolean(msg.FB_EMERGENCY);
      state.handbrake = Boolean(msg.FB_HANDBRAKESTATUS);
      return { vehicle: { state } };
    },
  },
  {
    id: "autonomous_mode_selection",
    topic: /\/autonomous_mode_selection$/i,
    type: /vehiclemode/i,
    extract: (msg) => {
      const label = modeLabel(msg.mode);
      const value = label || (msg.mode !== undefined ? String(msg.mode) : undefined);
      if (!value) return undefined;
      return { vehicle: { state: { mode: value } } };
    },
  },
];

// Returns the first entry whose topic or type regex matches.
// Type-only or topic-only matches are accepted; one signal is enough.
export function matchTopicEntry(topic, msgType) {
  const topicStr = String(topic || "");
  const typeStr = String(msgType || "");
  for (const entry of TOPIC_MAP) {
    if (entry.topic.test(topicStr) || entry.type.test(typeStr)) {
      return entry;
    }
  }
  return undefined;
}

// Topics we never want to route through the canonical pipeline regardless of
// match (e.g. they only carry raw bytes). Empty for now; placeholder for future
// guardrails.
export const CANONICAL_TOPIC_BLOCKLIST = new Set();

// Re-export modeLabel so callers that import via topicMap don't need to know
// where the helper lives.
export { modeLabel };
