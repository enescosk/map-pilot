import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import ControlPanel from "./components/ControlPanel";
import DecisionLogPanel from "./components/DecisionLogPanel";
import steeringWheelImage from "./assets/steering-wheel.png";
import "./App.css";

const WS_URL =
  import.meta.env.VITE_WS_URL ||
  `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:4000`;

export type WorkspaceMode = "perception" | "control" | "debug";

export type LidarReading = {
  angle: number;
  distance: number;
};

export type Point3D = {
  x: number;
  y: number;
  z: number;
  intensity?: number;
  seen?: number;
};

export type CameraStatus = {
  name?: string;
  topic: string;
  isActive: boolean;
  mode?: string;
  resolution: string;
  fps: number;
  issue?: string;
  frameSrc?: string;
  streamUrl?: string;
  frameCount: number;
  lastTime?: string;
};

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

export type DecisionLogEntry = {
  id: string;
  time: string;
  source: string;
  message: string;
};

export type CockpitEvent = {
  id: string;
  timestamp: number;
  timeLabel: string;
  severity: "warning" | "critical" | "info";
  source: "imu" | "speed" | "system";
  title: string;
  description?: string;
};

export type BagTopicSummary = {
  topic: string;
  type: string;
  count: number;
  lastTime?: string;
  sample?: string;
};

export type BagStatus = {
  connected: boolean;
  playing: boolean;
  source: string;
  path: string;
  frameCount: number;
  cursor: number;
  topics: BagTopicSummary[];
  currentTime?: string;
  startTime?: string;
  endTime?: string;
  durationSeconds?: number;
};

type BagFileOption = {
  name: string;
  path: string;
  size: number;
  modifiedAt: number;
};

type Vector3 = {
  x?: number;
  y?: number;
  z?: number;
};

type GpsFix = {
  latitude?: number;
  longitude?: number;
  altitude?: number;
};

type GpsTrailPoint = {
  latitude: number;
  longitude: number;
};

type TelemetryState = {
  speed: number;
  acceleration: Vector3;
  angularVelocity: Vector3;
  magneticField: Vector3;
  gps: GpsFix;
  vehicle: {
    speedKmh?: number;
    steeringAngle?: number;
    steeringSpeed?: number;
    steeringTorque?: number;
    targetSteeringAngle?: number;
    targetSteeringSpeed?: number;
    epsTemperature?: number;
    epsWork?: boolean;
    epsFault?: boolean;
    brakePressure?: number;
    targetBrakePressure?: number;
    brakePedal?: number;
    brakePercent?: number;
    brakeFaultLevel?: number;
    parkingBrake?: boolean;
    throttleSetSpeedKmh?: number;
    cruiseActive?: boolean;
    rpm?: number;
    tripDistance?: number;
    gear?: number;
    batterySoc?: number;
    batteryVoltage?: number;
    ignition?: boolean;
    leftSignal?: boolean;
    rightSignal?: boolean;
    emergency?: boolean;
    handbrake?: boolean;
    autonomousManualSelect?: boolean;
    mode?: string;
  };
  pose?: {
    position?: Vector3;
    orientation?: Vector3 & { w?: number };
  };
};

type SeriesPoint = {
  label: string;
  value: number;
};

