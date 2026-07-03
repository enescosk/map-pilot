import type { LidarReading, Point3D } from "../types/liveMessages";
import type { TelemetryState, Vector3 } from "../types/telemetry";

export type LidarCloudState = {
  points: Point3D[];
  frameId: string;
  resolvedFrame?: string;
  lastTime?: string;
  filterVersion?: number;
  // Raw point count from the most recent frame, even for topics the worker
  // skipped (not the active topic). Lets the picker list every cloud and lets
  // auto-selection compare them without storing their full point arrays.
  pointCount?: number;
};

export type LaserScanLike = {
  angle_min?: number;
  angle_max?: number;
  angle_increment?: number;
  range_min?: number;
  range_max?: number;
  ranges?: number[];
  intensities?: number[];
};

const MAX_LIDAR_HISTORY_POINTS = 32000;
const MAX_RENDERED_POINT_CLOUD_POINTS = 60000;
// The 3D renderer only draws up to ~65k points (its fixed typed-array pool), so
// storing far more than that is memory we never display.
const MAX_STORED_LIVE_POINTS = 80000;
export const POINT_CLOUD_FLUSH_MS = 100;
const LIDAR_VIEW_RADIUS_METERS = 80;
const LIDAR_VIEW_MIN_HEIGHT = -3;
const LIDAR_VIEW_MAX_HEIGHT = 12;
const LIDAR_MIN_RANGE_METERS = 0.5;
const LIDAR_EGO_CLEARANCE_METERS = 0.4;
const LIDAR_NOISE_VOXEL_SIZE = 0.4;
const LIDAR_MIN_VOXEL_POINTS = 2;
const LIDAR_MIN_NEIGHBOR_POINTS = 4;
const RENDER_VOXEL_SIZE = 0.2;
export const LIDAR_FILTER_VERSION = 3;

function polarToCartesian(angleRadians: number, distance: number): Point3D {
  return {
    x: Math.cos(angleRadians) * distance,
    y: Math.sin(angleRadians) * distance,
    z: 0,
  };
}

function filterValidRange(range: number, rangeMin: number, rangeMax: number): boolean {
  return Number.isFinite(range) && range > 0 && range >= rangeMin && range <= rangeMax;
}

function normalizeLaserScan(scan: LaserScanLike) {
  return {
    angleMin: Number(scan?.angle_min ?? 0),
    angleMax: Number(scan?.angle_max ?? Math.PI * 2),
    angleIncrement: Number(scan?.angle_increment ?? 0),
    rangeMin: Number(scan?.range_min ?? 0),
    rangeMax: Number(scan?.range_max ?? Number.POSITIVE_INFINITY),
    ranges: Array.isArray(scan?.ranges) ? scan.ranges : [],
    intensities: Array.isArray(scan?.intensities) ? scan.intensities : [],
  };
}

export function buildPointCloudFromScan(scan: LaserScanLike): Point3D[] {
  const norm = normalizeLaserScan(scan);
  const points: Point3D[] = [];
  for (let i = 0; i < norm.ranges.length; i += 1) {
    const range = Number(norm.ranges[i]);
    if (!filterValidRange(range, norm.rangeMin, norm.rangeMax)) continue;
    const angle = norm.angleMin + i * norm.angleIncrement;
    const pt = polarToCartesian(angle, range);
    pt.intensity = Number(norm.intensities[i] || 0);
    points.push(pt);
  }
  return points;
}

export function scanReadingsToPoints(readings: LidarReading[]): Point3D[] {
  return readings
    .filter((r) => Number.isFinite(r.distance) && r.distance > 0)
    .map((reading) => {
      const radians = (reading.angle * Math.PI) / 180;
      return {
        x: Math.cos(radians) * reading.distance,
        y: Math.sin(radians) * reading.distance,
        z: 0,
        intensity: reading.distance,
      };
    });
}

function usesCameraOpticalFrame(frameId?: string, resolvedFrame?: string) {
  const frame = String(resolvedFrame && !resolvedFrame.includes("raw") ? resolvedFrame : frameId || "").toLowerCase();
  return frame.includes("camera") || frame.includes("optical") || frame.includes("zed");
}

