// sensor_msgs/PointCloud2 binary parser. Reads x/y/z/intensity fields based on
// the field descriptors in the message header. Extracted verbatim from
// bagPlaybackSource.js so emitted bytes do not change.

import { MAX_SCAN_POINTS, MAX_POINT_CLOUD_POINTS } from "../config/env.js";

// Round to 3 decimals without the string round-trip of `Number(n.toFixed(3))`.
// On the point-cloud hot path this runs up to ~320k times per frame; toFixed
// allocates a string + reparses each call, and the value is packed to Float32
// (truncated) for the WS binary frame anyway.
function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function findPointField(message, name) {
  return message?.fields?.find((field) => field.name === name);
}

// rosbridge serializes a PointCloud2 `uint8[] data` field as a base64 string
// (default) or, with the right options, as a plain number array. Bag playback
// hands us a Buffer directly. Decode all three to a Buffer so the field reads
// below land on the real bytes — `Buffer.from(base64String)` without the
// "base64" arg silently mis-decodes as UTF-8 and corrupts the whole cloud.
function toPointCloudBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.from(data);
  if (typeof data === "string") return Buffer.from(data, "base64");
  if (data && (data instanceof Uint8Array || ArrayBuffer.isView(data))) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return Buffer.alloc(0);
}

function readField(buffer, offset, datatype, isBigEndian) {
  try {
    switch (datatype) {
      case 1: return buffer.readInt8(offset);
      case 2: return buffer.readUInt8(offset);
      case 3: return isBigEndian ? buffer.readInt16BE(offset) : buffer.readInt16LE(offset);
      case 4: return isBigEndian ? buffer.readUInt16BE(offset) : buffer.readUInt16LE(offset);
      case 5: return isBigEndian ? buffer.readInt32BE(offset) : buffer.readInt32LE(offset);
      case 6: return isBigEndian ? buffer.readUInt32BE(offset) : buffer.readUInt32LE(offset);
      case 7: return isBigEndian ? buffer.readFloatBE(offset) : buffer.readFloatLE(offset);
      case 8: return isBigEndian ? buffer.readDoubleBE(offset) : buffer.readDoubleLE(offset);
      default: return 0;
    }
  } catch (e) {
    return Number.NaN;
  }
}

export function pointCloud2ToReadings(message) {
  const data = message?.data;
  const xField = findPointField(message, "x");
  const yField = findPointField(message, "y");
  const pointStep = Number(message?.point_step || 0);
  const pointCount = Number(message?.width || 0) * Number(message?.height || 0);

  if (!data || !xField || !yField || pointStep <= 0 || pointCount <= 0) {
    return [];
  }

  const buffer = toPointCloudBuffer(data);
  const step = Math.max(1, Math.ceil(pointCount / MAX_SCAN_POINTS));
  const readings = [];

  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += step) {
    const baseOffset = pointIndex * pointStep;
    const x = readField(buffer, baseOffset + xField.offset, xField.datatype, message.is_bigendian);
    const y = readField(buffer, baseOffset + yField.offset, yField.datatype, message.is_bigendian);

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }

    const distance = Math.hypot(x, y);
    if (distance <= 0) {
      continue;
    }

    const angle = (Math.atan2(y, x) * 180) / Math.PI;
    readings.push({
      angle: Number(((angle + 360) % 360).toFixed(1)),
      distance: Number(distance.toFixed(3)),
    });
  }

  return readings;
}

export function pointCloud2ToPoints(message) {
  const data = message?.data;
  const xField = findPointField(message, "x");
  const yField = findPointField(message, "y");
  const zField = findPointField(message, "z");
  const intensityField = findPointField(message, "intensity");
  const pointStep = Number(message?.point_step || 0);
  const pointCount = Number(message?.width || 0) * Number(message?.height || 0);

  if (!data || !xField || !yField || pointStep <= 0 || pointCount <= 0) {
    return [];
  }

  const buffer = toPointCloudBuffer(data);
  const step = Math.max(1, Math.ceil(pointCount / MAX_POINT_CLOUD_POINTS));
  const points = [];

  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += step) {
    const baseOffset = pointIndex * pointStep;
    const x = readField(buffer, baseOffset + xField.offset, xField.datatype, message.is_bigendian);
    const y = readField(buffer, baseOffset + yField.offset, yField.datatype, message.is_bigendian);
    const z = zField ? readField(buffer, baseOffset + zField.offset, zField.datatype, message.is_bigendian) : 0;
    const intensity = intensityField
      ? readField(buffer, baseOffset + intensityField.offset, intensityField.datatype, message.is_bigendian)
      : 0;

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      continue;
    }

    if (x === 0 && y === 0 && z === 0) {
      continue;
    }

    points.push({
      x: round3(x),
      y: round3(y),
      z: round3(z),
      intensity: round3(Number.isFinite(intensity) ? intensity : 0),
    });
  }

  return points;
}
