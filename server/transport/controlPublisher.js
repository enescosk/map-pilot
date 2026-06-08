// Control publisher.
//
// Forwards control commands the dashboard sends over WebSocket to MQTT, where
// the vehicle-side `mqtt_to_ros` bridge republishes them on the real ROS
// topics.
//
// Frontend → backend WS:
//   { type: "control-command", topic: "/steer_control",
//     msgType: "beemobs_routine_manager/SteerControl",
//     message: { desired_angle: 15.0, desired_angle_speed: 3.0 } }
//
// Backend → MQTT (consumed by mqtt_to_ros.py on the vehicle computer):
//   topic:   map-pilot/control/steer_control
//   payload: { topic, type, message, time }

import mqtt from "mqtt";

const DEFAULT_URL = "mqtt://localhost:1883";
const DEFAULT_ROOT = "map-pilot";

// Topic ↔ message-type whitelist. Must match the reverse bridge's ALLOWED dict
// in ros_bridge/mqtt_bridge/scripts/mqtt_to_ros.py.
const ALLOWED = {
  "/throttle_control":          "dbw_interface/CruiseControlSignals",
  "/vcu_eps_control":           "dbw_interface/VCU_EPS_Control",
  "/vcu_ehb_control":           "dbw_interface/VCU_EHB_CONTROL",
  "/steer_control":             "beemobs_routine_manager/SteerControl",
  "/brake_control":             "beemobs_routine_manager/BrakeControl",
  "/autonomous_mode_selection": "beemobs_routine_manager/VehicleMode",
};

export function createControlPublisher({
  url = process.env.MQTT_CONTROL_URL || process.env.MQTT_URL || DEFAULT_URL,
  topicRoot = process.env.MQTT_TOPIC_ROOT || DEFAULT_ROOT,
  logger = console,
} = {}) {
  let client;
  let connected = false;

  function ensureClient() {
    if (client) return;
    client = mqtt.connect(url, {
      clientId: `map-pilot-control-${Math.random().toString(16).slice(2)}`,
      reconnectPeriod: 1000,
    });
    client.on("connect", () => {
      connected = true;
      logger.log?.(`Control publisher connected to ${url}`);
    });
    client.on("close", () => { connected = false; });
    client.on("error", (err) => logger.error?.("Control publisher error:", err.message));
  }

  function publish({ topic, msgType, message }) {
    if (!topic || !ALLOWED[topic]) {
      return { ok: false, reason: `topic ${topic} not allowed` };
    }
    const expected = ALLOWED[topic];
    const resolvedType = msgType || expected;
    if (resolvedType !== expected) {
      return { ok: false, reason: `msgType ${msgType} != expected ${expected}` };
    }

    ensureClient();
    const mqttTopic = `${topicRoot}/control${topic}`;
    const envelope = {
      topic,
      type: expected,
      time: new Date().toISOString(),
      message: message || {},
    };
    client.publish(mqttTopic, JSON.stringify(envelope));
    return { ok: true, mqttTopic };
  }

  function stop() {
    if (client) {
      client.end(true);
      client = undefined;
      connected = false;
    }
  }

  return { publish, stop, isConnected: () => connected, allowed: ALLOWED };
}
