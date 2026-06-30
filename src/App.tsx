import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import ControlPanel from "./components/ControlPanel";
import ConnectionPanel from "./components/ConnectionPanel";
import DecisionLogPanel from "./components/DecisionLogPanel";
import TopicHealthStrip from "./components/TopicHealthStrip";
import { SparkChart } from "./components/SparkChart";
import { MapPanel } from "./components/MapPanel";
import { VehicleCockpit } from "./components/VehicleCockpit";
import { CameraViewer } from "./components/CameraViewer";
import { LidarWorkspace } from "./components/LidarWorkspace";
import { useCameraFeed } from "./hooks/useCameraFeed";
import { useDashboardTelemetry } from "./hooks/useDashboardTelemetry";
import { useLiveTelemetry } from "./hooks/useLiveTelemetry";
import { usePointCloudBuffer, type PendingPointCloudPacket } from "./hooks/usePointCloudBuffer";
import { useTopicHealth } from "./hooks/useTopicHealth";
import type { CameraFrameMessage, CameraStreamMessage, LatestFrame, LidarReading, LiveMessage, Point3D, TelemetryMessage } from "./types/liveMessages";
import {
  LIDAR_FILTER_VERSION,
  MAX_TOTAL_MAP_POINTS,
  mergeLidarMap,
  POINT_CLOUD_FLUSH_MS,
  selectStoredLivePoints,
  type LidarCloudState,
} from "./utils/lidarProcessing";
import { sourceHealthLabel, sourceModeInfo } from "./utils/dashboardHelpers";
import { formatNumber, vectorMagnitude } from "./utils/telemetryFormatters";
import tubitakLogo from "./assets/tubitak-yatay-beyaz.png";
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
          // Real per-frame density for topic ranking (not the accumulated history).
          pointCount: packet.frameCount ?? previous.pointCount,
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
      const { topic, renderable, frameCount, time, frameId, resolvedFrame } = ev.data as {
        topic: string; renderable: Point3D[]; frameCount: number; time: string; frameId: string; resolvedFrame: string;
      };
      enqueuePointCloud({ topic, points: renderable, frameCount, frameId, resolvedFrame, time });
      setActivePointCloudTopic((prev) => prev || topic);
      setLatestFrame({ topic, time, messageType: "PointCloud2", preview: `${renderable.length} sampled 3D points` });
    }

    if (type === "cloud-skipped") {
      // A non-active cloud the worker chose not to fully process. Register the
      // topic (with its raw point count) so it still appears in the picker and
      // auto-selection can compare it — but do no heavy work.
      const { topic, n } = ev.data as { topic: string; n: number };
      setPointClouds((prev) => {
        const existing = prev[topic];
        if (existing && existing.pointCount === n && existing.points.length === 0) return prev;
        return {
          ...prev,
          [topic]: existing
            ? { ...existing, pointCount: n }
            : { points: [], mapPoints: [], frameId: "", resolvedFrame: "", pointCount: n },
        };
      });
    }
  }, [enqueuePointCloud]);

  const { connected: backendConnected, wsStatus, sendMessage, setActiveTopic: setWorkerActiveTopic } = useLiveTelemetry({
    url: WS_URL,
    onMessage: handleLiveMessage,
    onWorkerMessage: handleWorkerMessage,
  });

  useEffect(() => {
    if (backendConnected) {
      sendMessage({ type: "start-lidar" });
    }
  }, [backendConnected, sendMessage]);

  // Tell the worker which cloud is on screen so it only does the heavy
  // filter/downsample for that one (the other live clouds are dropped cheaply).
  useEffect(() => {
    setWorkerActiveTopic(activePointCloudTopic);
  }, [activePointCloudTopic, setWorkerActiveTopic]);

  const isLiveSource = backendSource === "mqtt" || backendSource === "vehicle-ros" || backendSource === "rosbridge" || backendSource === "direct-serial";
  const sourceTitle = isLiveSource ? "Canlı Araç" : "Bağlı değil";
  const sourceMode = sourceModeInfo(backendSource);
  const sourceHealth =
    topicHealth.sources[backendSource] ||
    topicHealth.sources[sourceMode.label];
  const sourceIsConnected = Boolean(sourceHealth?.connected ?? sourceConnected);
  // Only flag "stale" when real data topics go quiet — ignore internal/error
  // bookkeeping topics (e.g. __backend__) and tolerate a couple of naturally
  // bursty feeds so a healthy live demo doesn't read as red.
  const dataTopics = Object.entries(topicHealth.topics || {}).filter(
    ([name, topic]) => !name.startsWith("__") && topic.kind !== "error",
  );
  const staleDataTopics = dataTopics.filter(([, topic]) => topic.isStale);
  const sourceHasStaleTopics =
    sourceIsConnected && dataTopics.length > 0 && staleDataTopics.length > Math.max(2, dataTopics.length * 0.5);
  const sourceStatusText = sourceHealthLabel(sourceIsConnected, isLiveSource, sourceHasStaleTopics);

  function connectSource(source: "vehicle-ros" | "mqtt", rosbridgeUrl: string, mqttUrl: string) {
    sendMessage({ type: "connect-source", source, rosbridgeUrl, mqttUrl });
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div className="brand-block">
          <img className="brand-logo" src={tubitakLogo} alt="TÜBİTAK" />
          <div>
            <span className="app-kicker">MapPilot Cockpit</span>
            <h1>{sourceTitle}</h1>
          </div>
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
          {mode === "debug" && (
            <ControlPanel
              isMapping={false}
              lidarConnected={sourceConnected}
              backendConnected={backendConnected}
              onStartMapping={() => {}}
              onStopMapping={() => {}}
              onStartLidar={() => sendMessage({ type: "start-lidar" })}
              onStopLidar={() => sendMessage({ type: "stop-lidar" })}
            />
          )}
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
          </section>
        )}

        <aside className={mode === "debug" ? "hud-right" : "hud-right hud-right--cockpit"}>
          <CameraViewer camera={camera} />
          {mode === "debug" && <DecisionLogPanel entries={decisionLogEntries} />}
          {mode !== "debug" && (
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
          )}
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
