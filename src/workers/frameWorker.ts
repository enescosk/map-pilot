// Runs in a Web Worker. Receives raw JSON strings from the WebSocket,
// parses them, and does CPU-heavy lidar work off the main thread.

import type { LiveMessage, Point3D } from "../types/liveMessages";

const MAX_LIDAR_HISTORY = 32000;
const MAX_RENDERED = 60000;
const RENDER_VOXEL = 0.2;
const VIEW_RADIUS = 80;
const MIN_HEIGHT = -3;
const MAX_HEIGHT = 12;
const MIN_RANGE = 0.5;
const EGO_CLEARANCE = 0.4;

// Per-topic circular point buffer (avoids [...a,...b].slice() O(n) cost)
const topicBuffers = new Map<string, Float32Array>(); // x,y,z,intensity interleaved
const topicWritePos = new Map<string, number>();
const topicFill = new Map<string, number>();

const FLOATS_PER_POINT = 4;
const BUFFER_POINTS = MAX_LIDAR_HISTORY;
const BUFFER_FLOATS = BUFFER_POINTS * FLOATS_PER_POINT;

function getTopicBuffer(topic: string) {
  if (!topicBuffers.has(topic)) {
    topicBuffers.set(topic, new Float32Array(BUFFER_FLOATS));
    topicWritePos.set(topic, 0);
    topicFill.set(topic, 0);
  }
  return {
    buf: topicBuffers.get(topic)!,
    pos: topicWritePos.get(topic)!,
    fill: topicFill.get(topic)!,
  };
}

function appendToTopicBuffer(topic: string, pts: Point3D[]) {
  let { buf, pos, fill } = getTopicBuffer(topic);
  for (const p of pts) {
    buf[pos] = p.x;
    buf[pos + 1] = p.y;
    buf[pos + 2] = p.z;
    buf[pos + 3] = p.intensity ?? 0;
    pos = (pos + FLOATS_PER_POINT) % BUFFER_FLOATS;
    fill = Math.min(fill + 1, BUFFER_POINTS);
  }
  topicWritePos.set(topic, pos);
  topicFill.set(topic, fill);
}

function readTopicBuffer(topic: string): Point3D[] {
  const { buf, pos, fill } = getTopicBuffer(topic);
  const pts: Point3D[] = new Array(fill);
  // Read from oldest to newest
  const startPos = fill < BUFFER_POINTS ? 0 : pos;
  for (let i = 0; i < fill; i++) {
    const idx = ((startPos + i * FLOATS_PER_POINT) % BUFFER_FLOATS);
    pts[i] = { x: buf[idx], y: buf[idx + 1], z: buf[idx + 2], intensity: buf[idx + 3] };
  }
  return pts;
}

function clearTopicBuffer(topic: string) {
  topicBuffers.delete(topic);
  topicWritePos.delete(topic);
  topicFill.delete(topic);
}

function filterPoints(pts: Point3D[]): Point3D[] {
  const r2 = VIEW_RADIUS * VIEW_RADIUS;
  const ego2 = EGO_CLEARANCE * EGO_CLEARANCE;
  return pts.filter(p => {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return false;
    if (p.z < MIN_HEIGHT || p.z > MAX_HEIGHT) return false;
    const d2 = p.x * p.x + p.y * p.y;
    if (d2 < ego2) return false;
    const range = Math.sqrt(d2 + p.z * p.z);
    if (range < MIN_RANGE || range > VIEW_RADIUS) return false;
    return d2 <= r2;
  });
}

function downsample(pts: Point3D[], voxel: number): Point3D[] {
  const inv = 1 / voxel;
  const grid = new Map<number, Point3D>();
  for (const p of pts) {
    const kx = Math.floor(p.x * inv);
    const ky = Math.floor(p.y * inv);
    const kz = Math.floor(p.z * inv);
    // Pack into a single number for small coords (±4096 range, 1cm precision)
    const key = ((kx + 4096) * 8192 + (ky + 4096)) * 8192 + (kz + 4096);
    if (!grid.has(key)) grid.set(key, p);
  }
  return [...grid.values()];
}

function selectRenderable(pts: Point3D[]): Point3D[] {
  let result = pts.length > MAX_RENDERED * 1.5 ? downsample(pts, RENDER_VOXEL) : pts;
  let voxel = RENDER_VOXEL;
  while (result.length > MAX_RENDERED && voxel < 1.5) {
    voxel *= 1.4;
    result = downsample(pts, voxel);
  }
  if (result.length > MAX_RENDERED) {
    const step = Math.ceil(result.length / MAX_RENDERED);
    const out: Point3D[] = [];
    for (let i = 0; i < result.length; i += step) out.push(result[i]);
    result = out;
  }
  return result;
}

