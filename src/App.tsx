import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ErrorBoundary } from "./components/ErrorBoundary";
import ControlPanel from "./components/ControlPanel";
import ConnectionPanel from "./components/ConnectionPanel";
import DecisionLogPanel from "./components/DecisionLogPanel";
import TopicHealthStrip from "./components/TopicHealthStrip";
import { useCameraFeed } from "./hooks/useCameraFeed";
import { useDashboardTelemetry } from "./hooks/useDashboardTelemetry";
import { useLiveTelemetry } from "./hooks/useLiveTelemetry";
import { usePointCloudBuffer, type PendingPointCloudPacket } from "./hooks/usePointCloudBuffer";
import { useTopicHealth } from "./hooks/useTopicHealth";
import type { CameraFrameMessage, CameraStatus, CameraStreamMessage, LatestFrame, LidarReading, LiveMessage, Point3D, TelemetryMessage } from "./types/liveMessages";
import type { GpsFix, SeriesPoint, TelemetryState, Vector3 } from "./types/telemetry";
import {
  chooseBestPointCloudTopic,
  isMeaningfulDisplayPoint,
  LIDAR_FILTER_VERSION,
  MAX_TOTAL_MAP_POINTS,
  mergeLidarMap,
  POINT_CLOUD_FLUSH_MS,
  pointToDisplayThree,
  scanReadingsToPoints,
  selectStoredLivePoints,
  type LidarCloudState,
} from "./utils/lidarProcessing";
import { formatBoolean, formatGear, formatNumber, vectorMagnitude } from "./utils/telemetryFormatters";
import { timeStringToSeconds } from "./utils/timeLabel";
import "./App.css";

const WS_URL =
  import.meta.env.VITE_WS_URL ||
  `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:4000`;

export type WorkspaceMode = "perception" | "debug";

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

type LidarMode = "2d" | "3d";
type LidarColorMode = "intensity" | "height" | "distance";
type LidarDebugStats = {
  pointsCount: number;
  sourcePointsCount: number;
  min: Required<Vector3>;
  max: Required<Vector3>;
  threeMin: Required<Vector3>;
  threeMax: Required<Vector3>;
  firstPoints: Point3D[];
};

const LIDAR_RENDER_FPS = 30;
// Default camera: behind-and-above the ego, slightly looking down.
// In Three.js coords, vehicle is at origin and forward = -Z, so we sit at +Z (behind), +Y (above).
const DEFAULT_LIDAR_CAMERA_POSITION = new THREE.Vector3(0, 25, 35);
// Tighter height-color range: ground = blue, person height = green/yellow, canopy = red.
const HEIGHT_COLOR_MIN = -1;
const HEIGHT_COLOR_MAX = 5;
const ENABLE_LIDAR_CONTOURS = false;

function sourceModeInfo(source: string) {
  switch (source) {
    case "vehicle-ros":
      return { label: "vehicle-ros", kind: "Live ROS", waiting: "Waiting for live ROS topics..." };
    case "mqtt":
      return { label: "mqtt", kind: "Live MQTT", waiting: "Waiting for MQTT topics..." };
    case "rosbridge":
      return { label: "ros", kind: "Legacy live ROS", waiting: "Waiting for ROS scan topic..." };
    case "direct-serial":
      return { label: "direct", kind: "Bench live", waiting: "Waiting for direct LiDAR scan..." };
    default:
      return { label: source || "none", kind: "Source pending", waiting: "Waiting for backend source status..." };
  }
}

