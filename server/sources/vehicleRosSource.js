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

// LiDAR feeds are by far the heaviest topics (a single /rslidar_points is
// ~21 MB/s through rosbridge). The frontend only renders them on the LiDAR
// page, so they get their own subscribe lifecycle: startLidar()/stopLidar()
// toggle just these topics while telemetry/camera/GPS stay subscribed.
export function isLidarTopic(topic) {
  const lower = String(topic).toLowerCase();
  return lower.includes("scan") || lower.includes("cloud") || lower.includes("points")
    || lower.includes("rslidar") || lower.includes("laser");
}

// Correlation id for the /rosapi/topics service call so we can match its response.
const TOPIC_LIST_CALL_ID = "mappilot-topic-list";

export function createVehicleRosSource({ emit, url } = {}) {
  const rosbridgeUrl = url || process.env.ROSBRIDGE_URL || ROSBRIDGE_URL;
  const lidarTopics = LIVE_ROS_TOPICS.filter(isLidarTopic);
  const baseTopics = LIVE_ROS_TOPICS.filter((topic) => !isLidarTopic(topic));
  let rosSocket;
  let connected = false;
  let baseSubscribed = false;
  let lidarSubscribed = false;
  let lidarEnabled = true;
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

  function sendTopicOps(op, topics) {
    for (const topic of topics) {
      rosSocket.send(JSON.stringify({ op, topic }));
    }
  }

  // Ask rosbridge for the full list of advertised topics. Fire-and-forget:
  // the response arrives as a service_response handled in the message loop.
  function requestTopicList() {
    if (!rosSocket || rosSocket.readyState !== WebSocket.OPEN) {
      return;
    }
    rosSocket.send(JSON.stringify({
      op: "call_service",
      id: TOPIC_LIST_CALL_ID,
      service: "/rosapi/topics",
    }));
  }

  function subscribe() {
    if (!rosSocket || rosSocket.readyState !== WebSocket.OPEN) {
      return;
    }

    if (!baseSubscribed) {
      sendTopicOps("subscribe", baseTopics);
      baseSubscribed = true;
    }
    if (lidarEnabled && !lidarSubscribed) {
      sendTopicOps("subscribe", lidarTopics);
      lidarSubscribed = true;
    }
  }

  function unsubscribe() {
    if (!rosSocket || rosSocket.readyState !== WebSocket.OPEN) {
      return;
    }

    if (baseSubscribed) {
      sendTopicOps("unsubscribe", baseTopics);
      baseSubscribed = false;
    }
    if (lidarSubscribed) {
      sendTopicOps("unsubscribe", lidarTopics);
      lidarSubscribed = false;
    }
  }

  function startLidar() {
    lidarEnabled = true;
    if (rosSocket?.readyState === WebSocket.OPEN && !lidarSubscribed) {
      sendTopicOps("subscribe", lidarTopics);
      lidarSubscribed = true;
    }
  }

  function stopLidar() {
    lidarEnabled = false;
    if (rosSocket?.readyState === WebSocket.OPEN && lidarSubscribed) {
      sendTopicOps("unsubscribe", lidarTopics);
    }
    lidarSubscribed = false;
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
      baseSubscribed = false;
      lidarSubscribed = false;
    }

    rosSocket = new WebSocket(rosbridgeUrl);

    rosSocket.on("open", () => {
      reconnectDelay = 1000; // reset backoff after successful connect
      connected = true;
      emit(getStatus());
      subscribe();
      requestTopicList();
    });

    rosSocket.on("message", (raw) => {
      try {
        const packet = JSON.parse(raw.toString());

        // Topic discovery (Faz 1): rosbridge answers /rosapi/topics with a
        // service_response. Surface the advertised topic names to the UI
        // without touching the fixed subscription set or the data flow.
        if (packet.op === "service_response" && packet.id === TOPIC_LIST_CALL_ID) {
          const topics = packet.values?.topics || [];
          const types = packet.values?.types || [];
          emit({
            type: "topic-list",
            source: "vehicle-ros",
            topics: topics.map((name, i) => ({ topic: name, type: types[i] || "" })),
          });
          return;
        }

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
      baseSubscribed = false;
      lidarSubscribed = false;
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
    baseSubscribed = false;
    lidarSubscribed = false;
    emit(getStatus());
  }

  return { getStatus, start, stop, startLidar, stopLidar };
}
