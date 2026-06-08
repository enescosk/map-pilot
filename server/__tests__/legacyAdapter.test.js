import { describe, it, expect } from "vitest";
import { toLegacyTelemetry } from "../transport/legacyAdapter.js";

function adapt(canonical, invalid = []) {
  return toLegacyTelemetry(canonical, invalid, {});
}

describe("toLegacyTelemetry", () => {
  it("returns undefined for null/undefined input", () => {
    expect(adapt(null)).toBeUndefined();
    expect(adapt(undefined)).toBeUndefined();
  });

  it("returns undefined when canonical has no vehicle fields", () => {
    expect(adapt({})).toBeUndefined();
  });

  // ─── Speed ────────────────────────────────────────────────────────────────

  it("unwraps speedMps to telemetry.speed", () => {
    const result = adapt({ vehicle: { speedMps: { value: 5.0, unit: "m/s" } } });
    expect(result.speed).toBeCloseTo(5.0);
  });

  it("unwraps speedKmh to vehicle.speedKmh", () => {
    const result = adapt({ vehicle: { speedKmh: { value: 72.0, unit: "km/h" } } });
    expect(result.vehicle.speedKmh).toBeCloseTo(72.0);
  });

  // ─── Steering ─────────────────────────────────────────────────────────────

  it("unwraps steeringAngleDeg to vehicle.steeringAngle", () => {
    const result = adapt({ vehicle: { steeringAngleDeg: { value: 15, unit: "deg" } } });
    expect(result.vehicle.steeringAngle).toBe(15);
  });

  it("maps epsWork and epsFault booleans", () => {
    const result = adapt({ vehicle: { epsWork: true, epsFault: false } });
    expect(result.vehicle.epsWork).toBe(true);
    expect(result.vehicle.epsFault).toBe(false);
  });

  // ─── Brake ────────────────────────────────────────────────────────────────

  it("maps brake fields to legacy names", () => {
    const result = adapt({
      vehicle: {
        brake: {
          pressureBar: 10,
          pedalRaw: 5,
          parking: true,
          active: true,
          faultLevel: 2,
        },
      },
    });
    expect(result.vehicle.brakePressure).toBe(10);
    expect(result.vehicle.brakePedal).toBe(5);
    expect(result.vehicle.parkingBrake).toBe(true);
    expect(result.vehicle.brakeSystemActive).toBe(true);
    expect(result.vehicle.brakeFaultLevel).toBe(2);
  });

  // ─── Throttle ─────────────────────────────────────────────────────────────

  it("maps throttle.setSpeedKmh and cruiseActive", () => {
    const result = adapt({ vehicle: { throttle: { setSpeedKmh: 50, cruiseActive: true } } });
    expect(result.vehicle.throttleSetSpeedKmh).toBe(50);
    expect(result.vehicle.cruiseActive).toBe(true);
  });

  // ─── Drivetrain ───────────────────────────────────────────────────────────

  it("maps drivetrain fields", () => {
    const result = adapt({ vehicle: { drivetrain: { rpm: 1500, gear: 3, tripDistance: 999 } } });
    expect(result.vehicle.rpm).toBe(1500);
    expect(result.vehicle.gear).toBe(3);
    expect(result.vehicle.tripDistance).toBe(999);
  });

  // ─── Vehicle state ────────────────────────────────────────────────────────

  it("maps vehicle state summary fields", () => {
    const result = adapt({
      vehicle: {
        state: {
          mode: "Autonomous",
          batterySoc: 80,
          batteryVoltage: 48,
          ignition: true,
          leftSignal: false,
          rightSignal: true,
          emergency: false,
          handbrake: false,
        },
      },
    });
    expect(result.vehicle.mode).toBe("Autonomous");
    expect(result.vehicle.batterySoc).toBe(80);
    expect(result.vehicle.ignition).toBe(true);
    expect(result.vehicle.rightSignal).toBe(true);
  });

  // ─── Invalid fields ───────────────────────────────────────────────────────

  it("surfaces invalid fields in telemetry.invalidFields", () => {
    const result = adapt(
      { vehicle: { speedMps: { value: 5, unit: "m/s" } } },
      [{ field: "vehicle.speedMps", reason: "out-of-range" }],
    );
    expect(result.invalidFields).toEqual(["vehicle.speedMps"]);
  });

  it("does not include invalidFields when invalid array is empty", () => {
    const result = adapt({ vehicle: { speedMps: { value: 1, unit: "m/s" } } }, []);
    expect(result.invalidFields).toBeUndefined();
  });
});