function buildScanPoints(scan: {
  angle_min?: number; angle_max?: number; angle_increment?: number;
  range_min?: number; range_max?: number; ranges?: number[]; intensities?: number[];
}): Point3D[] {
  const angleMin = Number(scan?.angle_min ?? 0);
  const angleIncrement = Number(scan?.angle_increment ?? 0);
  const rangeMin = Number(scan?.range_min ?? 0);
  const rangeMax = Number(scan?.range_max ?? Infinity);
  const ranges = Array.isArray(scan?.ranges) ? scan.ranges : [];
  const intensities = Array.isArray(scan?.intensities) ? scan.intensities : [];
  const pts: Point3D[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const r = Number(ranges[i]);
    if (!Number.isFinite(r) || r <= 0 || r < rangeMin || r > rangeMax) continue;
    const angle = angleMin + i * angleIncrement;
    pts.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r, z: 0, intensity: Number(intensities[i] || 0) });
  }
  return pts;
}

self.onmessage = (ev: MessageEvent) => {
  const { type, payload } = ev.data as { type: string; payload: unknown };

  if (type === "parse-binary") {
    try {
      // Format: [4 bytes header length LE] [header JSON utf8, padded to /4] [Float32 xyzi interleaved]
      const buf = payload as ArrayBuffer;
      const view = new DataView(buf);
      const headerLen = view.getUint32(0, true);
      const headerBytes = new Uint8Array(buf, 4, headerLen);
      const header = JSON.parse(new TextDecoder().decode(headerBytes)) as {
        type: string; topic: string; time: string; source: string;
        frameId: string; resolvedFrame: string; n: number;
      };
      const dataOffset = 4 + headerLen;

      // Float32Array requires 4-byte aligned offset. Server pads header to
      // guarantee this, but fall back to a copy if a stale/old server sends
      // unaligned frames so we never silently drop.
      let xyzi: Float32Array;
      if (dataOffset % 4 === 0) {
        xyzi = new Float32Array(buf, dataOffset, header.n * 4);
      } else {
        const copy = buf.slice(dataOffset);
        xyzi = new Float32Array(copy);
      }

      const rawPts: Point3D[] = new Array(header.n);
      for (let i = 0; i < header.n; i++) {
        const o = i * 4;
        rawPts[i] = { x: xyzi[o], y: xyzi[o + 1], z: xyzi[o + 2], intensity: xyzi[o + 3] };
      }

      const filtered = filterPoints(rawPts);
      appendToTopicBuffer(header.topic, filtered);
      const history = readTopicBuffer(header.topic);
      const renderable = selectRenderable(history);
      self.postMessage({
        type: "cloud-ready",
        topic: header.topic,
        renderable,
        time: header.time,
        frameId: header.frameId,
        resolvedFrame: header.resolvedFrame,
      });
    } catch (err) {
      // Surface decode failures instead of swallowing them silently.
      self.postMessage({ type: "worker-error", scope: "parse-binary", message: String(err) });
    }
    return;
  }

  if (type === "parse") {
    // Parse raw JSON string and return the structured message
    let msg: LiveMessage;
    try {
      msg = JSON.parse(payload as string) as LiveMessage;
    } catch {
      return;
    }

    // For lidar/scan, do the heavy work here and send back renderable points
    if (msg.type === "scan" && (Array.isArray((msg as Record<string, unknown>).readings) || (msg as Record<string, unknown>).scan)) {
      const m = msg as Record<string, unknown>;
      const topic = (m.topic as string) || "scan";
      const rawPts: Point3D[] = Array.isArray(m.readings)
        ? (m.readings as Point3D[])
        : buildScanPoints(m.scan as Parameters<typeof buildScanPoints>[0]);
      const filtered = filterPoints(rawPts);
      appendToTopicBuffer(topic, filtered);
      const history = readTopicBuffer(topic);
      const renderable = selectRenderable(history);
      self.postMessage({ type: "scan-ready", topic, renderable, readingsLength: rawPts.length, time: m.time, frameId: m.frameId });
      return;
    }

    if (msg.type === "point-cloud") {
      const m = msg as Record<string, unknown>;
      const topic = (m.topic as string) || "point-cloud";
      if (Array.isArray(m.points)) {
        const rawPts = m.points as Point3D[];
        const filtered = filterPoints(rawPts);
        appendToTopicBuffer(topic, filtered);
        const history = readTopicBuffer(topic);
        const renderable = selectRenderable(history);
        self.postMessage({ type: "cloud-ready", topic, renderable, time: m.time, frameId: m.frameId, resolvedFrame: m.resolvedFrame });
      }
      return;
    }

    // For everything else, just pass the parsed message through
    self.postMessage({ type: "message", msg });
    return;
  }

  if (type === "reset") {
    for (const topic of topicBuffers.keys()) clearTopicBuffer(topic);
    return;
  }

  if (type === "clear-topic") {
    clearTopicBuffer(payload as string);
    return;
  }
};
