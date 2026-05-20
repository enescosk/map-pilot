// MQTT publisher.
//
// Subscribes to the in-process bus and forwards:
//   - every envelope to ${MQTT_TOPIC_ROOT}/events/<type>
//   - status envelopes to retained ${MQTT_TOPIC_ROOT}/vehicle/health
//   - canonical telemetry patches to structured ${MQTT_TOPIC_ROOT}/vehicle/<subsystem>
//     topics (speed, steering, brake, throttle, state) without re-parsing the
//     legacy envelope.
//
// Replaces the inline publishVehicleTelemetry block that used to live in
// server/index.js. Public MQTT topics are intentionally unchanged.

import mqtt from "mqtt";
import { telemetryBus, BUS_EVENTS } from "../services/telemetryBus.js";

const DEFAULT_URL = "mqtt://localhost:1883";
const DEFAULT_ROOT = "map-pilot";

function unwrapValue(maybe) {
  if (maybe === undefined || maybe === null) return undefined;
  if (typeof maybe === "object" && "value" in maybe) {
    return Number.isFinite(maybe.value) ? maybe.value : undefined;
  }
  return maybe;
}

function basePayload(meta) {
  return {
    source: meta?.sourceName || "unknown",
    sourceTopic: meta?.sourceTopic || "",
    time: meta?.sensorTimestamp || "",
    publishedAt: new Date().toISOString(),
  };
}

function publishCanonicalPatch(client, root, payload) {
  const { patch, meta } = payload;
  if (!client?.connected || !patch || !patch.vehicle) return;

  const v = patch.vehicle;
  const base = basePayload(meta);

  const speedMps = unwrapValue(v.speedMps);
  const speedKmh = unwrapValue(v.speedKmh);
  if (speedMps !== undefined || speedKmh !== undefined) {
    client.publish(
      `${root}/vehicle/speed`,
      JSON.stringify({
        ...base,
        speedMps,
        speedKmh: speedKmh ?? (speedMps !== undefined ? Number((speedMps * 3.6).toFixed(2)) : undefined),
      }),
    );
  }

  const steeringAngle = unwrapValue(v.steeringAngleDeg);
  const targetSteeringAngle = unwrapValue(v.targetSteeringAngleDeg);
  const steeringSpeed = unwrapValue(v.steeringSpeedDegPerSec);
  const steeringTorque = unwrapValue(v.steeringTorqueNm);
  if (
    steeringAngle !== undefined
    || targetSteeringAngle !== undefined
    || steeringSpeed !== undefined
    || steeringTorque !== undefined
  ) {
    client.publish(
      `${root}/vehicle/steering`,
      JSON.stringify({
        ...base,
        steeringAngle,
        targetSteeringAngle,
        steeringSpeed,
        steeringTorque,
      }),
    );
  }

  if (v.brake) {
    const b = v.brake;
    client.publish(
      `${root}/vehicle/brake`,
      JSON.stringify({
        ...base,
        brakePressure: b.pressureBar,
        targetBrakePressure: b.targetPressureBar,
        brakePercent: b.percent,
        parkingBrake: b.parking,
        brakeSystemActive: b.active,
        brakeFaultLevel: b.faultLevel,
      }),
    );
  }

  if (v.throttle) {
    const t = v.throttle;
    client.publish(
      `${root}/vehicle/throttle`,
      JSON.stringify({
        ...base,
        kind: t.kind,
        setSpeedKmh: t.setSpeedKmh,
        targetSpeedKmh: t.targetSpeedKmh,
        pedalPercent: t.pedalPercent,
        cruiseActive: t.cruiseActive,
      }),
    );
  }

  if (v.state) {
    const s = v.state;
    client.publish(
      `${root}/vehicle/state`,
      JSON.stringify({
        ...base,
        mode: s.mode,
        gear: s.gear,
        ignition: s.ignition,
        emergency: s.emergency,
        handbrake: s.handbrake,
        leftSignal: s.leftSignal,
        rightSignal: s.rightSignal,
        batterySoc: s.batterySoc,
        batteryVoltage: s.batteryVoltage,
      }),
      { retain: true },
    );
  }
}

function publishEventsAndHealth(client, root, envelope) {
  if (!client?.connected || !envelope || typeof envelope !== "object") return;
  const eventType = typeof envelope.type === "string" ? envelope.type : "message";
  client.publish(`${root}/events/${eventType}`, JSON.stringify(envelope));

  if (envelope.type === "status") {
    client.publish(
      `${root}/vehicle/health`,
      JSON.stringify({
        connected: Boolean(envelope.connected),
        source: envelope.source || "unknown",
        topic: envelope.topic || "",
        publishedAt: new Date().toISOString(),
      }),
      { retain: true },
    );
  }
}

export function createMqttPublisher({
  url = process.env.MQTT_URL || DEFAULT_URL,
  topicRoot = process.env.MQTT_TOPIC_ROOT || DEFAULT_ROOT,
  enabled = process.env.MQTT_PUBLISH === "true",
  bus = telemetryBus,
  logger = console,
} = {}) {
  let client;
  let started = false;

  function onEnvelope(envelope) { publishEventsAndHealth(client, topicRoot, envelope); }
  function onPatch(payload)     { publishCanonicalPatch(client, topicRoot, payload); }

  function start() {
    if (!enabled || started) return;
    started = true;
    client = mqtt.connect(url, {
      clientId: `map-pilot-vehicle-${Math.random().toString(16).slice(2)}`,
      reconnectPeriod: 1000,
    });
    client.on("connect", () => logger.log?.(`MQTT publisher connected to ${url}`));
    client.on("error", (err) => logger.error?.("MQTT publisher error:", err.message));
    bus.on(BUS_EVENTS.ENVELOPE, onEnvelope);
    bus.on(BUS_EVENTS.TELEMETRY_PATCH, onPatch);
  }

  function stop() {
    if (!started) return;
    started = false;
    bus.off(BUS_EVENTS.ENVELOPE, onEnvelope);
    bus.off(BUS_EVENTS.TELEMETRY_PATCH, onPatch);
    if (client) {
      client.end(true);
      client = undefined;
    }
  }

  function getClient() { return client; }

  return { start, stop, getClient, enabled, topicRoot };
}
