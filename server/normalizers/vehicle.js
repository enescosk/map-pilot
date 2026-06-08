// Vehicle telemetry normalizer. Maps raw ROS vehicle topics to the legacy
// telemetry envelope shape (telemetry.speed, telemetry.vehicle.*) that App.tsx
// expects. Extracted verbatim from bagPlaybackSource.js so emitted bytes do not
// change. The Phase-3 canonical pipeline (server/normalizers/index.js) handles
// the four target signals before this fallback runs; everything else still
// flows through here unchanged.

import { numberOrUndefined, scaledNumberOrUndefined } from "./helpers.js";

export function modeLabel(mode) {
  switch (Number(mode)) {
    case 0:
      return "Manual";
    case 1:
      return "Autonomous";
    case 2:
      return "Teleoperated";
    case 3:
      return "Emergency";
    default:
      return undefined;
  }
}

export function normalizeVehicleTelemetry(message, type, topic) {
  const lowerType = type.toLowerCase();
  const lowerTopic = topic.toLowerCase();
  const vehicle = {};
  const telemetry = {};

  if (lowerType.includes("velocityinformation") || lowerTopic.includes("velocityinformation")) {
    const speed = scaledNumberOrUndefined(message.VelocityMS, 0.01);
    const speedKmh = scaledNumberOrUndefined(message.VelocityKMH, 0.1);
    // CAN bus sends empty frames (0) between real updates — ignore zero values
    // so the last valid reading is preserved in state.
    if (speed !== undefined && speed > 0) telemetry.speed = speed;
    if (speedKmh !== undefined && speedKmh > 0) vehicle.speedKmh = speedKmh;
  }

  if (lowerType.includes("eps_response") || lowerTopic.includes("eps_response")) {
    vehicle.steeringAngle = numberOrUndefined(message.EPS_StrAng);
    vehicle.steeringSpeed = numberOrUndefined(message.EPS_StrAngSpdStat);
    vehicle.steeringTorque = scaledNumberOrUndefined(message.EPS_InputTq, 0.1);
    vehicle.epsTemperature = numberOrUndefined(message.EPS_MCUTemp);
    vehicle.epsWork = Boolean(message.EPS_WorkStat);
    vehicle.epsFault = Boolean(message.EPS_FltStat || message.EPS_CANFltStat || message.EPS_FltLv1Stat || message.EPS_FltLv2Stat || message.EPS_FltLv3Stat);
  }

  if (lowerType.includes("vcu_eps_control") || lowerTopic.includes("vcu_eps_control")) {
    vehicle.targetSteeringAngle = numberOrUndefined(message.Target_Angle_st);
    vehicle.targetSteeringSpeed = numberOrUndefined(message.Angle_speed_st);
    vehicle.epsWorkCommand = Boolean(message.VCU_EPSWorkMode);
  }

  if (lowerType.includes("steercontrol") || lowerTopic.includes("steer_control")) {
    vehicle.targetSteeringAngle = numberOrUndefined(message.desired_angle);
    vehicle.targetSteeringSpeed = numberOrUndefined(message.desired_angle_speed);
  }

  if (lowerType.includes("ehb_brakingresponse") || lowerTopic.includes("ehb_brakingresponse")) {
    vehicle.brakePressure = scaledNumberOrUndefined(message.EHB_ActualPressure, 0.125);
    vehicle.brakePedal = numberOrUndefined(message.EHB_BrkPedallStk);
    vehicle.brakeFaultLevel = numberOrUndefined(message.EHB_EHBFaultLevel);
    vehicle.parkingBrake = Boolean(message.EHB_ParkingBrakeRequest);
    vehicle.brakeSystemActive = Boolean(message.EHB_EHBStatus);
  }

  if (lowerType.includes("vcu_ehb_control") || lowerTopic.includes("vcu_ehb_control")) {
    vehicle.targetBrakePressure = scaledNumberOrUndefined(message.VCU_BrkAimPressure, 0.125);
    vehicle.brakingEnable = numberOrUndefined(message.VCU_BrakingEnable);
    vehicle.commandedVehicleSpeedKmh = scaledNumberOrUndefined(message.VCU_VehicleSpeed, 0.1);
  }

  if (lowerType.includes("brakecontrol") || lowerTopic.includes("brake_control")) {
    vehicle.brakePercent = numberOrUndefined(message.brake_percent);
  }

  if (lowerType.includes("cruisecontrolsignals") || lowerTopic.includes("throttle_control")) {
    vehicle.throttleSetSpeedKmh = numberOrUndefined(message.setSpeed_kmh);
    vehicle.cruiseActive = Boolean(message.cruiseActive);
  }

  if (lowerType.includes("fb_motordriver") || lowerTopic.includes("fb_motor_driver_report")) {
    vehicle.rpm = numberOrUndefined(message.VehicleRPM);
    vehicle.tripDistance = numberOrUndefined(message.PlusTripDistance);
    vehicle.gear = numberOrUndefined(message.GEAR_STATUS_FROM_MOTOR);
  }

  if (lowerType.includes("fb_omux_to_autonomous") || lowerTopic.includes("rc_unit_report")) {
    vehicle.batterySoc = numberOrUndefined(message.FB_BatterySOC);
    vehicle.batteryVoltage = numberOrUndefined(message.FB_BatteryVoltage);
    vehicle.ignition = Boolean(message.FB_IGNITION);
    vehicle.leftSignal = Boolean(message.FB_LeftSignal);
    vehicle.rightSignal = Boolean(message.FB_RightSignal);
    vehicle.emergency = Boolean(message.FB_EMERGENCY);
    vehicle.handbrake = Boolean(message.FB_HANDBRAKESTATUS);
  }

  if (lowerType.includes("autonomousheardbit") || lowerTopic.includes("autonomous_report")) {
    vehicle.autonomousManualSelect = Boolean(message.AutonomousManuelSelect);
  }

  if (lowerType.includes("vehiclemode") || lowerTopic.includes("autonomous_mode_selection")) {
    vehicle.mode = modeLabel(message.mode) || String(message.mode);
  }

  if (Object.keys(vehicle).length === 0 && Object.keys(telemetry).length === 0) {
    return undefined;
  }

  return {
    ...telemetry,
    vehicle,
  };
}
