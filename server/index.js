import { WebSocketServer } from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBagPlaybackSource } from "./sources/bagPlaybackSource.js";
import { createDirectLidarSource } from "./sources/directLidarSource.js";
import { createRosBridgeLidarSource } from "./sources/rosBridgeLidarSource.js";

const WS_PORT = Number(process.env.WS_PORT || 4000);
const LIDAR_SOURCE = process.env.LIDAR_SOURCE || "bag";
const BAG_DIRECTORY = process.env.BAG_DIRECTORY || path.join(os.homedir(), "Desktop", "enes_ws", "bag");
const DEFAULT_BAG_FILE_PATH = process.env.BAG_FILE_PATH || findBagFiles()[0]?.path || "";

const wss = new WebSocketServer({ port: WS_PORT });
let selectedBagPath = DEFAULT_BAG_FILE_PATH;
let lidarSource;

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
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
  if (selectedBagPath) {
    console.log(`Selected bag: ${selectedBagPath}`);
  }
});