function sourceHealthLabel(connected: boolean, isLiveSource: boolean, isStale: boolean) {
  if (isStale) return "topic stale";
  if (!isLiveSource) return connected ? "ready" : "idle";
  return connected ? "connected" : "disconnected";
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
  const hasTelemetry = telemetry.derived || telemetry.heading !== undefined || Object.values(vehicle).some((value) => value !== undefined);
  const gps = telemetry.gps || {};
  const hasGps = gps.latitude !== undefined && gps.longitude !== undefined;

  return (
    <section className="workspace-panel telemetry-card cockpit-card">
      <div className="panel-titlebar">
        <span>Vehicle Cockpit</span>
        <strong>{time || "--"}</strong>
      </div>
      <div className="cockpit-layout">
        <SpeedGauge speedKmh={vehicle.speedKmh} speedMs={telemetry.speed} />
        <VehicleTopView vehicle={vehicle} />
        {!hasTelemetry && (
          <p className="panel-note cockpit-note">Telemetry unavailable for this source</p>
        )}
        <div className="cockpit-status-grid">
          <div className="cockpit-metric">
            <span>Steering</span>
            <strong>{formatNumber(vehicle.steeringAngle, 0)}°</strong>
            <em>target {formatNumber(vehicle.targetSteeringAngle, 0)}°</em>
          </div>
          <div className="cockpit-metric">
            <span>Brake</span>
            <strong>{formatNumber(vehicle.brakePercent, 0)}%</strong>
            <em>{formatNumber(vehicle.brakePressure, 1)} bar</em>
          </div>
          <div className="cockpit-metric">
            <span>Throttle</span>
            <strong>{formatNumber(vehicle.throttleSetSpeedKmh, 0)} km/h</strong>
            <em>cruise {formatBoolean(vehicle.cruiseActive)}</em>
          </div>
          <div className="cockpit-metric">
            <span>Drive</span>
            <strong>{formatGear(vehicle.gear)}</strong>
            <em>{vehicle.mode || (telemetry.heading !== undefined ? `heading ${formatNumber(telemetry.heading, 0)}°` : "mode --")}</em>
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
          <div className="cockpit-metric">
            <span>Heading</span>
            <strong>{telemetry.heading !== undefined ? `${formatNumber(telemetry.heading, 0)}°` : "--"}</strong>
            <em>compass</em>
          </div>
          {hasGps && (
            <>
              <div className="cockpit-metric">
                <span>Latitude</span>
                <strong>{formatNumber(gps.latitude, 5)}°</strong>
                <em>GPS</em>
              </div>
              <div className="cockpit-metric">
                <span>Longitude</span>
                <strong>{formatNumber(gps.longitude, 5)}°</strong>
                <em>GPS</em>
              </div>
              {gps.altitude !== undefined && (
                <div className="cockpit-metric">
                  <span>Altitude</span>
                  <strong>{formatNumber(gps.altitude, 1)} m</strong>
                  <em>GPS</em>
                </div>
              )}
            </>
          )}
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
          <div className="empty-state">No camera frame received yet</div>
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
  const renderRequestRef = useRef<(() => void) | null>(null);
  const rawDisplayPoints = useMemo(() => points.length > 0 ? points : scanReadingsToPoints(readings), [points, readings]);
  const hasPoints = points.length > 0;
  // Worker already filters + downsamples; we only need the meaningful-display
  // filter here. Skipping denoisePointCloud removes a 60k×27 voxel-lookup pass
  // that was killing the main thread (was ~30-50 ms per flush at capacity).
  const scenePoints = useMemo(() => {
    return rawDisplayPoints.filter((point) => isMeaningfulDisplayPoint(point, frameId, resolvedFrame, vehiclePose));
  }, [frameId, rawDisplayPoints, resolvedFrame, vehiclePose]);
  const displayPoints = scenePoints; // worker already capped to render budget
  const debugStats = useMemo<LidarDebugStats>(() => {
    // Lazy: only compute when debug overlay is visible (saves 60k×trig per frame).
    if (!showDebug) {
      return {
        pointsCount: displayPoints.length,
        sourcePointsCount: rawDisplayPoints.length,
        min: { x: 0, y: 0, z: 0 },
        max: { x: 0, y: 0, z: 0 },
        threeMin: { x: 0, y: 0, z: 0 },
        threeMax: { x: 0, y: 0, z: 0 },
        firstPoints: [],
      };
    }
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
  }, [displayPoints, frameId, rawDisplayPoints.length, resolvedFrame, vehiclePose, showDebug]);

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

    // On-demand rendering: render only when data or camera changed, throttled to
    // LIDAR_RENDER_FPS. Saves ~10% CPU when idle vs continuous rAF.
    let frame = 0;
    let lastRenderMs = 0;
    let needsRender = true;
    const minRenderIntervalMs = 1000 / LIDAR_RENDER_FPS;
    const markDirty = () => { needsRender = true; };
    renderRequestRef.current = markDirty;

    const render = (now = 0) => {
      frame = requestAnimationFrame(render);
      if (!needsRender && now - lastRenderMs < minRenderIntervalMs * 4) {
        return;
      }
      if (now - lastRenderMs < minRenderIntervalMs) return;
      needsRender = false;
      lastRenderMs = now;
      controls.update();
      renderer.render(scene, camera);
    };
    controls.addEventListener("change", markDirty);
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

  // Pre-allocated typed-array pool — same buffer is reused across frames so we
  // avoid GC pressure (was ~21 MB/s of churn at 30 Hz with 60k points).
  const MAX_RENDER_POINTS = 65_536;
  const positionsRef = useRef<Float32Array>(new Float32Array(MAX_RENDER_POINTS * 3));
  const colorsRef = useRef<Float32Array>(new Float32Array(MAX_RENDER_POINTS * 3));

  // Create geometry + material ONCE on first render and reuse forever.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || cloudRef.current) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positionsRef.current, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colorsRef.current, 3));
    geometry.setDrawRange(0, 0);
    // Bounding sphere doesn't auto-update with in-place writes — give a large
    // sphere so frustum-culling never hides the cloud.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1000);

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
    cloud.renderOrder = 10;
    cloud.frustumCulled = false;
    cloudRef.current = cloud;
    scene.add(cloud);
  }, []);

  // Keep material.size in sync with the pointSize slider without recreating cloud.
  useEffect(() => {
    const cloud = cloudRef.current;
    if (!cloud) return;
    (cloud.material as THREE.PointsMaterial).size = Math.max(pointSize, 0.25);
  }, [pointSize]);

  // Per-cloud update: write into the existing typed-array slots and flag dirty.
  useEffect(() => {
    const cloud = cloudRef.current;
    if (!cloud) return;

    const positions = positionsRef.current;
    const colors = colorsRef.current;
    const color = new THREE.Color();
    const count = Math.min(displayPoints.length, MAX_RENDER_POINTS);

    for (let i = 0; i < count; i++) {
      const point = displayPoints[i];
      const threePoint = pointToDisplayThree(point, frameId, resolvedFrame, vehiclePose);
      const o = i * 3;
      positions[o]     = threePoint.x;
      positions[o + 1] = threePoint.y;
      positions[o + 2] = threePoint.z;

      if (colorMode === "intensity" && typeof point.intensity === "number" && point.intensity > 0) {
        const normalizedInt = Math.max(0, Math.min(1, point.intensity > 255 ? point.intensity / 4096 : point.intensity / 255));
        setTurboColor(color, normalizedInt);
      } else if (colorMode === "height") {
        const height = (threePoint.y - HEIGHT_COLOR_MIN) / (HEIGHT_COLOR_MAX - HEIGHT_COLOR_MIN);
        setTurboColor(color, height);
      } else {
        // Math.sqrt(x*x + y*y + z*z) is ~3× faster than Math.hypot in V8.
        const distance = Math.sqrt(threePoint.x * threePoint.x + threePoint.y * threePoint.y + threePoint.z * threePoint.z);
        const normalized = Math.max(0, Math.min(1, distance / 45));
        setTurboColor(color, 1 - normalized);
      }

      colors[o]     = color.r;
      colors[o + 1] = color.g;
      colors[o + 2] = color.b;
    }

    cloud.geometry.setDrawRange(0, count);
    (cloud.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (cloud.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    cloud.userData = { debugStats };
    renderRequestRef.current?.();
  }, [colorMode, debugStats, displayPoints, frameId, resolvedFrame, vehiclePose]);

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
  emptyMessage,
  onMapViewChange,
}: {
  readings: LidarReading[];
  pointClouds: Record<string, LidarCloudState>;
  activeTopic: string;
  setActiveTopic: (t: string) => void;
  vehiclePose?: TelemetryState["pose"];
  emptyMessage: string;
  onMapViewChange?: (active: boolean) => void;
}) {
  const [mode, setMode] = useState<LidarMode>("3d");
  const [cloudView, setCloudView] = useState<"live" | "map">("live");
  useEffect(() => {
    onMapViewChange?.(cloudView === "map");
  }, [cloudView, onMapViewChange]);
  const [pointSize, setPointSize] = useState(0.35);
  const [colorMode, setColorMode] = useState<LidarColorMode>("height");
  const [autoFit, setAutoFit] = useState(true);
  const [showDebug, setShowDebug] = useState(false);
  const availableTopics = Object.keys(pointClouds).sort();
  const bestTopic = useMemo(() => chooseBestPointCloudTopic(pointClouds), [pointClouds]);
  // During the first 4 s, keep updating to the best topic so we settle on the
  // highest-priority / most-points source once all topics have sent their first frames.
  // After that window, only auto-select when nothing is active (manual picks are respected).
  const lidarStartRef = useRef<number>(Date.now());
  useEffect(() => {
    if (!bestTopic) return;
    const elapsed = Date.now() - lidarStartRef.current;
    if (elapsed < 4000 || !activeTopic) {
      setActiveTopic(bestTopic);
    }
  }, [activeTopic, bestTopic, setActiveTopic]);
  const activeData = pointClouds[activeTopic] || { points: [], mapPoints: [], frameId: "", resolvedFrame: "" };
  const points = cloudView === "map" && activeData.mapPoints.length > 0
    ? activeData.mapPoints
    : activeData.points;
  const hasLidarData = readings.length > 0 || points.length > 0;

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
      {hasLidarData ? mode === "3d" ? (
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
      ) : <Lidar2D readings={readings} points={points} /> : (
        <div className="empty-state lidar-empty-state">{emptyMessage}</div>
      )}
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

function LatestFramePanel({ latest }: { latest?: LatestFrame }) {
  return (
    <section className="workspace-panel topic-workspace">
      <div className="panel-titlebar">
        <span>Son Mesaj</span>
        <strong>{latest?.messageType || "—"}</strong>
      </div>
      <div className="latest-payload">
        <span>{latest?.topic || "Veri bekleniyor..."}</span>
        <code>{latest?.preview || ""}</code>
      </div>
    </section>
  );
}

function App() {
  const [mode, setMode] = useState<WorkspaceMode>("perception");
  const [backendSource, setBackendSource] = useState("none");
  const [backendError, setBackendError] = useState<string | null>(null);
  const [lidarReadings, setLidarReadings] = useState<LidarReading[]>([]);
  const [pointClouds, setPointClouds] = useState<Record<string, LidarCloudState>>({});
  const [activePointCloudTopic, setActivePointCloudTopic] = useState<string>("");
  const [sourceConnected, setSourceConnected] = useState(false);
  const [latestFrame, setLatestFrameState] = useState<LatestFrame>();
  // Throttle latestFrame to ≤10 fps. Topic panel doesn't need 100+ updates/sec.
  const latestFrameRef = useRef<LatestFrame | undefined>(undefined);
  const latestFrameTimerRef = useRef<number | undefined>(undefined);
  const setLatestFrame = useCallback((frame: LatestFrame | undefined) => {
    latestFrameRef.current = frame;
    if (latestFrameTimerRef.current) return;
    latestFrameTimerRef.current = window.setTimeout(() => {
      latestFrameTimerRef.current = undefined;
      setLatestFrameState(latestFrameRef.current);
    }, 100);
  }, []);
  useEffect(() => () => {
    if (latestFrameTimerRef.current) window.clearTimeout(latestFrameTimerRef.current);
  }, []);
  const pointCloudsRef = useRef<Record<string, LidarCloudState>>({});
  const { topicHealth, handleTopicHealthMessage } = useTopicHealth();
  const { camera, resetCamera, handleCameraFrame, handleCameraStream } = useCameraFeed();
  const {
    telemetry,
    series,
    decisionLogEntries,
    handleTelemetryMessage,
    resetTelemetry,
  } = useDashboardTelemetry();

  useEffect(() => {
    pointCloudsRef.current = pointClouds;
  }, [pointClouds]);

  // Tracks whether ANY workspace currently shows the map view.
  // When false, mergeLidarMap is skipped (saves ~30-50ms/flush at capacity).
  const mapViewActiveRef = useRef(false);

  const handlePointCloudFlush = useCallback((pending: PendingPointCloudPacket[]) => {
    setPointClouds((prev) => {
      const next = { ...prev };
      const mapActive = mapViewActiveRef.current;

      for (const packet of pending) {
        // Worker already filtered + downsampled. denoisePointCloud was an
        // O(N×27) main-thread pass we no longer need.
        const livePoints = selectStoredLivePoints(packet.points);
        const previous = next[packet.topic] || { points: [], mapPoints: [], frameId: "", resolvedFrame: "" };
        const packetFrame = packet.resolvedFrame || packet.frameId || "";
        const frameChanged = previous.resolvedFrame && packetFrame && previous.resolvedFrame !== packetFrame;
        const previousMapPoints = previous.filterVersion === LIDAR_FILTER_VERSION && !frameChanged ? previous.mapPoints : [];
        next[packet.topic] = {
          points: livePoints,
          // Only rebuild the cumulative map when user is actually looking at it.
          mapPoints: mapActive ? mergeLidarMap(previousMapPoints, livePoints) : previousMapPoints,
          frameId: packet.frameId || previous.frameId || "",
          resolvedFrame: packet.resolvedFrame || previous.resolvedFrame || "",
          lastTime: packet.time || previous.lastTime,
          filterVersion: LIDAR_FILTER_VERSION,
        };
      }

      if (mapActive) {
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
      }

      return next;
    });
  }, []);

  const { enqueue: enqueuePointCloud, clear: clearPointCloudBuffer } = usePointCloudBuffer({
    flushMs: POINT_CLOUD_FLUSH_MS,
    onFlush: handlePointCloudFlush,
  });

  const resetStreamState = useCallback(() => {
    clearPointCloudBuffer();
    setLidarReadings([]);
    setPointClouds({});
    setActivePointCloudTopic("");
    setLatestFrame(undefined);
    resetTelemetry();
    resetCamera();
  }, [clearPointCloudBuffer, resetCamera, resetTelemetry]);

  const handleLiveMessage = useCallback((packet: LiveMessage) => {
        if (packet.type === "backend-error") {
          setBackendError(packet.message || "Bilinmeyen hata");
          return;
        }

        if (packet.type === "source-changed") {
          setBackendSource(packet.source || "unknown");
          setBackendError(null);
          resetStreamState();
        }

        if (packet.type === "status") {
          setBackendSource(packet.source || "unknown");
          setSourceConnected(Boolean(packet.connected));
        }

        // scan and point-cloud are handled by the Web Worker (see handleWorkerMessage)

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
          // No JSON.stringify on preview path — was running at 50+ Hz × 1KB.
          setLatestFrame({
            topic: packet.topic || "telemetry",
            time: packet.time,
            messageType: "Telemetry",
            preview: "",
          });
        }

        if (packet.type === "topic-health") {
          handleTopicHealthMessage(packet);
        }
  }, [
    handleCameraFrame,
    handleCameraStream,
    handleTelemetryMessage,
    handleTopicHealthMessage,
    resetStreamState,
  ]);

  // Worker delivers pre-processed scan-ready / cloud-ready results (lidar work is off main thread)
  const handleWorkerMessage = useCallback((ev: MessageEvent) => {
    const { type } = ev.data as { type: string };

    if (type === "scan-ready") {
      const { topic, renderable, readingsLength, time, frameId } = ev.data as {
        topic: string; renderable: Point3D[]; readingsLength: number; time: string; frameId: string;
      };
      setPointClouds((prev) => ({
        ...prev,
        [topic]: {
          points: renderable,
          mapPoints: prev[topic]?.mapPoints || [],
          frameId: frameId || "laser",
        },
      }));
      setActivePointCloudTopic((prev) => prev || topic);
      setLatestFrame({ topic, time, messageType: "LaserScan", preview: `${readingsLength} projected scan points` });
    }

    if (type === "cloud-ready") {
      const { topic, renderable, time, frameId, resolvedFrame } = ev.data as {
        topic: string; renderable: Point3D[]; time: string; frameId: string; resolvedFrame: string;
      };
      enqueuePointCloud({ topic, points: renderable, frameId, resolvedFrame, time });
      setActivePointCloudTopic((prev) => prev || topic);
      setLatestFrame({ topic, time, messageType: "PointCloud2", preview: `${renderable.length} sampled 3D points` });
    }
  }, [enqueuePointCloud]);

  const { connected: backendConnected, wsStatus, sendMessage } = useLiveTelemetry({
    url: WS_URL,
    onMessage: handleLiveMessage,
    onWorkerMessage: handleWorkerMessage,
  });

  useEffect(() => {
    if (backendConnected) {
      sendMessage({ type: "start-lidar" });
    }
  }, [backendConnected, sendMessage]);

  const isLiveSource = backendSource === "mqtt" || backendSource === "vehicle-ros" || backendSource === "rosbridge" || backendSource === "direct-serial";
  const sourceTitle = isLiveSource ? "Canlı Araç" : "Bağlı değil";
  const sourceMode = sourceModeInfo(backendSource);
  const sourceHealth =
    topicHealth.sources[backendSource] ||
    topicHealth.sources[sourceMode.label];
  const sourceIsConnected = Boolean(sourceHealth?.connected ?? sourceConnected);
  const sourceHasStaleTopics = Object.values(topicHealth.topics || {}).some((topic) => topic.isStale);
  const sourceStatusText = sourceHealthLabel(sourceIsConnected, isLiveSource, sourceHasStaleTopics);

  function connectSource(source: "vehicle-ros" | "mqtt", rosbridgeUrl: string, mqttUrl: string) {
    sendMessage({ type: "connect-source", source, rosbridgeUrl, mqttUrl });
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <span className="app-kicker">MapPilot Cockpit</span>
          <h1>{sourceTitle}</h1>
        </div>
        <div className="mode-switcher">
          <button type="button" className={mode === "perception" ? "active" : ""} onClick={() => setMode("perception")}>Cockpit</button>
          <button type="button" className={mode === "debug" ? "active" : ""} onClick={() => setMode("debug")}>LiDAR</button>
        </div>
        <div className="top-actions">
          <span className={
            backendConnected ? "status-pill good" :
            wsStatus === "connecting" ? "status-pill warn" : "status-pill bad"
          }>
            {backendConnected ? "Backend online" :
             wsStatus === "connecting" ? "Bağlanıyor…" : "Backend offline"}
          </span>
          <span className={isLiveSource ? "status-pill good" : "status-pill muted"} title={sourceMode.waiting}>
            {sourceMode.kind}: {sourceMode.label}
          </span>
          <span className={sourceIsConnected && !sourceHasStaleTopics ? "status-pill good" : sourceHasStaleTopics ? "status-pill bad" : "status-pill muted"}>
            {sourceStatusText}
          </span>
        </div>
      </header>
      <TopicHealthStrip health={topicHealth} sourceLabel={sourceMode.label} modeKind={sourceMode.kind} waitingMessage={sourceMode.waiting} />

      {backendError && (
        <div className="backend-error-banner" role="alert">
          <span>⚠ Backend hatası: {backendError}</span>
          <button type="button" onClick={() => setBackendError(null)}>✕</button>
        </div>
      )}

      <section className={`inspector-grid mode-${mode}`}>
        <aside className="hud-left">
          <ConnectionPanel
            onConnect={connectSource}
            currentSource={backendSource}
            connected={backendConnected}
            backendError={backendError}
          />
          <ControlPanel
            isMapping={false}
            lidarConnected={sourceConnected}
            backendConnected={backendConnected}
            onStartMapping={() => {}}
            onStopMapping={() => {}}
            onStartLidar={() => sendMessage({ type: "start-lidar" })}
            onStopLidar={() => sendMessage({ type: "stop-lidar" })}
          />
          <LatestFramePanel latest={latestFrame} />
        </aside>

        {mode === "debug" ? (
          <section className="hud-center hud-center--lidar">
            <LidarWorkspace
              readings={lidarReadings}
              pointClouds={pointClouds}
              activeTopic={activePointCloudTopic}
              setActiveTopic={setActivePointCloudTopic}
              vehiclePose={telemetry.pose}
              emptyMessage={sourceMode.waiting}
              onMapViewChange={(active) => { mapViewActiveRef.current = active; }}
            />
          </section>
        ) : (
          <section className="hud-center hud-center--cockpit">
            <VehicleCockpit telemetry={telemetry} time={latestFrame?.time} />
            <MapPanel gps={telemetry.gps} speed={telemetry.speed} />
            <div className="cockpit-charts">
              <SparkChart
                title="/imu/acceleration"
                value={formatNumber(vectorMagnitude(telemetry.acceleration))}
                unit="m/s2"
                data={series.acceleration}
                color="#34d399"
              />
              <SparkChart
                title="speed"
                value={formatNumber(telemetry.vehicle.speedKmh, 1)}
                unit="km/h"
                data={series.speed}
                color="#fbbf24"
              />
            </div>
          </section>
        )}

        <aside className="hud-right">
          <CameraViewer camera={camera} />
          <DecisionLogPanel entries={decisionLogEntries} />
        </aside>
      </section>

    </main>
  );
}

function AppWithBoundary() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}

export default AppWithBoundary;
