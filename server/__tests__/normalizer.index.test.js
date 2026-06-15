import { describe, it, expect, beforeEach } from "vitest";
import { normalizeFrame } from "../normalizers/index.js";
import { telemetryStore } from "../services/telemetryStore.js";

beforeEach(() => {
  telemetryStore.reset();
});

function frame(topic, type, message, source = "test") {
  return normalizeFrame({ topic, type, time: "2025-01-01T00:00:00.000Z", source, message });
}

// ─── Topic-map path (canonical pipeline) ─────────────────────────────────────

describe("normalizeFrame — canonical pipeline (topic map)", () => {
  it("routes /VelocityInformation through topic map and returns telemetry envelope", () => {
    const result = frame("/VelocityInformation", "dbw_interface/VelocityInformation", {
      VelocityMS: 200,
      VelocityKMH: 720,
    });
    expect(result.type).toBe("telemetry");
    expect(result.telemetry.speed).toBeCloseTo(2.0);
    expect(result.telemetry.vehicle.speedKmh).toBeCloseTo(7.2);
  });

  it("routes /eps_response through topic map", () => {
    const result = frame("/eps_response", "dbw_interface/EPS_Response", {
      EPS_StrAng: 10,
      EPS_WorkStat: 1,
    });
    expect(result.type).toBe("telemetry");
    expect(result.telemetry.vehicle.steeringAngle).toBe(10);
  });

  it("routes /EHB_BrakingResponse through topic map", () => {
    const result = frame("/EHB_BrakingResponse", "dbw_interface/EHB_BrakingResponse", {
      EHB_ActualPressure: 80,
    });
    expect(result.type).toBe("telemetry");
    expect(result.telemetry.vehicle.brakePressure).toBeCloseTo(10.0);
  });
});

// ─── Legacy path ──────────────────────────────────────────────────────────────

describe("normalizeFrame — legacy path", () => {
  it("routes LaserScan to scan envelope", () => {
    const result = frame("/scan", "sensor_msgs/LaserScan", {
      angle_min: 0,
      angle_increment: Math.PI / 180,
      range_min: 0.1,
      range_max: 10,
      ranges: [1.0, 2.0, 3.0],
    });
    expect(result.type).toBe("scan");
    expect(Array.isArray(result.readings)).toBe(true);
  });

  it("routes CompressedImage to camera-frame envelope", () => {
    const result = frame("/out/compressed", "sensor_msgs/CompressedImage", {
      format: "jpeg",
      data: Buffer.from([0xff, 0xd8]),
    });
    expect(result.type).toBe("camera-frame");
    expect(result.src).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("routes CompressedImage byte array (rosbridge format) to camera-frame", () => {
    const result = frame("/zed2i/zed_node/rgb/image_rect_color/compressed", "sensor_msgs/CompressedImage", {
      format: "jpeg",
      data: [0xff, 0xd8, 0xff],
    });
    expect(result.type).toBe("camera-frame");
    expect(result.src).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("routes nav_msgs/Odometry to telemetry with pose but no derived speed", () => {
    const result = frame("/ekf/odometry_earth", "nav_msgs/Odometry", {
      twist: { twist: { linear: { x: 3, y: 4, z: 0 }, angular: { x: 0, y: 0, z: 0 } } },
      pose: { pose: { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } },
    });
    expect(result.type).toBe("telemetry");
    // Speed is never derived from odometry — only from CAN /VelocityInformation.
    expect(result.telemetry.speed).toBeUndefined();
    expect(result.telemetry.pose).toBeDefined();
  });

  it("routes sensor_msgs/NavSatFix to telemetry with gps", () => {
    const result = frame("/navsatfix", "sensor_msgs/NavSatFix", {
      latitude: 41.0,
      longitude: 28.0,
      altitude: 100.0,
    });
    expect(result.type).toBe("telemetry");
    expect(result.telemetry.gps.latitude).toBe(41.0);
    expect(result.telemetry.gps.longitude).toBe(28.0);
  });

  it("routes sensor_msgs/Imu to telemetry with acceleration", () => {
    const result = frame("/imu/data", "sensor_msgs/Imu", {
      linear_acceleration: { x: 0, y: 0, z: 9.8 },
      angular_velocity: { x: 0, y: 0, z: 0 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    });
    expect(result.type).toBe("telemetry");
    expect(result.telemetry.accelerationMagnitude).toBeCloseTo(9.8);
  });

  it("returns bag-frame for unknown topic and type", () => {
    const result = frame("/unknown/topic", "custom_msgs/Unknown", { foo: 1 });
    expect(result.type).toBe("bag-frame");
    expect(result.topic).toBe("/unknown/topic");
  });
});

// ─── Field extraction edge cases ─────────────────────────────────────────────

describe("normalizeFrame — edge cases", () => {
  it("handles missing time gracefully", () => {
    const result = normalizeFrame({
      topic: "/VelocityInformation",
      type: "dbw_interface/VelocityInformation",
      source: "test",
      message: { VelocityMS: 100 },
    });
    expect(result.type).toBe("telemetry");
  });

  it("handles empty message without throwing", () => {
    expect(() => frame("/unknown", "unknown/Type", {})).not.toThrow();
  });

  it("handles null message without throwing", () => {
    expect(() => normalizeFrame({ topic: "/scan", type: "sensor_msgs/LaserScan", message: null })).not.toThrow();
  });
});
