import type { LidarReading } from "../types/liveMessages";

type LidarPanelProps = {
  readings: LidarReading[];
  isConnected: boolean;
};

function LidarPanel({ readings, isConnected }: LidarPanelProps) {
  // Keep the scan readable by scaling points against the visible range.
  const maxDistance = Math.max(...readings.map((reading) => reading.distance), 1);
  const displayRange = Math.max(2, Math.ceil(maxDistance));

  return (
    <article className="panel lidar-panel">
      <div className="panel-heading split-heading">
        <div>
          <p className="panel-label">Sensor</p>
          <h2>LiDAR Scan</h2>
        </div>
        <div className="lidar-summary">
          <strong>{readings.length}</strong>
          <span>points</span>
        </div>
      </div>

      <div className="lidar-visual" aria-label="Live LiDAR visualization">
        {readings.length === 0 ? (
          <p className="lidar-placeholder">Waiting for LiDAR scan data...</p>
        ) : (
          readings.map((reading, index) => {
            const angleInRadians = (reading.angle - 90) * (Math.PI / 180);
            const radius = Math.min(reading.distance / displayRange, 1) * 46;
            const x = 50 + Math.cos(angleInRadians) * radius;
            const y = 50 + Math.sin(angleInRadians) * radius;

            return (
              <span
                key={`${reading.angle}-${reading.distance}-${index}`}
                className="lidar-point"
                style={{
                  left: `${x}%`,
                  top: `${y}%`,
                }}
                title={`${reading.angle} degrees, ${reading.distance} meters`}
              />
            );
          })
        )}
        <span className="range-label top">{displayRange} m</span>
        <span className="range-label middle">{Math.round(displayRange / 2)} m</span>
      </div>

      <div className="lidar-footer">
        <p className={isConnected ? "connection good" : "connection warning"}>
          {isConnected ? "Receiving live LiDAR scan data" : "Sensor disconnected"}
        </p>
        <span>Range scaled to {displayRange} m</span>
      </div>
    </article>
  );
}

export default LidarPanel;