type LatestFrame = {
  topic: string;
  time?: string;
  messageType: string;
  preview: string;
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
type PendingPointCloudPacket = {
  topic: string;
  points: Point3D[];
  readings?: LidarReading[];
  frameId?: string;
  resolvedFrame?: string;
  time?: string;
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

const MAX_SERIES_POINTS = 80;
const MAX_LIDAR_HISTORY_POINTS = 16000;
const MAX_COCKPIT_EVENTS = 120;
const MAX_RENDERED_POINT_CLOUD_POINTS = 120000;
const MAX_STORED_LIVE_POINTS = 70000;
const MAX_LIDAR_MAP_POINTS = 420000;
const MAX_TOTAL_MAP_POINTS = 650000;
const LIDAR_MAP_VOXEL_SIZE = 0.08;
const POINT_CLOUD_FLUSH_MS = 180;
const LIDAR_RENDER_FPS = 30;
const DEFAULT_LIDAR_CAMERA_POSITION = new THREE.Vector3(-18, 26, 36);
const LIDAR_VIEW_RADIUS_METERS = 30;
const LIDAR_VIEW_MIN_HEIGHT = -2;
const LIDAR_VIEW_MAX_HEIGHT = 3.6;
const LIDAR_MIN_RANGE_METERS = 1.1;
const LIDAR_EGO_CLEARANCE_METERS = 1.15;
const LIDAR_NOISE_VOXEL_SIZE = 0.5;
const LIDAR_MIN_VOXEL_POINTS = 4;
const LIDAR_MIN_NEIGHBOR_POINTS = 7;
const LIDAR_MAP_CONFIRMATION_VOXEL_SIZE = 0.28;
const LIDAR_MAP_MIN_SEEN = 2;
const HEIGHT_COLOR_MIN = -2;
const HEIGHT_COLOR_MAX = 4;
const ENABLE_LIDAR_CONTOURS = false;
const LIDAR_FILTER_VERSION = 3;

const emptyTelemetry: TelemetryState = {
  speed: 0,
  acceleration: {},
  angularVelocity: {},
  magneticField: {},
  gps: {},
  vehicle: {},
};

function vectorMagnitude(vector?: Vector3) {
  if (!vector) {
    return 0;
  }

  return Math.hypot(Number(vector.x || 0), Number(vector.y || 0), Number(vector.z || 0));
}

function formatNumber(value?: number, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : "--";
}

function timeStringToSeconds(time?: string) {
  if (!time) {
    return 0;
  }

  return Number(time) || 0;
}

function formatDuration(seconds?: number) {
  if (!Number.isFinite(seconds)) {
    return "00:00";
  }

  const total = Math.max(0, Math.floor(Number(seconds)));
  const minutes = Math.floor(total / 60);
  const remainingSeconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function formatFileSize(bytes?: number) {
  const size = Number(bytes || 0);
  if (size >= 1_073_741_824) {
    return `${(size / 1_073_741_824).toFixed(1)} GB`;
  }
  if (size >= 1_048_576) {
    return `${(size / 1_048_576).toFixed(1)} MB`;
  }
  return `${Math.max(0, Math.round(size / 1024))} KB`;
}

function formatBoolean(value?: boolean) {
  if (typeof value !== "boolean") {
    return "--";
  }

  return value ? "On" : "Off";
}

function formatGear(value?: number) {
  switch (Number(value)) {
    case 0:
      return "N";
    case 1:
      return "D";
    case 2:
      return "R";
    default:
      return Number.isFinite(value) ? String(value) : "--";
  }
}

function timeLabel(time?: string) {
  if (!time) {
    return "--";
  }

  const [, fraction = ""] = time.split(".");
  return fraction.slice(0, 3) || time.slice(-6);
}

function pushSeries(series: SeriesPoint[], value: number, label: string) {
  return [...series, { value, label }].slice(-MAX_SERIES_POINTS);
}

function scanReadingsToPoints(readings: LidarReading[]) {
  return readings.map((reading) => {
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
  return frame === "odom" || frame === "map";
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

function appendCockpitEvent(events: CockpitEvent[], event: CockpitEvent) {
  const duplicateWindowSeconds = 1.2;
  const exists = events.some((current) => (
    current.source === event.source &&
    current.title === event.title &&
    Math.abs(current.timestamp - event.timestamp) < duplicateWindowSeconds
  ));

  if (exists) {
    return events;
  }

  return [...events, event].slice(-MAX_COCKPIT_EVENTS);
}

function selectRenderablePoints(points: Point3D[]) {
  if (points.length <= MAX_RENDERED_POINT_CLOUD_POINTS) {
    return points;
  }

  const step = Math.ceil(points.length / MAX_RENDERED_POINT_CLOUD_POINTS);
  const selected = [];
  for (let index = 0; index < points.length; index += step) {
    selected.push(points[index]);
  }
  return selected;
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
            <img className="steering-wheel" src={steeringWheelImage} alt="" aria-hidden="true" />
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

function Lidar2D({ readings }: { readings: LidarReading[] }) {
  const maxDistance = Math.max(...readings.map((reading) => reading.distance), 1);
  const displayRange = Math.max(2, Math.ceil(maxDistance));

  return (
    <div className="lidar-2d-stage">
      {readings.map((reading, index) => {
        const angleInRadians = (reading.angle - 90) * (Math.PI / 180);
        const radius = Math.min(reading.distance / displayRange, 1) * 47;
        const x = 50 + Math.cos(angleInRadians) * radius;
        const y = 50 + Math.sin(angleInRadians) * radius;

        return (
          <span
            key={`${reading.angle}-${reading.distance}-${index}`}
            className="lidar-dot"
            style={{ left: `${x}%`, top: `${y}%` }}
          />
        );
      })}
      <span className="ego-marker" />
      <span className="range-chip">{displayRange} m</span>
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

  const fitToCloud = useCallback(() => {
    const debugStats = cloudRef.current?.userData?.debugStats;
    const controls = controlsRef.current;
    if (!debugStats || !controls) return;
    
    const target = new THREE.Vector3(
      (debugStats.threeMin.x + debugStats.threeMax.x) / 2,
      (debugStats.threeMin.y + debugStats.threeMax.y) / 2,
      (debugStats.threeMin.z + debugStats.threeMax.z) / 2,
    );
    controls.target.copy(target);
    // Move camera to look at the center
    const span = Math.max(
      debugStats.threeMax.x - debugStats.threeMin.x,
      debugStats.threeMax.y - debugStats.threeMin.y,
      debugStats.threeMax.z - debugStats.threeMin.z,
      18,
    );
    setView(new THREE.Vector3(target.x - span * 0.38, target.y + span * 0.32, target.z + span * 0.58), target);
  }, [setView]);

  function setTopView() {
    const debugStats = cloudRef.current?.userData?.debugStats;
    const target = new THREE.Vector3(0, 0, 0);
    let height = 70;

    if (debugStats) {
      target.set(
        (debugStats.threeMin.x + debugStats.threeMax.x) / 2,
        (debugStats.threeMin.y + debugStats.threeMax.y) / 2,
        (debugStats.threeMin.z + debugStats.threeMax.z) / 2,
      );
      height = Math.max(
        debugStats.threeMax.x - debugStats.threeMin.x,
        debugStats.threeMax.z - debugStats.threeMin.z,
        35,
      ) * 1.35;
    }

    setView(new THREE.Vector3(target.x, target.y + height, target.z + 0.01), target, new THREE.Vector3(0, 0, -1));
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
    controls.maxDistance = 120;
    controls.minDistance = 8;
    controls.target.set(0, 0, 0);
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    controlsRef.current = controls;

    const grid = new THREE.GridHelper(90, 18, "#0e5e9c", "#10314a");
    grid.material.transparent = true;
    grid.material.opacity = 0.42;
    scene.add(grid);
    scene.add(new THREE.AxesHelper(5));

    const ringMaterial = new THREE.LineBasicMaterial({
      color: "#0f4e75",
      transparent: true,
      opacity: 0.38,
    });
    [10, 20, 30, 40].forEach((radius) => {
      const ringPoints = Array.from({ length: 96 }, (_, index) => {
        const angle = (index / 96) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(angle) * radius, 0.01, Math.sin(angle) * radius);
      });
      const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ringPoints), ringMaterial);
      scene.add(ring);
    });

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
    vehicle.scale.setScalar(0.68);
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

    const material = new THREE.PointsMaterial({
      alphaTest: 0.08,
      map: pointTextureRef.current,
      size: points.length > 0 ? Math.max(pointSize, 0.2) : Math.max(pointSize, 0.24),
      opacity: 0.98,
      transparent: true,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
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
  }, [activeTopic, autoFit, fitToCloud, hasPoints]);

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
  const [cloudView, setCloudView] = useState<"live" | "map">("map");
  const [pointSize, setPointSize] = useState(0.24);
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
  const points = cloudView === "map" ? activeData.mapPoints : activeData.points;

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
              max="0.32"
              min="0.04"
              step="0.01"
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
      ) : <Lidar2D readings={readings} />}
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
  const [backendConnected, setBackendConnected] = useState(false);
  const [backendSource, setBackendSource] = useState("none");
  const [lastPacketAt, setLastPacketAt] = useState(0);
  const [nowMs, setNowMs] = useState(Date.now());
  const [lidarReadings, setLidarReadings] = useState<LidarReading[]>([]);
  const [pointClouds, setPointClouds] = useState<Record<string, LidarCloudState>>({});
  const [activePointCloudTopic, setActivePointCloudTopic] = useState<string>("");
  const [camera, setCamera] = useState<CameraStatus>({
    topic: "/zed2i/zed_node/rgb/image_rect_color/compressed",
    isActive: false,
    resolution: "Waiting",
    fps: 0,
    frameCount: 0,
  });
  const [bagStatus, setBagStatus] = useState<BagStatus>({
    connected: false,
    playing: false,
    source: "none",
    path: "",
    frameCount: 0,
    cursor: 0,
    topics: [],
  });
  const [telemetry, setTelemetry] = useState<TelemetryState>(emptyTelemetry);
  const [cockpitEvents, setCockpitEvents] = useState<CockpitEvent[]>([]);
  const [latestFrame, setLatestFrame] = useState<LatestFrame>();
  const [pendingSeekRatio, setPendingSeekRatio] = useState<number | undefined>();
  const [bagFiles, setBagFiles] = useState<BagFileOption[]>([]);
  const [selectedBagPath, setSelectedBagPath] = useState("");
  const [series, setSeries] = useState({
    acceleration: [] as SeriesPoint[],
    angularVelocity: [] as SeriesPoint[],
    speed: [] as SeriesPoint[],
    magneticField: [] as SeriesPoint[],
  });
  const socketRef = useRef<WebSocket | null>(null);
  const pointCloudsRef = useRef<Record<string, LidarCloudState>>({});
  const pendingPointCloudsRef = useRef<Map<string, PendingPointCloudPacket>>(new Map());
  const pointCloudFlushTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    pointCloudsRef.current = pointClouds;
  }, [pointClouds]);

  useEffect(() => {
    let reconnectTimer: number | undefined;
    let shouldReconnect = true;

    function scheduleReconnect() {
      if (!shouldReconnect || reconnectTimer) {
        return;
      }

      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, 900);
    }

    function flushPointClouds() {
      pointCloudFlushTimerRef.current = undefined;
      const pending = [...pendingPointCloudsRef.current.values()];
      pendingPointCloudsRef.current.clear();
      if (pending.length === 0) {
        return;
      }

      setPointClouds((prev) => {
        const next = { ...prev };
        for (const packet of pending) {
          const cleanPoints = denoisePointCloud(packet.points, packet.frameId, packet.resolvedFrame);
          const livePoints = selectStoredLivePoints(cleanPoints);
          const previous = next[packet.topic] || { points: [], mapPoints: [], frameId: "", resolvedFrame: "" };
          const packetFrame = packet.resolvedFrame || packet.frameId || "";
          const isStableMapFrame = usesWorldFrame(packet.frameId, packet.resolvedFrame);
          const frameChanged = previous.resolvedFrame && packetFrame && previous.resolvedFrame !== packetFrame;
          const previousMapPoints = previous.filterVersion === LIDAR_FILTER_VERSION && !frameChanged ? previous.mapPoints : [];
          next[packet.topic] = {
            points: livePoints,
            mapPoints: isStableMapFrame ? mergeLidarMap(previousMapPoints, livePoints) : previousMapPoints,
            frameId: packet.frameId || previous.frameId || "",
            resolvedFrame: packet.resolvedFrame || previous.resolvedFrame || "",
            lastTime: packet.time || previous.lastTime,
            filterVersion: LIDAR_FILTER_VERSION,
          };
        }

        // Cross-topic cap: when multiple point-cloud topics accumulate, total
        // map memory is N * MAX_LIDAR_MAP_POINTS. Scale every topic down
        // proportionally so the total stays within MAX_TOTAL_MAP_POINTS.
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
    }

    function schedulePointCloudFlush() {
      if (pointCloudFlushTimerRef.current) {
        return;
      }

      pointCloudFlushTimerRef.current = window.setTimeout(flushPointClouds, POINT_CLOUD_FLUSH_MS);
    }

    function resetPlaybackState() {
      pendingPointCloudsRef.current.clear();
      if (pointCloudFlushTimerRef.current) {
        window.clearTimeout(pointCloudFlushTimerRef.current);
        pointCloudFlushTimerRef.current = undefined;
      }
      setPendingSeekRatio(undefined);
      setLidarReadings([]);
      setPointClouds({});
      setActivePointCloudTopic("");
      setCockpitEvents([]);
      setLatestFrame(undefined);
      setTelemetry(emptyTelemetry);
      setSeries({
        acceleration: [],
        angularVelocity: [],
        speed: [],
        magneticField: [],
      });
      setCamera((prev) => ({
        ...prev,
        isActive: false,
        frameSrc: "",
        resolution: "Waiting",
        fps: 0,
        frameCount: 0,
        lastTime: "",
      }));
    }

    function connect() {
      const existingSocket = socketRef.current;
      if (existingSocket?.readyState === WebSocket.OPEN || existingSocket?.readyState === WebSocket.CONNECTING) {
        return;
      }

      const socket = new WebSocket(WS_URL);
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        setBackendConnected(true);
        socket.send(JSON.stringify({ type: "start-lidar" }));
        socket.send(JSON.stringify({ type: "list-bags" }));
      });

      socket.addEventListener("message", (event) => {
      try {
        const packet = JSON.parse(event.data);
        setLastPacketAt(Date.now());
        const label = timeLabel(packet.time);

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
        }

        if (packet.type === "scan" && Array.isArray(packet.readings)) {
          const t = packet.topic || "scan";
          setLidarReadings(packet.readings);
          setPointClouds((prev) => ({
            ...prev,
            [t]: {
              points: appendLidarHistory(prev[t]?.points || [], scanReadingsToPoints(packet.readings)),
              mapPoints: prev[t]?.mapPoints || [],
              frameId: packet.frameId || "laser"
            }
          }));
          setActivePointCloudTopic((prev) => prev || t);
          setLatestFrame({
            topic: t,
            time: packet.time,
            messageType: "LaserScan",
            preview: `${packet.readings.length} projected scan points`,
          });
        }

        if (packet.type === "point-cloud") {
          const t = packet.topic || "point-cloud";
          if (Array.isArray(packet.readings)) {
            setLidarReadings(packet.readings);
          }
          if (Array.isArray(packet.points)) {
            pendingPointCloudsRef.current.set(t, {
              topic: t,
              points: packet.points,
              readings: packet.readings,
              frameId: packet.frameId || "",
              resolvedFrame: packet.resolvedFrame || "",
              time: packet.time,
            });
            schedulePointCloudFlush();
            setActivePointCloudTopic((prev) => {
              if (!prev || prev.toLowerCase().includes("scan")) {
                return t;
              }

              const currentPoints = pointCloudsRef.current[prev]?.points.length || 0;
              const incomingPoints = packet.points.length || 0;
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
          setCamera((prev) => ({
            topic: packet.topic || prev.topic,
            isActive: true,
            frameSrc: packet.src || prev.frameSrc,
            streamUrl: packet.streamUrl || prev.streamUrl,
            resolution: packet.resolution || prev.resolution,
            fps: Number(packet.fps || prev.fps),
            frameCount: prev.frameCount + 1,
            issue: packet.issue || "",
            lastTime: packet.time,
          }));
          setLatestFrame({
            topic: packet.topic || "camera",
            time: packet.time,
            messageType: "Camera",
            preview: packet.resolution || "JPEG frame",
          });
        }

        if (packet.type === "camera-stream" && typeof packet.streamUrl === "string") {
          setCamera((prev) => ({
            ...prev,
            topic: packet.topic || prev.topic,
            isActive: true,
            streamUrl: packet.streamUrl,
            resolution: packet.resolution || "Stream",
            issue: "",
            lastTime: packet.time || prev.lastTime,
          }));
          setLatestFrame({
            topic: packet.topic || "camera",
            time: packet.time,
            messageType: "Camera Stream",
            preview: packet.streamUrl,
          });
        }

        if (packet.type === "telemetry" && packet.telemetry) {
          setTelemetry((prev) => {
            const next = {
              ...prev,
              ...packet.telemetry,
              gps: { ...prev.gps, ...packet.telemetry.gps },
              acceleration: { ...prev.acceleration, ...packet.telemetry.acceleration },
              angularVelocity: { ...prev.angularVelocity, ...packet.telemetry.angularVelocity },
              magneticField: { ...prev.magneticField, ...packet.telemetry.magneticField },
              vehicle: { ...prev.vehicle, ...packet.telemetry.vehicle },
            };

            const accMag = vectorMagnitude(next.acceleration);
            const oldAccMag = vectorMagnitude(prev.acceleration);
            const speed = next.speed;
            const oldSpeed = prev.speed;

            if (accMag > 12 && oldAccMag <= 12) {
              setCockpitEvents((events) => appendCockpitEvent(
                events,
                {
                  id: `acc-${packet.time}-${Math.random()}`,
                  timestamp: timeStringToSeconds(packet.time),
                  timeLabel: label,
                  severity: "warning",
                  source: "imu",
                  title: "High Acceleration Spike",
                  description: `Acceleration reached ${formatNumber(accMag)} m/s²`,
                }
              ));
            }

            if (oldSpeed > 2 && speed < 0.5) {
              setCockpitEvents((events) => appendCockpitEvent(
                events,
                {
                  id: `stop-${packet.time}-${Math.random()}`,
                  timestamp: timeStringToSeconds(packet.time),
                  timeLabel: label,
                  severity: "critical",
                  source: "speed",
                  title: "Sudden Stop",
                  description: `Speed dropped rapidly from ${formatNumber(oldSpeed)} to ${formatNumber(speed)} m/s`,
                }
              ));
            }

            setSeries((current) => ({
              acceleration: packet.telemetry.acceleration
                ? pushSeries(current.acceleration, vectorMagnitude(next.acceleration), label)
                : current.acceleration,
              angularVelocity: packet.telemetry.angularVelocity
                ? pushSeries(current.angularVelocity, vectorMagnitude(next.angularVelocity), label)
                : current.angularVelocity,
              speed: typeof packet.telemetry.speed === "number"
                ? pushSeries(current.speed, packet.telemetry.speed, label)
                : current.speed,
              magneticField: packet.telemetry.magneticField
                ? pushSeries(current.magneticField, vectorMagnitude(next.magneticField), label)
                : current.magneticField,
            }));

            return next;
          });

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
      } catch (err) {
        console.error("Invalid backend message:", err);
      }
      });

      socket.addEventListener("close", () => {
        setBackendConnected(false);
        if (socketRef.current === socket) {
          socketRef.current = null;
        }
        scheduleReconnect();
      });

      socket.addEventListener("error", () => {
        setBackendConnected(false);
        socket.close();
        scheduleReconnect();
      });
    }

    connect();
    const clockTimer = window.setInterval(() => setNowMs(Date.now()), 1000);

    return () => {
      shouldReconnect = false;
      window.clearInterval(clockTimer);
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      if (pointCloudFlushTimerRef.current) {
        window.clearTimeout(pointCloudFlushTimerRef.current);
      }
      socketRef.current?.close();
    };
  }, []);

  const decisionLogEntries: DecisionLogEntry[] = useMemo(() => {
    return cockpitEvents.map((e) => ({
      id: e.id,
      time: e.timeLabel,
      source: e.source.toUpperCase(),
      message: `${e.title}: ${e.description}`,
    }));
  }, [cockpitEvents]);

  const bagName = useMemo(() => bagStatus.path.split("/").at(-1) || "2025-07-21-16-54-43.bag", [bagStatus.path]);
  const isLiveMqtt = backendSource === "mqtt";
  const secondsSincePacket = lastPacketAt > 0 ? Math.max(0, Math.round((nowMs - lastPacketAt) / 1000)) : 0;
  const streamIsFresh = backendConnected && lastPacketAt > 0 && secondsSincePacket <= 3;
  const liveBannerState = !backendConnected ? "offline" : streamIsFresh ? "live" : "stale";
  const liveBannerText = !backendConnected
    ? "Backend offline - dashboard is not receiving data"
    : streamIsFresh
      ? `Live stream healthy - last packet ${secondsSincePacket}s ago`
      : lastPacketAt > 0
        ? `Waiting for fresh data - last packet ${secondsSincePacket}s ago`
        : "Connected, waiting for first data packet";
  const currentSeconds = Math.max(0, timeStringToSeconds(bagStatus.currentTime) - timeStringToSeconds(bagStatus.startTime));
  const durationSeconds = Number(bagStatus.durationSeconds || 0);
  const playbackRatio = pendingSeekRatio ?? (durationSeconds > 0 ? Math.min(currentSeconds / durationSeconds, 1) : 0);
  const frameLabel = bagStatus.frameCount > 0
    ? `Frame ${Math.trunc(Math.min(bagStatus.cursor, bagStatus.frameCount))} / ${Math.trunc(bagStatus.frameCount)}`
    : "Frame 0 / 0";

  function sendPlaybackCommand(type: "start-lidar" | "stop-lidar") {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type }));
    }
  }

  function seekPlayback(ratio: number) {
    if (isLiveMqtt) {
      return;
    }

    if (socketRef.current?.readyState === WebSocket.OPEN) {
      setPendingSeekRatio(undefined);
      pendingPointCloudsRef.current.clear();
      if (pointCloudFlushTimerRef.current) {
        window.clearTimeout(pointCloudFlushTimerRef.current);
        pointCloudFlushTimerRef.current = undefined;
      }
      setPointClouds({});
      setLidarReadings([]);
      socketRef.current.send(JSON.stringify({ type: "seek-playback", ratio }));
    }
  }

  function seekPlaybackBySeconds(deltaSeconds: number) {
    if (durationSeconds <= 0) {
      return;
    }

    seekPlayback((currentSeconds + deltaSeconds) / durationSeconds);
  }

  function loadBag(path: string) {
    if (socketRef.current?.readyState === WebSocket.OPEN && path) {
      setSelectedBagPath(path);
      socketRef.current.send(JSON.stringify({ type: "load-bag", path }));
    }
  }

  function previewSeek(ratio: number) {
    const clampedRatio = Math.max(0, Math.min(1, ratio));
    setPendingSeekRatio(clampedRatio);
  }

  function commitPreviewSeek(ratio?: number) {
    const targetRatio = typeof ratio === "number" ? ratio : pendingSeekRatio;
    if (typeof targetRatio === "number") {
      seekPlayback(targetRatio);
    }
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <span className="app-kicker">MapPilot Cockpit</span>
          <h1>{bagName}</h1>
        </div>
        <label className="bag-picker">
          <span>Bag</span>
          <select value={selectedBagPath} onChange={(event) => loadBag(event.currentTarget.value)} disabled={isLiveMqtt}>
            {bagFiles.length === 0 ? (
              <option value="">{isLiveMqtt ? "Remote MQTT stream" : "No .bag files found"}</option>
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
          <span className={isLiveMqtt ? "status-pill good" : "status-pill muted"}>
            {isLiveMqtt ? "MQTT live" : "Playback source"}
          </span>
          <span className={streamIsFresh ? "status-pill good" : "status-pill muted"}>
            {lastPacketAt > 0 ? `Last packet ${secondsSincePacket}s` : "No packets"}
          </span>
          <span className={bagStatus.playing ? "status-pill good" : "status-pill muted"}>
            {bagStatus.playing ? "Playing" : "Paused"}
          </span>
          <button type="button" onClick={() => sendPlaybackCommand("start-lidar")}>Play</button>
          <button type="button" onClick={() => sendPlaybackCommand("stop-lidar")}>Pause</button>
        </div>
      </header>

      <section className={`live-banner ${liveBannerState}`} aria-live="polite">
        <strong>{isLiveMqtt ? "MQTT Live Mode" : "Playback Mode"}</strong>
        <span>{liveBannerText}</span>
      </section>

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
        <span>{isLiveMqtt ? "Live MQTT stream" : `${formatDuration(currentSeconds)} / ${formatDuration(durationSeconds)}`}</span>
        <div className="playback-controls" aria-label="Playback controls">
          <button type="button" onClick={() => seekPlaybackBySeconds(-10)} disabled={isLiveMqtt || durationSeconds <= 0}>
            -10s
          </button>
          <button
            type="button"
            onClick={() => sendPlaybackCommand(bagStatus.playing ? "stop-lidar" : "start-lidar")}
            disabled={!backendConnected || isLiveMqtt}
          >
            {isLiveMqtt ? "Live" : bagStatus.playing ? "Pause" : "Play"}
          </button>
          <button type="button" onClick={() => seekPlaybackBySeconds(10)} disabled={isLiveMqtt || durationSeconds <= 0}>
            +10s
          </button>
        </div>
        <div className={`timeline-wrapper ${isLiveMqtt ? "live" : ""}`}>
          <input
            aria-label="Playback position"
            className="timeline-control"
            disabled={isLiveMqtt}
            max="1000"
            min="0"
            type="range"
            value={Math.round(playbackRatio * 1000)}
            onInput={(event) => previewSeek(Number(event.currentTarget.value) / 1000)}
            onBlur={(event) => commitPreviewSeek(Number(event.currentTarget.value) / 1000)}
            onKeyUp={(event) => commitPreviewSeek(Number(event.currentTarget.value) / 1000)}
            onPointerUp={(event) => commitPreviewSeek(Number(event.currentTarget.value) / 1000)}
          />
          {!isLiveMqtt && durationSeconds > 0 && cockpitEvents.map((event) => {
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
