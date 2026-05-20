import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import ControlPanel from "./components/ControlPanel";
import DecisionLogPanel from "./components/DecisionLogPanel";
import TopicHealthStrip from "./components/TopicHealthStrip";
import { useBagPlayback } from "./hooks/useBagPlayback";
import { useCameraFeed } from "./hooks/useCameraFeed";
import { useDashboardTelemetry } from "./hooks/useDashboardTelemetry";
import { useLiveTelemetry } from "./hooks/useLiveTelemetry";
import { usePointCloudBuffer, type PendingPointCloudPacket } from "./hooks/usePointCloudBuffer";
import { useTopicHealth } from "./hooks/useTopicHealth";
import type { BagFileOption, BagStatus, BagTopicSummary, CameraFrameMessage, CameraStatus, CameraStreamMessage, LatestFrame, LidarReading, LiveMessage, Point3D, TelemetryMessage } from "./types/liveMessages";
import type { GpsFix, SeriesPoint, TelemetryState, Vector3 } from "./types/telemetry";
import { formatBoolean, formatDuration, formatFileSize, formatGear, formatNumber, vectorMagnitude } from "./utils/telemetryFormatters";
import { timeStringToSeconds } from "./utils/timeLabel";
import "./App.css";

const WS_URL =
  import.meta.env.VITE_WS_URL ||
  `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:4000`;

export type WorkspaceMode = "perception" | "control" | "debug";

export type RobotStatus = {
  name: string;
  battery: number;
  mode: string;
  isMapping: boolean;
  lidarConnected: boolean;
  location: string;
};

export type MapSummary = {
  areaCovered: number;
  roomsDetected: number;
  loopClosure: string;
  lastUpdated: string;
};

export type SystemHealthItem = {
  name: string;
  isActive: boolean;
  detail: string;
};

type GpsTrailPoint = {
  latitude: number;
  longitude: number;
};

export type BagFrame = LatestFrame;

type LidarMode = "2d" | "3d";
type LidarColorMode = "intensity" | "height" | "distance";
type LidarCloudState = {
  points: Point3D[];
  mapPoints: Point3D[];
  frameId: string;
  resolvedFrame?: string;
  lastTime?: string;
  filterVersion?: number;
};
type LidarDebugStats = {
  pointsCount: number;
  sourcePointsCount: number;
  min: Required<Vector3>;
  max: Required<Vector3>;
  threeMin: Required<Vector3>;
  threeMax: Required<Vector3>;
  firstPoints: Point3D[];
};

const MAX_LIDAR_HISTORY_POINTS = 32000;
// Density-controlled rendering: cap the number of points the GPU draws at once.
// Foxglove-style clarity beats raw point count. Lower = cleaner.
const MAX_RENDERED_POINT_CLOUD_POINTS = 60000;
const MAX_STORED_LIVE_POINTS = 120000;
const MAX_LIDAR_MAP_POINTS = 900000;
const MAX_TOTAL_MAP_POINTS = 1400000;
const LIDAR_MAP_VOXEL_SIZE = 0.15;
const POINT_CLOUD_FLUSH_MS = 100;
const LIDAR_RENDER_FPS = 30;
// Default camera: behind-and-above the ego, slightly looking down.
// In Three.js coords, vehicle is at origin and forward = -Z, so we sit at +Z (behind), +Y (above).
const DEFAULT_LIDAR_CAMERA_POSITION = new THREE.Vector3(0, 25, 35);
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
// Tighter height-color range: ground = blue, person height = green/yellow, canopy = red.
const HEIGHT_COLOR_MIN = -1;
const HEIGHT_COLOR_MAX = 5;
// Adaptive voxel-grid downsampling: produces uniform density across the scene so
// the area right next to the sensor doesn't become a glowing blob.
const RENDER_VOXEL_SIZE = 0.2;
const ENABLE_LIDAR_CONTOURS = false;
const LIDAR_FILTER_VERSION = 3;

// =====================================================================
// LiDAR coordinate helpers (ROS REP-103, matching Foxglove)
// ROS frame convention: x = forward, y = left, z = up (right-handed)
// LaserScan angle convention: 0 rad = +x (forward), positive = counter-clockwise (toward +y/left)
// =====================================================================

/** Convert polar (angle in radians, distance in meters) → Cartesian in ROS frame. */
function polarToCartesian(angleRadians: number, distance: number): Point3D {
  return {
    x: Math.cos(angleRadians) * distance,
    y: Math.sin(angleRadians) * distance,
    z: 0,
  };
}

/** Defensive range validity check matching the LaserScan spec. */
function filterValidRange(range: number, rangeMin: number, rangeMax: number): boolean {
  return Number.isFinite(range) && range > 0 && range >= rangeMin && range <= rangeMax;
}

/** Normalize a raw LaserScan-like object so missing fields don't break downstream code. */
type LaserScanLike = {
  angle_min?: number;
  angle_max?: number;
  angle_increment?: number;
  range_min?: number;
  range_max?: number;
  ranges?: number[];
  intensities?: number[];
};

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

/** Build a flat (z=0) 3D point list from a LaserScan, dropping invalid ranges. */
function buildPointCloudFromScan(scan: LaserScanLike): Point3D[] {
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

/**
 * Convert the existing degree-based reading array to ROS-frame 3D points.
 * Angle is in degrees with 0° = +x (forward). Output: x forward, y left, z=0.
 */
function scanReadingsToPoints(readings: LidarReading[]): Point3D[] {
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

function pointToDisplayThree(point: Point3D, frameId?: string, resolvedFrame?: string, vehiclePose?: TelemetryState["pose"]) {
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

function isMeaningfulDisplayPoint(point: Point3D, frameId?: string, resolvedFrame?: string, vehiclePose?: TelemetryState["pose"]) {
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

function denoisePointCloud(points: Point3D[], frameId?: string, resolvedFrame?: string) {
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

function setTurboColor(color: THREE.Color, value: number) {
  const t = Math.max(0, Math.min(1, value));
  if (t < 0.2) {
    color.setHSL(0.62 - t * 0.7, 1, 0.55);
  } else if (t < 0.45) {
    color.setHSL(0.48 - (t - 0.2) * 0.5, 1, 0.5);
  } else if (t < 0.7) {
    color.setHSL(0.32 - (t - 0.45) * 0.45, 1, 0.5);
  } else {
    color.setHSL(0.11 - (t - 0.7) * 0.36, 1, 0.52);
  }
}

function createPointSpriteTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) {
    return undefined;
  }

  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 31);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.45, "rgba(255,255,255,0.92)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function appendLidarHistory(current: Point3D[], nextPoints: Point3D[]) {
  if (nextPoints.length === 0) {
    return current;
  }

  return [...current, ...nextPoints].slice(-MAX_LIDAR_HISTORY_POINTS);
}

/**
 * Voxel-grid downsampling: keep at most one point per voxel-sized cube.
 * This produces a uniform spatial density across the entire scene, eliminating
 * the "glowing blob" near the sensor caused by dense overlapping returns.
 * Returns up to MAX_RENDERED_POINT_CLOUD_POINTS to keep frame rate stable.
 */
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
    // Keep the first (or last) sample in each voxel — same end result, lower CPU cost.
    if (!grid.has(key)) grid.set(key, p);
  }
  return [...grid.values()];
}

function selectRenderablePoints(points: Point3D[]) {
  // Step 1 — uniform voxel-grid downsample
  let result = points.length > MAX_RENDERED_POINT_CLOUD_POINTS * 1.5
    ? downsamplePointCloud(points, RENDER_VOXEL_SIZE)
    : points;
  // Step 2 — adaptive: if still too dense, increase voxel size until we're under budget
  let voxel = RENDER_VOXEL_SIZE;
  while (result.length > MAX_RENDERED_POINT_CLOUD_POINTS && voxel < 1.5) {
    voxel *= 1.4;
    result = downsamplePointCloud(points, voxel);
  }
  // Step 3 — hard cap via uniform stride if voxel downsample wasn't aggressive enough
  if (result.length > MAX_RENDERED_POINT_CLOUD_POINTS) {
    const step = Math.ceil(result.length / MAX_RENDERED_POINT_CLOUD_POINTS);
    const strided: Point3D[] = [];
    for (let i = 0; i < result.length; i += step) strided.push(result[i]);
    result = strided;
  }
  return result;
}

