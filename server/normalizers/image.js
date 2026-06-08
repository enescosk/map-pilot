// Image normalizers: produce browser-renderable data URLs from ROS image
// messages. Extracted verbatim from bagPlaybackSource.js. Three input variants
// are supported:
//   - compressed (sensor_msgs/CompressedImage)
//   - raw (sensor_msgs/Image, with explicit encoding)
//   - pre-encoded (object already carrying a src/dataUrl/base64 field)

import { PNG } from "pngjs";

export function imageToSource(message) {
  if (!message) {
    return "";
  }

  if (typeof message.src === "string") {
    return message.src;
  }

  if (typeof message.dataUrl === "string") {
    return message.dataUrl;
  }

  if (typeof message.data === "string" && typeof message.encoding === "string") {
    return `data:image/${message.encoding};base64,${message.data}`;
  }

  if (typeof message.data === "string") {
    return `data:image/jpeg;base64,${message.data}`;
  }

  return "";
}

const MAX_COMPRESSED_BYTES = 8 * 1024 * 1024; // 8 MB — sanity cap for a single frame

export function compressedImageToSource(message) {
  if (!message?.data) {
    return "";
  }

  const format = String(message.format || "jpeg").toLowerCase();
  const mime = format.includes("png") ? "image/png" : "image/jpeg";

  let buf;
  if (Buffer.isBuffer(message.data)) {
    if (message.data.length > MAX_COMPRESSED_BYTES) return "";
    buf = message.data;
  } else if (typeof message.data === "string") {
    if (message.data.length > MAX_COMPRESSED_BYTES * 1.4) return ""; // base64 overhead ~1.33×
    // Already base64-encoded (e.g. from bag playback)
    return `data:${mime};base64,${message.data}`;
  } else if (Array.isArray(message.data)) {
    if (message.data.length > MAX_COMPRESSED_BYTES) return "";
    // rosbridge sends CompressedImage.data as a plain number[] byte array
    buf = Buffer.from(message.data);
  } else {
    return "";
  }

  return `data:${mime};base64,${buf.toString("base64")}`;
}

const MAX_IMAGE_DIMENSION = 4096; // guard against malformed/malicious oversized frames

export function rawImageToSource(message) {
  const data = message?.data;
  const width = Number(message?.width || 0);
  const height = Number(message?.height || 0);
  const encoding = String(message?.encoding || "").toLowerCase();

  if (!data || width <= 0 || height <= 0) {
    return "";
  }

  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    return "";
  }

  let source;
  if (Buffer.isBuffer(data)) {
    source = data;
  } else if (Array.isArray(data)) {
    source = Buffer.from(data);
  } else if (typeof data === "string") {
    source = Buffer.from(data, "base64");
  } else {
    return "";
  }
  const png = new PNG({ width, height });
  const channels = encoding.includes("rgba") || encoding.includes("bgra") ? 4 : encoding.includes("mono") ? 1 : 3;
  const rowStep = Number(message.step || width * channels);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceOffset = y * rowStep + x * channels;
      const targetOffset = (y * width + x) * 4;

      if (encoding.includes("mono")) {
        const value = source[sourceOffset] || 0;
        png.data[targetOffset] = value;
        png.data[targetOffset + 1] = value;
        png.data[targetOffset + 2] = value;
        png.data[targetOffset + 3] = 255;
        continue;
      }

      const first = source[sourceOffset] || 0;
      const second = source[sourceOffset + 1] || 0;
      const third = source[sourceOffset + 2] || 0;
      const alpha = channels === 4 ? source[sourceOffset + 3] || 255 : 255;

      if (encoding.includes("bgr") || encoding === "8uc3") {
        png.data[targetOffset] = third;
        png.data[targetOffset + 1] = second;
        png.data[targetOffset + 2] = first;
      } else {
        png.data[targetOffset] = first;
        png.data[targetOffset + 1] = second;
        png.data[targetOffset + 2] = third;
      }
      png.data[targetOffset + 3] = alpha;
    }
  }

  return `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
}
