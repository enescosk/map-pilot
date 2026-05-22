import WebSocket from "ws";
import { laserScanToReadings } from "../normalizers/laserScan.js";

export const ROSBRIDGE_URL = process.env.ROSBRIDGE_URL || "ws://localhost:9090";
export const ROS_SCAN_TOPIC = process.env.ROS_SCAN_TOPIC || "/scan";

export function createRosBridgeLidarSource({ emit }) {
  let rosSocket;
  let subscribed = false;
  let connected = false;

  function emitStatus() {
    emit({
      type: "status",
      connected,
      source: "rosbridge",
      topic: ROS_SCAN_TOPIC,
    });
  }

  function getStatus() {
    return {
      type: "status",
      connected,
      source: "rosbridge",
      topic: ROS_SCAN_TOPIC,
    };
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
    console.log(`Subscribed to ROS topic ${ROS_SCAN_TOPIC} through ${ROSBRIDGE_URL}`);
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
    connected = false;
    emitStatus();
  }

  function connect() {
    if (rosSocket && rosSocket.readyState <= WebSocket.OPEN) {
      subscribeToScan();
      return;
    }

    rosSocket = new WebSocket(ROSBRIDGE_URL);

    rosSocket.on("open", () => {
      subscribeToScan();
    });

    rosSocket.on("message", (data) => {
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
    });

    rosSocket.on("close", () => {
      subscribed = false;
      connected = false;
      emitStatus();
    });

    rosSocket.on("error", (error) => {
      console.error("ROS bridge error:", error.message);
      connected = false;
      emitStatus();
    });
  }

  function start() {
    connect();
  }

  function stop() {
    unsubscribeFromScan();
  }

  return {
    getStatus,
    start,
    stop,
  };
}