function selectStoredLivePoints(points: Point3D[]) {
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

function mergeLidarMap(current: Point3D[], nextPoints: Point3D[]) {
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

function chooseBestPointCloudTopic(pointClouds: Record<string, LidarCloudState>) {
  return Object.entries(pointClouds)
    .filter(([topic, state]) => isPointCloudTopic(topic) && state.points.length > 0)
    .sort(([leftTopic, left], [rightTopic, right]) => {
      const priorityDelta = pointCloudTopicPriority(rightTopic) - pointCloudTopicPriority(leftTopic);
      return priorityDelta || right.points.length - left.points.length;
    })[0]?.[0] || "";
}

function SparkChart({ title, value, unit, data, color }: {
  title: string;
  value: string;
  unit: string;
  data: SeriesPoint[];
  color: string;
}) {
  const width = 320;
  const height = 106;
  const max = Math.max(...data.map((point) => Math.abs(point.value)), 1);
  const points = data
    .map((point, index) => {
      const x = data.length <= 1 ? 0 : (index / (data.length - 1)) * width;
      const y = height - (Math.abs(point.value) / max) * (height - 18) - 9;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <section className="chart-panel">
      <div className="panel-topline">
        <span>{title}</span>
        <strong>{value} {unit}</strong>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title} chart`}>
        <path d="M0 20 H320 M0 53 H320 M0 86 H320" className="chart-grid" />
        <polyline points={points} fill="none" stroke={color} strokeWidth="2.5" />
      </svg>
    </section>
  );
}

function SpeedGauge({ speedKmh, speedMs }: { speedKmh?: number; speedMs: number }) {
  const displaySpeed = Number.isFinite(speedKmh) ? Number(speedKmh) : speedMs * 3.6;
  const maxSpeed = 40;
  const ratio = Math.max(0, Math.min(1, displaySpeed / maxSpeed));
  const startAngle = 135;
  const sweepAngle = 270;
  const needleAngle = startAngle + ratio * sweepAngle;
  const angleToPoint = (angle: number, radius: number) => {
    const radians = (angle * Math.PI) / 180;
    return {
      x: 100 + Math.cos(radians) * radius,
      y: 100 + Math.sin(radians) * radius,
    };
  };
  const arcPath = (start: number, end: number, radius = 66) => {
    const startPoint = angleToPoint(start, radius);
    const endPoint = angleToPoint(end, radius);
    const largeArc = Math.abs(end - start) > 180 ? 1 : 0;
    return `M ${startPoint.x.toFixed(2)} ${startPoint.y.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} 1 ${endPoint.x.toFixed(2)} ${endPoint.y.toFixed(2)}`;
  };
  const angleForSpeed = (speed: number) => startAngle + (Math.max(0, Math.min(maxSpeed, speed)) / maxSpeed) * sweepAngle;
  const needleEnd = angleToPoint(needleAngle, 57);

  return (
    <section className="speed-gauge-card" aria-label="Vehicle speed gauge">
      <div className="gauge-dial">
        <svg viewBox="0 0 200 200" role="img" aria-label={`${formatNumber(displaySpeed, 1)} km/h`}>
          <path className="gauge-track" d={arcPath(startAngle, startAngle + sweepAngle)} />
          <path className="gauge-band band-low" d={arcPath(angleForSpeed(0), angleForSpeed(14))} />
          <path className="gauge-band band-mid" d={arcPath(angleForSpeed(14.8), angleForSpeed(26))} />
          <path className="gauge-band band-high" d={arcPath(angleForSpeed(26.8), angleForSpeed(40))} />
          <path className="gauge-progress" d={arcPath(startAngle, needleAngle)} />
          <line className="gauge-needle" x1="100" y1="100" x2={needleEnd.x} y2={needleEnd.y} />
          <circle className="gauge-hub" cx="100" cy="100" r="9" />
          <text className="gauge-tick-svg" x="47" y="151">0</text>
          <text className="gauge-tick-svg" x="100" y="39">20</text>
          <text className="gauge-tick-svg" x="153" y="151">40</text>
        </svg>
        <div className="gauge-readout">
          <strong>{formatNumber(displaySpeed, 1)}</strong>
          <span>km/h</span>
        </div>
      </div>
      <div className="gauge-subreadout">
        <span>{formatNumber(speedMs)} m/s</span>
        <span>{formatNumber(ratio * 100, 0)}%</span>
      </div>
    </section>
  );
}

function VehicleTopView({ vehicle }: { vehicle: TelemetryState["vehicle"] }) {
  const brakeActive = Number(vehicle.brakePercent || 0) > 0 || Number(vehicle.brakePressure || 0) > 0.2 || Boolean(vehicle.handbrake);
  const hazardActive = Boolean(vehicle.emergency) || (Boolean(vehicle.leftSignal) && Boolean(vehicle.rightSignal));

  return (
    <section className="vehicle-visual-card" aria-label="Vehicle signal visualization">
      <div className="vehicle-stage">
        <div className="vehicle-body">
          <div className="vehicle-shadow" />
          <div className="wheel front-left" />
          <div className="wheel front-right" />
          <div className="wheel rear-left" />
          <div className="wheel rear-right" />
          <div className="side-mirror left" />
          <div className="side-mirror right" />
          <div className="vehicle-shell">
            <div className={vehicle.ignition ? "headlight left active" : "headlight left"} />
            <div className={vehicle.ignition ? "headlight right active" : "headlight right"} />
            <div className={vehicle.leftSignal || hazardActive ? "corner-signal front-left active" : "corner-signal front-left"} />
            <div className={vehicle.rightSignal || hazardActive ? "corner-signal front-right active" : "corner-signal front-right"} />
            <div className={vehicle.leftSignal || hazardActive ? "corner-signal rear-left active" : "corner-signal rear-left"} />
            <div className={vehicle.rightSignal || hazardActive ? "corner-signal rear-right active" : "corner-signal rear-right"} />
            <div className="hood-lines" />
            <div className="vehicle-windshield front" />
            <div className="vehicle-roof" />
            <div className="vehicle-windshield rear" />
            <div className="trunk-lines" />
            <div className={brakeActive ? "brake-light left active" : "brake-light left"} />
            <div className={brakeActive ? "brake-light right active" : "brake-light right"} />
          </div>
        </div>
      </div>
      <div className="vehicle-light-strip">
        <span className={vehicle.leftSignal || hazardActive ? "lamp active amber" : "lamp amber"}>LEFT</span>
        <span className={brakeActive ? "lamp active red" : "lamp red"}>BRAKE</span>
        <span className={hazardActive ? "lamp active red" : "lamp red"}>HAZARD</span>
        <span className={vehicle.rightSignal || hazardActive ? "lamp active amber" : "lamp amber"}>RIGHT</span>
      </div>
    </section>
  );
}

function VehicleCockpit({ telemetry, time }: { telemetry: TelemetryState; time?: string }) {
  const vehicle = telemetry.vehicle;
  const steeringAngle = Number(vehicle.steeringAngle || 0);
  const steeringStyle = {
    "--steering-angle": `${Math.max(-90, Math.min(90, steeringAngle))}deg`,
  } as CSSProperties;

  return (
    <section className="workspace-panel telemetry-card cockpit-card">
      <div className="panel-titlebar">
        <span>Vehicle Cockpit</span>
        <strong>{time || "--"}</strong>
      </div>
      <div className="cockpit-layout">
        <SpeedGauge speedKmh={vehicle.speedKmh} speedMs={telemetry.speed} />
        <VehicleTopView vehicle={vehicle} />
        <div className="cockpit-status-grid">
          <div className="cockpit-metric">
            <span>Steering</span>
            <strong>{formatNumber(vehicle.steeringAngle, 0)}°</strong>
            <em>target {formatNumber(vehicle.targetSteeringAngle, 0)}°</em>
          </div>
          <div className="steering-wheel-widget" style={steeringStyle} aria-label="Steering angle">
            <div className="steering-wheel">
              <span />
            </div>
          </div>
          <div className="cockpit-metric">
            <span>Brake</span>
            <strong>{formatNumber(vehicle.brakePercent, 0)}%</strong>
            <em>{formatNumber(vehicle.brakePressure, 1)} bar</em>
          </div>
          <div className="cockpit-metric">
            <span>Throttle</span>
            <strong>{formatNumber(vehicle.throttleSetSpeedKmh, 0)}</strong>
            <em>cruise {formatBoolean(vehicle.cruiseActive)}</em>
          </div>
          <div className="cockpit-metric">
            <span>Drive</span>
            <strong>{formatGear(vehicle.gear)}</strong>
            <em>{vehicle.mode || "mode --"}</em>
          </div>
          <div className={vehicle.epsFault ? "cockpit-metric alert" : "cockpit-metric"}>
            <span>EPS</span>
            <strong>{formatBoolean(vehicle.epsWork)}</strong>
            <em>fault {formatBoolean(vehicle.epsFault)}</em>
          </div>
          <div className="cockpit-metric">
            <span>Battery</span>
            <strong>{formatNumber(vehicle.batterySoc, 0)}%</strong>
            <em>{formatNumber(vehicle.batteryVoltage, 0)} V</em>
          </div>
        </div>
      </div>
    </section>
  );
}

function CameraViewer({ camera }: { camera: CameraStatus }) {
  const [displaySrc, setDisplaySrc] = useState(camera.frameSrc || "");
  const cameraSrc = camera.streamUrl || displaySrc;

  useEffect(() => {
    if (camera.streamUrl) {
      return;
    }

    if (camera.frameSrc && camera.frameSrc !== displaySrc) {
      let cancelled = false;
      const image = new Image();
      image.onload = () => {
        if (!cancelled) {
          setDisplaySrc(camera.frameSrc || "");
        }
      };
      image.src = camera.frameSrc;

      return () => {
        cancelled = true;
      };
    }
  }, [camera.frameSrc, camera.streamUrl, displaySrc]);

  return (
    <section className="workspace-panel camera-workspace">
      <div className="panel-titlebar">
        <span>{camera.topic || "/camera"}</span>
        <strong>{camera.isActive ? "Live" : "Waiting"}</strong>
      </div>
      <div className="camera-stage">
        {cameraSrc ? (
          <img src={cameraSrc} alt="Live camera feed" />
        ) : (
          <div className="empty-state">Waiting for camera frame...</div>
        )}
      </div>
      <div className="metric-strip">
        <span>{camera.issue || camera.resolution}</span>
        <span>{camera.frameCount} frames</span>
        <span>{camera.lastTime || "--"}</span>
      </div>
    </section>
  );
}

// =====================================================================
// Lidar2D — Foxglove-style top-down view
//
// Screen mapping (right-handed, north-up):
//   ROS x (forward)  →  screen up   (decreasing y)
//   ROS y (left)     →  screen left (decreasing x)
//
// Inputs:
//   readings  — LaserScan polar samples (degrees + distance)
//   points    — full 3D point cloud (used in preference if non-empty)
// =====================================================================
function Lidar2D({ readings, points }: { readings: LidarReading[]; points?: Point3D[] }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Prefer the 3D cloud (projected top-down by ignoring z); fall back to polar readings.
  const flatPoints = useMemo(() => {
    if (points && points.length > 0) {
      return points
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
        .map((p) => ({
          x: p.x,
          y: p.y,
          intensity: Number(p.intensity || 0),
          distance: Math.hypot(p.x, p.y),
        }));
    }
    return scanReadingsToPoints(readings).map((p) => ({
      x: p.x,
      y: p.y,
      intensity: Number(p.intensity || 0),
      distance: Math.hypot(p.x, p.y),
    }));
  }, [points, readings]);

  // Auto-pick a nice range bound that contains 95% of points.
  const maxRange = useMemo(() => {
    if (flatPoints.length === 0) return 10;
    const sorted = flatPoints.map((p) => p.distance).sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 10;
    const niceValues = [2, 5, 10, 20, 30, 50, 80, 120, 200];
    return niceValues.find((v) => v >= p95) || Math.ceil(p95);
  }, [flatPoints]);

  // Draw on every change (and on resize).
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) return undefined;

    const draw = () => {
      const rect = wrapper.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Background
      ctx.fillStyle = "#070b12";
      ctx.fillRect(0, 0, width, height);

      const cx = width / 2;
      const cy = height / 2;
      // 90% of the half-extent maps to maxRange — leaves room for labels.
      const scale = (Math.min(width, height) * 0.45) / maxRange;

      // Grid (light)
      ctx.strokeStyle = "rgba(40, 70, 110, 0.35)";
      ctx.lineWidth = 1;
      const gridStep = maxRange <= 10 ? 1 : maxRange <= 30 ? 5 : maxRange <= 100 ? 10 : 25;
      for (let r = gridStep; r <= maxRange; r += gridStep) {
        const sx = r * scale;
        ctx.beginPath();
        ctx.moveTo(cx - sx, 0);
        ctx.lineTo(cx - sx, height);
        ctx.moveTo(cx + sx, 0);
        ctx.lineTo(cx + sx, height);
        ctx.moveTo(0, cy - sx);
        ctx.lineTo(width, cy - sx);
        ctx.moveTo(0, cy + sx);
        ctx.lineTo(width, cy + sx);
        ctx.stroke();
      }

      // Range rings
      const ringDistances = [1, 2, 5, 10, 20, 30, 50, 80, 100, 150].filter((d) => d <= maxRange);
      ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
      for (const d of ringDistances) {
        ctx.strokeStyle = "rgba(56, 189, 248, 0.28)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, d * scale, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = "rgba(148, 163, 184, 0.7)";
        ctx.fillText(`${d}m`, cx + d * scale + 3, cy - 3);
      }

      // Cardinal axes — forward = up
      ctx.strokeStyle = "rgba(56, 189, 248, 0.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, height);
      ctx.moveTo(0, cy);
      ctx.lineTo(width, cy);
      ctx.stroke();

      // Points — color by distance; close obstacles glow red.
      const CLOSE_OBSTACLE_M = 2;
      for (const p of flatPoints) {
        // ROS x (forward) → screen up (y decreases as you go up)
        // ROS y (left)    → screen left (x decreases as you go left)
        const sx = cx - p.y * scale;
        const sy = cy - p.x * scale;
        if (sx < 0 || sx > width || sy < 0 || sy > height) continue;
        const t = Math.min(1, p.distance / maxRange);
        let color: string;
        if (p.distance <= CLOSE_OBSTACLE_M) {
          color = "rgba(248, 113, 113, 0.95)"; // red — close obstacle
        } else {
          // Turbo-ish ramp from cyan (near) to magenta (far)
          const hue = 190 - t * 200;
          color = `hsl(${hue}, 90%, 60%)`;
        }
        ctx.fillStyle = color;
        ctx.fillRect(sx - 1, sy - 1, 2, 2);
      }

      // Ego vehicle marker — triangle pointing up (forward)
      ctx.save();
      ctx.translate(cx, cy);
      ctx.fillStyle = "#fbbf24";
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, -14);
      ctx.lineTo(-9, 9);
      ctx.lineTo(0, 5);
      ctx.lineTo(9, 9);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // Direction labels
      ctx.fillStyle = "rgba(251, 191, 36, 0.95)";
      ctx.font = "bold 11px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText("FRONT", cx - 18, 14);
      ctx.fillStyle = "rgba(148, 163, 184, 0.7)";
      ctx.fillText("BACK", cx - 16, height - 6);
      ctx.fillText("LEFT", 4, cy - 4);
      ctx.fillText("RIGHT", width - 36, cy - 4);
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [flatPoints, maxRange]);

  return (
    <div ref={wrapperRef} className="lidar-2d-stage">
      <canvas ref={canvasRef} style={{ display: "block" }} />
      <div className="lidar-2d-hud">
        <span>{flatPoints.length.toLocaleString()} pts</span>
        <span>Range {maxRange} m</span>
      </div>
    </div>
  );
}

function Lidar3D({
  readings,
  points,
  activeTopic,
  frameId,
  resolvedFrame,
  vehiclePose,
  pointSize,
  colorMode,
  autoFit,
  showDebug,
}: {
  readings: LidarReading[];
  points: Point3D[];
  activeTopic?: string;
  frameId?: string;
  resolvedFrame?: string;
  vehiclePose?: TelemetryState["pose"];
  pointSize: number;
  colorMode: LidarColorMode;
  autoFit: boolean;
  showDebug: boolean;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const cloudRef = useRef<THREE.Points | null>(null);
  const contourRef = useRef<THREE.LineSegments | null>(null);
  const vehicleRef = useRef<THREE.Group | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const pointTextureRef = useRef<THREE.Texture | undefined>(undefined);
  const rawDisplayPoints = useMemo(() => points.length > 0 ? points : scanReadingsToPoints(readings), [points, readings]);
  const hasPoints = points.length > 0;
  const scenePoints = useMemo(() => {
    return denoisePointCloud(rawDisplayPoints, frameId, resolvedFrame)
      .filter((point) => isMeaningfulDisplayPoint(point, frameId, resolvedFrame, vehiclePose));
  }, [frameId, rawDisplayPoints, resolvedFrame, vehiclePose]);
  const displayPoints = useMemo(() => selectRenderablePoints(scenePoints), [scenePoints]);
  const debugStats = useMemo<LidarDebugStats>(() => {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    let threeMinX = Infinity, threeMaxX = -Infinity;
    let threeMinY = Infinity, threeMaxY = -Infinity;
    let threeMinZ = Infinity, threeMaxZ = -Infinity;

    for (const point of displayPoints) {
      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
      minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
      const threePoint = pointToDisplayThree(point, frameId, resolvedFrame, vehiclePose);
      threeMinX = Math.min(threeMinX, threePoint.x); threeMaxX = Math.max(threeMaxX, threePoint.x);
      threeMinY = Math.min(threeMinY, threePoint.y); threeMaxY = Math.max(threeMaxY, threePoint.y);
      threeMinZ = Math.min(threeMinZ, threePoint.z); threeMaxZ = Math.max(threeMaxZ, threePoint.z);
    }

    if (displayPoints.length === 0) {
      minX = 0; maxX = 0; minY = 0; maxY = 0; minZ = 0; maxZ = 0;
      threeMinX = 0; threeMaxX = 0; threeMinY = 0; threeMaxY = 0; threeMinZ = 0; threeMaxZ = 0;
    }

    return {
      pointsCount: displayPoints.length,
      sourcePointsCount: rawDisplayPoints.length,
      min: { x: minX, y: minY, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ },
      threeMin: { x: threeMinX, y: threeMinY, z: threeMinZ },
      threeMax: { x: threeMaxX, y: threeMaxY, z: threeMaxZ },
      firstPoints: displayPoints.slice(0, 5),
    };
  }, [displayPoints, frameId, rawDisplayPoints.length, resolvedFrame, vehiclePose]);

  const setView = useCallback((position: THREE.Vector3, target = new THREE.Vector3(0, 0, 0), up = new THREE.Vector3(0, 1, 0)) => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) {
      return;
    }

    camera.up.copy(up);
    camera.position.copy(position);
    controls.target.copy(target);
    controls.update();
  }, []);

  function zoomView(multiplier: number) {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) {
      return;
    }

    const offset = camera.position.clone().sub(controls.target).multiplyScalar(multiplier);
    const distance = Math.max(controls.minDistance, Math.min(controls.maxDistance, offset.length()));
    offset.setLength(distance);
    camera.position.copy(controls.target).add(offset);
    controls.update();
  }

  /**
   * fitToCloud: zoom so the cloud is visible but keep the EGO (origin) in frame.
   * Foxglove behavior — the camera target stays at (0,0,0) so the vehicle marker
   * remains anchored at the center. We only adjust camera distance.
   */
  const fitToCloud = useCallback(() => {
    const debugStats = cloudRef.current?.userData?.debugStats;
    const controls = controlsRef.current;
    if (!debugStats || !controls) return;

    const target = new THREE.Vector3(0, 0, 0);
    const span = Math.max(
      Math.abs(debugStats.threeMax.x), Math.abs(debugStats.threeMin.x),
      Math.abs(debugStats.threeMax.z), Math.abs(debugStats.threeMin.z),
      18,
    );
    // Stay behind-and-above, looking at the ego.
    setView(new THREE.Vector3(0, span * 0.55, span * 0.95), target);
  }, [setView]);

  /** True top-down view, north (forward) at the top of the screen. */
  function setTopView() {
    const target = new THREE.Vector3(0, 0, 0);
    const debugStats = cloudRef.current?.userData?.debugStats;
    let height = 60;
    if (debugStats) {
      height = Math.max(
        Math.abs(debugStats.threeMax.x), Math.abs(debugStats.threeMin.x),
        Math.abs(debugStats.threeMax.z), Math.abs(debugStats.threeMin.z),
        35,
      ) * 1.3;
    }
    // up = -Z so forward (ROS x = Three -Z) points to the top of the screen.
    setView(new THREE.Vector3(0, height, 0.001), target, new THREE.Vector3(0, 0, -1));
  }

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) {
      return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#070a0c");

    const camera = new THREE.PerspectiveCamera(54, mount.clientWidth / mount.clientHeight, 0.1, 260);
    camera.position.copy(DEFAULT_LIDAR_CAMERA_POSITION);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);
    pointTextureRef.current = createPointSpriteTexture();

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = true;
    controls.panSpeed = 0.9;
    controls.rotateSpeed = 0.65;
    controls.zoomSpeed = 1.05;
    controls.maxDistance = 200;
    controls.minDistance = 4;
    controls.target.set(0, 0, 0);
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    controlsRef.current = controls;

    const grid = new THREE.GridHelper(160, 32, "#0e5e9c", "#10314a");
    grid.material.transparent = true;
    grid.material.opacity = 0.28;
    grid.position.y = -1.5; // sit at typical road level relative to roof-mounted sensor
    scene.add(grid);
    scene.add(new THREE.AxesHelper(5));

    const ringMaterial = new THREE.LineBasicMaterial({
      color: "#0f4e75",
      transparent: true,
      opacity: 0.45,
    });
    const ringDistances = [1, 2, 5, 10, 20, 30, 50, 80];
    const makeLabelSprite = (text: string, color = "#7dd3fc") => {
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 64;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = color;
        ctx.font = "bold 36px ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, 64, 32);
      }
      const texture = new THREE.CanvasTexture(canvas);
      texture.minFilter = THREE.LinearFilter;
      const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(4, 2, 1);
      return sprite;
    };
    ringDistances.forEach((radius) => {
      const ringPoints = Array.from({ length: 128 }, (_, index) => {
        const angle = (index / 128) * Math.PI * 2;
        // In Three.js: ring on the XZ plane (y=0). ROS x (forward) maps to -Z.
        return new THREE.Vector3(Math.cos(angle) * radius, 0.01, Math.sin(angle) * radius);
      });
      const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ringPoints), ringMaterial);
      scene.add(ring);
      // Label the ring along the +x (right) axis in Three.js space.
      const label = makeLabelSprite(`${radius}m`);
      label.position.set(radius, 0.6, 0);
      scene.add(label);
    });

    // Direction labels — FRONT/BACK/LEFT/RIGHT, aligned with ROS axes.
    // ROS x forward → Three.js -Z; ROS y left → Three.js -X.
    const frontLabel = makeLabelSprite("FRONT", "#fbbf24");
    frontLabel.position.set(0, 1.2, -8);
    scene.add(frontLabel);
    const backLabel = makeLabelSprite("BACK", "#64748b");
    backLabel.position.set(0, 1.2, 8);
    scene.add(backLabel);
    const leftLabel = makeLabelSprite("LEFT", "#94a3b8");
    leftLabel.position.set(-8, 1.2, 0);
    scene.add(leftLabel);
    const rightLabel = makeLabelSprite("RIGHT", "#94a3b8");
    rightLabel.position.set(8, 1.2, 0);
    scene.add(rightLabel);

    // Bright forward-direction arrow on the ground.
    const arrowMat = new THREE.LineBasicMaterial({ color: "#fbbf24", transparent: true, opacity: 0.9 });
    const arrowGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0.05, 0),
      new THREE.Vector3(0, 0.05, -6),
      new THREE.Vector3(-0.4, 0.05, -5.2),
      new THREE.Vector3(0, 0.05, -6),
      new THREE.Vector3(0.4, 0.05, -5.2),
    ]);
    scene.add(new THREE.Line(arrowGeom, arrowMat));

    const vehicle = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 0.55, 3.4),
      new THREE.MeshBasicMaterial({ color: "#e5edf6" }),
    );
    body.position.y = 0.45;
    vehicle.add(body);

    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(1.35, 0.42, 1.35),
      new THREE.MeshBasicMaterial({ color: "#38bdf8" }),
    );
    cabin.position.set(0, 0.95, -0.35);
    vehicle.add(cabin);

    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.42, 0.9, 3),
      new THREE.MeshBasicMaterial({ color: "#f59e0b" }),
    );
    nose.position.set(0, 0.55, -2.15);
    nose.rotation.x = -Math.PI / 2;
    vehicle.add(nose);

    const wheelMaterial = new THREE.MeshBasicMaterial({ color: "#111827" });
    [
      [-1.25, 0.22, -1.1],
      [1.25, 0.22, -1.1],
      [-1.25, 0.22, 1.1],
      [1.25, 0.22, 1.1],
    ].forEach(([x, y, z]) => {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.22, 16), wheelMaterial);
      wheel.position.set(x, y, z);
      wheel.rotation.z = Math.PI / 2;
      vehicle.add(wheel);
    });
    vehicle.scale.setScalar(1.1);
    scene.add(vehicle);
    vehicleRef.current = vehicle;

    sceneRef.current = scene;
    rendererRef.current = renderer;

    let frame = 0;
    let lastRenderMs = 0;
    const minRenderIntervalMs = 1000 / LIDAR_RENDER_FPS;
    const render = (now = 0) => {
      frame = requestAnimationFrame(render);
      if (now - lastRenderMs < minRenderIntervalMs) {
        return;
      }
      lastRenderMs = now;
      controls.update();
      renderer.render(scene, camera);
    };
    render();

    const handleResize = () => {
      if (!mount || !rendererRef.current) {
        return;
      }
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      rendererRef.current.setSize(mount.clientWidth, mount.clientHeight);
    };

    window.addEventListener("resize", handleResize);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", handleResize);
      controls.dispose();
      pointTextureRef.current?.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      cameraRef.current = null;
      vehicleRef.current = null;
    };
  }, []);

  useEffect(() => {
    const vehicle = vehicleRef.current;
    if (!vehicle) {
      return;
    }

    vehicle.position.set(0, 0, 0);
  }, [frameId, resolvedFrame, vehiclePose]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) {
      return;
    }

    if (cloudRef.current) {
      scene.remove(cloudRef.current);
      cloudRef.current.geometry.dispose();
      const material = cloudRef.current.material;
      if (Array.isArray(material)) {
        material.forEach((item) => item.dispose());
      } else {
        material.dispose();
      }
    }
    if (contourRef.current) {
      scene.remove(contourRef.current);
      contourRef.current.geometry.dispose();
      const material = contourRef.current.material;
      if (Array.isArray(material)) {
        material.forEach((item) => item.dispose());
      } else {
        material.dispose();
      }
    }

    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(displayPoints.length * 3);
    const colors = new Float32Array(displayPoints.length * 3);
    const color = new THREE.Color();
    const threePoints: Vector3[] = [];
    const pointColors: Vector3[] = [];

    displayPoints.forEach((point, index) => {
      const threePoint = pointToDisplayThree(point, frameId, resolvedFrame, vehiclePose);
      threePoints.push(threePoint);
      positions[index * 3] = threePoint.x;
      positions[index * 3 + 1] = threePoint.y;
      positions[index * 3 + 2] = threePoint.z;

      if (colorMode === "intensity" && typeof point.intensity === "number" && point.intensity > 0) {
        const normalizedInt = Math.max(0, Math.min(1, point.intensity > 255 ? point.intensity / 4096 : point.intensity / 255));
        setTurboColor(color, normalizedInt);
      } else if (colorMode === "height") {
        const height = (threePoint.y - HEIGHT_COLOR_MIN) / (HEIGHT_COLOR_MAX - HEIGHT_COLOR_MIN);
        setTurboColor(color, height);
      } else {
        const distance = Math.hypot(threePoint.x, threePoint.y, threePoint.z);
        const normalized = Math.max(0, Math.min(1, distance / 45));
        setTurboColor(color, 1 - normalized);
      }
      
      colors[index * 3] = color.r;
      colors[index * 3 + 1] = color.g;
      colors[index * 3 + 2] = color.b;
      pointColors.push({ x: color.r, y: color.g, z: color.b });
    });

    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    // Simple, robust point rendering:
    // - No texture map → solid square points, always visible
    // - NormalBlending → no white blob from overlapping points
    // - depthTest OFF → ground points below the grid stay visible
    // - opaque → no alpha test edge cases
    const material = new THREE.PointsMaterial({
      size: Math.max(pointSize, 0.25),
      opacity: 1,
      transparent: false,
      vertexColors: true,
      blending: THREE.NormalBlending,
      depthTest: false,
      depthWrite: false,
      sizeAttenuation: true,
    });

    const cloud = new THREE.Points(geometry, material);
    cloud.userData = { debugStats };
    cloud.renderOrder = 10;
    cloudRef.current = cloud;
    scene.add(cloud);

    const contourBuckets = new Map<number, number[]>();
    threePoints.forEach((point, index) => {
      const bucket = Math.round(Number(point.y || 0) / 0.22);
      const items = contourBuckets.get(bucket) || [];
      items.push(index);
      contourBuckets.set(bucket, items);
    });

    const linePositions: number[] = [];
    const lineColors: number[] = [];
    for (const indices of contourBuckets.values()) {
      if (indices.length < 3) {
        continue;
      }

      indices.sort((left, right) => Math.atan2(threePoints[left].z || 0, threePoints[left].x || 0) - Math.atan2(threePoints[right].z || 0, threePoints[right].x || 0));

      for (let i = 1; i < indices.length; i += 1) {
        const left = threePoints[indices[i - 1]];
        const right = threePoints[indices[i]];
        const dx = Number(left.x || 0) - Number(right.x || 0);
        const dy = Number(left.y || 0) - Number(right.y || 0);
        const dz = Number(left.z || 0) - Number(right.z || 0);
        const distance = Math.hypot(dx, dy, dz);
        if (distance <= 2.2 && distance >= 0.05) {
          linePositions.push(Number(left.x || 0), Number(left.y || 0), Number(left.z || 0), Number(right.x || 0), Number(right.y || 0), Number(right.z || 0));
          const leftColor = pointColors[indices[i - 1]];
          const rightColor = pointColors[indices[i]];
          lineColors.push(leftColor.x || 0, leftColor.y || 0, leftColor.z || 0, rightColor.x || 0, rightColor.y || 0, rightColor.z || 0);
        }
      }
    }

    if (ENABLE_LIDAR_CONTOURS && linePositions.length > 0) {
      const contourGeometry = new THREE.BufferGeometry();
      contourGeometry.setAttribute("position", new THREE.Float32BufferAttribute(linePositions, 3));
      contourGeometry.setAttribute("color", new THREE.Float32BufferAttribute(lineColors, 3));
      const contourMaterial = new THREE.LineBasicMaterial({
        blending: THREE.AdditiveBlending,
        depthTest: true,
        opacity: 0.72,
        transparent: true,
        vertexColors: true,
      });
      const contours = new THREE.LineSegments(contourGeometry, contourMaterial);
      contours.renderOrder = 9;
      contourRef.current = contours;
      scene.add(contours);
    }
  }, [colorMode, debugStats, displayPoints, frameId, pointSize, points.length, resolvedFrame, vehiclePose]);

  useEffect(() => {
    if (!autoFit || !hasPoints) {
      return;
    }

    const timer = window.setTimeout(fitToCloud, 120);
    return () => window.clearTimeout(timer);
  }, [activeTopic, autoFit, fitToCloud, hasPoints, displayPoints.length]);

  return (
    <div className="lidar-3d-stage" ref={mountRef}>
      {showDebug && debugStats && (
        <div className="lidar-debug-card">
          <strong>Lidar Debug</strong><br />
          Topic: <span style={{ color: "#fbbf24" }}>{activeTopic || "None"}</span><br />
          Sensor Frame: {frameId || "unknown"}<br />
          Render Frame: {resolvedFrame || frameId || "raw sensor frame (no TF applied)"}<br />
          Valid Points: {debugStats.pointsCount.toLocaleString()} / {debugStats.sourcePointsCount.toLocaleString()}<br />
          Min XYZ: {debugStats.min.x.toFixed(2)}, {debugStats.min.y.toFixed(2)}, {debugStats.min.z.toFixed(2)}<br />
          Max XYZ: {debugStats.max.x.toFixed(2)}, {debugStats.max.y.toFixed(2)}, {debugStats.max.z.toFixed(2)}<br />
          First 5 Points:<br />
          {debugStats.firstPoints.map((point, index) => `[${index}] x:${point.x.toFixed(2)} y:${point.y.toFixed(2)} z:${point.z.toFixed(2)} int:${point.intensity?.toFixed(1) ?? 0}`).join("\n")}
        </div>
      )}
      <div className="lidar-view-controls" aria-label="LiDAR viewport controls">
        <button type="button" onClick={() => zoomView(0.75)} title="Zoom in">+</button>
        <button type="button" onClick={() => zoomView(1.35)} title="Zoom out">-</button>
        <button type="button" onClick={fitToCloud} title="Fit to point cloud bounds">Fit</button>
        <button type="button" onClick={setTopView} title="Top view">Top</button>
        <button type="button" onClick={() => setView(DEFAULT_LIDAR_CAMERA_POSITION.clone())} title="Reset view">Reset</button>
      </div>
      <div className="lidar-hud">
        <span>{resolvedFrame || frameId || "raw frame"}</span>
        <span>left orbit / right pan / wheel zoom</span>
        <span>{points.length.toLocaleString()} pts</span>
      </div>
    </div>
  );
}

function LidarWorkspace({
  readings,
  pointClouds,
  activeTopic,
  setActiveTopic,
  vehiclePose,
}: {
  readings: LidarReading[];
  pointClouds: Record<string, LidarCloudState>;
  activeTopic: string;
  setActiveTopic: (t: string) => void;
  vehiclePose?: TelemetryState["pose"];
}) {
  const [mode, setMode] = useState<LidarMode>("3d");
  const [cloudView, setCloudView] = useState<"live" | "map">("live");
  const [pointSize, setPointSize] = useState(0.35);
  const [colorMode, setColorMode] = useState<LidarColorMode>("height");
  const [autoFit, setAutoFit] = useState(true);
  const [showDebug, setShowDebug] = useState(false);
  const availableTopics = Object.keys(pointClouds).sort();
  const bestTopic = useMemo(() => chooseBestPointCloudTopic(pointClouds), [pointClouds]);
  useEffect(() => {
    if (!bestTopic) {
      return;
    }

    const activePoints = pointClouds[activeTopic]?.points.length || 0;
    const bestPoints = pointClouds[bestTopic]?.points.length || 0;
    if (!activeTopic || activeTopic.toLowerCase().includes("scan") || bestPoints > activePoints * 2) {
      setActiveTopic(bestTopic);
    }
  }, [activeTopic, bestTopic, pointClouds, setActiveTopic]);
  const activeData = pointClouds[activeTopic] || { points: [], mapPoints: [], frameId: "", resolvedFrame: "" };
  const points = cloudView === "map" && activeData.mapPoints.length > 0
    ? activeData.mapPoints
    : activeData.points;

  return (
    <section className="workspace-panel lidar-workspace">
      <div className="panel-titlebar">
        <div className="panel-title-group">
          <span>Overview</span>
          {availableTopics.length > 0 && (
            <select
              className="topic-select"
              value={activeTopic}
              onChange={(e) => setActiveTopic(e.target.value)}
            >
              <option value="" disabled>Select point cloud</option>
              {availableTopics.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
        </div>
        <div className="segmented-control" aria-label="LiDAR mode">
          <button type="button" className={mode === "2d" ? "selected" : ""} onClick={() => setMode("2d")}>
            2D
          </button>
          <button type="button" className={mode === "3d" ? "selected" : ""} onClick={() => setMode("3d")}>
            3D
          </button>
        </div>
      </div>
      {mode === "3d" && (
        <div className="lidar-tool-strip">
          <div className="lidar-control-group source-control">
            <span className="control-caption">Source</span>
            <div className="segmented-control compact" aria-label="Point cloud view">
              <button type="button" className={cloudView === "live" ? "selected" : ""} onClick={() => setCloudView("live")}>
                Live
              </button>
              <button type="button" className={cloudView === "map" ? "selected" : ""} onClick={() => setCloudView("map")}>
                Map
              </button>
            </div>
          </div>
          <label className="lidar-control-group">
            <span className="control-caption">Color</span>
            <select aria-label="Point color mode" value={colorMode} onChange={(event) => setColorMode(event.currentTarget.value as LidarColorMode)}>
              <option value="intensity">Intensity</option>
              <option value="height">Height</option>
              <option value="distance">Distance</option>
            </select>
          </label>
          <label className="lidar-control-group size-control">
            <span className="control-caption">Size</span>
            <input
              max="1.5"
              min="0.04"
              step="0.02"
              type="range"
              value={pointSize}
              onChange={(event) => setPointSize(Number(event.currentTarget.value))}
            />
          </label>
          <label className="toggle-row">
            <input checked={autoFit} type="checkbox" onChange={(event) => setAutoFit(event.currentTarget.checked)} />
            <span>Auto</span>
          </label>
          <label className="toggle-row">
            <input checked={showDebug} type="checkbox" onChange={(event) => setShowDebug(event.currentTarget.checked)} />
            <span>Debug</span>
          </label>
        </div>
      )}
      {mode === "3d" ? (
        <Lidar3D
          readings={readings}
          points={points}
          activeTopic={activeTopic}
          frameId={activeData.frameId}
          resolvedFrame={activeData.resolvedFrame}
          vehiclePose={vehiclePose}
          pointSize={pointSize}
          colorMode={colorMode}
          autoFit={autoFit}
          showDebug={showDebug}
        />
      ) : <Lidar2D readings={readings} points={points} />}
      <div className="metric-strip">
        <span>{readings.length} scan points</span>
        <span>{activeData.points.length.toLocaleString()} live pts</span>
        <span>{activeData.mapPoints.length.toLocaleString()} map pts</span>
        <span>{mode.toUpperCase()} {cloudView}</span>
      </div>
    </section>
  );
}

function MapPanel({ gps, speed }: { gps: GpsFix; speed: number }) {
  const lat = Number(gps.latitude);
  const lon = Number(gps.longitude);
  const hasFix = Number.isFinite(lat) && Number.isFinite(lon);
  const mapCenter = useMemo<GpsTrailPoint | undefined>(() => {
    if (!hasFix) {
      return undefined;
    }

    const snap = 0.0025;
    return {
      latitude: Math.round(lat / snap) * snap,
      longitude: Math.round(lon / snap) * snap,
    };
  }, [hasFix, lat, lon]);

  const mapSrc = mapCenter
    ? `https://www.openstreetmap.org/export/embed.html?bbox=${mapCenter.longitude - 0.006}%2C${mapCenter.latitude - 0.004}%2C${mapCenter.longitude + 0.006}%2C${mapCenter.latitude + 0.004}&layer=mapnik&marker=${mapCenter.latitude}%2C${mapCenter.longitude}`
    : "";

  return (
    <section className="workspace-panel map-workspace">
      <div className="panel-titlebar">
        <span>Map</span>
        <strong>{hasFix ? `${formatNumber(lat, 5)}, ${formatNumber(lon, 5)}` : "No fix"}</strong>
      </div>
      {mapSrc ? <iframe title="OpenStreetMap vehicle position" src={mapSrc} /> : <div className="empty-state">Waiting for GPS...</div>}
      <div className="metric-strip">
        <span>Speed {formatNumber(speed)} m/s</span>
        <span>Alt {formatNumber(gps.altitude)} m</span>
      </div>
    </section>
  );
}

function TopicPanel({ topics, latest }: { topics: BagTopicSummary[]; latest?: LatestFrame }) {
  return (
    <section className="workspace-panel topic-workspace">
      <div className="panel-titlebar">
        <span>Topics</span>
        <strong>{topics.length}</strong>
      </div>
      <div className="topic-scroll">
        {topics.map((topic) => (
          <div className="topic-item" key={`${topic.topic}-${topic.type}`}>
            <strong>{topic.topic}</strong>
            <span>{topic.type}</span>
            <em>{topic.count.toLocaleString()} msg</em>
          </div>
        ))}
      </div>
      <div className="latest-payload">
        <span>{latest?.topic || "Waiting for next message..."}</span>
        <code>{latest?.preview || ""}</code>
      </div>
    </section>
  );
}

function App() {
  const [mode, setMode] = useState<WorkspaceMode>("perception");
  const [backendSource, setBackendSource] = useState("none");
  const [lidarReadings, setLidarReadings] = useState<LidarReading[]>([]);
  const [pointClouds, setPointClouds] = useState<Record<string, LidarCloudState>>({});
  const [activePointCloudTopic, setActivePointCloudTopic] = useState<string>("");
  const [bagStatus, setBagStatus] = useState<BagStatus>({
    connected: false,
    playing: false,
    source: "none",
    path: "",
    frameCount: 0,
    cursor: 0,
    topics: [],
  });
  const [latestFrame, setLatestFrame] = useState<LatestFrame>();
  const [pendingSeekRatio, setPendingSeekRatio] = useState<number | undefined>();
  const [bagFiles, setBagFiles] = useState<BagFileOption[]>([]);
  const [selectedBagPath, setSelectedBagPath] = useState("");
  const pointCloudsRef = useRef<Record<string, LidarCloudState>>({});
  const { topicHealth, handleTopicHealthMessage } = useTopicHealth();
  const { camera, resetCamera, handleCameraFrame, handleCameraStream } = useCameraFeed();
  const {
    telemetry,
    series,
    cockpitEvents,
    decisionLogEntries,
    handleTelemetryMessage,
    resetTelemetry,
  } = useDashboardTelemetry();

  useEffect(() => {
    pointCloudsRef.current = pointClouds;
  }, [pointClouds]);

  const handlePointCloudFlush = useCallback((pending: PendingPointCloudPacket[]) => {
    setPointClouds((prev) => {
      const next = { ...prev };
      for (const packet of pending) {
        const cleanPoints = denoisePointCloud(packet.points, packet.frameId, packet.resolvedFrame);
        const livePoints = selectStoredLivePoints(cleanPoints);
        const previous = next[packet.topic] || { points: [], mapPoints: [], frameId: "", resolvedFrame: "" };
        const packetFrame = packet.resolvedFrame || packet.frameId || "";
        const frameChanged = previous.resolvedFrame && packetFrame && previous.resolvedFrame !== packetFrame;
        const previousMapPoints = previous.filterVersion === LIDAR_FILTER_VERSION && !frameChanged ? previous.mapPoints : [];
        next[packet.topic] = {
          points: livePoints,
          mapPoints: mergeLidarMap(previousMapPoints, livePoints),
          frameId: packet.frameId || previous.frameId || "",
          resolvedFrame: packet.resolvedFrame || previous.resolvedFrame || "",
          lastTime: packet.time || previous.lastTime,
          filterVersion: LIDAR_FILTER_VERSION,
        };
      }

      const totalMapPoints = Object.values(next).reduce((sum, s) => sum + s.mapPoints.length, 0);
      if (totalMapPoints > MAX_TOTAL_MAP_POINTS) {
        const ratio = MAX_TOTAL_MAP_POINTS / totalMapPoints;
        for (const key of Object.keys(next)) {
          const s = next[key];
          if (s.mapPoints.length === 0) continue;
          const cap = Math.max(1, Math.floor(s.mapPoints.length * ratio));
          const step = Math.ceil(s.mapPoints.length / cap);
          next[key] = { ...s, mapPoints: s.mapPoints.filter((_, i) => i % step === 0) };
        }
      }

      return next;
    });
  }, []);

  const { enqueue: enqueuePointCloud, clear: clearPointCloudBuffer } = usePointCloudBuffer({
    flushMs: POINT_CLOUD_FLUSH_MS,
    onFlush: handlePointCloudFlush,
  });

  const resetPlaybackState = useCallback(() => {
    clearPointCloudBuffer();
    setPendingSeekRatio(undefined);
    setLidarReadings([]);
    setPointClouds({});
    setActivePointCloudTopic("");
    setLatestFrame(undefined);
    resetTelemetry();
    resetCamera();
  }, [clearPointCloudBuffer, resetCamera, resetTelemetry]);

  const handleLiveMessage = useCallback((packet: LiveMessage) => {
        if (packet.type === "bag-list") {
          const files = Array.isArray(packet.files) ? packet.files : [];
          setBagFiles(files);
          setSelectedBagPath(packet.selectedPath || files[0]?.path || "");
        }

        if (packet.type === "reset-playback") {
          resetPlaybackState();
          setSelectedBagPath(packet.path || "");
        }

        if (packet.type === "status") {
          setBackendSource(packet.source || "unknown");
          if (packet.source === "mqtt" || packet.source === "vehicle-ros") {
            setBagStatus((prev) => ({
              ...prev,
              connected: Boolean(packet.connected),
              playing: Boolean(packet.connected),
              source: packet.source || "unknown",
            }));
          }
        }

        if (packet.type === "scan" && (Array.isArray(packet.readings) || packet.scan)) {
          const t = packet.topic || "scan";
          // Two supported input shapes: pre-projected readings, or a raw LaserScan object.
          const scanPoints = Array.isArray(packet.readings)
            ? scanReadingsToPoints(packet.readings)
            : buildPointCloudFromScan(packet.scan as LaserScanLike);
          if (Array.isArray(packet.readings)) {
            setLidarReadings(packet.readings);
          }
          setPointClouds((prev) => ({
            ...prev,
            [t]: {
              points: appendLidarHistory(prev[t]?.points || [], scanPoints),
              mapPoints: prev[t]?.mapPoints || [],
              frameId: packet.frameId || "laser"
            }
          }));
          setActivePointCloudTopic((prev) => prev || t);
          setLatestFrame({
            topic: t,
            time: packet.time,
            messageType: "LaserScan",
            preview: `${packet.readings?.length || scanPoints.length} projected scan points`,
          });
        }

        if (packet.type === "point-cloud") {
          const t = packet.topic || "point-cloud";
          if (Array.isArray(packet.readings)) {
            setLidarReadings(packet.readings);
          }
          if (Array.isArray(packet.points)) {
            const packetPoints = packet.points;
            enqueuePointCloud({
              topic: t,
              points: packetPoints,
              readings: packet.readings,
              frameId: packet.frameId || "",
              resolvedFrame: packet.resolvedFrame || "",
              time: packet.time,
            });
            setActivePointCloudTopic((prev) => {
              if (!prev || prev.toLowerCase().includes("scan")) {
                return t;
              }

              const currentPoints = pointCloudsRef.current[prev]?.points.length || 0;
              const incomingPoints = packetPoints.length;
              return incomingPoints > currentPoints * 2 ? t : prev;
            });
          }
          setLatestFrame({
            topic: t,
            time: packet.time,
            messageType: "PointCloud2",
            preview: `${packet.points?.length || 0} sampled 3D points`,
          });
        }

        if (packet.type === "camera-frame" && typeof packet.src === "string") {
          handleCameraFrame(packet as CameraFrameMessage);
          setLatestFrame({
            topic: packet.topic || "camera",
            time: packet.time,
            messageType: "Camera",
            preview: packet.resolution || "JPEG frame",
          });
        }

        if (packet.type === "camera-stream" && typeof packet.streamUrl === "string") {
          handleCameraStream(packet as CameraStreamMessage);
          setLatestFrame({
            topic: packet.topic || "camera",
            time: packet.time,
            messageType: "Camera Stream",
            preview: packet.streamUrl,
          });
        }

        if (packet.type === "telemetry" && packet.telemetry) {
          handleTelemetryMessage(packet as TelemetryMessage);

          setLatestFrame({
            topic: packet.topic || "telemetry",
            time: packet.time,
            messageType: "Telemetry",
            preview: JSON.stringify(packet.telemetry).slice(0, 220),
          });
        }

        if (packet.type === "bag-frame") {
          setLatestFrame({
            topic: packet.topic || "unknown",
            time: packet.time,
            messageType: packet.messageType || "unknown",
            preview: JSON.stringify(packet.payload).slice(0, 220),
          });
        }

        if (packet.type === "bag-status") {
          setBagStatus({
            connected: Boolean(packet.connected),
            playing: Boolean(packet.playing),
            source: packet.source || "bag-playback",
            path: packet.path || "",
            frameCount: Number(packet.frameCount || 0),
            cursor: Number(packet.cursor || 0),
            topics: Array.isArray(packet.topics) ? packet.topics : [],
            currentTime: packet.currentTime || "",
            startTime: packet.startTime || "",
            endTime: packet.endTime || "",
            durationSeconds: Number(packet.durationSeconds || 0),
          });
        }
        if (packet.type === "topic-health") {
          handleTopicHealthMessage(packet);
        }
  }, [
    enqueuePointCloud,
    handleCameraFrame,
    handleCameraStream,
    handleTelemetryMessage,
    handleTopicHealthMessage,
    resetPlaybackState,
  ]);

  const { connected: backendConnected, sendMessage } = useLiveTelemetry({
    url: WS_URL,
    onMessage: handleLiveMessage,
  });

  useEffect(() => {
    if (backendConnected) {
      sendMessage({ type: "start-lidar" });
      sendMessage({ type: "list-bags" });
    }
  }, [backendConnected, sendMessage]);

  const bagName = useMemo(() => bagStatus.path.split("/").at(-1) || "2025-07-21-16-54-43.bag", [bagStatus.path]);
  const isLiveSource = backendSource === "mqtt" || backendSource === "vehicle-ros";

  function loadBag(path: string) {
    if (path && sendMessage({ type: "load-bag", path })) {
      setSelectedBagPath(path);
    }
  }

  const {
    currentSeconds,
    durationSeconds,
    playbackRatio,
    frameLabel,
    sendPlaybackCommand,
    seekPlayback,
    seekPlaybackBySeconds,
    previewSeek,
    commitPreviewSeek,
  } = useBagPlayback({
    bagStatus,
    pendingSeekRatio,
    isLiveSource,
    sendMessage,
    setPendingSeekRatio,
    onBeforeSeek: resetPlaybackState,
  });

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <span className="app-kicker">MapPilot Cockpit</span>
          <h1>{bagName}</h1>
        </div>
        <label className="bag-picker">
          <span>Bag</span>
          <select value={selectedBagPath} onChange={(event) => loadBag(event.currentTarget.value)} disabled={isLiveSource}>
            {bagFiles.length === 0 ? (
              <option value="">{isLiveSource ? "Live vehicle stream" : "No .bag files found"}</option>
            ) : bagFiles.map((file) => (
              <option key={file.path} value={file.path}>
                {file.name} ({formatFileSize(file.size)})
              </option>
            ))}
          </select>
        </label>
        <div className="mode-switcher">
          <button type="button" className={mode === "perception" ? "active" : ""} onClick={() => setMode("perception")}>Perception</button>
          <button type="button" className={mode === "control" ? "active" : ""} onClick={() => setMode("control")}>Control</button>
          <button type="button" className={mode === "debug" ? "active" : ""} onClick={() => setMode("debug")}>Triage & Debug</button>
        </div>
        <div className="top-actions">
          <span className={backendConnected ? "status-pill good" : "status-pill bad"}>
            {backendConnected ? "Backend online" : "Backend offline"}
          </span>
          <span className={isLiveSource ? "status-pill good" : "status-pill muted"}>
            {isLiveSource ? `Live source: ${backendSource}` : "Bag playback"}
          </span>
          <span className={bagStatus.playing ? "status-pill good" : "status-pill muted"}>
            {bagStatus.playing ? "Playing" : "Paused"}
          </span>
          <button type="button" onClick={() => sendPlaybackCommand("start-lidar")}>Play</button>
          <button type="button" onClick={() => sendPlaybackCommand("stop-lidar")}>Pause</button>
        </div>
      </header>
      <TopicHealthStrip health={topicHealth} />

      <section className={`inspector-grid mode-${mode}`}>
        <aside className="hud-left">
          <CameraViewer camera={camera} />
          <TopicPanel topics={bagStatus.topics} latest={latestFrame} />
        </aside>

        <section className="hud-center">
          <LidarWorkspace
            readings={lidarReadings}
            pointClouds={pointClouds}
            activeTopic={activePointCloudTopic}
            setActiveTopic={setActivePointCloudTopic}
            vehiclePose={telemetry.pose}
          />
          <MapPanel gps={telemetry.gps} speed={telemetry.speed} />
          <DecisionLogPanel entries={decisionLogEntries} />
        </section>

        <aside className="hud-right">
          <ControlPanel
            isMapping={false}
            lidarConnected={bagStatus.playing}
            backendConnected={backendConnected}
            onStartMapping={() => {}}
            onStopMapping={() => {}}
            onStartLidar={() => sendPlaybackCommand("start-lidar")}
            onStopLidar={() => sendPlaybackCommand("stop-lidar")}
          />
          <div className="telemetry-charts">
            <VehicleCockpit telemetry={telemetry} time={latestFrame?.time} />
            <SparkChart
              title="/imu/acceleration"
              value={formatNumber(vectorMagnitude(telemetry.acceleration))}
              unit="m/s2"
              data={series.acceleration}
              color="#34d399"
            />
          </div>
        </aside>
      </section>

      <footer className="playback-bar">
        <span>{isLiveSource ? "Live vehicle stream" : `${formatDuration(currentSeconds)} / ${formatDuration(durationSeconds)}`}</span>
        <div className="playback-controls" aria-label="Playback controls">
          <button type="button" onClick={() => seekPlaybackBySeconds(-10)} disabled={isLiveSource || durationSeconds <= 0}>
            -10s
          </button>
          <button
            type="button"
            onClick={() => sendPlaybackCommand(bagStatus.playing ? "stop-lidar" : "start-lidar")}
            disabled={!backendConnected || isLiveSource}
          >
            {isLiveSource ? "Live" : bagStatus.playing ? "Pause" : "Play"}
          </button>
          <button type="button" onClick={() => seekPlaybackBySeconds(10)} disabled={isLiveSource || durationSeconds <= 0}>
            +10s
          </button>
        </div>
        <div className="timeline-wrapper">
          <input
            aria-label="Playback position"
            className="timeline-control"
            disabled={isLiveSource}
            max="1000"
            min="0"
            type="range"
            value={Math.round(playbackRatio * 1000)}
            onInput={(event) => previewSeek(Number(event.currentTarget.value) / 1000)}
            onBlur={(event) => commitPreviewSeek(Number(event.currentTarget.value) / 1000)}
            onKeyUp={(event) => commitPreviewSeek(Number(event.currentTarget.value) / 1000)}
            onPointerUp={(event) => commitPreviewSeek(Number(event.currentTarget.value) / 1000)}
          />
          {!isLiveSource && durationSeconds > 0 && cockpitEvents.map((event) => {
            const ratio = (event.timestamp - timeStringToSeconds(bagStatus.startTime)) / durationSeconds;
            if (ratio < 0 || ratio > 1) return null;
            return (
              <span
                key={event.id}
                className={`event-marker severity-${event.severity}`}
                style={{ left: `${ratio * 100}%` }}
                title={`${event.title}: ${event.description}`}
                onClick={() => seekPlayback(ratio)}
              />
            );
          })}
        </div>
        <div className="frame-count" aria-label="Playback frame count">
          <span>Frames</span>
          <strong>{frameLabel.replace("Frame ", "")}</strong>
        </div>
      </footer>
    </main>
  );
}

export default App;
