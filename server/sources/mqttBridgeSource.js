import mqtt from "mqtt";
import { normalizeFrame } from "../normalizers/index.js";
import { rosTimeToString } from "../normalizers/helpers.js";

const MQTT_URL = process.env.MQTT_URL || "mqtt://localhost:1883";
const MQTT_TOPIC_ROOT = process.env.MQTT_TOPIC_ROOT || "map-pilot";
const MQTT_EVENTS_TOPIC = `${MQTT_TOPIC_ROOT}/events/#`;
const MQTT_RAW_TOPICS = (process.env.MQTT_RAW_TOPICS || `${MQTT_TOPIC_ROOT}/raw/#`)
  .split(",")
  .map((topic) => topic.trim())
  .filter(Boolean);

function topicFromRawMqttTopic(mqttTopic) {
  const rawPrefix = `${MQTT_TOPIC_ROOT}/raw`;
  if (mqttTopic === rawPrefix) {
    return "unknown";
  }
  if (mqttTopic.startsWith(`${rawPrefix}/`)) {
    return `/${mqttTopic.slice(rawPrefix.length + 1)}`;
  }
  return mqttTopic;
}

export function createMqttBridgeSource({ emit }) {
  let client;
  let connected = false;

  function getStatus() {
    return {
      type: "status",
      connected,
      source: "mqtt",
      topic: [MQTT_EVENTS_TOPIC, ...MQTT_RAW_TOPICS].join(", "),
    };
  }

  function start() {
    if (client) {
      return;
    }

    client = mqtt.connect(MQTT_URL, {
      clientId: `map-pilot-dashboard-${Math.random().toString(16).slice(2)}`,
      reconnectPeriod: 1000,
    });

    client.on("connect", () => {
      connected = true;
      emit(getStatus());
      client.subscribe([MQTT_EVENTS_TOPIC, ...MQTT_RAW_TOPICS]);
    });

    client.on("message", (topic, payload) => {
      try {
        const parsed = JSON.parse(payload.toString());
        if (topic.startsWith(`${MQTT_TOPIC_ROOT}/events/`)) {
          emit(parsed);
          return;
        }

        const message = parsed.message || parsed.msg || parsed.payload || parsed;
        const normalized = normalizeFrame({
          topic: parsed.topic || topicFromRawMqttTopic(topic),
          type: parsed.type || parsed.msgType || parsed.messageType || parsed._type || message?._type || "",
          time: parsed.time || parsed.timestamp || rosTimeToString(message?.header?.stamp),
          source: "mqtt",
          message,
        });
        emit(normalized);
      } catch (error) {
        emit({ type: "backend-error", message: `Invalid MQTT payload: ${error.message}` });
      }
    });

    client.on("close", () => {
      connected = false;
      emit(getStatus());
    });

    client.on("error", (error) => {
      emit({ type: "backend-error", message: `MQTT error: ${error.message}` });
    });
  }

  function stop() {
    if (!client) {
      return;
    }

    client.end(true);
    client = undefined;
    connected = false;
    emit(getStatus());
  }

  return { getStatus, start, stop };
}
