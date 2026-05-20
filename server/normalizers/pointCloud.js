// sensor_msgs/PointCloud (legacy, not PointCloud2) parser. Used by the bag
// playback fallback path; extracted verbatim from bagPlaybackSource.js.

import { MAX_SCAN_POINTS } from "../config/env.js";

export function pointCloudToReadings(message) {
  const points = Array.isArray(message?.points) ? message.points : [];
  const step = Math.max(1, Math.ceil(points.length / MAX_SCAN_POINTS));

  return points
    .filter((_, index) => index % step === 0)
    .map((point) => {
      const x = Number(point.x || 0);
      const y = Number(point.y || 0);
      const angle = (Math.atan2(y, x) * 180) / Math.PI;
      return {
        angle: Number(((angle + 360) % 360).toFixed(1)),
        distance: Number(Math.hypot(x, y).toFixed(3)),
      };
    })
    .filter((reading) => reading.distance > 0);
}
