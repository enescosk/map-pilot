import { describe, it, expect } from "vitest";
import { laserScanToReadings } from "../normalizers/laserScan.js";

function makeScan(overrides = {}) {
  return {
    angle_min: -Math.PI,
    angle_increment: Math.PI / 180, // 1° per step
    range_min: 0.1,
    range_max: 10.0,
    ranges: Array(360).fill(1.0),
    intensities: [],
    ...overrides,
  };
}

describe("laserScanToReadings", () => {
  it("returns empty array for null/undefined", () => {
    expect(laserScanToReadings(null)).toEqual([]);
    expect(laserScanToReadings(undefined)).toEqual([]);
  });

  it("returns empty array when ranges is not an array", () => {
    expect(laserScanToReadings({ ranges: "bad" })).toEqual([]);
  });

  it("parses a simple 360-point scan", () => {
    const readings = laserScanToReadings(makeScan());
    expect(readings.length).toBeGreaterThan(0);
    readings.forEach((r) => {
      expect(r.angle).toBeGreaterThanOrEqual(0);
      expect(r.angle).toBeLessThan(360);
      expect(r.distance).toBeGreaterThan(0);
    });
  });

  it("filters out NaN and Infinity ranges", () => {
    const scan = makeScan({ ranges: [NaN, Infinity, -Infinity, 1.5, 2.0] });
    const readings = laserScanToReadings(scan);
    readings.forEach((r) => expect(Number.isFinite(r.distance)).toBe(true));
  });

  it("filters out ranges below range_min", () => {
    const scan = makeScan({ ranges: [0.05, 1.0], range_min: 0.1 });
    const readings = laserScanToReadings(scan);
    readings.forEach((r) => expect(r.distance).toBeGreaterThanOrEqual(0.1));
  });

  it("filters out ranges above range_max", () => {
    const scan = makeScan({ ranges: [5.0, 15.0], range_max: 10.0 });
    const readings = laserScanToReadings(scan);
    readings.forEach((r) => expect(r.distance).toBeLessThanOrEqual(10.0));
  });

  it("filters out zero distances", () => {
    const scan = makeScan({ ranges: [0, 1.0] });
    const readings = laserScanToReadings(scan);
    readings.forEach((r) => expect(r.distance).toBeGreaterThan(0));
  });

  it("includes angleRadians and intensity fields", () => {
    const scan = makeScan({
      ranges: [2.0],
      intensities: [100],
      angle_min: 0,
      angle_increment: 0,
    });
    const readings = laserScanToReadings(scan);
    expect(readings[0]).toHaveProperty("angleRadians");
    expect(readings[0]).toHaveProperty("intensity");
    expect(readings[0].intensity).toBe(100);
  });

  it("normalizes negative angles to [0, 360)", () => {
    const scan = makeScan({
      ranges: [1.0],
      angle_min: -Math.PI,
      angle_increment: 0,
    });
    const readings = laserScanToReadings(scan);
    expect(readings[0].angle).toBeGreaterThanOrEqual(0);
    expect(readings[0].angle).toBeLessThan(360);
  });

  it("returns empty array when all ranges are invalid", () => {
    const scan = makeScan({ ranges: [NaN, 0, -1, Infinity] });
    expect(laserScanToReadings(scan)).toEqual([]);
  });
});
