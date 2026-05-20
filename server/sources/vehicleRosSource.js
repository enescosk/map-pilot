import WebSocket from "ws";
import { normalizeFrame } from "../normalizers/index.js";
import { rosTimeToString } from "../normalizers/helpers.js";

const ROSBRIDGE_URL = process.env.ROSBRIDGE_URL || "ws://localhost:9090";
const VEHICLE_TOPICS = (process.env.VEHICLE_TOPICS || [
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
  "/rslidar_points",
  "/imu/data",
  "/navsatfix",
].join(","))
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
      topic: VEHICLE_TOPICS.join(", "),
    };
  }

  function subscribe() {
    if (!rosSocket || rosSocket.readyState !== WebSocket.OPEN || subscribed) {
      return;
    }

    for (const topic of VEHICLE_TOPICS) {
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

    for (const topic of VEHICLE_TOPICS) {
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
          message: packet.msg,
        });

        normalized.source = "vehicle-ros";
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
