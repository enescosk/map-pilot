import type { LidarReading, Point3D } from "../types/liveMessages";
import type { TelemetryState, Vector3 } from "../types/telemetry";

export type LidarCloudState = {
  points: Point3D[];
  mapPoints: Point3D[];
  frameId: string;
  resolvedFrame?: string;
  lastTime?: string;
  filterVersion?: number;
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
const MAX_STORED_LIVE_POINTS = 120000;
const MAX_LIDAR_MAP_POINTS = 900000;
export const MAX_TOTAL_MAP_POINTS = 1400000;
const LIDAR_MAP_VOXEL_SIZE = 0.15;
export const POINT_CLOUD_FLUSH_MS = 100;
const LIDAR_VIEW_RADIUS_METERS = 80;
const LIDAR_VIEW_MIN_HEIGHT = -3;
const LIDAR_VIEW_MAX_HEIGHT = 12;
const LIDAR_MIN_RANGE_METERS = 0.5;
const LIDAR_EGO_CLEARANCE_METERS = 0.4;
const LIDAR_NOISE_VOXEL_SIZE = 0.4;
const LIDAR_MIN_VOXEL_POINTS = 2;
const LIDAR_MIN_NEIGHBOR_POINTS = 4;
const LIDAR_MAP_CONFIRMATION_VOXEL_SIZE = 0.2;
const LIDAR_MAP_MIN_SEEN = 1;
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
  const horizontalDistance = Math.hypot(threePoint.x, threePoint.z);
  return (
    Number.isFinite(threePoint.x) &&
    Number.isFinite(threePoint.y) &&
    Number.isFinite(threePoint.z) &&
    horizontalDistance <= LIDAR_VIEW_RADIUS_METERS &&
    threePoint.y >= LIDAR_VIEW_MIN_HEIGHT &&
    threePoint.y <= LIDAR_VIEW_MAX_HEIGHT
  );
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

function mapConfirmationKey(point: Point3D) {
  return [
    Math.round(point.x / LIDAR_MAP_CONFIRMATION_VOXEL_SIZE),
    Math.round(point.y / LIDAR_MAP_CONFIRMATION_VOXEL_SIZE),
    Math.round(point.z / LIDAR_MAP_CONFIRMATION_VOXEL_SIZE),
  ].join(":");
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

function voxelKey(point: Point3D) {
  return [
    Math.round(point.x / LIDAR_MAP_VOXEL_SIZE),
    Math.round(point.y / LIDAR_MAP_VOXEL_SIZE),
    Math.round(point.z / LIDAR_MAP_VOXEL_SIZE),
  ].join(":");
}

export function mergeLidarMap(current: Point3D[], nextPoints: Point3D[]) {
  if (nextPoints.length === 0) {
    return current;
  }

  const map = new Map<string, Point3D>();
  const confirmationCounts = new Map<string, number>();
  for (const point of current) {
    map.set(voxelKey(point), point);
    const confirmationKey = mapConfirmationKey(point);
    confirmationCounts.set(confirmationKey, Math.max(confirmationCounts.get(confirmationKey) || 0, point.seen || LIDAR_MAP_MIN_SEEN));
  }

  const step = Math.max(1, Math.ceil(nextPoints.length / 14000));
  for (let index = 0; index < nextPoints.length; index += step) {
    const point = nextPoints[index];
    if (Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)) {
      const confirmationKey = mapConfirmationKey(point);
      const seen = Math.min(12, (confirmationCounts.get(confirmationKey) || 0) + 1);
      confirmationCounts.set(confirmationKey, seen);
      if (seen >= LIDAR_MAP_MIN_SEEN) {
        map.set(voxelKey(point), { ...point, seen });
      }
    }
  }

  const merged = [...map.values()];
  if (merged.length <= MAX_LIDAR_MAP_POINTS) {
    return merged;
  }

  const trimStep = Math.ceil(merged.length / MAX_LIDAR_MAP_POINTS);
  return merged.filter((_, index) => index % trimStep === 0);
}

function isPointCloudTopic(topic: string) {
  const lower = topic.toLowerCase();
  return lower.includes("cloud") || lower.includes("points") || lower.includes("rslidar");
}

function pointCloudTopicPriority(topic: string) {
  const lower = topic.toLowerCase();
  if (lower.includes("helios") || lower.includes("rslidar") || lower.includes("m1")) {
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

export function chooseBestPointCloudTopic(pointClouds: Record<string, LidarCloudState>) {
  return Object.entries(pointClouds)
    .filter(([topic, state]) => isPointCloudTopic(topic) && state.points.length > 0)
    .sort(([leftTopic, left], [rightTopic, right]) => {
      const priorityDelta = pointCloudTopicPriority(rightTopic) - pointCloudTopicPriority(leftTopic);
      return priorityDelta || right.points.length - left.points.length;
    })[0]?.[0] || "";
}
