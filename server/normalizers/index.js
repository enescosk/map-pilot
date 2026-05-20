// Frame-shape dispatcher. Routes raw frames (from bag playback or live ROS)
// through the appropriate per-type parser and returns the legacy WS envelope
// shape that today's dashboard consumes.
//
// Phase-3 layout: the legacy dispatcher (normalizeFrame) is unchanged. A new
// 4-signal pipeline runs as a pre-check above it; if it produces an envelope,
// the legacy path is skipped for that frame. See routeThroughTopicMap below.

import { laserScanToReadings } from "./laserScan.js";
import { pointCloudToReadings } from "./pointCloud.js";
import { pointCloud2ToReadings, pointCloud2ToPoints } from "./pointCloud2.js";
import { compressedImageToSource, imageToSource, rawImageToSource } from "./image.js";
import { normalizeVehicleTelemetry } from "./vehicle.js";
import { matchTopicEntry } from "../mapping/topicMap.js";
import { telemetryStore } from "../services/telemetryStore.js";
import { toLegacyTelemetry } from "../transport/legacyAdapter.js";
import { healthRegistry } from "../services/healthRegistry.js";
import { telemetryBus, BUS_EVENTS } from "../services/telemetryBus.js";

const DEFAULT_SOURCE = "bag-playback";

export function normalizeFrame(frame) {
  const message = frame.message || frame.msg || frame.payload || frame;
  const type = frame.type || frame.msgType || "";
  const topic = frame.topic || "unknown";
  const time = frame.time || frame.timestamp || "";
  const source = frame.source || DEFAULT_SOURCE;

  // New canonical pipeline for the topics in the topic map (Phase 3 target set).
  // If the topic matches, run extract -> store -> legacy adapter and return.
  const routed = routeThroughTopicMap({ message, type, topic, time, source });
  if (routed) {
    return routed;
  }

  return normalizeFrameLegacy({ message, type, topic, time, source });
}

function routeThroughTopicMap({ message, type, topic, time, source }) {
  const entry = matchTopicEntry(topic, type);
  if (!entry) {
    return undefined;
  }

  let patch;
  try {
    patch = entry.extract(message);
  } catch (error) {
    healthRegistry.recordError(topic, `extract: ${error.message}`);
    return undefined;
  }

  if (!patch || typeof patch !== "object") {
    healthRegistry.recordError(topic, "extractor returned empty patch");
    return undefined;
  }

  const meta = { sourceName: source, sourceTopic: topic, sensorTimestamp: time };
  const { invalid } = telemetryStore.applyUpdate(patch, meta);
  healthRegistry.recordOk(topic, invalid.length);

  // Surface the canonical patch on the bus so downstream consumers (mqttPublisher,
  // topicHealthService) can act on structured data instead of re-parsing the
  // legacy envelope.
  telemetryBus.emit(BUS_EVENTS.TELEMETRY_PATCH, { patch, meta, invalid });

  // Adapter consumes the per-frame patch, not the cumulative store, so each
  // emit contains only fields actually seen this frame — matches the legacy
  // normalizer's behavior exactly.
  const legacy = toLegacyTelemetry(patch, invalid, meta);
  if (!legacy) {
    return undefined;
  }

  return {
    type: "telemetry",
    source,
    topic,
    time,
    telemetry: legacy,
  };
}

function normalizeFrameLegacy({ message, type, topic, time, source }) {
  const lowerTopic = topic.toLowerCase();
  const lowerType = type.toLowerCase();

  if (lowerType.includes("laserscan") || lowerTopic.includes("scan")) {
    const readings = laserScanToReadings(message);
    if (readings.length > 0) {
      return { type: "scan", readings, source, topic, time };
    }
  }

  if (lowerType.includes("pointcloud") || lowerTopic.includes("points")) {
    const readings = message.data ? pointCloud2ToReadings(message) : pointCloudToReadings(message);
    const points = message.data ? pointCloud2ToPoints(message) : message.points || [];
    if (readings.length > 0 || points.length > 0) {
      return {
        type: "point-cloud",
        readings,
        points,
        source,
        topic,
        time,
        frameId: message.header?.frame_id || "",
      };
    }
  }

  if (lowerType.includes("compressedimage")) {
    const src = compressedImageToSource(message);
    if (src) {
      return {
        type: "camera-frame",
        source,
        topic,
        time,
        src,
        resolution: "Compressed",
        fps: Number(message.fps || 0),
      };
    }
  }

  if (lowerType.includes("image") || lowerTopic.includes("camera") || lowerTopic.includes("image")) {
    const src = rawImageToSource(message) || imageToSource(message);
    if (src) {
      return {
        type: "camera-frame",
        source,
        topic,
        time,
        src,
        resolution: message.width && message.height ? `${message.width}x${message.height}` : "Recorded",
        fps: Number(message.fps || 0),
      };
    }
  }

  if (lowerType.includes("imu")) {
    return {
      type: "telemetry",
      source,
      topic,
      time,
      telemetry: {
        acceleration: message.linear_acceleration,
        angularVelocity: message.angular_velocity,
        orientation: message.orientation,
      },
    };
  }

  if (lowerType.includes("magneticfield") || lowerTopic.includes("mag")) {
    return {
      type: "telemetry",
      source,
      topic,
      time,
      telemetry: {
        magneticField: message.magnetic_field,
      },
    };
  }

  if (lowerType.includes("navsatfix") || lowerTopic.includes("gps") || lowerTopic.includes("navsat")) {
    return {
      type: "telemetry",
      source,
      topic,
      time,
      telemetry: {
        gps: {
          latitude: message.latitude,
          longitude: message.longitude,
          altitude: message.altitude,
        },
      },
    };
  }

  if (lowerType.includes("odometry")) {
    const linear = message.twist?.twist?.linear || {};
    const angular = message.twist?.twist?.angular || {};
    const speed = Math.hypot(Number(linear.x || 0), Number(linear.y || 0), Number(linear.z || 0));

    return {
      type: "telemetry",
      source,
      topic,
      time,
      telemetry: {
        speed: Number(speed.toFixed(3)),
        linearVelocity: linear,
        angularVelocity: angular,
        pose: message.pose?.pose,
      },
    };
  }

  const vehicleTelemetry = normalizeVehicleTelemetry(message, type, topic);
  if (vehicleTelemetry) {
    return {
      type: "telemetry",
      source,
      topic,
      time,
      telemetry: vehicleTelemetry,
    };
  }

  return {
    type: "bag-frame",
    source,
    topic,
    time,
    messageType: type || "unknown",
    payload: message,
  };
}
