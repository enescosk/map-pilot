import { describe, it, expect } from "vitest";
import { mpsToKmh, kmhToMps, radToDeg, degToRad } from "../mapping/units.js";

describe("mpsToKmh", () => {
  it("converts 1 m/s to 3.6 km/h", () => {
    expect(mpsToKmh(1)).toBeCloseTo(3.6);
  });

  it("converts 0 to 0", () => {
    expect(mpsToKmh(0)).toBe(0);
  });

  it("returns undefined for NaN/Infinity", () => {
    expect(mpsToKmh(NaN)).toBeUndefined();
    expect(mpsToKmh(Infinity)).toBeUndefined();
    expect(mpsToKmh("abc")).toBeUndefined();
  });
});

describe("kmhToMps", () => {
  it("converts 3.6 km/h to 1 m/s", () => {
    expect(kmhToMps(3.6)).toBeCloseTo(1.0);
  });

  it("converts 0 to 0", () => {
    expect(kmhToMps(0)).toBe(0);
  });

  it("returns undefined for NaN/Infinity", () => {
    expect(kmhToMps(NaN)).toBeUndefined();
    expect(kmhToMps(Infinity)).toBeUndefined();
  });

  it("is inverse of mpsToKmh", () => {
    expect(kmhToMps(mpsToKmh(5))).toBeCloseTo(5);
  });
});

describe("radToDeg", () => {
  it("converts PI to 180", () => {
    expect(radToDeg(Math.PI)).toBeCloseTo(180);
  });

  it("converts 0 to 0", () => {
    expect(radToDeg(0)).toBe(0);
  });

  it("returns undefined for NaN", () => {
    expect(radToDeg(NaN)).toBeUndefined();
    expect(radToDeg(Infinity)).toBeUndefined();
  });
});

describe("degToRad", () => {
  it("converts 180 to PI", () => {
    expect(degToRad(180)).toBeCloseTo(Math.PI);
  });

  it("converts 0 to 0", () => {
    expect(degToRad(0)).toBe(0);
  });

  it("returns undefined for NaN", () => {
    expect(degToRad(NaN)).toBeUndefined();
    expect(degToRad(Infinity)).toBeUndefined();
  });

  it("is inverse of radToDeg", () => {
    expect(degToRad(radToDeg(1.5))).toBeCloseTo(1.5);
  });
});
