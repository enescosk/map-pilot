import { describe, it, expect } from "vitest";
import {
  vectorMagnitude,
  formatNumber,
  formatDuration,
  formatFileSize,
  formatBoolean,
  formatGear,
} from "../utils/telemetryFormatters";
import { timeStringToSeconds, timeLabel } from "../utils/timeLabel";

// ─── vectorMagnitude ──────────────────────────────────────────────────────────

describe("vectorMagnitude", () => {
  it("returns 0 for undefined/empty vector", () => {
    expect(vectorMagnitude(undefined)).toBe(0);
    expect(vectorMagnitude({})).toBe(0);
  });

  it("calculates 3D magnitude", () => {
    expect(vectorMagnitude({ x: 3, y: 4, z: 0 })).toBeCloseTo(5.0);
    expect(vectorMagnitude({ x: 1, y: 1, z: 1 })).toBeCloseTo(Math.sqrt(3));
  });

  it("treats missing axes as 0", () => {
    expect(vectorMagnitude({ x: 5 })).toBeCloseTo(5.0);
  });
});

// ─── formatNumber ─────────────────────────────────────────────────────────────

describe("formatNumber", () => {
  it("formats to 2 decimal places by default", () => {
    expect(formatNumber(3.14159)).toBe("3.14");
  });

  it("respects digits parameter", () => {
    expect(formatNumber(3.14159, 0)).toBe("3");
    expect(formatNumber(3.14159, 4)).toBe("3.1416");
  });

  it("returns -- for undefined/NaN/Infinity", () => {
    expect(formatNumber(undefined)).toBe("--");
    expect(formatNumber(NaN)).toBe("--");
    expect(formatNumber(Infinity)).toBe("--");
  });

  it("formats 0 correctly", () => {
    expect(formatNumber(0)).toBe("0.00");
  });

  it("formats negative numbers", () => {
    expect(formatNumber(-5.5, 1)).toBe("-5.5");
  });
});

// ─── formatDuration ───────────────────────────────────────────────────────────

describe("formatDuration", () => {
  it("formats 0 seconds", () => {
    expect(formatDuration(0)).toBe("00:00");
  });

  it("formats 90 seconds as 01:30", () => {
    expect(formatDuration(90)).toBe("01:30");
  });

  it("formats 3600 seconds as 60:00", () => {
    expect(formatDuration(3600)).toBe("60:00");
  });

  it("returns 00:00 for undefined/NaN", () => {
    expect(formatDuration(undefined)).toBe("00:00");
    expect(formatDuration(NaN)).toBe("00:00");
  });

  it("clamps negative values to 00:00", () => {
    expect(formatDuration(-10)).toBe("00:00");
  });
});

// ─── formatFileSize ───────────────────────────────────────────────────────────

describe("formatFileSize", () => {
  it("formats bytes as KB", () => {
    expect(formatFileSize(2048)).toBe("2 KB");
  });

  it("formats as MB", () => {
    expect(formatFileSize(5 * 1_048_576)).toBe("5.0 MB");
  });

  it("formats as GB", () => {
    expect(formatFileSize(2 * 1_073_741_824)).toBe("2.0 GB");
  });

  it("handles 0 and undefined", () => {
    expect(formatFileSize(0)).toBe("0 KB");
    expect(formatFileSize(undefined)).toBe("0 KB");
  });
});

// ─── formatBoolean ────────────────────────────────────────────────────────────

describe("formatBoolean", () => {
  it("returns On/Off for booleans", () => {
    expect(formatBoolean(true)).toBe("On");
    expect(formatBoolean(false)).toBe("Off");
  });

  it("returns -- for non-boolean", () => {
    expect(formatBoolean(undefined)).toBe("--");
    expect(formatBoolean(1 as unknown as boolean)).toBe("--");
  });
});

// ─── formatGear ───────────────────────────────────────────────────────────────

describe("formatGear", () => {
  it("maps 0→N, 1→D, 2→R", () => {
    expect(formatGear(0)).toBe("N");
    expect(formatGear(1)).toBe("D");
    expect(formatGear(2)).toBe("R");
  });

  it("stringifies other finite values", () => {
    expect(formatGear(5)).toBe("5");
  });

  it("returns -- for undefined/NaN", () => {
    expect(formatGear(undefined)).toBe("--");
    expect(formatGear(NaN)).toBe("--");
  });
});

// ─── timeStringToSeconds ──────────────────────────────────────────────────────

describe("timeStringToSeconds", () => {
  it("returns 0 for undefined/null/empty", () => {
    expect(timeStringToSeconds(undefined)).toBe(0);
    expect(timeStringToSeconds(null as unknown as undefined)).toBe(0);
    expect(timeStringToSeconds("")).toBe(0);
  });

  it("parses numeric string", () => {
    expect(timeStringToSeconds("1234.5")).toBeCloseTo(1234.5);
  });

  it("accepts numbers directly", () => {
    expect(timeStringToSeconds(42)).toBe(42);
  });

  it("returns 0 for unparseable strings", () => {
    expect(timeStringToSeconds("not-a-number")).toBe(0);
  });
});

// ─── timeLabel ────────────────────────────────────────────────────────────────

describe("timeLabel", () => {
  it("returns -- for undefined/empty", () => {
    expect(timeLabel(undefined)).toBe("--");
    expect(timeLabel("")).toBe("--");
  });

  it("extracts fractional part from timestamp string", () => {
    const label = timeLabel("1753106099.511656");
    expect(label).toBe("511");
  });

  it("handles numeric input", () => {
    const label = timeLabel(1234.567);
    expect(label).toBeTruthy();
    expect(label).not.toBe("--");
  });
});
