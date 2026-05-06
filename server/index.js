import { WebSocketServer } from "ws";
import { createBagPlaybackSource } from "./sources/bagPlaybackSource.js";
import { createDirectLidarSource } from "./sources/directLidarSource.js";
import { createRosBridgeLidarSource } from "./sources/rosBridgeLidarSource.js";

const WS_PORT = Number(process.env.WS_PORT || 4000);
const LIDAR_SOURCE = process.env.LIDAR_SOURCE || "direct";

const wss = new WebSocketServer({ port: WS_PORT });

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

function createLidarSource() {
  if (LIDAR_SOURCE === "bag") {
    return createBagPlaybackSource({
      emit: broadcast,
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

const lidarSource = createLidarSource();

wss.on("connection", (ws) => {
  console.log("Frontend connected to MapPilot backend");
  ws.send(JSON.stringify({ type: "backend-status", connected: true }));
  ws.send(JSON.stringify(lidarSource.getStatus()));

  ws.on("message", (message) => {
    try {
      const payload = JSON.parse(message.toString());

      if (payload.type === "start-lidar") {
        lidarSource.start();
      }

      if (payload.type === "stop-lidar") {
        lidarSource.stop();
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
});