function usesWorldFrame(frameId?: string, resolvedFrame?: string) {
  const frame = String(resolvedFrame && !resolvedFrame.includes("raw") ? resolvedFrame : frameId || "").replace(/^\//, "").toLowerCase();
  return frame === "odom" || frame === "map" || frame === "world" || frame === "global";
}

function pointToThree(point: Point3D, frameId?: string, resolvedFrame?: string) {
  if (usesCameraOpticalFrame(frameId, resolvedFrame)) {
    return {
      x: point.x,
      y: -point.y,
      z: -point.z,
    };
  }

  return {
    x: -point.y,
    y: point.z,
    z: -point.x,
  };
}

function pointToEgoRelative(point: Point3D, vehiclePose?: TelemetryState["pose"]) {
  const position = vehiclePose?.position;
  if (!position) {
    return point;
  }

  const vehicleX = Number(position.x || 0);
  const vehicleY = Number(position.y || 0);
  const vehicleZ = Number(position.z || 0);
  if (!Number.isFinite(vehicleX) || !Number.isFinite(vehicleY) || !Number.isFinite(vehicleZ)) {
    return point;
  }

  return {
    ...point,
    x: point.x - vehicleX,
    y: point.y - vehicleY,
    z: point.z - vehicleZ,
  };
}

export function pointToDisplayThree(point: Point3D, frameId?: string, resolvedFrame?: string, vehiclePose?: TelemetryState["pose"]) {
  const displayPoint = usesWorldFrame(frameId, resolvedFrame) ? pointToEgoRelative(point, vehiclePose) : point;
  return pointToThree(displayPoint, frameId, resolvedFrame);
}

// ─── Allocation-free display transform ───────────────────────────────────────
// The 3D view converts up to 60k points per flush. The object-returning helpers
// above cost one throwaway {x,y,z} per point per pass (~1.2M objects/s at 10 Hz
// over two passes), which shows up as GC pauses. Hot paths instead resolve the
// frame ONCE per batch and write transformed coords into a caller-owned target.

export type DisplayFrameTransform = {
  cameraOptical: boolean;
  // Ego offset — non-zero only for world-frame clouds with a finite pose.
  offsetX: number;
  offsetY: number;
  offsetZ: number;
};

export function getDisplayFrameTransform(
  frameId?: string,
  resolvedFrame?: string,
  vehiclePose?: TelemetryState["pose"],
): DisplayFrameTransform {
  const transform: DisplayFrameTransform = {
    cameraOptical: usesCameraOpticalFrame(frameId, resolvedFrame),
    offsetX: 0,
    offsetY: 0,
    offsetZ: 0,
  };
  if (usesWorldFrame(frameId, resolvedFrame)) {
    const position = vehiclePose?.position;
    const x = Number(position?.x || 0);
    const y = Number(position?.y || 0);
    const z = Number(position?.z || 0);
    if (position && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      transform.offsetX = x;
      transform.offsetY = y;
      transform.offsetZ = z;
    }
  }
  return transform;
}

/** Same math as pointToDisplayThree, but writes into `out` — no allocation. */
export function transformDisplayPointInto(out: Vector3, point: Point3D, transform: DisplayFrameTransform) {
  const x = point.x - transform.offsetX;
  const y = point.y - transform.offsetY;
  const z = point.z - transform.offsetZ;
  if (transform.cameraOptical) {
    out.x = x;
    out.y = -y;
    out.z = -z;
  } else {
    out.x = -y;
    out.y = z;
    out.z = -x;
  }
}

/** Scalar variant of isMeaningfulDisplayPoint over already-transformed coords. */
export function isMeaningfulThreeCoords(x: number, y: number, z: number) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
  if (y < LIDAR_VIEW_MIN_HEIGHT || y > LIDAR_VIEW_MAX_HEIGHT) return false;
  // Squared compare instead of Math.hypot — identical result, ~3× faster in V8.
  return x * x + z * z <= LIDAR_VIEW_RADIUS_METERS * LIDAR_VIEW_RADIUS_METERS;
}

