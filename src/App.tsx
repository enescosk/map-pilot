import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import ConnectionPanel from "./components/ConnectionPanel";
import DiscoveredTopicsPanel from "./components/DiscoveredTopicsPanel";
import RawMessagePanel from "./components/RawMessagePanel";
import DecisionLogPanel from "./components/DecisionLogPanel";
import TopicHealthStrip from "./components/TopicHealthStrip";
import { SparkChart } from "./components/SparkChart";
import { MapPanel } from "./components/MapPanel";
import { VehicleCockpit } from "./components/VehicleCockpit";
import { VehicleControlPanel } from "./components/VehicleControlPanel";
import { CameraViewer } from "./components/CameraViewer";
import { LidarWorkspace } from "./components/LidarWorkspace";
import { useCameraFeed } from "./hooks/useCameraFeed";
import { useDashboardTelemetry } from "./hooks/useDashboardTelemetry";
import { useLiveTelemetry } from "./hooks/useLiveTelemetry";
import { usePointCloudBuffer, type PendingPointCloudPacket } from "./hooks/usePointCloudBuffer";
import { useTopicHealth } from "./hooks/useTopicHealth";
import type { CameraFrameMessage, CameraStreamMessage, LatestFrame, LidarReading, LiveMessage, Point3D, RawMessage, TelemetryMessage, TopicInfo } from "./types/liveMessages";
import {
  LIDAR_FILTER_VERSION,
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
  // Mirror for stable callbacks (handleWorkerMessage) that must see the current
  // mode without re-subscribing the worker on every page switch.
  const modeRef = useRef<WorkspaceMode>(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  const [backendSource, setBackendSource] = useState("none");
  const [backendError, setBackendError] = useState<string | null>(null);
  const [lidarReadings, setLidarReadings] = useState<LidarReading[]>([]);
  const [pointClouds, setPointClouds] = useState<Record<string, LidarCloudState>>({});
  const [activePointCloudTopic, setActivePointCloudTopic] = useState<string>("");
  const [sourceConnected, setSourceConnected] = useState(false);
  const [latestFrame, setLatestFrameState] = useState<LatestFrame>();
  // Faz 1: topics the vehicle advertises (from /rosapi/topics). Discovery only.
  const [advertisedTopics, setAdvertisedTopics] = useState<TopicInfo[]>([]);
  // Faz 2: topics the user picked for raw inspection + their latest message.
  const [selectedTopics, setSelectedTopics] = useState<Set<string>>(new Set());
  const [rawMessages, setRawMessages] = useState<Record<string, RawMessage>>({});
  // When each topic was picked, so the raw panel can show "N sn'dir veri yok".
  const selectedAtRef = useRef<Record<string, number>>({});
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

  const handlePointCloudFlush = useCallback((pending: PendingPointCloudPacket[]) => {
    setPointClouds((prev) => {
      const next = { ...prev };

      for (const packet of pending) {
        // Worker already filtered + downsampled. denoisePointCloud was an
        // O(N×27) main-thread pass we no longer need.
        const livePoints = selectStoredLivePoints(packet.points);
        const previous = next[packet.topic] || { points: [], frameId: "", resolvedFrame: "" };
        next[packet.topic] = {
          points: livePoints,
          frameId: packet.frameId || previous.frameId || "",
          resolvedFrame: packet.resolvedFrame || previous.resolvedFrame || "",
          lastTime: packet.time || previous.lastTime,
          filterVersion: LIDAR_FILTER_VERSION,
          // Real per-frame density for topic ranking (not the accumulated history).
          pointCount: packet.frameCount ?? previous.pointCount,
        };
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

        if (packet.type === "topic-list" && Array.isArray(packet.topics)) {
          setAdvertisedTopics(packet.topics);
        }

        if (packet.type === "raw-message" && typeof packet.topic === "string") {
          const raw = packet as RawMessage;
          setRawMessages((prev) => ({ ...prev, [raw.topic]: raw }));
        }
  }, [
    handleCameraFrame,
    handleCameraStream,
    handleTelemetryMessage,
    handleTopicHealthMessage,
    resetStreamState,
  ]);

  // Register a topic (with its raw point count) so it appears in the picker and
  // auto-selection can compare it — without storing any point array.
  const registerCloudTopic = useCallback((topic: string, n: number) => {
    setPointClouds((prev) => {
      const existing = prev[topic];
      if (existing && existing.pointCount === n && existing.points.length === 0) return prev;
      return {
        ...prev,
        [topic]: existing
          ? { ...existing, pointCount: n }
          : { points: [], frameId: "", resolvedFrame: "", pointCount: n },
      };
    });
  }, []);

  // Worker delivers pre-processed scan-ready / cloud-ready results (lidar work is off main thread)
  const handleWorkerMessage = useCallback((ev: MessageEvent) => {
    const { type } = ev.data as { type: string };
    // Off the LiDAR page, never push big point arrays through React state —
    // rendering 60-80k invisible points was saturating the main thread. Straggler
    // frames (backend stop in flight) only update the cheap topic registry.
    const lidarPageOpen = modeRef.current === "debug";

    if (type === "scan-ready") {
      const { topic, renderable, readingsLength, time, frameId } = ev.data as {
        topic: string; renderable: Point3D[]; readingsLength: number; time: string; frameId: string;
      };
      if (lidarPageOpen) {
        setPointClouds((prev) => ({
          ...prev,
          [topic]: {
            points: renderable,
            frameId: frameId || "laser",
          },
        }));
      } else {
        registerCloudTopic(topic, readingsLength);
      }
      setActivePointCloudTopic((prev) => prev || topic);
      setLatestFrame({ topic, time, messageType: "LaserScan", preview: `${readingsLength} projected scan points` });
    }

    if (type === "cloud-ready") {
      const { topic, renderable, frameCount, time, frameId, resolvedFrame } = ev.data as {
        topic: string; renderable: Point3D[]; frameCount: number; time: string; frameId: string; resolvedFrame: string;
      };
      if (lidarPageOpen) {
        enqueuePointCloud({ topic, points: renderable, frameCount, frameId, resolvedFrame, time });
      } else {
        registerCloudTopic(topic, frameCount ?? renderable.length);
      }
      setActivePointCloudTopic((prev) => prev || topic);
      setLatestFrame({ topic, time, messageType: "PointCloud2", preview: `${renderable.length} sampled 3D points` });
    }

    if (type === "cloud-skipped") {
      // A non-active cloud the worker chose not to fully process.
      const { topic, n } = ev.data as { topic: string; n: number };
      registerCloudTopic(topic, n);
    }
  }, [enqueuePointCloud, registerCloudTopic, setLatestFrame]);

  const { connected: backendConnected, wsStatus, sendMessage, setActiveTopic: setWorkerActiveTopic } = useLiveTelemetry({
    url: WS_URL,
    onMessage: handleLiveMessage,
    onWorkerMessage: handleWorkerMessage,
  });

  // The lidar firehose (~21 MB/s off the vehicle) only runs while the LiDAR
  // page is actually open. Initial mode is "perception", so the pipeline starts
  // cold and the backend unsubscribes the heavy topics whenever we leave.
  useEffect(() => {
    if (backendConnected) {
      sendMessage({ type: mode === "debug" ? "start-lidar" : "stop-lidar" });
    }
    if (mode !== "debug") {
      // Drop any point-cloud packets still waiting for their 100 ms flush so a
      // page switch doesn't land one last heavy setPointClouds.
      clearPointCloudBuffer();
    }
  }, [backendConnected, clearPointCloudBuffer, mode, sendMessage]);

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

  // Faz 2: toggle a topic's raw subscription. Picking sends subscribe-topic to
  // the backend; unpicking unsubscribes and drops its last cached message.
  const toggleTopic = useCallback((topic: string) => {
    setSelectedTopics((prev) => {
      const next = new Set(prev);
      if (next.has(topic)) {
        next.delete(topic);
        delete selectedAtRef.current[topic];
        sendMessage({ type: "unsubscribe-topic", topic });
        setRawMessages((msgs) => {
          const { [topic]: _drop, ...rest } = msgs;
          return rest;
        });
      } else {
        next.add(topic);
        selectedAtRef.current[topic] = Date.now();
        sendMessage({ type: "subscribe-topic", topic });
      }
      return next;
    });
  }, [sendMessage]);

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
          <VehicleControlPanel sendMessage={sendMessage} />
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
            <div className="cockpit-bottom">
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
              <DiscoveredTopicsPanel
                topics={advertisedTopics}
                selected={selectedTopics}
                onToggle={toggleTopic}
              />
              <RawMessagePanel selected={selectedTopics} messages={rawMessages} selectedAt={selectedAtRef.current} />
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
