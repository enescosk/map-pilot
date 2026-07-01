// MapPilot backend entry point.
//
// Responsibilities are intentionally minimal:
//   - boot the WebSocket server
//   - construct the configured live source (vehicle-ros / mqtt / ros / direct)
//   - route every emitted envelope onto the telemetryBus
//   - subscribe the WS server, MQTT publisher, and topic-health ticker to the bus
//   - handle client command messages (start/stop/connect-source/control-command)
//
// All cleaning, validation, MQTT republish, and health logic lives in the
// per-domain modules under server/{normalizers,services,transport}.

import { WebSocketServer } from "ws";

import { createDirectLidarSource } from "./sources/directLidarSource.js";
import { createSyntheticLidarSource } from "./sources/syntheticLidarSource.js";
import { createMqttBridgeSource, MQTT_RAW_TOPICS, MQTT_URL } from "./sources/mqttBridgeSource.js";
import { createRosBridgeLidarSource, ROS_SCAN_TOPIC, ROSBRIDGE_URL as ROS_LIDAR_BRIDGE_URL } from "./sources/rosBridgeLidarSource.js";
import { createVehicleRosSource, LIVE_ROS_TOPICS, ROSBRIDGE_URL as VEHICLE_ROSBRIDGE_URL } from "./sources/vehicleRosSource.js";

import { telemetryBus, BUS_EVENTS } from "./services/telemetryBus.js";
import { telemetryStore } from "./services/telemetryStore.js";
import { topicHealthService } from "./services/topicHealthService.js";
import { createMqttPublisher } from "./transport/mqttPublisher.js";
import { createControlPublisher } from "./transport/controlPublisher.js";

const WS_PORT = Number(process.env.WS_PORT || 4000);
const LIDAR_SOURCE = process.env.LIDAR_SOURCE || "vehicle-ros";
const MQTT_PUBLISH = process.env.MQTT_PUBLISH === "true";
const AUTO_START_SOURCE =
  process.env.AUTO_START_SOURCE === "true" ||
  ["mqtt", "ros", "vehicle-ros", "synthetic"].includes(LIDAR_SOURCE);

const wss = new WebSocketServer({ port: WS_PORT });
let lidarSource;
// Cumulative telemetry across all topics, sent as a single snapshot on connect
// so a freshly-loaded dashboard shows every field immediately instead of waiting
// for each (possibly slow) topic to publish its next frame.
let telemetrySnapshot = {};
let latestTelemetryEnvelope;

