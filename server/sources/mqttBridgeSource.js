import mqtt from "mqtt";

const MQTT_URL = process.env.MQTT_URL || "mqtt://localhost:1883";
const MQTT_TOPIC_ROOT = process.env.MQTT_TOPIC_ROOT || "map-pilot";

export function createMqttBridgeSource({ emit }) {
  let client;
  let connected = false;

  function getStatus() {
    return {
      type: "status",
      connected,
      source: "mqtt",
      topic: `${MQTT_TOPIC_ROOT}/events/#`,
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
      client.subscribe(`${MQTT_TOPIC_ROOT}/events/#`);
    });

    client.on("message", (_topic, payload) => {
      try {
        emit(JSON.parse(payload.toString()));
      } catch (error) {
        emit({
          type: "backend-error",
          message: `Invalid MQTT payload: ${error.message}`,
        });
      }
    });

    client.on("close", () => {
      connected = false;
      emit(getStatus());
    });

    client.on("error", (error) => {
      emit({
        type: "backend-error",
        message: `MQTT error: ${error.message}`,
      });
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

  return {
    getStatus,
    start,
    stop,
  };
}
