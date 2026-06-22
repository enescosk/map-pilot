import { useEffect, useMemo, useState } from "react";
import type { LidarReading } from "../types/liveMessages";
import type { TelemetryState } from "../types/telemetry";
import { chooseBestPointCloudTopic, type LidarCloudState } from "../utils/lidarProcessing";
import { Lidar2D } from "./Lidar2D";
import { Lidar3D, type LidarColorMode } from "./Lidar3D";

type LidarMode = "2d" | "3d";

export function LidarWorkspace({
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
