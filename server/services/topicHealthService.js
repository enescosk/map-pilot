// Per-topic health tracking + periodic snapshot emission.
//
// Responsibilities:
//   - Observe every envelope on the bus; record per-topic lastSeenMs, hit
//     count, and packet-kind summary.
//   - Track source connection state derived from "status" envelopes.
//   - Compute "stale" flags using per-kind TTLs.
//   - Emit a controlled-rate {type:"topic-health", topics, sources, time}
//     blob on the bus so the WS broadcaster forwards it to all clients.
//
// Lightweight by design. No persistence, no I/O beyond an interval timer.

import { telemetryBus, BUS_EVENTS } from "./telemetryBus.js";

const DEFAULT_TTL_MS = 5000;
const TTL_BY_KIND = Object.freeze({
  // Envelope `type` -> stale TTL in ms.
  telemetry: 1500,
  scan: 2000,
  "point-cloud": 2000,
  "camera-frame": 2000,
  "camera-stream": 5000,
  status: 10_000,
  "bag-status": 10_000,
  "bag-frame": 5000,
});

// Some envelopes carry sensor-class info but use the generic "telemetry"
// type — give them roomier TTLs based on topic substring.
const TOPIC_TTL_OVERRIDES = [
  { match: /imu/i, ttlMs: 3000 },
  { match: /navsat|gps/i, ttlMs: 3000 },
  { match: /odom/i, ttlMs: 3000 },
];

function ttlFor(kind, topic) {
  const lowerTopic = String(topic || "").toLowerCase();
  for (const override of TOPIC_TTL_OVERRIDES) {
    if (override.match.test(lowerTopic)) return override.ttlMs;
  }
  return TTL_BY_KIND[kind] ?? DEFAULT_TTL_MS;
}

export function createTopicHealthService({
  bus = telemetryBus,
  intervalMs = 1000,
  now = () => Date.now(),
} = {}) {
  const topics = new Map(); // topic -> { kind, lastSeenMs, hitCount, ttlMs, lastError, errorCount }
  const sources = new Map(); // sourceName -> { connected, lastStatusMs, topic }
  let timer;

  function recordEnvelope(envelope) {
    if (!envelope || typeof envelope !== "object") return;
    const kind = String(envelope.type || "");
    const topic = String(envelope.topic || "");
    const source = String(envelope.source || "");
    const t = now();

    if (kind === "status" && source) {
      sources.set(source, {
        connected: Boolean(envelope.connected),
        lastStatusMs: t,
        topic: envelope.topic || "",
      });
      return;
    }

    if (kind === "backend-error") {
      const key = topic || "__backend__";
      const entry = topics.get(key) || {
        kind: "error",
        lastSeenMs: 0,
        hitCount: 0,
        ttlMs: DEFAULT_TTL_MS,
        errorCount: 0,
      };
      entry.errorCount += 1;
      entry.lastError = envelope.message || "unknown";
      entry.lastSeenMs = t;
      topics.set(key, entry);
      return;
    }

    if (!topic) return;

    const entry = topics.get(topic) || {
      kind,
      lastSeenMs: 0,
      hitCount: 0,
      ttlMs: ttlFor(kind, topic),
      errorCount: 0,
    };
    entry.kind = kind || entry.kind;
    entry.ttlMs = ttlFor(entry.kind, topic);
    entry.lastSeenMs = t;
    entry.hitCount += 1;
    if (envelope.source) entry.sourceName = envelope.source;
    topics.set(topic, entry);
  }

  function recordInvalidFromPatch(payload) {
    if (!payload || !Array.isArray(payload.invalid) || payload.invalid.length === 0) return;
    const topic = payload?.meta?.sourceTopic;
    if (!topic) return;
    const entry = topics.get(topic);
    if (!entry) return;
    entry.invalidCount = (entry.invalidCount || 0) + payload.invalid.length;
    entry.lastInvalid = payload.invalid[payload.invalid.length - 1];
  }

  function buildSnapshot() {
    const t = now();
    const topicsOut = {};
    for (const [topic, entry] of topics.entries()) {
      const ageMs = t - entry.lastSeenMs;
      topicsOut[topic] = {
        kind: entry.kind,
        sourceName: entry.sourceName,
        lastSeenMs: entry.lastSeenMs,
        ageMs,
        ttlMs: entry.ttlMs,
        isStale: ageMs > entry.ttlMs,
        hitCount: entry.hitCount,
        errorCount: entry.errorCount || 0,
        invalidCount: entry.invalidCount || 0,
        lastError: entry.lastError,
        lastInvalid: entry.lastInvalid,
      };
    }
    const sourcesOut = {};
    for (const [name, entry] of sources.entries()) {
      sourcesOut[name] = { ...entry };
    }
    return {
      type: "topic-health",
      time: new Date(t).toISOString(),
      topics: topicsOut,
      sources: sourcesOut,
    };
  }

  function tick() {
    const snapshot = buildSnapshot();
    bus.emit(BUS_EVENTS.TOPIC_HEALTH, snapshot);
    bus.emit(BUS_EVENTS.ENVELOPE, snapshot);
  }

  function start() {
    if (timer) return;
    bus.on(BUS_EVENTS.ENVELOPE, recordEnvelope);
    bus.on(BUS_EVENTS.TELEMETRY_PATCH, recordInvalidFromPatch);
    timer = setInterval(tick, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  function stop() {
    if (!timer) return;
    bus.off(BUS_EVENTS.ENVELOPE, recordEnvelope);
    bus.off(BUS_EVENTS.TELEMETRY_PATCH, recordInvalidFromPatch);
    clearInterval(timer);
    timer = undefined;
  }

  function getSnapshot() {
    return buildSnapshot();
  }

  function reset() {
    topics.clear();
    sources.clear();
  }

  return { start, stop, getSnapshot, reset };
}

// Singleton convenience handle. Callers that want isolation (tests) create
// their own via createTopicHealthService().
export const topicHealthService = createTopicHealthService();
