import { WebSocketServer } from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mqtt from "mqtt";
import { createBagPlaybackSource } from "./sources/bagPlaybackSource.js";
import { createDirectLidarSource } from "./sources/directLidarSource.js";
import { createMqttBridgeSource } from "./sources/mqttBridgeSource.js";
import { createRosBridgeLidarSource } from "./sources/rosBridgeLidarSource.js";

const WS_PORT = Number(process.env.WS_PORT || 4000);
const LIDAR_SOURCE = process.env.LIDAR_SOURCE || "bag";
const BAG_DIRECTORY = process.env.BAG_DIRECTORY || path.join(os.homedir(), "Desktop", "enes_ws", "bag");
const DEFAULT_BAG_FILE_PATH = process.env.BAG_FILE_PATH || findBagFiles()[0]?.path || "";
const MQTT_URL = process.env.MQTT_URL || "mqtt://localhost:1883";
const MQTT_TOPIC_ROOT = process.env.MQTT_TOPIC_ROOT || "map-pilot";
const MQTT_PUBLISH = process.env.MQTT_PUBLISH === "true";
const AUTO_START_SOURCE = process.env.AUTO_START_SOURCE === "true" || MQTT_PUBLISH;
const SESSION_RECORD = process.env.SESSION_RECORD === "true";
const SESSION_DIRECTORY = process.env.SESSION_DIRECTORY || path.join(process.cwd(), "data", "sessions");

const wss = new WebSocketServer({ port: WS_PORT });
let selectedBagPath = DEFAULT_BAG_FILE_PATH;
let lidarSource;
let mqttClient;
let sessionRecorder;

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
  sessionRecorder?.record(message);

  if (mqttClient?.connected) {
    const eventType = typeof message.type === "string" ? message.type : "message";
    mqttClient.publish(`${MQTT_TOPIC_ROOT}/events/${eventType}`, payload);
    publishVehicleTopics(message);
  }

  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

function createSessionRecorder() {
  fs.mkdirSync(SESSION_DIRECTORY, { recursive: true });
  const startedAt = new Date();
  const id = startedAt.toISOString().replace(/[:.]/g, "-");
  const eventPath = path.join(SESSION_DIRECTORY, `${id}.jsonl`);
  const reportPath = path.join(SESSION_DIRECTORY, `${id}-report.json`);
  const htmlReportPath = path.join(SESSION_DIRECTORY, `${id}-report.html`);
  const stream = fs.createWriteStream(eventPath, { flags: "a" });
  const countsByType = {};
  const countsByTopic = {};
  const summary = {
    id,
    startedAt: startedAt.toISOString(),
    endedAt: "",
    source: LIDAR_SOURCE,
    selectedBagPath,
    mqttUrl: MQTT_URL,
    mqttTopicRoot: MQTT_TOPIC_ROOT,
    totalMessages: 0,
    telemetryMessages: 0,
    maxSpeedMps: 0,
    maxSpeedKmh: 0,
    countsByType,
    countsByTopic,
  };

  function record(message) {
    if (!message || message.type === "status") {
      return;
    }

    summary.totalMessages += 1;
    countsByType[message.type || "unknown"] = (countsByType[message.type || "unknown"] || 0) + 1;
    if (message.topic) {
      countsByTopic[message.topic] = (countsByTopic[message.topic] || 0) + 1;
    }

    if (message.type === "telemetry" && message.telemetry) {
      summary.telemetryMessages += 1;
      const speedMps = Number(message.telemetry.speed);
      const speedKmh = Number(message.telemetry.vehicle?.speedKmh);
      if (Number.isFinite(speedMps)) {
        summary.maxSpeedMps = Math.max(summary.maxSpeedMps, speedMps);
        summary.maxSpeedKmh = Math.max(summary.maxSpeedKmh, Number((speedMps * 3.6).toFixed(2)));
      }
      if (Number.isFinite(speedKmh)) {
        summary.maxSpeedKmh = Math.max(summary.maxSpeedKmh, speedKmh);
      }
    }

    stream.write(`${JSON.stringify({
      recordedAt: new Date().toISOString(),
      ...message,
    })}\n`);
  }

  function finish() {
    summary.endedAt = new Date().toISOString();
    fs.writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`);
    fs.writeFileSync(htmlReportPath, renderSessionReportHtml(summary));
    stream.end();
    console.log(`Session events saved: ${eventPath}`);
    console.log(`Session report saved: ${reportPath}`);
    console.log(`Session HTML report saved: ${htmlReportPath}`);
  }

  console.log(`Session recording enabled: ${eventPath}`);
  return {
    record,
    finish,
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderRows(entries) {
  return Object.entries(entries)
    .sort((left, right) => right[1] - left[1])
    .map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${Number(value).toLocaleString()}</td></tr>`)
    .join("");
}

