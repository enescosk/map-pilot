import WebSocket from "ws";
import { normalizeFrame } from "../normalizers/index.js";
import { rosTimeToString } from "../normalizers/helpers.js";

const ROSBRIDGE_URL = process.env.ROSBRIDGE_URL || "ws://localhost:9090";
const DEFAULT_LIVE_ROS_TOPICS = [
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
  "/imu/data",
  "/zed2i/zed_node/imu/data",
  "/ekf/odometry_earth",
  "/zed2i/zed_node/odom",
  "/heading",
  "/navsatfix",
];
const LIVE_ROS_TOPICS = (process.env.LIVE_ROS_TOPICS || process.env.VEHICLE_TOPICS || DEFAULT_LIVE_ROS_TOPICS.join(","))
  .split(",")
  .map((topic) => topic.trim())
  .filter(Boolean);

export function createVehicleRosSource({ emit }) {
  let rosSocket;
  let connected = false;
  let subscribed = false;

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
    if (rosSocket && rosSocket.readyState <= WebSocket.OPEN) {
      subscribe();
      return;
    }

    rosSocket = new WebSocket(ROSBRIDGE_URL);

    rosSocket.on("open", () => {
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

        const normalized = normalizeFrame({
          topic: packet.topic,
          type: packet.msg._type || "",
          time: rosTimeToString(packet.msg.header?.stamp),
          source: "vehicle-ros",
          message: packet.msg,
        });

        emit(normalized);
      } catch (error) {
        emit({ type: "backend-error", message: `Invalid vehicle ROS packet: ${error.message}` });
      }
    });

    rosSocket.on("close", () => {
      connected = false;
      subscribed = false;
      emit(getStatus());
    });

    rosSocket.on("error", (error) => {
      emit({ type: "backend-error", message: `Vehicle ROS bridge error: ${error.message}` });
    });
  }

  function stop() {
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
