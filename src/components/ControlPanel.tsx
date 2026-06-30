import { memo } from "react";

type ControlPanelProps = {
  isMapping: boolean;
  lidarConnected: boolean;
  backendConnected: boolean;
  onStartMapping: () => void;
  onStopMapping: () => void;
  onStartLidar: () => void;
  onStopLidar: () => void;
};

function ControlPanel({
  isMapping,
  lidarConnected,
  backendConnected,
  onStartMapping,
  onStopMapping,
  onStartLidar,
  onStopLidar,
}: ControlPanelProps) {
  return (
    <article className="panel control-panel">
      <div className="panel-heading">
        <p className="panel-label">Operatör</p>
        <h2>Kontroller</h2>
      </div>

      {/* These buttons send simple commands to the local LiDAR backend. */}
      <div className="control-stack">
        <button type="button" onClick={onStartMapping} disabled={isMapping}>
          Start Mapping
        </button>
        <button type="button" onClick={onStopMapping} disabled={!isMapping}>
          Stop Mapping
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={onStartLidar}
          disabled={!backendConnected || lidarConnected}
        >
          Start LiDAR
        </button>
        <button
          type="button"
          className="secondary-button danger-button"
          onClick={onStopLidar}
          disabled={!backendConnected || !lidarConnected}
        >
          Stop LiDAR
        </button>
      </div>
      {!backendConnected && (
        <p className="control-warning">LiDAR backend offline. Start the server first.</p>
      )}
    </article>
  );
}

export default memo(ControlPanel);