function renderSessionReportHtml(summary) {
  const durationSeconds = summary.endedAt
    ? Math.max(0, Math.round((new Date(summary.endedAt).getTime() - new Date(summary.startedAt).getTime()) / 1000))
    : 0;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MapPilot Session Report</title>
  <style>
    body { background: #0f172a; color: #e5edf6; font-family: Inter, Arial, sans-serif; margin: 0; padding: 32px; }
    main { margin: 0 auto; max-width: 1040px; }
    h1 { margin: 0 0 8px; }
    .muted { color: #94a3b8; }
    .grid { display: grid; gap: 16px; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 24px 0; }
    .card { background: #111827; border: 1px solid #334155; border-radius: 10px; padding: 16px; }
    .card span { color: #94a3b8; display: block; font-size: 12px; text-transform: uppercase; }
    .card strong { display: block; font-size: 28px; margin-top: 8px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border-bottom: 1px solid #334155; padding: 10px 8px; text-align: left; }
    th { color: #7dd3fc; font-size: 12px; text-transform: uppercase; }
    .two-col { display: grid; gap: 20px; grid-template-columns: 1fr 1fr; }
    @media (max-width: 800px) { .grid, .two-col { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <h1>MapPilot Session Report</h1>
    <p class="muted">${escapeHtml(summary.id)}</p>
    <div class="grid">
      <div class="card"><span>Total messages</span><strong>${summary.totalMessages.toLocaleString()}</strong></div>
      <div class="card"><span>Telemetry messages</span><strong>${summary.telemetryMessages.toLocaleString()}</strong></div>
      <div class="card"><span>Max speed</span><strong>${Number(summary.maxSpeedKmh).toFixed(1)} km/h</strong></div>
      <div class="card"><span>Duration</span><strong>${durationSeconds}s</strong></div>
    </div>
    <div class="card">
      <p><strong>Source:</strong> ${escapeHtml(summary.source)}</p>
      <p><strong>Bag:</strong> ${escapeHtml(summary.selectedBagPath)}</p>
      <p><strong>MQTT:</strong> ${escapeHtml(summary.mqttUrl)} / ${escapeHtml(summary.mqttTopicRoot)}</p>
      <p><strong>Started:</strong> ${escapeHtml(summary.startedAt)} &nbsp; <strong>Ended:</strong> ${escapeHtml(summary.endedAt)}</p>
    </div>
    <div class="two-col" style="margin-top: 20px;">
      <section class="card">
        <h2>Messages by Type</h2>
        <table><thead><tr><th>Type</th><th>Count</th></tr></thead><tbody>${renderRows(summary.countsByType)}</tbody></table>
      </section>
      <section class="card">
        <h2>Messages by Topic</h2>
        <table><thead><tr><th>Topic</th><th>Count</th></tr></thead><tbody>${renderRows(summary.countsByTopic)}</tbody></table>
      </section>
    </div>
  </main>
</body>
</html>
`;
}

function publishJsonTopic(topic, payload, options = {}) {
  mqttClient?.publish(`${MQTT_TOPIC_ROOT}/${topic}`, JSON.stringify(payload), options);
}

function publishVehicleTopics(message) {
  if (message.type === "status" || message.type === "bag-status") {
    publishJsonTopic("vehicle/health", {
      connected: Boolean(message.connected),
      playing: Boolean(message.playing),
      source: message.source || "unknown",
      topic: message.topic || "",
      path: message.path || "",
      currentTime: message.currentTime || "",
      publishedAt: new Date().toISOString(),
    }, { retain: true });
    return;
  }

  if (message.type !== "telemetry" || !message.telemetry) {
    return;
  }

  const telemetry = message.telemetry;
  const vehicle = telemetry.vehicle || {};
  const base = {
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

  if (vehicle.steering || typeof vehicle.steeringAngle === "number") {
    publishJsonTopic("vehicle/steering", {
      ...base,
      steering: vehicle.steering,
      steeringAngle: vehicle.steeringAngle,
      steeringCommand: vehicle.steeringCommand,
    });
  }

  if (vehicle.brake || typeof vehicle.brakePressure === "number" || typeof vehicle.brakeCommand === "number") {
    publishJsonTopic("vehicle/brake", {
      ...base,
      brake: vehicle.brake,
      brakePressure: vehicle.brakePressure,
      brakeCommand: vehicle.brakeCommand,
    });
  }

  if (vehicle.mode || vehicle.gear || typeof vehicle.battery === "number") {
    publishJsonTopic("vehicle/state", {
      ...base,
      mode: vehicle.mode,
      gear: vehicle.gear,
      battery: vehicle.battery,
      throttle: vehicle.throttle,
      epsStatus: vehicle.epsStatus,
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

if (SESSION_RECORD) {
  sessionRecorder = createSessionRecorder();
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

function shutdown() {
  lidarSource?.stop?.();
  sessionRecorder?.finish();
  mqttClient?.end?.(true);
  wss.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
