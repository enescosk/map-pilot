import { describe, it, expect } from "vitest";
import { normalizeDerivedTelemetry } from "../normalizers/derivedTelemetry.js";

function norm(type, message, topic = "", options = {}) {
  return normalizeDerivedTelemetry(message, type, topic, options);
}

// ─── Odometry ─────────────────────────────────────────────────────────────────

describe("Odometry", () => {
  const msg = {
    twist: {
      twist: {
        linear:  { x: 3, y: 4, z: 0 },
        angular: { x: 0, y: 0, z: 0.1 },
      },
    },
    pose: {
      pose: {
        position:    { x: 1, y: 2, z: 0 },
        orientation: { x: 0, y: 0, z: 0, w: 1 }, // identity → yaw = 0°
      },
    },
  };

  it("extracts speed magnitude from linear velocity", () => {
    const result = norm("nav_msgs/Odometry", msg);
    expect(result.speed).toBeCloseTo(5.0); // sqrt(3²+4²+0²)
    expect(result.vehicle.speedKmh).toBeCloseTo(18.0); // 5 * 3.6
  });

  it("extracts heading from identity quaternion (0°)", () => {
    const result = norm("nav_msgs/Odometry", msg);
    expect(result.heading).toBe(0);
  });

  it("includes linearVelocity, angularVelocity, and pose", () => {
    const result = norm("nav_msgs/Odometry", msg);
    expect(result.linearVelocity).toEqual(msg.twist.twist.linear);
    expect(result.angularVelocity).toEqual(msg.twist.twist.angular);
    expect(result.pose).toEqual(msg.pose.pose);
  });

  it("sets derived:true and derivedFrom equal to topic", () => {
    const result = norm("nav_msgs/Odometry", msg, "/odom");
    expect(result.derived).toBe(true);
    expect(result.derivedFrom).toBe("/odom");
  });

  it("suppresses speed and vehicle when nativeSpeedAvailable is true", () => {
    const result = norm("nav_msgs/Odometry", msg, "/odom", { nativeSpeedAvailable: true });
    expect(result.speed).toBeUndefined();
    expect(result.vehicle).toBeUndefined();
  });

  it("matches by topic containing 'odom' regardless of type string", () => {
    const result = norm("UnknownType", msg, "/robot/odom");
    expect(result.speed).toBeDefined();
  });

  it("handles missing twist gracefully (zero speed is not emitted)", () => {
    const result = norm("nav_msgs/Odometry", {});
    // Zero speed from missing/zero twist is filtered — state holds last valid reading.
    expect(result.speed).toBeUndefined();
  });
});

// ─── IMU ──────────────────────────────────────────────────────────────────────

describe("IMU", () => {
  const msg = {
    linear_acceleration: { x: 0,   y: 0, z: 9.81 },
    angular_velocity:    { x: 0.1, y: 0, z: 0 },
    orientation:         { x: 0,   y: 0, z: 0, w: 1 },
  };

  it("extracts acceleration, angularVelocity, and orientation", () => {
    const result = norm("sensor_msgs/Imu", msg);
    expect(result.acceleration).toEqual(msg.linear_acceleration);
    expect(result.angularVelocity).toEqual(msg.angular_velocity);
    expect(result.orientation).toEqual(msg.orientation);
  });

  it("computes accelerationMagnitude (z-only → ≈ 9.81)", () => {
    const result = norm("sensor_msgs/Imu", msg);
    expect(result.accelerationMagnitude).toBeCloseTo(9.81);
  });

  it("sets derived:true", () => {
    const result = norm("sensor_msgs/Imu", msg);
    expect(result.derived).toBe(true);
  });

  it("matches by topic containing 'imu'", () => {
    const result = norm("UnknownType", msg, "/imu/data");
    expect(result.accelerationMagnitude).toBeDefined();
  });

  it("handles missing linear_acceleration (magnitude = 0)", () => {
    const result = norm("sensor_msgs/Imu", {});
    expect(result.accelerationMagnitude).toBe(0);
  });
});

// ─── Float64 / heading ────────────────────────────────────────────────────────

describe("Float64 heading", () => {
  it("extracts heading from message.data", () => {
    const result = norm("std_msgs/Float64", { data: 90 }, "/heading");
    expect(result.heading).toBe(90);
  });

  it("normalises negative angles to 0-360", () => {
    const result = norm("std_msgs/Float64", { data: -90 }, "/heading");
    expect(result.heading).toBe(270);
  });

  it("wraps angles above 360", () => {
    const result = norm("std_msgs/Float64", { data: 400 }, "/heading");
    expect(result.heading).toBeCloseTo(40);
  });

  it("rounds to 2 decimal places", () => {
    const result = norm("std_msgs/Float64", { data: 10.123456 }, "/heading");
    expect(result.heading).toBe(10.12);
  });

  it("matches by topic ending with /heading", () => {
    const result = norm("UnknownType", { data: 45 }, "/robot/heading");
    expect(result.heading).toBe(45);
  });

  it("returns undefined when heading value cannot be parsed", () => {
    expect(norm("std_msgs/Float64", {}, "/heading")).toBeUndefined();
    expect(norm("std_msgs/Float64", { data: "not-a-number" }, "/heading")).toBeUndefined();
  });
});

// ─── NavSatFix / GPS ─────────────────────────────────────────────────────────

describe("NavSatFix", () => {
  it("extracts latitude, longitude, altitude", () => {
    const result = norm("sensor_msgs/NavSatFix", {
      latitude: 41.0, longitude: 28.9, altitude: 50,
    });
    expect(result.gps).toEqual({ latitude: 41.0, longitude: 28.9, altitude: 50 });
  });

  it("sets derived:true", () => {
    const result = norm("sensor_msgs/NavSatFix", { latitude: 0, longitude: 0, altitude: 0 });
    expect(result.derived).toBe(true);
  });

  it("matches by topic containing 'gps'", () => {
    const result = norm("UnknownType", { latitude: 10, longitude: 20, altitude: 0 }, "/gps/fix");
    expect(result.gps).toBeDefined();
  });

  it("matches by topic containing 'navsat'", () => {
    const result = norm("UnknownType", { latitude: 10, longitude: 20, altitude: 0 }, "/navsat/fix");
    expect(result.gps).toBeDefined();
  });
});

// ─── Unknown type ─────────────────────────────────────────────────────────────

describe("unknown message type", () => {
  it("returns undefined for an unrecognised type and topic", () => {
    expect(norm("SomeRandomType", { foo: 1 }, "/some/topic")).toBeUndefined();
  });

  it("returns undefined for an empty type and non-matching topic", () => {
    expect(norm("", { foo: 1 }, "/random")).toBeUndefined();
  });
});
