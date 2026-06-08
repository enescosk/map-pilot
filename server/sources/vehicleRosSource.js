import WebSocket from "ws";
import { normalizeFrame } from "../normalizers/index.js";
import { rosTimeToString } from "../normalizers/helpers.js";

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
];
export const LIVE_ROS_TOPICS = (process.env.LIVE_ROS_TOPICS || process.env.VEHICLE_TOPICS || DEFAULT_LIVE_ROS_TOPICS.join(","))
  .split(",")
  .map((topic) => topic.trim())
  .filter(Boolean);

// rosbridge_server v0.11+ omits msg._type. We infer it from the topic name
// shape so normalizers can dispatch correctly without an extra service round-trip.
function inferRosTypeFromTopic(topic, msg) {
  const t = topic.toLowerCase();
  if (t.includes("compressed") && !t.includes("depth")) return "sensor_msgs/CompressedImage";
  if (t.includes("image_raw") || /\/image(?!_rect)/.test(t) || (msg?.width && msg?.height && msg?.encoding)) return "sensor_msgs/Image";
  if (t.endsWith("/scan") || t.includes("laser_scan")) return "sensor_msgs/LaserScan";
  if (t.includes("rslidar_points") || t.includes("point_cloud") || t === "/cloud" || t.endsWith("/cloud")) return "sensor_msgs/PointCloud2";
  if (t.includes("/odom") || t.includes("odometry")) return "nav_msgs/Odometry";
  if (t.includes("imu/data")) return "sensor_msgs/Imu";
  if (t === "/navsatfix" || t.includes("navsat")) return "sensor_msgs/NavSatFix";
  if (t === "/heading") return "std_msgs/Float64";
  if (t.endsWith("/velocityinformation")) return "dbw_interface/VelocityInformation";
  if (t.endsWith("/eps_response")) return "dbw_interface/EPS_Response";
  if (t.endsWith("/ehb_brakingresponse")) return "dbw_interface/EHB_BrakingResponse";
  if (t.endsWith("/fb_motor_driver_report")) return "dbw_interface/FB_MotorDriver";
  if (t.endsWith("/autonomous_report")) return "dbw_interface/AutonomousHeardBit";
  if (t.endsWith("/rc_unit_report")) return "dbw_interface/FB_OMUX_to_AUTONOMOUS";
  if (t.endsWith("/throttle_control")) return "dbw_interface/CruiseControlSignals";
  if (t.endsWith("/vcu_eps_control")) return "dbw_interface/VCU_EPS_Control";
  if (t.endsWith("/vcu_ehb_control")) return "dbw_interface/VCU_EHB_Control";
  if (t.endsWith("/steer_control")) return "dbw_interface/SteerControl";
  if (t.endsWith("/brake_control")) return "dbw_interface/BrakeControl";
  if (t.endsWith("/autonomous_mode_selection")) return "dbw_interface/VehicleMode";
  return "";
}

export function createVehicleRosSource({ emit, url } = {}) {
  const rosbridgeUrl = url || process.env.ROSBRIDGE_URL || ROSBRIDGE_URL;
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

  function emitTopicList() {
    emit({
      type: "bag-status",
      connected: true,
      playing: true,
      source: "vehicle-ros",
      path: "",
      frameCount: 0,
      cursor: 0,
      topics: LIVE_ROS_TOPICS.map((t) => ({ topic: t, type: "", count: 0 })),
      currentTime: "",
      startTime: "",
      endTime: "",
      durationSeconds: 0,
    });
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
    emitTopicList();
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
    // Idempotent: already connected / connecting → just (re-)subscribe and bail.
    if (rosSocket) {
      if (rosSocket.readyState === WebSocket.OPEN) {
        subscribe();
        return;
      }
      if (rosSocket.readyState === WebSocket.CONNECTING) {
        // Still negotiating — do nothing, the existing "open" handler will subscribe.
        return;
      }
      // Stale socket in CLOSING/CLOSED — detach listeners so its trailing
      // events don't clobber the new instance's state, then drop the reference.
      try { rosSocket.removeAllListeners(); } catch { /* noop */ }
      try { rosSocket.close(); } catch { /* noop */ }
      rosSocket = undefined;
      subscribed = false;
    }

    const socket = new WebSocket(rosbridgeUrl);
    rosSocket = socket;

    socket.on("open", () => {
      // Guard: if we got replaced by a newer start() call, do nothing.
      if (socket !== rosSocket) return;
      connected = true;
      emit(getStatus());
      subscribe();
    });

    socket.on("message", (raw) => {
      if (socket !== rosSocket) return;
      try {
        const packet = JSON.parse(raw.toString());
        if (packet.op !== "publish" || !packet.topic || !packet.msg) {
          return;
        }

        const inferredType = packet.msg._type || inferRosTypeFromTopic(packet.topic, packet.msg);

        const normalized = normalizeFrame({
          topic: packet.topic,
          type: inferredType,
          time: rosTimeToString(packet.msg.header?.stamp),
          source: "vehicle-ros",
          message: packet.msg,
        });

        emit(normalized);
      } catch (error) {
        emit({ type: "backend-error", message: `Invalid vehicle ROS packet: ${error.message}` });
      }
    });

    socket.on("close", () => {
      // Old/replaced socket closing — don't touch shared state.
      if (socket !== rosSocket) return;
      connected = false;
      subscribed = false;
      emit(getStatus());
    });

    socket.on("error", (error) => {
      // Suppress "closed before established" for sockets that were already
      // replaced by a newer start() — those are expected lifecycle events,
      // not user-visible errors.
      if (socket !== rosSocket) return;
      const message = String(error?.message || error);
      if (/closed before the connection was established/i.test(message)) {
        // Connection attempt aborted by us — swallow.
        return;
      }
      emit({ type: "backend-error", message: `Vehicle ROS bridge error: ${message}` });
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
