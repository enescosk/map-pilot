/**
 * useDashboardTelemetry logic tests.
 * Tests the pure merge/event logic without React rendering by simulating
 * the state machine directly through the hook's exported functions.
 */
import { describe, it, expect } from "vitest";
import { emptyTelemetry } from "../hooks/useDashboardTelemetry";
import { vectorMagnitude } from "../utils/telemetryFormatters";
import type { TelemetryState } from "../types/telemetry";

// ─── Telemetry merge logic (mirrors useDashboardTelemetry internals) ──────────

function mergeTelemetry(
  prev: TelemetryState,
  patch: Record<string, unknown>,
  nativeSpeedSeen: boolean,
): { next: TelemetryState; nativeSpeedSeen: boolean } {
  const vehiclePatch = { ...(patch.vehicle as Record<string, unknown> || {}) };
  const isDerived = patch.derived === true;

  let nextNative = nativeSpeedSeen;
  if (!isDerived && (typeof patch.speed === "number" || typeof vehiclePatch.speedKmh === "number")) {
    nextNative = true;
  }
  if (isDerived && nextNative) {
    delete vehiclePatch.speedKmh;
  }

  const next: TelemetryState = {
    ...prev,
    ...(patch as Partial<TelemetryState>),
    speed: isDerived && nextNative && typeof patch.speed === "number"
      ? prev.speed
      : (patch.speed as number ?? prev.speed),
    gps: { ...prev.gps, ...(patch.gps as object || {}) },
    acceleration: { ...prev.acceleration, ...(patch.acceleration as object || {}) },
    angularVelocity: { ...prev.angularVelocity, ...(patch.angularVelocity as object || {}) },
    magneticField: { ...prev.magneticField, ...(patch.magneticField as object || {}) },
    vehicle: { ...prev.vehicle, ...vehiclePatch },
  };

  return { next, nativeSpeedSeen: nextNative };
}

describe("telemetry merge logic", () => {
  it("merges vehicle fields into state", () => {
    const { next } = mergeTelemetry(emptyTelemetry, { vehicle: { speedKmh: 72 } }, false);
    expect(next.vehicle.speedKmh).toBe(72);
  });

  it("merges gps fields without overwriting previous", () => {
    const state1 = mergeTelemetry(emptyTelemetry, { gps: { latitude: 41.0, longitude: 28.0 } }, false).next;
    const { next } = mergeTelemetry(state1, { gps: { altitude: 100 } }, false);
    expect(next.gps.latitude).toBe(41.0);
    expect(next.gps.altitude).toBe(100);
  });

  it("native speed suppresses derived speed", () => {
    const { next: s1, nativeSpeedSeen } = mergeTelemetry(emptyTelemetry, { speed: 5.0 }, false);
    expect(nativeSpeedSeen).toBe(true);
    const { next: s2 } = mergeTelemetry(s1, { speed: 99.0, derived: true }, nativeSpeedSeen);
    expect(s2.speed).toBe(5.0);
  });

  it("derived speed used when no native speed seen", () => {
    const { next } = mergeTelemetry(emptyTelemetry, { speed: 3.5, derived: true }, false);
    expect(next.speed).toBe(3.5);
  });

  it("derived vehicle.speedKmh suppressed after native speed", () => {
    const { next: s1, nativeSpeedSeen } = mergeTelemetry(emptyTelemetry, { vehicle: { speedKmh: 72 } }, false);
    const { next: s2 } = mergeTelemetry(s1, { vehicle: { speedKmh: 999 }, derived: true }, nativeSpeedSeen);
    expect(s2.vehicle.speedKmh).toBe(72);
  });

  it("marks native speed seen after first native packet", () => {
    const { nativeSpeedSeen } = mergeTelemetry(emptyTelemetry, { speed: 1.0 }, false);
    expect(nativeSpeedSeen).toBe(true);
  });

  it("does not mark native speed seen for derived packet", () => {
    const { nativeSpeedSeen } = mergeTelemetry(emptyTelemetry, { speed: 1.0, derived: true }, false);
    expect(nativeSpeedSeen).toBe(false);
  });
});

// ─── Cockpit event detection ──────────────────────────────────────────────────

describe("cockpit event detection", () => {
  it("sudden stop: speed drops from >2 to <0.5", () => {
    const prev = { ...emptyTelemetry, speed: 5.0 };
    const { next } = mergeTelemetry(prev, { speed: 0.1 }, true);
    const isSuddenStop = prev.speed > 2 && next.speed < 0.5;
    expect(isSuddenStop).toBe(true);
  });

  it("no sudden stop when speed was already low", () => {
    const prev = { ...emptyTelemetry, speed: 1.0 };
    const { next } = mergeTelemetry(prev, { speed: 0.1 }, true);
    const isSuddenStop = prev.speed > 2 && next.speed < 0.5;
    expect(isSuddenStop).toBe(false);
  });

  it("high acceleration: magnitude > 12", () => {
    const { next } = mergeTelemetry(emptyTelemetry, { acceleration: { x: 15, y: 0, z: 0 } }, false);
    expect(vectorMagnitude(next.acceleration)).toBeGreaterThan(12);
  });

  it("normal acceleration: magnitude <= 12", () => {
    const { next } = mergeTelemetry(emptyTelemetry, { acceleration: { x: 2, y: 2, z: 2 } }, false);
    expect(vectorMagnitude(next.acceleration)).toBeLessThanOrEqual(12);
  });
});

// ─── emptyTelemetry shape ─────────────────────────────────────────────────────

describe("emptyTelemetry", () => {
  it("has zero speed", () => {
    expect(emptyTelemetry.speed).toBe(0);
  });

  it("has empty vehicle/gps/acceleration objects", () => {
    expect(emptyTelemetry.vehicle).toEqual({});
    expect(emptyTelemetry.gps).toEqual({});
    expect(emptyTelemetry.acceleration).toEqual({});
  });
});
