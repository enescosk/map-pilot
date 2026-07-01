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

// Per-topic field policy. This is a *safety gate* on the actuation values that
// leave the backend for the real vehicle — the topic/type whitelist alone lets
// through any payload (e.g. desired_angle: 9999). Each entry lists the only keys
// forwarded for that topic; unknown keys are dropped so a buggy/hostile frontend
// cannot inject arbitrary ROS fields. Field rules:
//   { min, max } — numeric: a non-finite value rejects the whole command; a
//                  finite value is clamped to the range (control stays responsive
//                  but bounded rather than dropping a frame mid-maneuver).
//   { enum: [...] } — discrete: value must be one of the listed integers, else
//                     the command is rejected (clamping a mode selection would be
//                     semantically wrong / unsafe).
//   {} — flag/boolean passthrough: key is allowed, value forwarded unchanged.
// Numeric bounds mirror server/schema/telemetry.js RANGE_GUARDS; raw CAN fields
// note their scale so the physical limit is auditable.
const CONTROL_FIELDS = {
  "/steer_control": {
    desired_angle:       { min: -720, max: 720 },  // deg
    desired_angle_speed: { min: 0,    max: 1000 }, // deg/s
  },
  "/brake_control": {
    brake_percent: { min: 0, max: 100 },
  },
  "/vcu_eps_control": {
    Target_Angle_st: { min: -720, max: 720 },  // deg
    Angle_speed_st:  { min: 0,    max: 1000 }, // deg/s
    VCU_EPSWorkMode: {},                        // flag passthrough
  },
  "/vcu_ehb_control": {
    VCU_BrkAimPressure: { min: 0, max: 1600 }, // raw ×0.125 -> 0..200 bar
    VCU_BrakingEnable:  { min: 0, max: 1 },
    VCU_VehicleSpeed:   { min: 0, max: 3000 }, // raw ×0.1 -> 0..300 km/h
  },
  "/throttle_control": {
    setSpeed_kmh: { min: 0, max: 300 },
    cruiseActive: {},                          // flag passthrough
  },
  "/autonomous_mode_selection": {
    mode: { enum: [0, 1, 2, 3] },              // Manual / Autonomous / Teleop / Emergency
  },
};

// Whitelist keys, reject non-finite/invalid actuation, clamp numerics to their
// safe range. Returns { ok, message } or { ok: false, reason }.
function sanitizeControlMessage(topic, message) {
  const spec = CONTROL_FIELDS[topic];
  if (!spec) return { ok: true, message: {} };
  const raw = message && typeof message === "object" ? message : {};
  const clean = {};
  for (const [key, rule] of Object.entries(spec)) {
    if (!(key in raw)) continue;
    const value = raw[key];

    if (rule.enum) {
      const n = Number(value);
      if (!Number.isInteger(n) || !rule.enum.includes(n)) {
        return { ok: false, reason: `${key}=${value} not one of [${rule.enum.join(",")}]` };
      }
      clean[key] = n;
      continue;
    }

    if (rule.min !== undefined || rule.max !== undefined) {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        return { ok: false, reason: `${key} must be a finite number (got ${value})` };
      }
      clean[key] = Math.min(rule.max, Math.max(rule.min, n));
      continue;
    }

    // Flag/boolean passthrough — allowed key, value forwarded unchanged.
    clean[key] = value;
  }
  return { ok: true, message: clean };
}

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

    const sanitized = sanitizeControlMessage(topic, message);
    if (!sanitized.ok) {
      return { ok: false, reason: sanitized.reason };
    }

    ensureClient();
    const mqttTopic = `${topicRoot}/control${topic}`;
    const envelope = {
      topic,
      type: expected,
      time: new Date().toISOString(),
      message: sanitized.message,
    };
    client.publish(mqttTopic, JSON.stringify(envelope), { qos: 1 });
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
