import type { RobotStatus } from "../App";

type RobotStatusPanelProps = {
  robot: RobotStatus;
};

function RobotStatusPanel({ robot }: RobotStatusPanelProps) {
  const batteryClass = robot.battery > 30 ? "metric-value good" : "metric-value warning";

  return (
    <article className="panel robot-status-panel">
      <div className="panel-heading">
        <p className="panel-label">Robot</p>
        <h2>Status</h2>
      </div>

      <div className="status-list">
        <div>
          <span>Mode</span>
          <strong>{robot.mode}</strong>
        </div>
        <div>
          <span>Battery</span>
          <strong className={batteryClass}>{robot.battery}%</strong>
        </div>
        <div>
          <span>Location</span>
          <strong>{robot.location}</strong>
        </div>
        <div>
          <span>LiDAR</span>
          <strong>{robot.lidarConnected ? "Connected" : "Offline"}</strong>
        </div>
      </div>
    </article>
  );
}

export default RobotStatusPanel;
