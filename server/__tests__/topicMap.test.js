import { describe, it, expect } from "vitest";
import { TOPIC_MAP, matchTopicEntry } from "../mapping/topicMap.js";

// ─── matchTopicEntry ──────────────────────────────────────────────────────────

describe("matchTopicEntry", () => {
  it("matches by topic regex", () => {
    const entry = matchTopicEntry("/VelocityInformation", "");
    expect(entry).not.toBeUndefined();
    expect(entry.id).toBe("velocity");
  });

  it("matches by type regex when topic is empty", () => {
    const entry = matchTopicEntry("", "dbw_interface/VelocityInformation");
    expect(entry).not.toBeUndefined();
    expect(entry.id).toBe("velocity");
  });

  it("returns undefined for unknown topic and type", () => {
    expect(matchTopicEntry("/unknown/topic", "unknown/Type")).toBeUndefined();
  });

  it("is case-insensitive for topic match", () => {
    expect(matchTopicEntry("/velocityinformation", "")).not.toBeUndefined();
  });
});

// ─── velocity extractor ───────────────────────────────────────────────────────

describe("velocity entry extractor", () => {
  const entry = TOPIC_MAP.find((e) => e.id === "velocity");

  it("extracts speedMps and speedKmh with units", () => {
    const result = entry.extract({ VelocityMS: 200, VelocityKMH: 720 });
    expect(result.vehicle.speedMps).toEqual({ value: 2.0, unit: "m/s" });
    expect(result.vehicle.speedKmh).toEqual({ value: 72.0, unit: "km/h" });
  });

  it("derives kmh from mps when VelocityKMH is absent", () => {
    const result = entry.extract({ VelocityMS: 100 });
    expect(result.vehicle.speedMps.value).toBeCloseTo(1.0);
    expect(result.vehicle.speedKmh.value).toBeCloseTo(3.6);
  });

  it("returns undefined when both fields are missing", () => {
    expect(entry.extract({})).toBeUndefined();
  });
});

// ─── eps_response extractor ───────────────────────────────────────────────────

describe("eps_response entry extractor", () => {
  const entry = TOPIC_MAP.find((e) => e.id === "eps_response");

  it("extracts steering angle with deg unit", () => {
    const result = entry.extract({ EPS_StrAng: 15, EPS_WorkStat: 1, EPS_FltStat: 0 });
    expect(result.vehicle.steeringAngleDeg).toEqual({ value: 15, unit: "deg" });
    expect(result.vehicle.epsWork).toBe(true);
    expect(result.vehicle.epsFault).toBe(false);
  });

  it("sets epsFault when any fault flag is set", () => {
    const result = entry.extract({ EPS_FltLv3Stat: 1 });
    expect(result.vehicle.epsFault).toBe(true);
  });
});

// ─── ehb_brake extractor ─────────────────────────────────────────────────────

describe("ehb_brake entry extractor", () => {
  const entry = TOPIC_MAP.find((e) => e.id === "ehb_brake");

  it("scales pressure by 0.125", () => {
    const result = entry.extract({ EHB_ActualPressure: 80 });
    expect(result.vehicle.brake.pressureBar).toBeCloseTo(10.0);
  });

  it("extracts parking brake and active flags", () => {
    const result = entry.extract({ EHB_ParkingBrakeRequest: 1, EHB_EHBStatus: 1 });
    expect(result.vehicle.brake.parking).toBe(true);
    expect(result.vehicle.brake.active).toBe(true);
  });
});

// ─── throttle_control extractor ───────────────────────────────────────────────

describe("throttle_control entry extractor", () => {
  const entry = TOPIC_MAP.find((e) => e.id === "throttle_control");

  it("extracts setSpeedKmh and cruiseActive", () => {
    const result = entry.extract({ setSpeed_kmh: 50, cruiseActive: true });
    expect(result.vehicle.throttle.setSpeedKmh).toBe(50);
    expect(result.vehicle.throttle.cruiseActive).toBe(true);
    expect(result.vehicle.throttle.kind).toBe("targetSpeed");
  });
});

// ─── rc_unit_report extractor ─────────────────────────────────────────────────

describe("rc_unit_report entry extractor", () => {
  const entry = TOPIC_MAP.find((e) => e.id === "rc_unit_report");

  it("extracts battery, ignition, and signals", () => {
    const result = entry.extract({
      FB_BatterySOC: 85,
      FB_BatteryVoltage: 48,
      FB_IGNITION: 1,
      FB_LeftSignal: 0,
      FB_RightSignal: 1,
      FB_EMERGENCY: 0,
      FB_HANDBRAKESTATUS: 1,
    });
    expect(result.vehicle.state.batterySoc).toBe(85);
    expect(result.vehicle.state.ignition).toBe(true);
    expect(result.vehicle.state.rightSignal).toBe(true);
    expect(result.vehicle.state.handbrake).toBe(true);
  });
});

// ─── autonomous_mode_selection extractor ──────────────────────────────────────

describe("autonomous_mode_selection entry extractor", () => {
  const entry = TOPIC_MAP.find((e) => e.id === "autonomous_mode_selection");

  it("maps mode number to label", () => {
    expect(entry.extract({ mode: 1 }).vehicle.state.mode).toBe("Autonomous");
    expect(entry.extract({ mode: 3 }).vehicle.state.mode).toBe("Emergency");
  });

  it("returns undefined when mode is missing", () => {
    expect(entry.extract({})).toBeUndefined();
  });
});

// ─── fb_motor_driver_report extractor ────────────────────────────────────────

describe("fb_motor_driver_report entry extractor", () => {
  const entry = TOPIC_MAP.find((e) => e.id === "fb_motor_driver_report");

  it("extracts rpm, gear, and tripDistance", () => {
    const result = entry.extract({ VehicleRPM: 1200, GEAR_STATUS_FROM_MOTOR: 3, PlusTripDistance: 500 });
    expect(result.vehicle.drivetrain.rpm).toBe(1200);
    expect(result.vehicle.drivetrain.gear).toBe(3);
    expect(result.vehicle.drivetrain.tripDistance).toBe(500);
  });

  it("returns undefined when all fields are absent", () => {
    expect(entry.extract({})).toBeUndefined();
  });
});
