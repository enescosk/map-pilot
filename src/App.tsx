import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import ControlPanel from "./components/ControlPanel";
import DecisionLogPanel from "./components/DecisionLogPanel";
import "./App.css";

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

const MAX_SERIES_POINTS = 80;
const MAX_LIDAR_HISTORY_POINTS = 30000;

const emptyTelemetry: TelemetryState = {
  speed: 0,
  acceleration: {},
  angularVelocity: {},
  magneticField: {},
  gps: {},
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

function appendLidarHistory(current: Point3D[], nextPoints: Point3D[]) {
  if (nextPoints.length === 0) {
    return current;
  }

  return [...current, ...nextPoints].slice(-MAX_LIDAR_HISTORY_POINTS);
}

function isDensePointCloud(_topic?: string, points?: Point3D[]) {
  // Any cloud with > 500 points is considered dense — always replace, never accumulate
  return Boolean(points && points.length > 500);
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

function CameraViewer({ camera }: { camera: CameraStatus }) {
  const [displaySrc, setDisplaySrc] = useState(camera.frameSrc || "");

  useEffect(() => {
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
  }, [camera.frameSrc, displaySrc]);

  return (
    <section className="workspace-panel camera-workspace">
      <div className="panel-titlebar">
        <span>{camera.topic || "/camera"}</span>
        <strong>{camera.isActive ? "Live" : "Waiting"}</strong>
      </div>
      <div className="camera-stage">
        {displaySrc ? (
          <img src={displaySrc} alt="Recorded camera frame" />
        ) : (
          <div className="empty-state">Waiting for camera frame...</div>
        )}
      </div>
      <div className="metric-strip">
        <span>{camera.resolution}</span>
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

function Lidar3D({ readings, points, activeTopic, frameId, resolvedFrame }: { readings: LidarReading[]; points: Point3D[]; activeTopic?: string; frameId?: string; resolvedFrame?: string }) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const cloudRef = useRef<THREE.Points | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);

  function setView(position: THREE.Vector3, target = new THREE.Vector3(0, 0, 0)) {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) {
      return;
    }

    camera.position.copy(position);
    controls.target.copy(target);
    controls.update();
  }

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

  function fitToCloud() {
    const debugStats = cloudRef.current?.userData?.debugStats;
    const controls = controlsRef.current;
    if (!debugStats || !controls) return;
    
    // Calculate center in ROS coordinates
    const cx = (debugStats.min.x + debugStats.max.x) / 2;
    const cy = (debugStats.min.y + debugStats.max.y) / 2;
    const cz = (debugStats.min.z + debugStats.max.z) / 2;
    
    // Convert to Three.js coordinates
    const tX = -cy;
    const tY = cz;
    const tZ = -cx;
    
    controls.target.set(tX, tY, tZ);
    // Move camera to look at the center
    setView(new THREE.Vector3(tX + 18, Math.max(tY + 15, 5), tZ + 28), controls.target);
  }

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) {
      return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#070a0c");

    const camera = new THREE.PerspectiveCamera(54, mount.clientWidth / mount.clientHeight, 0.1, 260);
    camera.position.set(18, -42, 28);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

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

    const grid = new THREE.GridHelper(80, 20, "#168eea", "#164569");
    scene.add(grid);
    scene.add(new THREE.AxesHelper(10));

    const ringMaterial = new THREE.LineBasicMaterial({
      color: "#164569",
      transparent: true,
      opacity: 0.7,
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
    scene.add(vehicle);

    sceneRef.current = scene;
    rendererRef.current = renderer;

    let frame = 0;
    const render = () => {
      frame = requestAnimationFrame(render);
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
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      cameraRef.current = null;
    };
  }, []);

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

    const displayPoints = points.length > 0 ? points : scanReadingsToPoints(readings);

    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(displayPoints.length * 3);
    const colors = new Float32Array(displayPoints.length * 3);
    const color = new THREE.Color();

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    displayPoints.forEach((point, index) => {
      // ROS coordinate system: X forward, Y left, Z up
      // Three.js coordinate system: X right, Y up, Z backward (camera looks down -Z)
      // Assuming vehicle faces -Z in Three.js:
      // Three.X = -ROS.Y (Right)
      // Three.Y = ROS.Z (Up)
      // Three.Z = -ROS.X (Backward)
      positions[index * 3] = -point.y;
      positions[index * 3 + 1] = point.z;
      positions[index * 3 + 2] = -point.x;

      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
      minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);

      if (typeof point.intensity === "number" && point.intensity > 0) {
        // Map intensity 0-255 to color (e.g., blue to red)
        const normalizedInt = Math.max(0, Math.min(1, point.intensity / 255));
        color.setHSL(0.66 - normalizedInt * 0.66, 1, 0.55);
      } else {
        const distance = Math.hypot(point.x, point.y, point.z);
        const normalized = Math.max(0, Math.min(1, distance / 55));
        const height = Math.max(0, Math.min(1, (point.z + 1.5) / 5));
        color.setHSL(0.62 - normalized * 0.42 - height * 0.12, 1, 0.58);
      }
      
      colors[index * 3] = color.r;
      colors[index * 3 + 1] = color.g;
      colors[index * 3 + 2] = color.b;
    });

    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: points.length > 0 ? 0.16 : 0.28,
      opacity: 0.92,
      transparent: true,
      vertexColors: true,
      sizeAttenuation: true,
    });

    const cloud = new THREE.Points(geometry, material);
    cloud.userData = {
      debugStats: {
        pointsCount: displayPoints.length,
        min: { x: minX, y: minY, z: minZ },
        max: { x: maxX, y: maxY, z: maxZ },
        firstPoints: displayPoints.slice(0, 5),
      }
    };
    cloudRef.current = cloud;
    scene.add(cloud);
  }, [points, readings]);

  const debugStats = cloudRef.current?.userData?.debugStats;

  return (
    <div className="lidar-3d-stage" ref={mountRef}>
      {debugStats && (
        <div style={{ position: "absolute", top: 10, left: 10, background: "rgba(0,0,0,0.85)", padding: "10px 14px", borderRadius: 6, fontSize: "0.72rem", pointerEvents: "none", zIndex: 100, color: "#c9d8f0", whiteSpace: "pre-wrap", lineHeight: 1.6, fontFamily: "monospace" }}>
          <strong style={{ color: "#38bdf8" }}>Lidar Debug</strong><br />
          Topic: <span style={{ color: "#fbbf24" }}>{activeTopic || "None"}</span><br />
          Sensor Frame: {frameId || "unknown"}<br />
          Render Frame: {resolvedFrame || frameId || "raw sensor frame (no TF applied)"}<br />
          Valid Points: {debugStats.pointsCount.toLocaleString()}<br />
          Min XYZ: {debugStats.min.x.toFixed(2)}, {debugStats.min.y.toFixed(2)}, {debugStats.min.z.toFixed(2)}<br />
          Max XYZ: {debugStats.max.x.toFixed(2)}, {debugStats.max.y.toFixed(2)}, {debugStats.max.z.toFixed(2)}<br />
          First 5 Points:<br />
          {debugStats.firstPoints.map((p: any, i: number) => `[${i}] x:${p.x.toFixed(2)} y:${p.y.toFixed(2)} z:${p.z.toFixed(2)} int:${p.intensity?.toFixed(1) ?? 0}`).join("\n")}
        </div>
      )}
      <div className="lidar-view-controls" aria-label="LiDAR viewport controls">
        <button type="button" onClick={() => zoomView(0.75)} title="Zoom in">+</button>
        <button type="button" onClick={() => zoomView(1.35)} title="Zoom out">-</button>
        <button type="button" onClick={fitToCloud} title="Fit to point cloud bounds">Fit</button>
        <button type="button" onClick={() => setView(new THREE.Vector3(0, 0.1, 58))} title="Top view">Top</button>
        <button type="button" onClick={() => setView(new THREE.Vector3(18, -42, 28))} title="Reset view">Reset</button>
      </div>
      <div className="lidar-hud">
        <span>base_link</span>
        <span>left orbit / right pan / wheel zoom</span>
        <span>{points.length.toLocaleString()} pts</span>
      </div>
    </div>
  );
}

