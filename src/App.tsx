import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import ControlPanel from "./components/ControlPanel";
import ConnectionPanel from "./components/ConnectionPanel";
import DecisionLogPanel from "./components/DecisionLogPanel";
import TopicHealthStrip from "./components/TopicHealthStrip";
import { SparkChart } from "./components/SparkChart";
import { MapPanel } from "./components/MapPanel";
import { VehicleCockpit } from "./components/VehicleCockpit";
import { CameraViewer } from "./components/CameraViewer";
import { Lidar2D } from "./components/Lidar2D";
import { Lidar3D, type LidarColorMode } from "./components/Lidar3D";
import { useCameraFeed } from "./hooks/useCameraFeed";
import { useDashboardTelemetry } from "./hooks/useDashboardTelemetry";
import { useLiveTelemetry } from "./hooks/useLiveTelemetry";
import { usePointCloudBuffer, type PendingPointCloudPacket } from "./hooks/usePointCloudBuffer";
import { useTopicHealth } from "./hooks/useTopicHealth";
import type { CameraFrameMessage, CameraStreamMessage, LatestFrame, LidarReading, LiveMessage, Point3D, TelemetryMessage } from "./types/liveMessages";
import type { TelemetryState } from "./types/telemetry";
import {
  chooseBestPointCloudTopic,
  LIDAR_FILTER_VERSION,
  MAX_TOTAL_MAP_POINTS,
  mergeLidarMap,
  POINT_CLOUD_FLUSH_MS,
  selectStoredLivePoints,
  type LidarCloudState,
} from "./utils/lidarProcessing";
import { formatNumber, vectorMagnitude } from "./utils/telemetryFormatters";
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

type LidarMode = "2d" | "3d";

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
  // Lazy state initializer (not useRef(Date.now())) keeps render pure.
  const [lidarStartMs] = useState(() => Date.now());
  useEffect(() => {
    if (!bestTopic) return;
    const elapsed = Date.now() - lidarStartMs;
    if (elapsed < 4000 || !activeTopic) {
      setActiveTopic(bestTopic);
    }
  }, [activeTopic, bestTopic, setActiveTopic, lidarStartMs]);
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
