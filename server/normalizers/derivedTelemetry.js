// Derived telemetry fallback for bags that contain standard ROS sensor topics
// but no native CAN / vehicle-control topics.

import { numberOrUndefined } from "./helpers.js";

function finiteVectorMagnitude(vector) {
  const x = numberOrUndefined(vector?.x) || 0;
  const y = numberOrUndefined(vector?.y) || 0;
  const z = numberOrUndefined(vector?.z) || 0;
  return Math.hypot(x, y, z);
}

function quaternionYawDegrees(quaternion) {
  if (!quaternion) return undefined;
  const x = numberOrUndefined(quaternion.x) || 0;
  const y = numberOrUndefined(quaternion.y) || 0;
  const z = numberOrUndefined(quaternion.z) || 0;
  const w = numberOrUndefined(quaternion.w) ?? 1;
  const sinyCosp = 2 * (w * z + x * y);
  const cosyCosp = 1 - 2 * (y * y + z * z);
  const yaw = Math.atan2(sinyCosp, cosyCosp) * 180 / Math.PI;
  return Number.isFinite(yaw) ? Number(((yaw + 360) % 360).toFixed(2)) : undefined;
}

function headingFromFloatMessage(message) {
  const value = numberOrUndefined(message?.data ?? message?.value ?? message);
  if (value === undefined) return undefined;
  const normalized = ((value % 360) + 360) % 360;
  return Number(normalized.toFixed(2));
}

export function normalizeDerivedTelemetry(message, type, topic) {
  const lowerType = String(type || "").toLowerCase();
  const lowerTopic = String(topic || "").toLowerCase();
  const telemetry = {
    derived: true,
    derivedFrom: topic,
  };
  const vehicle = {};

  if (lowerType.includes("odometry") || lowerTopic.includes("odom")) {
    // Speed is intentionally NOT derived from odometry. Odometry velocity
    // (GNSS/EKF earth-frame or visual) is unreliable as ground speed — it shows
    // tens of km/h while the vehicle is stationary. Speed comes only from the CAN
    // /VelocityInformation topic; if that topic is absent, no speed is shown
    // rather than displaying a wrong value. Odometry is still used for pose/heading.
    telemetry.linearVelocity = message.twist?.twist?.linear || {};
    telemetry.angularVelocity = message.twist?.twist?.angular || {};
    telemetry.pose = message.pose?.pose;

    const yaw = quaternionYawDegrees(message.pose?.pose?.orientation);
    if (yaw !== undefined && telemetry.heading === undefined) {
      telemetry.heading = yaw;
    }
  } else if (lowerType.includes("imu") || lowerTopic.includes("imu")) {
    telemetry.acceleration = message.linear_acceleration;
    telemetry.angularVelocity = message.angular_velocity;
    telemetry.orientation = message.orientation;
    telemetry.accelerationMagnitude = Number(finiteVectorMagnitude(message.linear_acceleration).toFixed(3));
  } else if (lowerType.includes("float64") || lowerTopic === "/heading" || lowerTopic.endsWith("/heading")) {
    const heading = headingFromFloatMessage(message);
    if (heading === undefined) {
      return undefined;
    }
    telemetry.heading = heading;
  } else if (lowerType.includes("navsatfix") || lowerTopic.includes("gps") || lowerTopic.includes("navsat")) {
    telemetry.gps = {
      latitude: message.latitude,
      longitude: message.longitude,
      altitude: message.altitude,
    };
  } else {
    return undefined;
  }

  if (Object.keys(vehicle).length > 0) {
    telemetry.vehicle = vehicle;
  }

  return telemetry;
}