function isMeaningfulScenePoint(point: Point3D, frameId?: string, resolvedFrame?: string) {
  const threePoint = pointToThree(point, frameId, resolvedFrame);
  const horizontalDistance = Math.hypot(threePoint.x, threePoint.z);
  const isWorldFrame = usesWorldFrame(frameId, resolvedFrame);
  return (
    Number.isFinite(threePoint.x) &&
    Number.isFinite(threePoint.y) &&
    Number.isFinite(threePoint.z) &&
    (isWorldFrame || horizontalDistance >= LIDAR_MIN_RANGE_METERS) &&
    (isWorldFrame || horizontalDistance <= LIDAR_VIEW_RADIUS_METERS) &&
    (isWorldFrame || Math.abs(threePoint.x) > LIDAR_EGO_CLEARANCE_METERS || Math.abs(threePoint.z) > LIDAR_EGO_CLEARANCE_METERS) &&
    threePoint.y >= LIDAR_VIEW_MIN_HEIGHT &&
    threePoint.y <= LIDAR_VIEW_MAX_HEIGHT
  );
}

export function isMeaningfulDisplayPoint(point: Point3D, frameId?: string, resolvedFrame?: string, vehiclePose?: TelemetryState["pose"]) {
  const threePoint = pointToDisplayThree(point, frameId, resolvedFrame, vehiclePose);
  return isMeaningfulThreeCoords(threePoint.x, threePoint.y, threePoint.z);
}

function noiseVoxelKey(point: Vector3) {
  return [
    Math.round(Number(point.x || 0) / LIDAR_NOISE_VOXEL_SIZE),
    Math.round(Number(point.y || 0) / LIDAR_NOISE_VOXEL_SIZE),
    Math.round(Number(point.z || 0) / LIDAR_NOISE_VOXEL_SIZE),
  ].join(":");
}

export function denoisePointCloud(points: Point3D[], frameId?: string, resolvedFrame?: string) {
  if (points.length === 0) {
    return points;
  }

  const candidates: Array<{ point: Point3D; threePoint: Vector3; key: string }> = [];
  const voxelCounts = new Map<string, number>();

  for (const point of points) {
    if (!isMeaningfulScenePoint(point, frameId, resolvedFrame)) {
      continue;
    }

    const threePoint = pointToThree(point, frameId, resolvedFrame);
    const key = noiseVoxelKey(threePoint);
    candidates.push({ point, threePoint, key });
    voxelCounts.set(key, (voxelCounts.get(key) || 0) + 1);
  }

  if (candidates.length < Math.min(250, points.length * 0.15)) {
    return candidates.map((candidate) => candidate.point);
  }

  const filtered = candidates.filter(({ threePoint, key }) => {
    if ((voxelCounts.get(key) || 0) >= LIDAR_MIN_VOXEL_POINTS) {
      return true;
    }

    const vx = Math.round(Number(threePoint.x || 0) / LIDAR_NOISE_VOXEL_SIZE);
    const vy = Math.round(Number(threePoint.y || 0) / LIDAR_NOISE_VOXEL_SIZE);
    const vz = Math.round(Number(threePoint.z || 0) / LIDAR_NOISE_VOXEL_SIZE);
    let support = voxelCounts.get(key) || 0;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          if (dx === 0 && dy === 0 && dz === 0) {
            continue;
          }
          support += voxelCounts.get(`${vx + dx}:${vy + dy}:${vz + dz}`) || 0;
          if (support >= LIDAR_MIN_NEIGHBOR_POINTS) {
            return true;
          }
        }
      }
    }
    return false;
  });

  return filtered.length >= Math.min(200, candidates.length * 0.2)
    ? filtered.map((candidate) => candidate.point)
    : candidates.map((candidate) => candidate.point);
}

export function appendLidarHistory(current: Point3D[], nextPoints: Point3D[]) {
  if (nextPoints.length === 0) {
    return current;
  }

  return [...current, ...nextPoints].slice(-MAX_LIDAR_HISTORY_POINTS);
}