// Deep-merge a per-frame telemetry patch into the cumulative snapshot. Plain
// objects merge recursively; everything else (primitives, arrays) replaces.
function mergeTelemetryDeep(target, patch) {
  if (!patch || typeof patch !== "object") return target;
  const out = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = mergeTelemetryDeep(out[key] && typeof out[key] === "object" ? out[key] : {}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function sanitizeUrlForLog(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    return url.toString();
  } catch {
    return String(value || "");
  }
}

function sourceKind() {
  if (["vehicle-ros", "mqtt", "ros"].includes(LIDAR_SOURCE)) return "live";
  if (LIDAR_SOURCE === "direct") return "bench";
  return "custom";
}

function logStartupDiagnostics() {
  console.log(`MapPilot backend listening on ws://localhost:${WS_PORT}`);
  console.log(`LiDAR source: ${LIDAR_SOURCE} (${sourceKind()})`);
  console.log(`Source auto-start: ${AUTO_START_SOURCE ? "enabled" : "disabled"}`);

  if (LIDAR_SOURCE === "vehicle-ros") {
    console.log(`ROS bridge URL: ${sanitizeUrlForLog(VEHICLE_ROSBRIDGE_URL)}`);
    console.log(`Live ROS topics: ${LIVE_ROS_TOPICS.join(", ")}`);
  } else if (LIDAR_SOURCE === "ros") {
    console.log(`ROS bridge URL: ${sanitizeUrlForLog(ROS_LIDAR_BRIDGE_URL)}`);
    console.log(`ROS scan topic: ${ROS_SCAN_TOPIC}`);
  } else if (LIDAR_SOURCE === "mqtt") {
    console.log(`MQTT URL: ${sanitizeUrlForLog(MQTT_URL)}`);
    console.log(`MQTT raw topics: ${MQTT_RAW_TOPICS.join(", ")}`);
  }

  if (mqttPublisher.enabled) {
    console.log(`MQTT publish: enabled (events + vehicle/* under '${mqttPublisher.topicRoot}')`);
  }
}

// ---------------------------------------------------------------------------
// Bus wiring: sources -> bus -> { WS broadcaster, MQTT publisher, health }.
// ---------------------------------------------------------------------------

function emitFromSource(envelope) {
  telemetryBus.emit(BUS_EVENTS.ENVELOPE, envelope);
}

const MAX_BUFFERED_BYTES = 512 * 1024; // 512 KB — drop slow clients rather than OOM

/**
 * Pack a point-cloud envelope as a binary message:
 *   [4 bytes header length LE] [header JSON utf8] [payload: Float32 xyzi interleaved]
 *
 * This avoids ~3.6 MB/cloud of JSON serialization cost (60k points × ~60 chars each)
 * and lets the worker wrap the payload as a typed array with zero copy.
 */
function packPointCloudBinary(envelope) {
  const points = envelope.points || [];
  const n = points.length;
  const header = {
    type: "point-cloud-binary",
    topic: envelope.topic || "",
    time: envelope.time || "",
    source: envelope.source || "",
    frameId: envelope.frameId || "",
    resolvedFrame: envelope.resolvedFrame || "",
    n,
  };
  const headerJson = Buffer.from(JSON.stringify(header), "utf8");
  // Pad header to multiple of 4 bytes so the Float32 payload that follows is
  // 4-byte aligned (required by `new Float32Array(buf, offset, ...)` in the worker).
  const padBytes = (4 - (headerJson.length % 4)) % 4;
  const headerBuf = padBytes === 0 ? headerJson : Buffer.concat([headerJson, Buffer.alloc(padBytes, 0x20)]);
  const headerLen = Buffer.alloc(4);
  headerLen.writeUInt32LE(headerBuf.length, 0);
  const xyzi = Buffer.alloc(n * 16); // 4 floats × 4 bytes
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const off = i * 16;
    xyzi.writeFloatLE(Number(p.x) || 0, off);
    xyzi.writeFloatLE(Number(p.y) || 0, off + 4);
    xyzi.writeFloatLE(Number(p.z) || 0, off + 8);
    xyzi.writeFloatLE(Number(p.intensity) || 0, off + 12);
  }
  return Buffer.concat([headerLen, headerBuf, xyzi]);
}

function broadcast(envelope) {
  // No connected clients → skip packing/serialization entirely. Point-cloud
  // packing and large-envelope JSON.stringify are the two most expensive steps
  // here; there's no point paying for them when nobody is listening.
  let hasOpenClient = false;
  for (const client of wss.clients) {
    if (client.readyState === 1) { hasOpenClient = true; break; }
  }
  if (!hasOpenClient) return;

  // Hot path: point-cloud → binary frame. Everything else → JSON.
  const isBinaryEligible = envelope?.type === "point-cloud" && Array.isArray(envelope.points) && envelope.points.length > 0;
  const payload = isBinaryEligible ? packPointCloudBinary(envelope) : JSON.stringify(envelope);

  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    if (client.bufferedAmount > MAX_BUFFERED_BYTES) continue; // drop slow clients
    client.send(payload);
  }
}

telemetryBus.on(BUS_EVENTS.ENVELOPE, (envelope) => {
  if (envelope?.type === "telemetry") {
    telemetrySnapshot = mergeTelemetryDeep(telemetrySnapshot, envelope.telemetry || {});
    // The merged snapshot spans many topics — the per-frame "derived" marker is
    // meaningless on it and would mislead the frontend's derived-speed handling.
    delete telemetrySnapshot.derived;
    delete telemetrySnapshot.derivedFrom;
    latestTelemetryEnvelope = {
      type: "telemetry",
      source: envelope.source,
      topic: "snapshot",
      time: envelope.time,
      telemetry: telemetrySnapshot,
    };
  }
  broadcast(envelope);
});

const mqttPublisher = createMqttPublisher();
mqttPublisher.start();
const controlPublisher = createControlPublisher();
topicHealthService.start();

// ---------------------------------------------------------------------------
// Source factory + lifecycle
// ---------------------------------------------------------------------------

function createLidarSource(sourceOverride, rosbridgeUrlOverride, mqttUrlOverride) {
  const src = sourceOverride || LIDAR_SOURCE;
  if (src === "ros") {
    return createRosBridgeLidarSource({ emit: emitFromSource, url: rosbridgeUrlOverride });
  }
  if (src === "vehicle-ros") {
    return createVehicleRosSource({ emit: emitFromSource, url: rosbridgeUrlOverride });
  }
  if (src === "mqtt") {
    return createMqttBridgeSource({ emit: emitFromSource, url: mqttUrlOverride });
  }
  if (src === "synthetic") {
    return createSyntheticLidarSource({ emit: emitFromSource });
  }
  return createDirectLidarSource({ emit: emitFromSource });
}

