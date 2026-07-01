import WebSocket from "ws";
import { laserScanToReadings } from "../normalizers/laserScan.js";

export const ROSBRIDGE_URL = process.env.ROSBRIDGE_URL || "ws://localhost:9090";
export const ROS_SCAN_TOPIC = process.env.ROS_SCAN_TOPIC || "/scan";

export function createRosBridgeLidarSource({ emit, url } = {}) {
  const rosbridgeUrl = url || process.env.ROSBRIDGE_URL || ROSBRIDGE_URL;
  let rosSocket;
  let subscribed = false;
  let connected = false;
  let stopped = false;
  let reconnectTimer;
  let reconnectDelay = 1000;

  function getStatus() {
    return {
      type: "status",
      connected,
      source: "rosbridge",
      topic: ROS_SCAN_TOPIC,
    };
  }

  function emitStatus() {
    emit(getStatus());
  }

  function subscribeToScan() {
    if (!rosSocket || rosSocket.readyState !== WebSocket.OPEN || subscribed) {
      return;
    }

    rosSocket.send(
      JSON.stringify({
        op: "subscribe",
        topic: ROS_SCAN_TOPIC,
        throttle_rate: 100,
      }),
    );
    subscribed = true;
    connected = true;
    emitStatus();
    console.log(`Subscribed to ROS topic ${ROS_SCAN_TOPIC} through ${rosbridgeUrl}`);
  }

  function unsubscribeFromScan() {
    if (!rosSocket || rosSocket.readyState !== WebSocket.OPEN || !subscribed) {
      return;
    }

    rosSocket.send(
      JSON.stringify({
        op: "unsubscribe",
        topic: ROS_SCAN_TOPIC,
      }),
    );
    subscribed = false;
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (!stopped) {
        rosSocket = undefined;
        start();
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
      }
    }, reconnectDelay);
  }

  function start() {
    stopped = false;
    if (rosSocket) {
      if (rosSocket.readyState === WebSocket.OPEN) {
        subscribeToScan();
        return;
      }
      // Stale socket in a non-OPEN state — close it cleanly before reconnecting.
      rosSocket.close();
      rosSocket = undefined;
      subscribed = false;
    }

    rosSocket = new WebSocket(rosbridgeUrl);

    rosSocket.on("open", () => {
      // Reset the backoff after a successful link so a later drop retries fast.
      reconnectDelay = 1000;
      subscribeToScan();
    });

    rosSocket.on("message", (data) => {
      try {
        const packet = JSON.parse(data.toString());
        if (packet.op !== "publish" || packet.topic !== ROS_SCAN_TOPIC) {
          return;
        }

        const readings = laserScanToReadings(packet.msg);
        if (readings.length > 0) {
          emit({
            type: "scan",
            readings,
            source: "rosbridge",
            topic: ROS_SCAN_TOPIC,
          });
        }
      } catch (error) {
        emit({ type: "backend-error", message: `Invalid ROS scan packet: ${error.message}` });
      }
    });

    rosSocket.on("close", () => {
      subscribed = false;
      connected = false;
      emitStatus();
      if (!stopped) scheduleReconnect();
    });

    rosSocket.on("error", (error) => {
      emit({ type: "backend-error", message: `ROS bridge error: ${error.message}` });
    });
  }

  function stop() {
    stopped = true;
    clearTimeout(reconnectTimer);
    reconnectDelay = 1000;
    unsubscribeFromScan();
    if (rosSocket) {
      rosSocket.close();
      rosSocket = undefined;
    }
    connected = false;
    subscribed = false;
    emitStatus();
  }

  return {
    getStatus,
    start,
    stop,
  };
}