function downsamplePointCloud(points: Point3D[], voxelSize: number): Point3D[] {
  if (points.length === 0) return points;
  const grid = new Map<string, Point3D>();
  const inv = 1 / voxelSize;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue;
    const kx = Math.floor(p.x * inv);
    const ky = Math.floor(p.y * inv);
    const kz = Math.floor(p.z * inv);
    const key = `${kx}:${ky}:${kz}`;
    if (!grid.has(key)) grid.set(key, p);
  }
  return [...grid.values()];
}

export function selectRenderablePoints(points: Point3D[]) {
  let result = points.length > MAX_RENDERED_POINT_CLOUD_POINTS * 1.5
    ? downsamplePointCloud(points, RENDER_VOXEL_SIZE)
    : points;
  let voxel = RENDER_VOXEL_SIZE;
  while (result.length > MAX_RENDERED_POINT_CLOUD_POINTS && voxel < 1.5) {
    voxel *= 1.4;
    result = downsamplePointCloud(points, voxel);
  }
  if (result.length > MAX_RENDERED_POINT_CLOUD_POINTS) {
    const step = Math.ceil(result.length / MAX_RENDERED_POINT_CLOUD_POINTS);
    const strided: Point3D[] = [];
    for (let i = 0; i < result.length; i += step) strided.push(result[i]);
    result = strided;
  }
  return result;
}

export function selectStoredLivePoints(points: Point3D[]) {
  if (points.length <= MAX_STORED_LIVE_POINTS) {
    return points;
  }

  const step = Math.ceil(points.length / MAX_STORED_LIVE_POINTS);
  const selected = [];
  for (let index = 0; index < points.length; index += step) {
    selected.push(points[index]);
  }
  return selected;
}

function isPointCloudTopic(topic: string) {
  const lower = topic.toLowerCase();
  return lower.includes("cloud") || lower.includes("points") || lower.includes("rslidar");
}

function pointCloudTopicPriority(topic: string) {
  const lower = topic.toLowerCase();
  // Secondary / auxiliary sensors (e.g. /m1/rslidar_points is a tilted side
  // unit in a non-base_link frame) rank below the primary roof cloud so
  // auto-selection lands on the clean, forward-facing /rslidar_points by default.
  if (lower.includes("/m1") || lower.includes("m1/")) {
    return 2;
  }
  if (lower.includes("helios") || lower.includes("rslidar")) {
    return 3;
  }
  if (lower.includes("laser") || lower.includes("lidar")) {
    return 2;
  }
  if (lower.includes("camera") || lower.includes("zed")) {
    return 1;
  }
  return 0;
}

// Effective point count for ranking. Prefer the real per-frame count
// (`pointCount`) — it reflects a topic's true density. `points.length` is the
// ACCUMULATED history, so a near-empty topic that happened to be active for a
// while looks falsely dense; only fall back to it when no frame count is known.
function cloudPointCount(state: LidarCloudState) {
  return state.pointCount ?? (state.points.length > 0 ? state.points.length : 0);
}

// Topics that emit only a handful of points per frame (e.g. the vehicle's
// /m1/rslidar_points sends ~5 pts) are effectively empty and must never win
// auto-selection over a real cloud like /rslidar_points (~136k pts). They stay
// in the picker so a user can still inspect them manually.
const MIN_AUTO_SELECT_POINTS = 200;

export function chooseBestPointCloudTopic(pointClouds: Record<string, LidarCloudState>) {
  const candidates = Object.entries(pointClouds)
    .filter(([topic, state]) => isPointCloudTopic(topic) && cloudPointCount(state) > 0)
    .sort(([leftTopic, left], [rightTopic, right]) => {
      // Prefer clouds with a meaningful number of points first — a dense cloud
      // always beats a near-empty one regardless of topic-name priority.
      const leftDense = cloudPointCount(left) >= MIN_AUTO_SELECT_POINTS ? 1 : 0;
      const rightDense = cloudPointCount(right) >= MIN_AUTO_SELECT_POINTS ? 1 : 0;
      if (leftDense !== rightDense) return rightDense - leftDense;
      const priorityDelta = pointCloudTopicPriority(rightTopic) - pointCloudTopicPriority(leftTopic);
      return priorityDelta || cloudPointCount(right) - cloudPointCount(left);
    });
  return candidates[0]?.[0] || "";
}
