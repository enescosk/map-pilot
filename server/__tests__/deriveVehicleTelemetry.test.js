import { describe, it, expect } from "vitest";
import {
  speedFromTwist,
  steeringAngleFromYaw,
  rpmFromSpeed,
  pedalsFromAccel,
  createVehicleDeriver,
} from "../sources/deriveVehicleTelemetry.js";

describe("speedFromTwist", () => {
  it("returns hypot of x/y (ground speed)", () => {
    expect(speedFromTwist({ x: 3, y: 4 })).toBeCloseTo(5);
  });
  it("ignores z and treats missing as 0", () => {
    expect(speedFromTwist({ x: 6.94, z: 99 })).toBeCloseTo(6.94);
    expect(speedFromTwist(null)).toBe(0);
  });
});

describe("steeringAngleFromYaw", () => {
  it("is 0 below the minimum speed (noise guard)", () => {
    expect(steeringAngleFromYaw(0.3, 0.2)).toBe(0);
  });
  it("turns right (positive) for positive yaw rate while moving", () => {
    const deg = steeringAngleFromYaw(0.2, 6.94);
    expect(deg).toBeGreaterThan(0);
    expect(deg).toBeLessThan(10);
  });
  it("clamps to the believable max", () => {
    expect(steeringAngleFromYaw(50, 5)).toBeLessThanOrEqual(35);
    expect(steeringAngleFromYaw(-50, 5)).toBeGreaterThanOrEqual(-35);
  });
});

describe("rpmFromSpeed", () => {
  it("is 0 at standstill", () => {
    expect(rpmFromSpeed(0)).toBe(0);
  });
  it("scales with speed", () => {
    expect(rpmFromSpeed(6.94)).toBeGreaterThan(rpmFromSpeed(3));
  });
});

describe("pedalsFromAccel", () => {
  it("maps positive accel to throttle, zero brake", () => {
    const p = pedalsFromAccel(1.0);
    expect(p.throttlePercent).toBeGreaterThan(0);
    expect(p.brakePercent).toBe(0);
  });
  it("maps negative accel to brake, zero throttle", () => {
    const p = pedalsFromAccel(-1.5);
    expect(p.brakePercent).toBeGreaterThan(0);
    expect(p.throttlePercent).toBe(0);
  });
  it("returns zeros inside the deadband", () => {
    expect(pedalsFromAccel(0.05)).toEqual({ throttlePercent: 0, brakePercent: 0 });
  });
});

describe("createVehicleDeriver", () => {
  it("returns null until a speed sample arrives", () => {
    const d = createVehicleDeriver();
    expect(d.ingest("/imu/data", "sensor_msgs/Imu", { angular_velocity: { z: 0.1 } }, 1000)).toBeNull();
  });

  it("emits a synthetic vehicle patch once speed is known", () => {
    const d = createVehicleDeriver();
    d.ingest("/imu/data", "sensor_msgs/Imu", { angular_velocity: { z: 0.2 }, linear_acceleration: { x: 1.0 } }, 0);
    const patch = d.ingest(
      "/gnss_1/velocity",
      "geometry_msgs/TwistWithCovarianceStamped",
      { twist: { twist: { linear: { x: 6.94, y: 0 } } } },
      1000,
    );
    expect(patch).not.toBeNull();
    expect(patch.synthetic).toBe(true);
    expect(patch.vehicle.synthetic).toBe(true);
    expect(patch.vehicle.speedKmh).toBeCloseTo(25, 0);
    expect(patch.speed).toBeCloseTo(6.94, 1);
    expect(patch.vehicle.steeringAngle).toBeGreaterThan(0);
    expect(patch.vehicle.throttlePedalPercent).toBeGreaterThan(0);
    expect(patch.vehicle.rpm).toBeGreaterThan(0);
  });

  it("throttles output to the configured interval", () => {
    const d = createVehicleDeriver();
    const first = d.ingest("/gnss_1/velocity", "twistwithcovariance", { twist: { twist: { linear: { x: 5, y: 0 } } } }, 0);
    const tooSoon = d.ingest("/imu/data", "imu", { angular_velocity: { z: 0 } }, 10);
    const later = d.ingest("/imu/data", "imu", { angular_velocity: { z: 0 } }, 200);
    expect(first).not.toBeNull();
    expect(tooSoon).toBeNull();
    expect(later).not.toBeNull();
  });

  it("passes heading through when available", () => {
    const d = createVehicleDeriver();
    d.ingest("/heading", "std_msgs/Float64", { data: 78.2 }, 0);
    const patch = d.ingest("/gnss_1/velocity", "twistwithcovariance", { twist: { twist: { linear: { x: 5, y: 0 } } } }, 1000);
    expect(patch.heading).toBeCloseTo(78.2, 1);
  });
});
