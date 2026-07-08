import { memo, useEffect, useMemo, useState } from "react";
import type { LidarReading, Point3D } from "../types/liveMessages";
import type { TelemetryState } from "../types/telemetry";
import { chooseBestPointCloudTopic, xyziToPoints, type LidarCloudState } from "../utils/lidarProcessing";
import { Lidar2D } from "./Lidar2D";
import { Lidar3D, type LidarColorMode } from "./Lidar3D";

type LidarMode = "2d" | "3d";
const EMPTY_XYZI = new Float32Array(0);
const EMPTY_POINTS: Point3D[] = [];

function LidarWorkspaceImpl({
  readings,
  pointClouds,
  activeTopic,
  setActiveTopic,
  vehiclePose,
  emptyMessage,
}: {
  readings: LidarReading[];
  pointClouds: Record<string, LidarCloudState>;
  activeTopic: string;
  setActiveTopic: (t: string) => void;
  vehiclePose?: TelemetryState["pose"];
  emptyMessage: string;
}) {
  const [mode, setMode] = useState<LidarMode>("3d");
  const [pointSize, setPointSize] = useState(0.45);
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
  const activeData = pointClouds[activeTopic] || { pointsXyzi: EMPTY_XYZI, pointsCount: 0, frameId: "", resolvedFrame: "" };
  const hasLidarData = readings.length > 0 || activeData.pointsCount > 0;
  // Lidar2D still consumes a Point3D[]; only pay that conversion when the 2D
  // canvas view is actually visible (the GPU/3D path reads pointsXyzi directly).
  const legacyPoints = useMemo(
    () => (mode === "2d" ? xyziToPoints(activeData.pointsXyzi, activeData.pointsCount) : EMPTY_POINTS),
    [mode, activeData.pointsXyzi, activeData.pointsCount],
  );

  return (
    <section className="workspace-panel lidar-workspace">
      <div className="panel-titlebar">
        <div className="panel-title-group">
          <span>Genel Görünüm</span>
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
          pointsXyzi={activeData.pointsXyzi}
          pointCount={activeData.pointsCount}
          activeTopic={activeTopic}
          frameId={activeData.frameId}
          resolvedFrame={activeData.resolvedFrame}
          vehiclePose={vehiclePose}
          pointSize={pointSize}
          colorMode={colorMode}
          autoFit={autoFit}
          showDebug={showDebug}
        />
      ) : <Lidar2D readings={readings} points={legacyPoints} /> : (
        <div className="empty-state lidar-empty-state">{emptyMessage}</div>
      )}
      <div className="metric-strip">
        <span>{readings.length} scan points</span>
        <span>{activeData.pointsCount.toLocaleString()} live pts</span>
        <span>{mode.toUpperCase()}</span>
      </div>
    </section>
  );
}

export const LidarWorkspace = memo(LidarWorkspaceImpl);
