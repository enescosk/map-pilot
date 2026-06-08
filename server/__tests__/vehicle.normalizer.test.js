import { describe, it, expect } from "vitest";
import { normalizeVehicleTelemetry, modeLabel } from "../normalizers/vehicle.js";

// Helper to call with a type-keyed message
function norm(type, message, topic = "") {
  return normalizeVehicleTelemetry(message, type, topic);
}

// ─── modeLabel ───────────────────────────────────────────────────────────────

describe("modeLabel", () => {
  it("maps integers to labels", () => {
    expect(modeLabel(0)).toBe("Manual");
    expect(modeLabel(1)).toBe("Autonomous");
    expect(modeLabel(2)).toBe("Teleoperated");
    expect(modeLabel(3)).toBe("Emergency");
  });

  it("accepts numeric strings", () => {
    expect(modeLabel("1")).toBe("Autonomous");
  });

  it("returns undefined for unknown values", () => {
    expect(modeLabel(99)).toBeUndefined();
    expect(modeLabel(-1)).toBeUndefined();
  });
});

// ─── VelocityInformation ─────────────────────────────────────────────────────

describe("VelocityInformation", () => {
  it("extracts speed in m/s (× 0.01) and km/h (× 0.1)", () => {
    const result = norm("VelocityInformation", { VelocityMS: 200, VelocityKMH: 720 });
    expect(result.speed).toBeCloseTo(2.0);
    expect(result.vehicle.speedKmh).toBeCloseTo(72.0);
  });

  it("ignores zero/null velocity fields (CAN empty frames)", () => {
    const result = norm("VelocityInformation", { VelocityMS: null, VelocityKMH: 0 });
    // All zeros → nothing to write → normalizer returns undefined so state is unchanged.
    expect(result).toBeUndefined();
  });
});

// ─── EPS ─────────────────────────────────────────────────────────────────────

describe("EPS_Response", () => {
  it("extracts steering angle and fault flags", () => {
    const result = norm("EPS_Response", {
      EPS_StrAng: 15.5,
      EPS_FltStat: 0,
      EPS_WorkStat: 1,
    });
    expect(result.vehicle.steeringAngle).toBe(15.5);
    expect(result.vehicle.epsWork).toBe(true);
    expect(result.vehicle.epsFault).toBe(false);
  });

  it("sets epsFault true when any fault flag is set", () => {
    const result = norm("EPS_Response", { EPS_FltLv2Stat: 1 });
    expect(result.vehicle.epsFault).toBe(true);
  });
});

describe("SteerControl (by topic)", () => {
  it("extracts target angle via topic match", () => {
    const result = normalizeVehicleTelemetry(
      { desired_angle: 25, desired_angle_speed: 10 },
      "beemobs_routine_manager/SteerControl",
      "/steer_control",
    );
    expect(result.vehicle.targetSteeringAngle).toBe(25);
    expect(result.vehicle.targetSteeringSpeed).toBe(10);
  });
});

// ─── Brakes ──────────────────────────────────────────────────────────────────

describe("BrakeControl", () => {
  it("extracts brake_percent", () => {
    const result = norm("BrakeControl", { brake_percent: 42 });
    expect(result.vehicle.brakePercent).toBe(42);
  });

  it("returns 0 for zero brake", () => {
    const result = norm("BrakeControl", { brake_percent: 0 });
    expect(result.vehicle.brakePercent).toBe(0);
  });
});

describe("EHB_BrakingResponse", () => {
  it("scales pressure by 0.125 and extracts pedal/parking", () => {
    const result = norm("EHB_BrakingResponse", {
      EHB_ActualPressure: 80,   // × 0.125 = 10 bar
      EHB_BrkPedallStk: 5,
      EHB_ParkingBrakeRequest: 1,
    });
    expect(result.vehicle.brakePressure).toBeCloseTo(10);
    expect(result.vehicle.brakePedal).toBe(5);
    expect(result.vehicle.parkingBrake).toBe(true);
  });
});

// ─── Throttle ────────────────────────────────────────────────────────────────

describe("CruiseControlSignals", () => {
  it("extracts setSpeed_kmh and cruiseActive", () => {
    const result = norm("CruiseControlSignals", { setSpeed_kmh: 30, cruiseActive: true });
    expect(result.vehicle.throttleSetSpeedKmh).toBe(30);
    expect(result.vehicle.cruiseActive).toBe(true);
  });

  it("treats numeric 1 as truthy cruiseActive", () => {
    const result = norm("CruiseControlSignals", { setSpeed_kmh: 0, cruiseActive: 1 });
    expect(result.vehicle.cruiseActive).toBe(true);
  });
});

// ─── Vehicle state / RC unit ─────────────────────────────────────────────────

describe("Fb_OmuxToAutonomous / rc_unit_report", () => {
  it("extracts battery, ignition, signals, and emergency flags", () => {
    // Type check uses includes("fb_omux_to_autonomous") — underscores required
    const result = norm("Fb_Omux_To_Autonomous", {
      FB_BatterySOC: 85,
      FB_BatteryVoltage: 48,
      FB_IGNITION: 1,
      FB_LeftSignal: 0,
      FB_RightSignal: 1,
      FB_EMERGENCY: 0,
      FB_HANDBRAKESTATUS: 1,
    });
    expect(result.vehicle.batterySoc).toBe(85);
    expect(result.vehicle.batteryVoltage).toBe(48);
    expect(result.vehicle.ignition).toBe(true);
    expect(result.vehicle.leftSignal).toBe(false);
    expect(result.vehicle.rightSignal).toBe(true);
    expect(result.vehicle.emergency).toBe(false);
    expect(result.vehicle.handbrake).toBe(true);
  });
});

// ─── VehicleMode ─────────────────────────────────────────────────────────────

describe("VehicleMode", () => {
  it("translates mode number to label", () => {
    expect(norm("VehicleMode", { mode: 2 }).vehicle.mode).toBe("Teleoperated");
    expect(norm("VehicleMode", { mode: 3 }).vehicle.mode).toBe("Emergency");
  });

  it("stringifies unknown mode values", () => {
    expect(norm("VehicleMode", { mode: 99 }).vehicle.mode).toBe("99");
  });
});

// ─── Unknown type ─────────────────────────────────────────────────────────────

describe("unknown message type", () => {
  it("returns undefined for completely unrecognised type and topic", () => {
    expect(norm("RandomUnknownType", { foo: 1 }, "/some/topic")).toBeUndefined();
  });
});
