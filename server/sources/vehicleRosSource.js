import WebSocket from "ws";
import { normalizeFrame } from "../normalizers/index.js";
import { rosTimeToString } from "../normalizers/helpers.js";
import { matchTopicEntry } from "../mapping/topicMap.js";
import { createVehicleDeriver } from "./deriveVehicleTelemetry.js";

// When the played bag has no CAN/vehicle topics, reconstruct the cockpit gauges
// from motion sensors (GNSS velocity + IMU + heading). Opt-in via env so a
// real-CAN deployment is unaffected. Real CAN always wins: if a genuine vehicle
// frame arrived within REAL_CAN_TTL_MS, derived output is suppressed.
const DERIVE_VEHICLE = process.env.DERIVE_VEHICLE === "true";
const REAL_CAN_TTL_MS = 2000;

export const ROSBRIDGE_URL = process.env.ROSBRIDGE_URL || "ws://localhost:9090";
export const DEFAULT_LIVE_ROS_TOPICS = [
  "/VelocityInformation",
  "/eps_response",
  "/EHB_BrakingResponse",
  "/fb_motor_driver_report",
  "/rc_unit_report",
  "/autonomous_report",
  "/throttle_control",
  "/vcu_eps_control",
  "/vcu_ehb_control",
  "/steer_control",
  "/brake_control",
  "/autonomous_mode_selection",
  "/scan",
  "/left_laser/scan",
  "/right_laser/scan",
  "/rslidar_points",
  "/m1/rslidar_points",
  "/cloud",
  "/camera/image_raw",
  "/out/compressed",
  "/zed2i/zed_node/rgb/image_rect_color/compressed",
  "/imu/data",
  "/zed2i/zed_node/imu/data",
  "/ekf/odometry_earth",
  "/zed2i/zed_node/odom",
  "/heading",
  "/navsatfix",
  "/gnss_1/velocity",
];
export const LIVE_ROS_TOPICS = (process.env.LIVE_ROS_TOPICS || process.env.VEHICLE_TOPICS || DEFAULT_LIVE_ROS_TOPICS.join(","))
  .split(",")
  .map((topic) => topic.trim())
  .filter(Boolean);

export function createVehicleRosSource({ emit, url } = {}) {
  const rosbridgeUrl = url || process.env.ROSBRIDGE_URL || ROSBRIDGE_URL;
  let rosSocket;
  let connected = false;
  let subscribed = false;
  let reconnectTimer;
  let stopped = false;
  let reconnectDelay = 1000;
  const deriver = DERIVE_VEHICLE ? createVehicleDeriver() : null;
  let lastRealCanMs = 0;

  function getStatus() {
    return {
      type: "status",
      connected,
      source: "vehicle-ros",
      topic: LIVE_ROS_TOPICS.join(", "),
    };
  }

  function subscribe() {
    if (!rosSocket || rosSocket.readyState !== WebSocket.OPEN || subscribed) {
      return;
    }

    for (const topic of LIVE_ROS_TOPICS) {
      rosSocket.send(JSON.stringify({
        op: "subscribe",
        topic,
      }));
    }
    subscribed = true;
  }

  function unsubscribe() {
    if (!rosSocket || rosSocket.readyState !== WebSocket.OPEN || !subscribed) {
      return;
    }

    for (const topic of LIVE_ROS_TOPICS) {
      rosSocket.send(JSON.stringify({
        op: "unsubscribe",
        topic,
      }));
    }
    subscribed = false;
  }

  function start() {
    stopped = false;
    if (rosSocket) {
      if (rosSocket.readyState === WebSocket.OPEN) {
        subscribe();
        return;
      }
      // Stale socket in a non-OPEN state — close it cleanly before reconnecting
      rosSocket.close();
      rosSocket = undefined;
      subscribed = false;
    }

    rosSocket = new WebSocket(rosbridgeUrl);

    rosSocket.on("open", () => {
      reconnectDelay = 1000; // reset backoff after successful connect
      connected = true;
      emit(getStatus());
      subscribe();
    });

    rosSocket.on("message", (raw) => {
      try {
        const packet = JSON.parse(raw.toString());
        if (packet.op !== "publish" || !packet.topic || !packet.msg) {
          return;
        }

        const msgType = packet.msg._type || "";
        const time = rosTimeToString(packet.msg.header?.stamp);

        const normalized = normalizeFrame({
          topic: packet.topic,
          type: msgType,
          time,
          source: "vehicle-ros",
          message: packet.msg,
        });

        emit(normalized);

        if (deriver) {
          // A genuine CAN/vehicle frame (matches the topic map) means real data
          // is present — record it so derivation backs off for REAL_CAN_TTL_MS.
          if (matchTopicEntry(packet.topic, msgType)) {
            lastRealCanMs = Date.now();
          } else if (Date.now() - lastRealCanMs > REAL_CAN_TTL_MS) {
            const patch = deriver.ingest(packet.topic, msgType, packet.msg);
            if (patch) {
              emit({ type: "telemetry", source: "vehicle-derived", topic: "/derived/vehicle", time, telemetry: patch });
            }
          }
        }
      } catch (error) {
        emit({ type: "backend-error", message: `Invalid vehicle ROS packet: ${error.message}` });
      }
    });

    rosSocket.on("close", () => {
      connected = false;
      subscribed = false;
      emit(getStatus());
      if (!stopped) scheduleReconnect();
    });

    rosSocket.on("error", (error) => {
      emit({ type: "backend-error", message: `Vehicle ROS bridge error: ${error.message}` });
    });
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

  function stop() {
    stopped = true;
    clearTimeout(reconnectTimer);
    reconnectDelay = 1000;
    unsubscribe();
    if (rosSocket) {
      rosSocket.close();
      rosSocket = undefined;
    }
    connected = false;
    subscribed = false;
    emit(getStatus());
  }

  return { getStatus, start, stop };
}
