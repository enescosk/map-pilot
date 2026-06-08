import { describe, it, expect } from "vitest";
import { pointCloudToReadings } from "../normalizers/pointCloud.js";
import { pointCloud2ToReadings, pointCloud2ToPoints } from "../normalizers/pointCloud2.js";

// ─── pointCloudToReadings (legacy PointCloud) ─────────────────────────────────

describe("pointCloudToReadings", () => {
  it("returns empty array for null/undefined", () => {
    expect(pointCloudToReadings(null)).toEqual([]);
    expect(pointCloudToReadings(undefined)).toEqual([]);
  });

  it("returns empty array when points is not an array", () => {
    expect(pointCloudToReadings({ points: "bad" })).toEqual([]);
  });

  it("converts x/y points to angle/distance readings", () => {
    const readings = pointCloudToReadings({
      points: [{ x: 1, y: 0 }, { x: 0, y: 1 }],
    });
    expect(readings).toHaveLength(2);
    expect(readings[0].distance).toBeCloseTo(1.0);
    expect(readings[0].angle).toBeCloseTo(0); // atan2(0,1) = 0°
    expect(readings[1].distance).toBeCloseTo(1.0);
    expect(readings[1].angle).toBeCloseTo(90); // atan2(1,0) = 90°
  });

  it("filters out zero-distance points", () => {
    const readings = pointCloudToReadings({
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    });
    expect(readings).toHaveLength(1);
    expect(readings[0].distance).toBeCloseTo(1.0);
  });

  it("normalizes negative angles to [0, 360)", () => {
    // atan2(0, -1) = 180°, atan2(-1, 0) = -90° → 270°
    const readings = pointCloudToReadings({
      points: [{ x: -1, y: 0 }, { x: 0, y: -1 }],
    });
    readings.forEach((r) => {
      expect(r.angle).toBeGreaterThanOrEqual(0);
      expect(r.angle).toBeLessThan(360);
    });
  });
});

// ─── pointCloud2ToReadings ────────────────────────────────────────────────────

function makePC2(points) {
  // Build a minimal PointCloud2 buffer with x(float32) y(float32) z(float32)
  const pointStep = 12; // 3 × 4 bytes
  const buf = Buffer.alloc(points.length * pointStep);
  points.forEach(({ x, y, z = 0 }, i) => {
    buf.writeFloatLE(x, i * pointStep + 0);
    buf.writeFloatLE(y, i * pointStep + 4);
    buf.writeFloatLE(z, i * pointStep + 8);
  });
  return {
    data: buf,
    width: points.length,
    height: 1,
    point_step: pointStep,
    is_bigendian: false,
    fields: [
      { name: "x", offset: 0,  datatype: 7 },
      { name: "y", offset: 4,  datatype: 7 },
      { name: "z", offset: 8,  datatype: 7 },
    ],
  };
}

describe("pointCloud2ToReadings", () => {
  it("returns empty array for null/undefined", () => {
    expect(pointCloud2ToReadings(null)).toEqual([]);
    expect(pointCloud2ToReadings(undefined)).toEqual([]);
  });

  it("returns empty array when required fields are missing", () => {
    expect(pointCloud2ToReadings({ data: Buffer.alloc(4) })).toEqual([]);
  });

  it("parses a two-point cloud", () => {
    const msg = makePC2([{ x: 1, y: 0 }, { x: 0, y: 2 }]);
    const readings = pointCloud2ToReadings(msg);
    expect(readings).toHaveLength(2);
    expect(readings[0].distance).toBeCloseTo(1.0);
    expect(readings[1].distance).toBeCloseTo(2.0);
  });

  it("skips points with zero distance", () => {
    const msg = makePC2([{ x: 0, y: 0 }, { x: 1, y: 0 }]);
    const readings = pointCloud2ToReadings(msg);
    expect(readings).toHaveLength(1);
  });

  it("produces angles in [0, 360)", () => {
    const msg = makePC2([{ x: -1, y: -1 }, { x: 1, y: 1 }]);
    const readings = pointCloud2ToReadings(msg);
    readings.forEach((r) => {
      expect(r.angle).toBeGreaterThanOrEqual(0);
      expect(r.angle).toBeLessThan(360);
    });
  });
});

// ─── pointCloud2ToPoints ──────────────────────────────────────────────────────

describe("pointCloud2ToPoints", () => {
  it("returns empty array for missing data", () => {
    expect(pointCloud2ToPoints(null)).toEqual([]);
  });

  it("extracts x/y/z from a simple cloud", () => {
    const msg = makePC2([{ x: 1.5, y: 2.5, z: 3.5 }]);
    const points = pointCloud2ToPoints(msg);
    expect(points).toHaveLength(1);
    expect(points[0].x).toBeCloseTo(1.5);
    expect(points[0].y).toBeCloseTo(2.5);
    expect(points[0].z).toBeCloseTo(3.5);
  });

  it("skips all-zero points (origin noise)", () => {
    const msg = makePC2([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]);
    const points = pointCloud2ToPoints(msg);
    expect(points).toHaveLength(1);
    expect(points[0].x).toBeCloseTo(1);
  });

  it("includes intensity field when present", () => {
    const pointStep = 16;
    const buf = Buffer.alloc(pointStep);
    buf.writeFloatLE(1.0, 0);
    buf.writeFloatLE(2.0, 4);
    buf.writeFloatLE(3.0, 8);
    buf.writeFloatLE(0.75, 12);
    const msg = {
      data: buf,
      width: 1,
      height: 1,
      point_step: pointStep,
      is_bigendian: false,
      fields: [
        { name: "x",         offset: 0,  datatype: 7 },
        { name: "y",         offset: 4,  datatype: 7 },
        { name: "z",         offset: 8,  datatype: 7 },
        { name: "intensity", offset: 12, datatype: 7 },
      ],
    };
    const points = pointCloud2ToPoints(msg);
    expect(points[0].intensity).toBeCloseTo(0.75);
  });
});