function setLidarSource(nextSource) {
  if (lidarSource?.stop) {
    lidarSource.stop();
  }
  lidarSource = nextSource;
}

setLidarSource(createLidarSource());
if (AUTO_START_SOURCE) {
  lidarSource.start();
}

// ---------------------------------------------------------------------------
// WebSocket lifecycle
// ---------------------------------------------------------------------------

wss.on("connection", (ws) => {
  console.log("Frontend connected to MapPilot backend");

  // 1. Connection banner.
  ws.send(JSON.stringify({ type: "backend-status", connected: true }));

  // 2. Current source status.
  ws.send(JSON.stringify(lidarSource.getStatus()));

  // 3. Cached telemetry snapshot (if anything has streamed yet this session).
  if (latestTelemetryEnvelope) {
    ws.send(JSON.stringify(latestTelemetryEnvelope));
  }

  // 4. Latest topic-health snapshot — also lets the UI distinguish "no data yet"
  //    from "backend never started".
  ws.send(JSON.stringify(topicHealthService.getSnapshot()));

  ws.on("message", (message) => {
    try {
      const payload = JSON.parse(message.toString());

      if (payload.type === "start-lidar") {
        lidarSource?.start();
      }

      if (payload.type === "stop-lidar") {
        lidarSource?.stop();
      }

      if (payload.type === "connect-source") {
        const { source, rosbridgeUrl, mqttUrl } = payload;
        const allowed = ["vehicle-ros", "mqtt", "ros"];
        if (!allowed.includes(source)) {
          ws.send(JSON.stringify({ type: "backend-error", message: `Unknown source: ${source}` }));
          return;
        }
        if (rosbridgeUrl !== undefined) {
          let parsedRos;
          try { parsedRos = new URL(rosbridgeUrl); } catch { parsedRos = null; }
          if (!parsedRos || !["ws:", "wss:"].includes(parsedRos.protocol)) {
            ws.send(JSON.stringify({ type: "backend-error", message: "rosbridgeUrl must be a ws:// or wss:// URL" }));
            return;
          }
        }
        if (mqttUrl !== undefined) {
          let parsedMqtt;
          try { parsedMqtt = new URL(mqttUrl); } catch { parsedMqtt = null; }
          if (!parsedMqtt || !["mqtt:", "mqtts:", "tcp:", "tls:"].includes(parsedMqtt.protocol)) {
            ws.send(JSON.stringify({ type: "backend-error", message: "mqttUrl must be a mqtt:// or mqtts:// URL" }));
            return;
          }
        }
        latestTelemetryEnvelope = undefined;
        telemetrySnapshot = {};
        telemetryStore.reset();
        topicHealthService.reset();
        setLidarSource(createLidarSource(source, rosbridgeUrl, mqttUrl));
        lidarSource.start();
        broadcast({ type: "source-changed", source });
        ws.send(JSON.stringify(lidarSource.getStatus()));
        console.log(`Source changed to ${source} via UI (rosbridge=${sanitizeUrlForLog(rosbridgeUrl || "-")} mqtt=${sanitizeUrlForLog(mqttUrl || "-")})`);
      }

      if (payload.type === "control-command") {
        const now = Date.now();
        const lastSent = ws._lastControlSentAt || 0;
        if (now - lastSent < 50) return; // 20 Hz cap
        ws._lastControlSentAt = now;
        const result = controlPublisher.publish({
          topic: payload.topic,
          msgType: payload.msgType,
          message: payload.message,
        });
        if (!result.ok) {
          ws.send(JSON.stringify({ type: "backend-error", message: `Control rejected: ${result.reason}` }));
        }
      }
    } catch (err) {
      console.error("Invalid client message:", err);
    }
  });
});

wss.on("listening", () => {
  logStartupDiagnostics();
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let isShuttingDown = false;

function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n${signal} received — shutting down gracefully`);
  lidarSource?.stop?.();
  mqttPublisher.stop?.();
  controlPublisher.stop?.();
  topicHealthService.stop?.();
  wss.close(() => {
    console.log("WebSocket server closed");
    process.exit(0);
  });
  // Fallback: if graceful shutdown stalls (e.g., hanging socket), force exit
  setTimeout(() => { console.error("Forced exit after timeout"); process.exit(1); }, 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
