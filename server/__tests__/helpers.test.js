import { describe, it, expect } from "vitest";
import {
  numberOrUndefined,
  scaledNumberOrUndefined,
  timeToSeconds,
  rosTimeToString,
} from "../normalizers/helpers.js";

describe("numberOrUndefined", () => {
  it("returns the number for valid integers", () => {
    expect(numberOrUndefined(42)).toBe(42);
    expect(numberOrUndefined(0)).toBe(0);
    expect(numberOrUndefined(-7)).toBe(-7);
  });

  it("parses numeric strings", () => {
    expect(numberOrUndefined("3.14")).toBeCloseTo(3.14);
    expect(numberOrUndefined("0")).toBe(0);
  });

  it("returns undefined for non-finite values", () => {
    expect(numberOrUndefined(undefined)).toBeUndefined();
    expect(numberOrUndefined(NaN)).toBeUndefined();
    expect(numberOrUndefined(Infinity)).toBeUndefined();
    expect(numberOrUndefined(-Infinity)).toBeUndefined();
  });

  // Number(null) === 0 and Number("") === 0, both finite — function returns 0.
  // Callers that need to distinguish "missing" from "zero" must check upstream.
  it("returns 0 for null and empty string (Number coercion edge cases)", () => {
    expect(numberOrUndefined(null)).toBe(0);
    expect(numberOrUndefined("")).toBe(0);
  });

  it("returns undefined for non-numeric strings", () => {
    expect(numberOrUndefined("abc")).toBeUndefined();
  });
});

describe("scaledNumberOrUndefined", () => {
  it("scales by the given factor", () => {
    expect(scaledNumberOrUndefined(100, 0.01)).toBeCloseTo(1.0);
    expect(scaledNumberOrUndefined(4096, 0.125)).toBeCloseTo(512);
  });

  it("rounds to 3 decimal places", () => {
    // 1 * 0.01 → 0.010 (exact)
    expect(scaledNumberOrUndefined(1, 0.01)).toBe(0.01);
    // 7 * 0.1 → 0.700 (no floating-point accumulation)
    expect(scaledNumberOrUndefined(7, 0.1)).toBe(0.7);
  });

  it("returns undefined when the value is undefined", () => {
    expect(scaledNumberOrUndefined(undefined, 0.01)).toBeUndefined();
  });

  // null coerces to 0 via numberOrUndefined, so scaled result is 0, not undefined
  it("returns 0 for null input (null coerces to 0)", () => {
    expect(scaledNumberOrUndefined(null, 2)).toBe(0);
  });

  it("returns undefined when the value is NaN", () => {
    expect(scaledNumberOrUndefined(NaN, 0.1)).toBeUndefined();
  });
});

describe("timeToSeconds", () => {
  it("converts ROS time objects", () => {
    expect(timeToSeconds({ sec: 10, nsec: 500_000_000 })).toBeCloseTo(10.5);
  });

  it("handles plain number input", () => {
    expect(timeToSeconds(5)).toBe(5);
  });

  it("returns 0 for missing/invalid input", () => {
    expect(timeToSeconds(undefined)).toBe(0);
    expect(timeToSeconds(null)).toBe(0);
    expect(timeToSeconds({})).toBe(0);
  });
});

describe("rosTimeToString", () => {
  it("returns an ISO string for a valid stamp", () => {
    const result = rosTimeToString({ sec: 1_700_000_000, nsec: 0 });
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("falls back to current time for missing stamp", () => {
    const before = Date.now();
    const result = rosTimeToString(null);
    const after = Date.now();
    const ts = new Date(result).getTime();
    expect(ts).toBeGreaterThanOrEqual(before - 5);
    expect(ts).toBeLessThanOrEqual(after + 5);
  });
});
