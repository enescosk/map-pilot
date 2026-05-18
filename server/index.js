import { WebSocketServer } from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mqtt from "mqtt";
import { createBagPlaybackSource } from "./sources/bagPlaybackSource.js";
import { createDirectLidarSource } from "./sources/directLidarSource.js";
import { createMqttBridgeSource } from "./sources/mqttBridgeSource.js";
import { createRosBridgeLidarSource } from "./sources/rosBridgeLidarSource.js";
import { createVehicleRosSource } from "./sources/vehicleRosSource.js";

const WS_PORT = Number(process.env.WS_PORT || 4000);
const LIDAR_SOURCE = process.env.LIDAR_SOURCE || "bag";
const BAG_DIRECTORY = process.env.BAG_DIRECTORY || path.join(os.homedir(), "Desktop", "enes_ws", "bag");
const DEFAULT_BAG_FILE_PATH = process.env.BAG_FILE_PATH || findBagFiles()[0]?.path || "";
const MQTT_URL = process.env.MQTT_URL || "mqtt://localhost:1883";
const MQTT_TOPIC_ROOT = process.env.MQTT_TOPIC_ROOT || "map-pilot";
const MQTT_PUBLISH = process.env.MQTT_PUBLISH === "true";
const AUTO_START_SOURCE = process.env.AUTO_START_SOURCE === "true" || MQTT_PUBLISH || LIDAR_SOURCE === "mqtt";

const wss = new WebSocketServer({ port: WS_PORT });
let selectedBagPath = DEFAULT_BAG_FILE_PATH;
let lidarSource;
let mqttClient;

if (MQTT_PUBLISH) {
  mqttClient = mqtt.connect(MQTT_URL, {
    clientId: `map-pilot-vehicle-${Math.random().toString(16).slice(2)}`,
    reconnectPeriod: 1000,
  });

  mqttClient.on("connect", () => {
    console.log(`MQTT publisher connected to ${MQTT_URL}`);
  });

  mqttClient.on("error", (error) => {
    console.error("MQTT publisher error:", error.message);
  });
}

function broadcast(message) {
  const payload = JSON.stringify(message);
  publishMqtt(message, payload);

  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

function publishMqtt(message, payload) {
  if (!mqttClient?.connected) {
    return;
  }

  const eventType = typeof message.type === "string" ? message.type : "message";
  mqttClient.publish(`${MQTT_TOPIC_ROOT}/events/${eventType}`, payload);

  if (message.type === "status") {
    mqttClient.publish(`${MQTT_TOPIC_ROOT}/vehicle/health`, JSON.stringify({
      connected: Boolean(message.connected),
      source: message.source || "unknown",
      topic: message.topic || "",
      publishedAt: new Date().toISOString(),
    }), { retain: true });
  }

  if (message.type === "telemetry" && message.telemetry) {
    publishVehicleTelemetry(message);
  }
}

function publishJsonTopic(topic, payload, options = {}) {
  mqttClient?.publish(`${MQTT_TOPIC_ROOT}/${topic}`, JSON.stringify(payload), options);
}

function publishVehicleTelemetry(message) {
  const telemetry = message.telemetry;
  const vehicle = telemetry.vehicle || {};
  const base = {
    source: message.source || "unknown",
    sourceTopic: message.topic || "",
    time: message.time || "",
    publishedAt: new Date().toISOString(),
  };

  if (typeof telemetry.speed === "number" || typeof vehicle.speedKmh === "number") {
    publishJsonTopic("vehicle/speed", {
      ...base,
      speedMps: telemetry.speed,
      speedKmh: vehicle.speedKmh ?? (typeof telemetry.speed === "number" ? Number((telemetry.speed * 3.6).toFixed(2)) : undefined),
    });
  }

  if (typeof vehicle.steeringAngle === "number" || typeof vehicle.targetSteeringAngle === "number") {
    publishJsonTopic("vehicle/steering", {
      ...base,
      steeringAngle: vehicle.steeringAngle,
      targetSteeringAngle: vehicle.targetSteeringAngle,
      steeringSpeed: vehicle.steeringSpeed,
      steeringTorque: vehicle.steeringTorque,
    });
  }

  if (typeof vehicle.brakePressure === "number" || typeof vehicle.brakePercent === "number") {
    publishJsonTopic("vehicle/brake", {
      ...base,
      brakePressure: vehicle.brakePressure,
      targetBrakePressure: vehicle.targetBrakePressure,
      brakePercent: vehicle.brakePercent,
      handbrake: vehicle.handbrake,
    });
  }

  if (vehicle.mode || vehicle.gear !== undefined || vehicle.batterySoc !== undefined || vehicle.ignition !== undefined) {
    publishJsonTopic("vehicle/state", {
      ...base,
      mode: vehicle.mode,
      gear: vehicle.gear,
      batterySoc: vehicle.batterySoc,
      batteryVoltage: vehicle.batteryVoltage,
      ignition: vehicle.ignition,
      epsFault: vehicle.epsFault,
    }, { retain: true });
  }
}

function findBagFiles() {
  if (!fs.existsSync(BAG_DIRECTORY)) {
    return [];
  }

  return fs
    .readdirSync(BAG_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(bag|jsonl?|db3)$/i.test(entry.name))
    .map((entry) => {
      const filePath = path.join(BAG_DIRECTORY, entry.name);
      const stats = fs.statSync(filePath);
      return {
        name: entry.name,
        path: filePath,
        size: stats.size,
        modifiedAt: stats.mtimeMs,
      };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
}

function createLidarSource() {
  if (LIDAR_SOURCE === "bag") {
    return createBagPlaybackSource({
      emit: broadcast,
      filePath: selectedBagPath,
    });
  }

  if (LIDAR_SOURCE === "ros") {
    return createRosBridgeLidarSource({
      emit: broadcast,
    });
  }

  if (LIDAR_SOURCE === "vehicle-ros") {
    return createVehicleRosSource({
      emit: broadcast,
    });
  }

  if (LIDAR_SOURCE === "mqtt") {
    return createMqttBridgeSource({
      emit: broadcast,
    });
  }

  return createDirectLidarSource({
    emit: broadcast,
  });
}

function setLidarSource(nextSource) {
  if (lidarSource?.stop) {
    lidarSource.stop();
  }

  lidarSource = nextSource;
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

wss.on("connection", (ws) => {
  console.log("Frontend connected to MapPilot backend");
  ws.send(JSON.stringify({ type: "backend-status", connected: true }));
  ws.send(JSON.stringify(lidarSource.getStatus()));
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
  console.log(`MapPilot backend listening on ws://localhost:${WS_PORT}`);
  console.log(`LiDAR source: ${LIDAR_SOURCE}`);
  console.log(`Bag directory: ${BAG_DIRECTORY}`);
  if (MQTT_PUBLISH) {
    console.log(`MQTT publish: ${MQTT_URL} -> ${MQTT_TOPIC_ROOT}/events/<type>`);
  }
  if (selectedBagPath) {
    console.log(`Selected bag: ${selectedBagPath}`);
  }
});
