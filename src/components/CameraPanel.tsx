import type { CameraStatus } from "../types/liveMessages";

type CameraPanelProps = {
  camera: CameraStatus;
};

function CameraPanel({ camera }: CameraPanelProps) {
  return (
    <article className="panel camera-panel">
      <div className="panel-heading split-heading">
        <div>
          <p className="panel-label">Camera</p>
          <h2>{camera.name}</h2>
        </div>
        <span className={camera.isActive ? "system-pill active" : "system-pill inactive"}>
          {camera.isActive ? "Active" : "Inactive"}
        </span>
      </div>

      <div className={camera.isActive ? "camera-feed active" : "camera-feed"}>
        {camera.frameSrc ? (
          <img src={camera.frameSrc} alt={`${camera.name} frame`} />
        ) : (
          <>
            <div className="camera-crosshair horizontal" />
            <div className="camera-crosshair vertical" />
            <span>{camera.isActive ? "Live Camera Feed" : "No Camera Feed"}</span>
          </>
        )}
      </div>

      <div className="camera-metrics">
        <span>Mode: {camera.mode}</span>
        <span>Resolution: {camera.resolution}</span>
        <span>FPS: {camera.fps}</span>
      </div>

      {!camera.isActive && camera.issue && <p className="panel-alert">{camera.issue}</p>}
    </article>
  );
}

export default CameraPanel;