function LidarWorkspace({ readings, pointClouds, activeTopic, setActiveTopic }: { readings: LidarReading[]; pointClouds: Record<string, { points: Point3D[], frameId: string, resolvedFrame?: string }>; activeTopic: string; setActiveTopic: (t: string) => void }) {
  const [mode, setMode] = useState<LidarMode>("3d");
  const availableTopics = Object.keys(pointClouds).sort();
  const activeData = pointClouds[activeTopic] || { points: [], frameId: "", resolvedFrame: "" };
  const points = activeData.points;

  return (
    <section className="workspace-panel lidar-workspace">
      <div className="panel-titlebar">
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <span>Overview</span>
          {availableTopics.length > 0 && (
            <select
              value={activeTopic}
              onChange={(e) => setActiveTopic(e.target.value)}
              style={{ background: "#111827", color: "#fff", border: "1px solid #374151", borderRadius: "4px", padding: "2px 8px" }}
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
      {mode === "3d" ? <Lidar3D readings={readings} points={points} activeTopic={activeTopic} frameId={activeData.frameId} resolvedFrame={activeData.resolvedFrame} /> : <Lidar2D readings={readings} />}
      <div className="metric-strip">
        <span>{readings.length} scan points</span>
        <span>{points.length.toLocaleString()} cloud points</span>
        <span>{mode.toUpperCase()} view</span>
      </div>
    </section>
  );
}

function MapPanel({ gps, speed }: { gps: GpsFix; speed: number }) {
  const lat = Number(gps.latitude);
  const lon = Number(gps.longitude);
  const hasFix = Number.isFinite(lat) && Number.isFinite(lon);
  const [mapCenter, setMapCenter] = useState<GpsTrailPoint | undefined>();

  useEffect(() => {
    if (!hasFix) {
      return;
    }

    const timer = window.setTimeout(() => {
      setMapCenter((current) => {
        if (!current) {
          return { latitude: lat, longitude: lon };
        }

        const movedEnough = Math.hypot(current.latitude - lat, current.longitude - lon) > 0.0025;
        return movedEnough ? { latitude: lat, longitude: lon } : current;
      });
    }, 0);

    return () => window.clearTimeout(timer);
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
  const [lidarReadings, setLidarReadings] = useState<LidarReading[]>([]);
  const [pointClouds, setPointClouds] = useState<Record<string, { points: Point3D[], frameId: string, resolvedFrame?: string }>>({});
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
  const [series, setSeries] = useState({
    acceleration: [] as SeriesPoint[],
    angularVelocity: [] as SeriesPoint[],
    speed: [] as SeriesPoint[],
    magneticField: [] as SeriesPoint[],
  });
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let reconnectTimer: number | undefined;
    let shouldReconnect = true;

    function connect() {
      const socket = new WebSocket("ws://localhost:4000");
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        setBackendConnected(true);
        socket.send(JSON.stringify({ type: "start-lidar" }));
      });

      socket.addEventListener("message", (event) => {
      try {
        const packet = JSON.parse(event.data);
        const label = timeLabel(packet.time);

        if (packet.type === "scan" && Array.isArray(packet.readings)) {
          const t = packet.topic || "scan";
          setLidarReadings(packet.readings);
          setPointClouds((prev) => ({
            ...prev,
            [t]: {
              points: appendLidarHistory(prev[t]?.points || [], scanReadingsToPoints(packet.readings)),
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
            setPointClouds((prev) => ({
              ...prev,
              [t]: {
                points: isDensePointCloud(t, packet.points)
                  ? packet.points
                  : appendLidarHistory(prev[t]?.points || [], packet.points),
                frameId: packet.frameId || "",
                resolvedFrame: packet.resolvedFrame || "",
              }
            }));
            setActivePointCloudTopic((prev) => prev || t);
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
            frameSrc: packet.src,
            resolution: packet.resolution || prev.resolution,
            fps: Number(packet.fps || prev.fps),
            frameCount: prev.frameCount + 1,
            lastTime: packet.time,
          }));
          setLatestFrame({
            topic: packet.topic || "camera",
            time: packet.time,
            messageType: "Camera",
            preview: packet.resolution || "JPEG frame",
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
            };

            const accMag = vectorMagnitude(next.acceleration);
            const oldAccMag = vectorMagnitude(prev.acceleration);
            const speed = next.speed;
            const oldSpeed = prev.speed;

            if (accMag > 12 && oldAccMag <= 12) {
              setCockpitEvents((events) => [
                ...events,
                {
                  id: `acc-${packet.time}-${Math.random()}`,
                  timestamp: timeStringToSeconds(packet.time),
                  timeLabel: label,
                  severity: "warning",
                  source: "imu",
                  title: "High Acceleration Spike",
                  description: `Acceleration reached ${formatNumber(accMag)} m/s²`,
                }
              ]);
            }

            if (oldSpeed > 2 && speed < 0.5) {
              setCockpitEvents((events) => [
                ...events,
                {
                  id: `stop-${packet.time}-${Math.random()}`,
                  timestamp: timeStringToSeconds(packet.time),
                  timeLabel: label,
                  severity: "critical",
                  source: "speed",
                  title: "Sudden Stop",
                  description: `Speed dropped rapidly from ${formatNumber(oldSpeed)} to ${formatNumber(speed)} m/s`,
                }
              ]);
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
        if (shouldReconnect) {
          reconnectTimer = window.setTimeout(connect, 900);
        }
      });

      socket.addEventListener("error", () => {
        setBackendConnected(false);
      });
    }

    connect();

    return () => {
      shouldReconnect = false;
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      socketRef.current?.close();
    };
  }, []);

  const decisionLogEntries: DecisionLogEntry[] = useMemo(() => {
    return cockpitEvents.map((e) => ({
      time: e.timeLabel,
      source: e.source.toUpperCase(),
      message: `${e.title}: ${e.description}`,
    }));
  }, [cockpitEvents]);

  const bagName = useMemo(() => bagStatus.path.split("/").at(-1) || "2025-07-21-16-54-43.bag", [bagStatus.path]);
  const currentSeconds = Math.max(0, timeStringToSeconds(bagStatus.currentTime) - timeStringToSeconds(bagStatus.startTime));
  const durationSeconds = Number(bagStatus.durationSeconds || 0);
  const playbackRatio = durationSeconds > 0 ? Math.min(currentSeconds / durationSeconds, 1) : 0;

  function sendPlaybackCommand(type: "start-lidar" | "stop-lidar") {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type }));
    }
  }

  function seekPlayback(ratio: number) {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      setPointClouds({});
      setLidarReadings([]);
      socketRef.current.send(JSON.stringify({ type: "seek-playback", ratio }));
    }
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <span className="app-kicker">MapPilot Cockpit</span>
          <h1>{bagName}</h1>
        </div>
        <div className="mode-switcher">
          <button type="button" className={mode === "perception" ? "active" : ""} onClick={() => setMode("perception")}>Perception</button>
          <button type="button" className={mode === "control" ? "active" : ""} onClick={() => setMode("control")}>Control</button>
          <button type="button" className={mode === "debug" ? "active" : ""} onClick={() => setMode("debug")}>Triage & Debug</button>
        </div>
        <div className="top-actions">
          <span className={backendConnected ? "status-pill good" : "status-pill bad"}>
            {backendConnected ? "Backend online" : "Backend offline"}
          </span>
          <span className={bagStatus.playing ? "status-pill good" : "status-pill muted"}>
            {bagStatus.playing ? "Playing" : "Paused"}
          </span>
          <button type="button" onClick={() => sendPlaybackCommand("start-lidar")}>Play</button>
          <button type="button" onClick={() => sendPlaybackCommand("stop-lidar")}>Pause</button>
        </div>
      </header>

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
            <SparkChart
              title="/imu/acceleration"
              value={formatNumber(vectorMagnitude(telemetry.acceleration))}
              unit="m/s2"
              data={series.acceleration}
              color="#34d399"
            />
            <SparkChart
              title="/vehicle/speed"
              value={formatNumber(telemetry.speed)}
              unit="m/s"
              data={series.speed}
              color="#f59e0b"
            />
          </div>
          <section className="workspace-panel telemetry-card">
            <div className="panel-titlebar">
              <span>Vehicle State</span>
              <strong>{latestFrame?.time || "--"}</strong>
            </div>
            <div className="state-grid">
              <span>GPS</span>
              <strong>{formatNumber(telemetry.gps.latitude, 6)}, {formatNumber(telemetry.gps.longitude, 6)}</strong>
              <span>Acceleration XYZ</span>
              <strong>{formatNumber(telemetry.acceleration.x)} / {formatNumber(telemetry.acceleration.y)} / {formatNumber(telemetry.acceleration.z)}</strong>
              <span>Angular XYZ</span>
              <strong>{formatNumber(telemetry.angularVelocity.x)} / {formatNumber(telemetry.angularVelocity.y)} / {formatNumber(telemetry.angularVelocity.z)}</strong>
            </div>
          </section>
        </aside>
      </section>

      <footer className="playback-bar">
        <span>{formatDuration(currentSeconds)} / {formatDuration(durationSeconds)}</span>
        <div className="timeline-wrapper">
          <input
            aria-label="Playback position"
            className="timeline-control"
            max="1000"
            min="0"
            type="range"
            value={Math.round(playbackRatio * 1000)}
            onChange={(event) => seekPlayback(Number(event.currentTarget.value) / 1000)}
            onInput={(event) => seekPlayback(Number(event.currentTarget.value) / 1000)}
          />
          {durationSeconds > 0 && cockpitEvents.map((event) => {
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
        <strong>{latestFrame?.time || "Waiting for bag messages"}</strong>
      </footer>
    </main>
  );
}

export default App;
