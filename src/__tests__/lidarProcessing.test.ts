import { describe, it, expect } from "vitest";
import {
  buildPointCloudFromScan,
  scanReadingsToPoints,
  appendLidarHistory,
  selectRenderablePoints,
  selectStoredLiveXyzi,
  denoisePointCloud,
  chooseBestPointCloudTopic,
  LIDAR_FILTER_VERSION,
} from "../utils/lidarProcessing";
import type { Point3D, LidarReading } from "../types/liveMessages";

function pt(x: number, y: number, z = 0): Point3D {
  return { x, y, z };
}

function toXyzi(points: Point3D[]): Float32Array {
  const out = new Float32Array(points.length * 4);
  points.forEach((p, i) => {
    out[i * 4] = p.x;
    out[i * 4 + 1] = p.y;
    out[i * 4 + 2] = p.z;
    out[i * 4 + 3] = p.intensity ?? 0;
  });
  return out;
}

// ─── buildPointCloudFromScan ──────────────────────────────────────────────────

describe("buildPointCloudFromScan", () => {
  it("converts polar scan to cartesian points", () => {
    const points = buildPointCloudFromScan({
      angle_min: 0,
      angle_increment: Math.PI / 2,
      range_min: 0,
      range_max: 10,
      ranges: [1.0, 1.0],
    });
    expect(points).toHaveLength(2);
    expect(points[0].x).toBeCloseTo(1.0); // angle=0 → x=1, y=0
    expect(points[0].y).toBeCloseTo(0.0);
    expect(points[1].x).toBeCloseTo(0.0); // angle=π/2 → x=0, y=1
    expect(points[1].y).toBeCloseTo(1.0);
  });

  it("filters out-of-range values", () => {
    const points = buildPointCloudFromScan({
      angle_min: 0,
      angle_increment: 0.1,
      range_min: 0.5,
      range_max: 5.0,
      ranges: [0.1, 2.0, 8.0, NaN],
    });
    expect(points).toHaveLength(1);
    expect(points[0].x).not.toBeNaN();
  });

  it("returns empty array for empty scan", () => {
    expect(buildPointCloudFromScan({ ranges: [] })).toEqual([]);
  });
});

// ─── scanReadingsToPoints ─────────────────────────────────────────────────────

describe("scanReadingsToPoints", () => {
  it("converts readings to points", () => {
    const readings: LidarReading[] = [
      { angle: 0, distance: 1.0 },
      { angle: 90, distance: 2.0 },
    ];
    const points = scanReadingsToPoints(readings);
    expect(points).toHaveLength(2);
    expect(points[0].x).toBeCloseTo(1.0);
    expect(points[1].y).toBeCloseTo(2.0);
  });

  it("filters zero/NaN distances", () => {
    const readings: LidarReading[] = [
      { angle: 0, distance: 0 },
      { angle: 0, distance: NaN },
      { angle: 0, distance: 1.0 },
    ];
    expect(scanReadingsToPoints(readings)).toHaveLength(1);
  });
});

// ─── appendLidarHistory ───────────────────────────────────────────────────────

describe("appendLidarHistory", () => {
  it("appends new points to existing history", () => {
    const current = [pt(1, 0), pt(2, 0)];
    const result = appendLidarHistory(current, [pt(3, 0)]);
    expect(result).toHaveLength(3);
  });

  it("returns current unchanged when nextPoints is empty", () => {
    const current = [pt(1, 0)];
    expect(appendLidarHistory(current, [])).toBe(current);
  });

  it("trims to MAX_LIDAR_HISTORY_POINTS (32000)", () => {
    const big = Array.from({ length: 32000 }, (_, i) => pt(i, 0));
    const result = appendLidarHistory(big, [pt(99999, 0)]);
    expect(result).toHaveLength(32000);
    expect(result[result.length - 1].x).toBe(99999);
  });
});

// ─── selectStoredLivePoints ───────────────────────────────────────────────────

