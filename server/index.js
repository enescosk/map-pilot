// MapPilot backend entry point.
//
// Responsibilities are intentionally minimal:
//   - boot the WebSocket server
//   - construct the configured live/bag source
//   - route every emitted envelope onto the telemetryBus
//   - subscribe the WS server, MQTT publisher, and topic-health ticker to the bus
//   - handle client command messages (start/stop/load-bag/seek/list-bags)
//
// All cleaning, validation, MQTT republish, and health logic lives in the
// per-domain modules under server/{normalizers,services,transport}.

import { WebSocketServer } from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createBagPlaybackSource } from "./sources/bagPlaybackSource.js";
import { createDirectLidarSource } from "./sources/directLidarSource.js";
import { createMqttBridgeSource, MQTT_RAW_TOPICS, MQTT_URL } from "./sources/mqttBridgeSource.js";
import { createRosBridgeLidarSource, ROS_SCAN_TOPIC, ROSBRIDGE_URL as ROS_LIDAR_BRIDGE_URL } from "./sources/rosBridgeLidarSource.js";
import { createVehicleRosSource, LIVE_ROS_TOPICS, ROSBRIDGE_URL as VEHICLE_ROSBRIDGE_URL } from "./sources/vehicleRosSource.js";

import { telemetryBus, BUS_EVENTS } from "./services/telemetryBus.js";
import { telemetryStore } from "./services/telemetryStore.js";
import { topicHealthService } from "./services/topicHealthService.js";
import { createMqttPublisher } from "./transport/mqttPublisher.js";
import { createControlPublisher } from "./transport/controlPublisher.js";

const WS_PORT = Number(process.env.WS_PORT || 4000);
const LIDAR_SOURCE = process.env.LIDAR_SOURCE || "bag";
const BAG_DIRECTORY = process.env.BAG_DIRECTORY || path.join(os.homedir(), "Desktop", "enes_ws", "bag");
const DEFAULT_BAG_FILE_PATH = process.env.BAG_FILE_PATH || findBagFiles()[0]?.path || "";
const MQTT_PUBLISH = process.env.MQTT_PUBLISH === "true";
const AUTO_START_SOURCE =
  process.env.AUTO_START_SOURCE === "true" ||
  ["mqtt", "ros", "vehicle-ros"].includes(LIDAR_SOURCE);

const wss = new WebSocketServer({ port: WS_PORT });
let selectedBagPath = DEFAULT_BAG_FILE_PATH;
let lidarSource;
let latestTelemetryEnvelope; // cached for snapshot-on-connect

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
  if (LIDAR_SOURCE === "bag") return "offline/debug";
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
  } else if (LIDAR_SOURCE === "bag") {
    console.log("Bag playback auto-start: disabled unless AUTO_START_SOURCE=true or the UI sends Play");
    console.log(`Bag directory: ${BAG_DIRECTORY}`);
    if (selectedBagPath) {
      console.log(`Selected bag: ${selectedBagPath}`);
    }
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
    latestTelemetryEnvelope = envelope;
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
  if (src === "bag") {
    return createBagPlaybackSource({ emit: emitFromSource, filePath: selectedBagPath });
  }
  if (src === "ros") {
    return createRosBridgeLidarSource({ emit: emitFromSource, url: rosbridgeUrlOverride });
  }
  if (src === "vehicle-ros") {
    return createVehicleRosSource({ emit: emitFromSource, url: rosbridgeUrlOverride });
  }
  if (src === "mqtt") {
    return createMqttBridgeSource({ emit: emitFromSource, url: mqttUrlOverride });
  }
  return createDirectLidarSource({ emit: emitFromSource });
}

function setLidarSource(nextSource) {
  if (lidarSource?.stop) {
    lidarSource.stop();
  }
  lidarSource = nextSource;
}

function findBagFiles() {
  if (!fs.existsSync(BAG_DIRECTORY)) return [];
  return fs
    .readdirSync(BAG_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(bag|jsonl?|db3)$/i.test(entry.name))
    .map((entry) => {
      const filePath = path.join(BAG_DIRECTORY, entry.name);
      const stats = fs.statSync(filePath);
      return { name: entry.name, path: filePath, size: stats.size, modifiedAt: stats.mtimeMs };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
}

function broadcastBagList(ws) {
  const files = findBagFiles();
  ws.send(JSON.stringify({
    type: "bag-list",
    files,
    selectedPath: selectedBagPath || files[0]?.path || "",
    directory: BAG_DIRECTORY,
  }));
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

  // 5. Available bag files.
  broadcastBagList(ws);

  ws.on("message", (message) => {
    try {
      const payload = JSON.parse(message.toString());

      if (payload.type === "start-lidar") {
        lidarSource?.start();
      }

      if (payload.type === "stop-lidar") {
        lidarSource?.stop();
      }

      if (payload.type === "list-bags") {
        broadcastBagList(ws);
      }

      if (payload.type === "load-bag" && typeof payload.path === "string") {
        const requestedPath = path.resolve(payload.path);
        const resolvedBagDir = path.resolve(BAG_DIRECTORY);
        if (!requestedPath.startsWith(resolvedBagDir + path.sep) && requestedPath !== resolvedBagDir) {
          ws.send(JSON.stringify({ type: "backend-error", message: "Bag file must be inside the bag directory" }));
          return;
        }
        if (!fs.existsSync(requestedPath)) {
          ws.send(JSON.stringify({ type: "backend-error", message: `Bag file not found: ${requestedPath}` }));
          return;
        }
        selectedBagPath = requestedPath;
        latestTelemetryEnvelope = undefined;
        telemetryStore.reset();
        setLidarSource(createLidarSource());
        ws.send(JSON.stringify({ type: "reset-playback", path: selectedBagPath }));
        broadcastBagList(ws);
        ws.send(JSON.stringify(lidarSource.getStatus()));
        lidarSource.start();
      }

      if (payload.type === "seek-playback" && typeof lidarSource?.seek === "function") {
        lidarSource.seek(Number(payload.ratio || 0));
      }

      if (payload.type === "connect-source") {
        const { source, rosbridgeUrl, mqttUrl } = payload;
        const allowed = ["vehicle-ros", "mqtt", "bag", "ros"];
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
        telemetryStore.reset();
        setLidarSource(createLidarSource(source, rosbridgeUrl, mqttUrl));
        lidarSource.start();
        broadcast({ type: "source-changed", source });
        ws.send(JSON.stringify(lidarSource.getStatus()));
        console.log(`Source changed to ${source} via UI (rosbridge=${sanitizeUrlForLog(rosbridgeUrl || "-")} mqtt=${sanitizeUrlForLog(mqttUrl || "-")})`);
      }

      if (payload.type === "control-command") {
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
