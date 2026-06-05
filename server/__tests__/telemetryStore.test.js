import { describe, it, expect, beforeEach } from "vitest";
import { telemetryStore } from "../services/telemetryStore.js";

const META = { sourceName: "test", sourceTopic: "/test" };

beforeEach(() => {
  telemetryStore.reset();
});

// ─── Basic merge ─────────────────────────────────────────────────────────────

describe("applyUpdate — basic merge", () => {
  it("writes a top-level scalar", () => {
    telemetryStore.applyUpdate({ speed: 5.0 }, META);
    expect(telemetryStore.getSnapshot().speed).toBeCloseTo(5.0);
  });

  it("writes a nested field", () => {
    telemetryStore.applyUpdate({ vehicle: { brakePercent: 40 } }, META);
    expect(telemetryStore.getSnapshot().vehicle.brakePercent).toBe(40);
  });

  it("updates sourceName and sourceTopic from meta", () => {
    telemetryStore.applyUpdate({}, { sourceName: "mqtt", sourceTopic: "/speed" });
    const snap = telemetryStore.getSnapshot();
    expect(snap.sourceName).toBe("mqtt");
    expect(snap.sourceTopic).toBe("/speed");
  });
});

// ─── Deep merge ──────────────────────────────────────────────────────────────

describe("applyUpdate — deep merge", () => {
  it("does not wipe sibling fields on a second patch", () => {
    telemetryStore.applyUpdate({ vehicle: { brakePercent: 40 } }, META);
    telemetryStore.applyUpdate({ vehicle: { steeringAngle: 15 } }, META);
    const snap = telemetryStore.getSnapshot();
    // Both must survive
    expect(snap.vehicle.brakePercent).toBe(40);
    expect(snap.vehicle.steeringAngle).toBe(15);
  });

  it("overwrites the same field on a second patch", () => {
    telemetryStore.applyUpdate({ speed: 3 }, META);
    telemetryStore.applyUpdate({ speed: 7 }, META);
    expect(telemetryStore.getSnapshot().speed).toBe(7);
  });

  it("treats { value, unit } objects as leaf values — does not recurse", () => {
    const leaf = { value: 9.81, unit: "m/s²" };
    telemetryStore.applyUpdate({ acceleration: leaf }, META);
    expect(telemetryStore.getSnapshot().acceleration).toEqual(leaf);
  });

  it("skips undefined values in the patch", () => {
    telemetryStore.applyUpdate({ speed: 5 }, META);
    telemetryStore.applyUpdate({ speed: undefined }, META);
    // undefined should be ignored; speed stays 5
    expect(telemetryStore.getSnapshot().speed).toBe(5);
  });
});

// ─── lastUpdateMs ────────────────────────────────────────────────────────────

describe("getLastUpdateMs", () => {
  it("returns a timestamp after an update", () => {
    const before = Date.now();
    telemetryStore.applyUpdate({ speed: 1 }, META);
    const ts = telemetryStore.getLastUpdateMs("speed");
    expect(ts).toBeGreaterThanOrEqual(0);
    // performance.now() is relative so we just check it's a non-negative number
    expect(typeof ts).toBe("number");
  });

  it("returns undefined for a field that has never been written", () => {
    expect(telemetryStore.getLastUpdateMs("vehicle.nonexistent")).toBeUndefined();
  });

  it("tracks nested paths", () => {
    telemetryStore.applyUpdate({ vehicle: { speedKmh: 60 } }, META);
    const ts = telemetryStore.getLastUpdateMs("vehicle.speedKmh");
    expect(typeof ts).toBe("number");
  });
});

// ─── Range validation ────────────────────────────────────────────────────────

describe("range validation", () => {
  it("flags out-of-range values in validity.invalid", () => {
    // brake percent > 100 is out of range
    telemetryStore.applyUpdate({ vehicle: { brake: { percent: 150 } } }, META);
    const invalid = telemetryStore.getSnapshot().validity.invalid;
    const entry = invalid.find((e) => e.field === "vehicle.brake.percent");
    expect(entry).toBeDefined();
    expect(entry.reason).toMatch(/out-of-range/);
  });

  it("does not flag in-range values", () => {
    telemetryStore.applyUpdate({ vehicle: { brake: { percent: 50 } } }, META);
    const invalid = telemetryStore.getSnapshot().validity.invalid;
    expect(invalid.find((e) => e.field === "vehicle.brake.percent")).toBeUndefined();
  });

  it("flags non-finite values", () => {
    telemetryStore.applyUpdate({ vehicle: { brake: { percent: NaN } } }, META);
    const invalid = telemetryStore.getSnapshot().validity.invalid;
    const entry = invalid.find((e) => e.field === "vehicle.brake.percent");
    expect(entry?.reason).toBe("not-finite");
  });

  it("validity.invalid is empty after a clean update", () => {
    telemetryStore.applyUpdate({ vehicle: { brake: { percent: 30 } } }, META);
    expect(telemetryStore.getSnapshot().validity.invalid).toHaveLength(0);
  });
});

// ─── Reset ───────────────────────────────────────────────────────────────────

describe("reset", () => {
  it("clears written fields", () => {
    telemetryStore.applyUpdate({ speed: 42, vehicle: { brakePercent: 20 } }, META);
    telemetryStore.reset();
    const snap = telemetryStore.getSnapshot();
    // Dynamic fields (speed, vehicle.brakePercent) are deleted; only empty-template keys remain
    expect(snap.speed).toBeUndefined();
    expect(snap.sourceName).toBe(""); // field that exists in createEmptyTelemetry
    expect(telemetryStore.getLastUpdateMs("speed")).toBeUndefined();
  });

  it("allows fresh writes after reset", () => {
    telemetryStore.applyUpdate({ speed: 10 }, META);
    telemetryStore.reset();
    telemetryStore.applyUpdate({ speed: 99 }, META);
    expect(telemetryStore.getSnapshot().speed).toBe(99);
  });
});

// ─── touched / fields tracking ────────────────────────────────────────────────

describe("validity.fields", () => {
  it("includes all paths that have ever been written", () => {
    telemetryStore.applyUpdate({ speed: 1, vehicle: { brakePercent: 2 } }, META);
    const { fields } = telemetryStore.getSnapshot().validity;
    expect(fields).toContain("speed");
    expect(fields).toContain("vehicle.brakePercent");
  });
});
