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

telemetryBus.on(BUS_EVENTS.ENVELOPE, (envelope) => {
  if (envelope?.type === "telemetry") {
    latestTelemetryEnvelope = envelope;
  }
});

telemetryBus.on(BUS_EVENTS.ENVELOPE, (envelope) => {
  const payload = JSON.stringify(envelope);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
});

const mqttPublisher = createMqttPublisher();
mqttPublisher.start();
topicHealthService.start();

// ---------------------------------------------------------------------------
// Source factory + lifecycle
// ---------------------------------------------------------------------------

function createLidarSource() {
  if (LIDAR_SOURCE === "bag") {
    return createBagPlaybackSource({ emit: emitFromSource, filePath: selectedBagPath });
  }
  if (LIDAR_SOURCE === "ros") {
    return createRosBridgeLidarSource({ emit: emitFromSource });
  }
  if (LIDAR_SOURCE === "vehicle-ros") {
    return createVehicleRosSource({ emit: emitFromSource });
  }
  if (LIDAR_SOURCE === "mqtt") {
    return createMqttBridgeSource({ emit: emitFromSource });
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
        lidarSource.start();
      }

      if (payload.type === "stop-lidar") {
        lidarSource.stop();
      }

      if (payload.type === "list-bags") {
        broadcastBagList(ws);
      }

      if (payload.type === "load-bag" && typeof payload.path === "string") {
        const requestedPath = path.resolve(payload.path);
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

      if (payload.type === "seek-playback" && typeof lidarSource.seek === "function") {
        lidarSource.seek(Number(payload.ratio || 0));
      }
    } catch (err) {
      console.error("Invalid client message:", err);
    }
  });
});

wss.on("listening", () => {
  logStartupDiagnostics();
});