describe("selectStoredLiveXyzi", () => {
  it("returns input unchanged when under limit", () => {
    const xyzi = toXyzi([pt(1, 0), pt(2, 0)]);
    const result = selectStoredLiveXyzi(xyzi, 2);
    expect(result.xyzi).toBe(xyzi);
    expect(result.count).toBe(2);
  });

  it("downsamples when over the stored-live cap", () => {
    const xyzi = toXyzi(Array.from({ length: 150000 }, (_, i) => pt(i, 0)));
    const result = selectStoredLiveXyzi(xyzi, 150000);
    expect(result.count).toBeLessThanOrEqual(80000);
    expect(result.count).toBeGreaterThan(0);
  });
});

// ─── selectRenderablePoints ───────────────────────────────────────────────────

describe("selectRenderablePoints", () => {
  it("returns input unchanged when under limit", () => {
    const pts = [pt(1, 0), pt(2, 0)];
    expect(selectRenderablePoints(pts)).toHaveLength(2);
  });

  it("reduces to max 60000 when given large cloud", () => {
    const pts = Array.from({ length: 100000 }, (_, i) => pt(i * 0.1, i * 0.1, 0));
    const result = selectRenderablePoints(pts);
    expect(result.length).toBeLessThanOrEqual(60000);
  });
});

// ─── denoisePointCloud ────────────────────────────────────────────────────────

describe("denoisePointCloud", () => {
  it("returns empty array unchanged", () => {
    expect(denoisePointCloud([])).toEqual([]);
  });

  it("passes through a dense cluster", () => {
    // 300 points clustered near (1,1,0) — should survive denoising
    const dense = Array.from({ length: 300 }, (_, i) => pt(1 + (i % 10) * 0.05, 1 + Math.floor(i / 10) * 0.05));
    const result = denoisePointCloud(dense);
    expect(result.length).toBeGreaterThan(0);
  });

  it("filters isolated noise points", () => {
    // Dense cluster + 1 isolated outlier far away
    const dense = Array.from({ length: 300 }, (_, i) => pt((i % 10) * 0.05, Math.floor(i / 10) * 0.05));
    const withNoise = [...dense, pt(1000, 1000, 0)];
    const result = denoisePointCloud(withNoise);
    const hasOutlier = result.some((p) => p.x > 500);
    expect(hasOutlier).toBe(false);
  });

  it("returns points array when all points filtered (fallback)", () => {
    // Too few points → falls back to returning all candidates
    const sparse = [pt(0, 0), pt(10, 10), pt(100, 100)];
    const result = denoisePointCloud(sparse);
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─── chooseBestPointCloudTopic ────────────────────────────────────────────────

describe("chooseBestPointCloudTopic", () => {
  it("returns empty string when no topics", () => {
    expect(chooseBestPointCloudTopic({})).toBe("");
  });

  it("prefers rslidar over generic cloud", () => {
    const clouds = {
      "/cloud": { pointsXyzi: toXyzi(Array(100).fill(pt(1, 0))), pointsCount: 100, frameId: "" },
      "/m1/rslidar_points": { pointsXyzi: toXyzi(Array(50).fill(pt(1, 0))), pointsCount: 50, frameId: "" },
    };
    expect(chooseBestPointCloudTopic(clouds)).toBe("/m1/rslidar_points");
  });

  it("ignores topics with no points", () => {
    const clouds = {
      "/cloud": { pointsXyzi: toXyzi([]), pointsCount: 0, frameId: "" },
      "/scan": { pointsXyzi: toXyzi([pt(1, 0)]), pointsCount: 1, frameId: "" },
    };
    expect(chooseBestPointCloudTopic(clouds)).toBe("");
  });
});

// ─── LIDAR_FILTER_VERSION ──────────────────────────────────────────────────────

describe("LIDAR_FILTER_VERSION", () => {
  it("is a positive integer", () => {
    expect(Number.isInteger(LIDAR_FILTER_VERSION)).toBe(true);
    expect(LIDAR_FILTER_VERSION).toBeGreaterThan(0);
  });
});
