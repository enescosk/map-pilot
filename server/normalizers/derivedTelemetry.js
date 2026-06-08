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

export function normalizeDerivedTelemetry(message, type, topic, options = {}) {
  const lowerType = String(type || "").toLowerCase();
  const lowerTopic = String(topic || "").toLowerCase();
  const telemetry = {
    derived: true,
    derivedFrom: topic,
  };
  const vehicle = {};

  if (lowerType.includes("odometry") || lowerTopic.includes("odom")) {
    const linear = message.twist?.twist?.linear || {};
    const angular = message.twist?.twist?.angular || {};
    const speedMps = finiteVectorMagnitude(linear);
    // Only write speed when non-zero — odom packets with zero twist are noise,
    // not genuine stops. State holds last valid reading until a real value arrives.
    if (!options.nativeSpeedAvailable && speedMps > 0) {
      telemetry.speed = Number(speedMps.toFixed(3));
      vehicle.speedKmh = Number((speedMps * 3.6).toFixed(2));
    }
    telemetry.linearVelocity = linear;
    telemetry.angularVelocity = angular;
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
