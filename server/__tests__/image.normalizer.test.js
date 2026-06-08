import { describe, it, expect } from "vitest";
import { imageToSource, compressedImageToSource, rawImageToSource } from "../normalizers/image.js";

// ─── imageToSource ────────────────────────────────────────────────────────────

describe("imageToSource", () => {
  it("returns empty string for null/undefined", () => {
    expect(imageToSource(null)).toBe("");
    expect(imageToSource(undefined)).toBe("");
  });

  it("returns message.src directly if present", () => {
    expect(imageToSource({ src: "data:image/jpeg;base64,abc" })).toBe("data:image/jpeg;base64,abc");
  });

  it("returns message.dataUrl directly if present", () => {
    expect(imageToSource({ dataUrl: "data:image/png;base64,xyz" })).toBe("data:image/png;base64,xyz");
  });

  it("builds data URL from base64 string + encoding", () => {
    const result = imageToSource({ data: "abc123", encoding: "png" });
    expect(result).toBe("data:image/png;base64,abc123");
  });

  it("defaults to jpeg when encoding is missing", () => {
    const result = imageToSource({ data: "abc123" });
    expect(result).toBe("data:image/jpeg;base64,abc123");
  });

  it("returns empty string when data is not a string and no src/dataUrl", () => {
    expect(imageToSource({ data: 123 })).toBe("");
  });
});

// ─── compressedImageToSource ──────────────────────────────────────────────────

describe("compressedImageToSource", () => {
  it("returns empty string for null/undefined", () => {
    expect(compressedImageToSource(null)).toBe("");
    expect(compressedImageToSource(undefined)).toBe("");
  });

  it("returns empty string when data is missing", () => {
    expect(compressedImageToSource({ format: "jpeg" })).toBe("");
  });

  it("handles Buffer data and produces jpeg data URL", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff]); // fake JPEG header bytes
    const result = compressedImageToSource({ data: buf, format: "jpeg" });
    expect(result).toMatch(/^data:image\/jpeg;base64,/);
    expect(Buffer.from(result.split(",")[1], "base64")).toEqual(buf);
  });

  it("handles number[] byte array (rosbridge format)", () => {
    const bytes = [0xff, 0xd8, 0xff, 0xe0];
    const result = compressedImageToSource({ data: bytes, format: "jpeg" });
    expect(result).toMatch(/^data:image\/jpeg;base64,/);
    expect(Buffer.from(result.split(",")[1], "base64")).toEqual(Buffer.from(bytes));
  });

  it("handles base64 string data directly (bag playback format)", () => {
    const b64 = Buffer.from([1, 2, 3]).toString("base64");
    const result = compressedImageToSource({ data: b64, format: "jpeg" });
    expect(result).toBe(`data:image/jpeg;base64,${b64}`);
  });

  it("uses png mime when format includes png", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const result = compressedImageToSource({ data: buf, format: "png" });
    expect(result).toMatch(/^data:image\/png;base64,/);
  });

  it("defaults to jpeg when format is not specified", () => {
    const buf = Buffer.from([0x01]);
    const result = compressedImageToSource({ data: buf });
    expect(result).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("returns empty string for unsupported data type", () => {
    expect(compressedImageToSource({ data: 12345 })).toBe("");
  });
});

// ─── rawImageToSource ─────────────────────────────────────────────────────────

describe("rawImageToSource", () => {
  it("returns empty string for missing data", () => {
    expect(rawImageToSource(null)).toBe("");
    expect(rawImageToSource({ width: 1, height: 1 })).toBe("");
  });

  it("returns empty string when width or height is 0", () => {
    const data = new Uint8Array(3).fill(128);
    expect(rawImageToSource({ data, width: 0, height: 1, encoding: "rgb8" })).toBe("");
    expect(rawImageToSource({ data, width: 1, height: 0, encoding: "rgb8" })).toBe("");
  });

  it("produces a PNG data URL from a 1×1 rgb8 Buffer", () => {
    const px = Buffer.from([255, 0, 0]); // red pixel
    const result = rawImageToSource({ data: px, width: 1, height: 1, encoding: "rgb8" });
    expect(result).toMatch(/^data:image\/png;base64,/);
  });

  it("produces a PNG data URL from a 1×1 rgb8 number[] (rosbridge format)", () => {
    const px = [0, 255, 0]; // green pixel
    const result = rawImageToSource({ data: px, width: 1, height: 1, encoding: "rgb8" });
    expect(result).toMatch(/^data:image\/png;base64,/);
  });

  it("produces a PNG data URL from a 1×1 rgb8 base64 string", () => {
    const px = Buffer.from([0, 0, 255]); // blue pixel
    const result = rawImageToSource({ data: px.toString("base64"), width: 1, height: 1, encoding: "rgb8" });
    expect(result).toMatch(/^data:image\/png;base64,/);
  });

  it("handles mono8 encoding (1 channel)", () => {
    const px = Buffer.from([200]);
    const result = rawImageToSource({ data: px, width: 1, height: 1, encoding: "mono8" });
    expect(result).toMatch(/^data:image\/png;base64,/);
  });

  it("handles bgr8 encoding (channels swapped)", () => {
    const px = Buffer.from([255, 0, 0]); // BGR: blue=255 → should become R=0,G=0,B=255 in PNG
    const result = rawImageToSource({ data: px, width: 1, height: 1, encoding: "bgr8" });
    expect(result).toMatch(/^data:image\/png;base64,/);
  });

  it("returns empty string for unsupported data type", () => {
    expect(rawImageToSource({ data: 12345, width: 1, height: 1, encoding: "rgb8" })).toBe("");
  });
});
