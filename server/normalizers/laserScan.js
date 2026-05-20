// sensor_msgs/LaserScan parser. Filters NaN/Infinity/zero/out-of-range samples
// and downsamples to MAX_SCAN_POINTS. Angle output is degrees in [0, 360) for
// backward compatibility with the 2D scan view.

import { MAX_SCAN_POINTS } from "../config/env.js";

export function laserScanToReadings(message) {
  if (!message || !Array.isArray(message.ranges)) {
    return [];
  }

  const step = Math.max(1, Math.ceil(message.ranges.length / MAX_SCAN_POINTS));
  const angleMin = Number(message.angle_min || 0);
  const angleIncrement = Number(message.angle_increment || 0);
  const rangeMin = Number(message.range_min || 0);
  const rangeMax = Number(message.range_max || Number.POSITIVE_INFINITY);
  const intensities = Array.isArray(message.intensities) ? message.intensities : [];
  const readings = [];

  for (let index = 0; index < message.ranges.length; index += step) {
    const distance = Number(message.ranges[index]);
    if (!Number.isFinite(distance) || distance <= 0 || distance < rangeMin || distance > rangeMax) {
      continue;
    }

    const angleRadians = angleMin + index * angleIncrement;
    const angleDegrees = (angleRadians * 180) / Math.PI;
    readings.push({
      angle: Number(((angleDegrees + 360) % 360).toFixed(2)),
      angleRadians: Number(angleRadians.toFixed(4)),
      distance: Number(distance.toFixed(3)),
      intensity: Number((Number(intensities[index]) || 0).toFixed(2)),
    });
  }

  return readings;
}
