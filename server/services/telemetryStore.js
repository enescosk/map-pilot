// In-memory canonical telemetry store.
//
// Phase-3 responsibilities:
//   - Deep-merge per-topic patches into a single canonical object.
//   - Track per-leaf lastUpdateMs (used by Phase-4 staleness service).
//   - Run range-guard validation; record offenders in validity.invalid without
//     dropping them.
//
// NOT in Phase 3: staleness ticker, snapshot subscription. The store exposes
// `getSnapshot()` so a future bus layer can fan out without re-deriving state.

import { createEmptyTelemetry, RANGE_GUARDS } from "../schema/telemetry.js";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function deepMerge(target, patch, pathPrefix, touched) {
  for (const [key, value] of Object.entries(patch)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (value === undefined) continue;
    const path = pathPrefix ? `${pathPrefix}.${key}` : key;

    if (isPlainObject(value) && !isValueWithUnit(value)) {
      if (!isPlainObject(target[key])) {
        target[key] = {};
      }
      deepMerge(target[key], value, path, touched);
      continue;
    }

    target[key] = value;
    touched.push(path);
  }
}

function isValueWithUnit(value) {
  return (
    isPlainObject(value)
    && Object.prototype.hasOwnProperty.call(value, "value")
    && Object.prototype.hasOwnProperty.call(value, "unit")
  );
}

function validate(stored, touchedPaths) {
  const invalid = [];
  for (const path of touchedPaths) {
    const guard = RANGE_GUARDS[path];
    if (!guard) continue;
    const raw = readPath(stored, path);
    const numeric = isValueWithUnit(raw) ? raw.value : raw;
    if (typeof numeric !== "number" || !Number.isFinite(numeric)) {
      invalid.push({ field: path, reason: "not-finite" });
      continue;
    }
    if (numeric < guard.min || numeric > guard.max) {
      invalid.push({ field: path, reason: `out-of-range[${guard.min},${guard.max}]` });
    }
  }
  return invalid;
}

function readPath(obj, path) {
  return path.split(".").reduce((acc, key) => {
    if (acc == null || FORBIDDEN_KEYS.has(key)) return undefined;
    return acc[key];
  }, obj);
}

function createStore() {
  const state = createEmptyTelemetry();
  const lastUpdateMs = new Map();

  function applyUpdate(patch, meta) {
    const now = (typeof performance !== "undefined" && performance.now)
      ? Math.round(performance.now())
      : Date.now();
    const touched = [];

    deepMerge(state, patch, "", touched);

    state.sourceName = meta.sourceName || state.sourceName;
    state.sourceTopic = meta.sourceTopic || state.sourceTopic;
    state.monoTimestampMs = now;
    state.sensorTimestamp = meta.sensorTimestamp || state.sensorTimestamp;

    for (const path of touched) {
      lastUpdateMs.set(path, now);
    }

    const invalid = validate(state, touched);
    state.validity.invalid = invalid;
    state.validity.fields = Array.from(lastUpdateMs.keys());

    return { stored: state, touched, invalid };
  }

  function getSnapshot() {
    return state;
  }

  function getLastUpdateMs(path) {
    return lastUpdateMs.get(path);
  }

  function reset() {
    // Delete all existing keys before re-applying empty state, otherwise
    // dynamically-added fields (e.g. speed, vehicle.*) survive the reset.
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, createEmptyTelemetry());
    lastUpdateMs.clear();
  }

  return { applyUpdate, getSnapshot, getLastUpdateMs, reset };
}

// A single module-scoped store is fine for Phase 3 (one source instance at a
// time). When parallel sources arrive, swap this for an instance-per-source
// model created by a service factory.
export const telemetryStore = createStore();
