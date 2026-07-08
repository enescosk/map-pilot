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

// The dashboard displays exactly one point-cloud topic at a time. Processing
// the other 4+ live clouds (each up to 136k pts at 10 Hz) is pure waste and a
// prime crash vector, so we only do the heavy filter/downsample for the active
// topic. Empty string means "not chosen yet" — process everything so the first
// frames can populate the topic list and auto-selection can settle.
let activeTopic = "";

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
  const state = getTopicBuffer(topic);
  const buf = state.buf;
  let pos = state.pos;
  let fill = state.fill;
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

// Ingest + filter directly off the incoming xyzi Float32Array — no per-point
// {x,y,z,intensity} objects. This is the hot path for the RSLidar firehose
// (up to ~136k pts/frame @10Hz): the old code materialized `header.n` JS
// objects just to filter them and throw them away one line later.
function appendFilteredToTopicBuffer(topic: string, xyzi: Float32Array, count: number) {
  const state = getTopicBuffer(topic);
  const buf = state.buf;
  let pos = state.pos;
  let fill = state.fill;
  const r2 = VIEW_RADIUS * VIEW_RADIUS;
  const ego2 = EGO_CLEARANCE * EGO_CLEARANCE;
  for (let i = 0; i < count; i++) {
    const o = i * FLOATS_PER_POINT;
    const x = xyzi[o];
    const y = xyzi[o + 1];
    const z = xyzi[o + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (z < MIN_HEIGHT || z > MAX_HEIGHT) continue;
    const d2 = x * x + y * y;
    if (d2 < ego2 || d2 > r2) continue;
    const range = Math.sqrt(d2 + z * z);
    if (range < MIN_RANGE || range > VIEW_RADIUS) continue;
    buf[pos] = x;
    buf[pos + 1] = y;
    buf[pos + 2] = z;
    buf[pos + 3] = xyzi[o + 3];
    pos = (pos + FLOATS_PER_POINT) % BUFFER_FLOATS;
    fill = Math.min(fill + 1, BUFFER_POINTS);
  }
  topicWritePos.set(topic, pos);
  topicFill.set(topic, fill);
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

// Voxel-downsample: walks the circular Float32Array buffer directly and
// keeps a buffer *offset* per voxel instead of a materialized
// {x,y,z,intensity} object. Objects are only ever created for the final,
// already-capped renderable set (materializeRenderableXyzi below).
function downsampleBufferIndices(buf: Float32Array, startPos: number, fill: number, voxel: number): number[] {
  const inv = 1 / voxel;
  const grid = new Map<number, number>(); // voxel key -> float offset into buf
  for (let i = 0; i < fill; i++) {
    const idx = (startPos + i * FLOATS_PER_POINT) % BUFFER_FLOATS;
    const kx = Math.floor(buf[idx] * inv);
    const ky = Math.floor(buf[idx + 1] * inv);
    const kz = Math.floor(buf[idx + 2] * inv);
    const key = ((kx + 4096) * 8192 + (ky + 4096)) * 8192 + (kz + 4096);
    if (!grid.has(key)) grid.set(key, idx);
  }
  return [...grid.values()];
}

function selectRenderableIndices(buf: Float32Array, startPos: number, fill: number): number[] {
  let indices: number[];
  if (fill > MAX_RENDERED * 1.5) {
    indices = downsampleBufferIndices(buf, startPos, fill, RENDER_VOXEL);
  } else {
    indices = new Array(fill);
    for (let i = 0; i < fill; i++) indices[i] = (startPos + i * FLOATS_PER_POINT) % BUFFER_FLOATS;
  }
  let voxel = RENDER_VOXEL;
  while (indices.length > MAX_RENDERED && voxel < 1.5) {
    voxel *= 1.4;
    indices = downsampleBufferIndices(buf, startPos, fill, voxel);
  }
  if (indices.length > MAX_RENDERED) {
    const step = Math.ceil(indices.length / MAX_RENDERED);
    const out: number[] = [];
    for (let i = 0; i < indices.length; i += step) out.push(indices[i]);
    indices = out;
  }
  return indices;
}

// Final materialization for the wire: a fresh xyzi-interleaved Float32Array
// sized to the (already capped, <=MAX_RENDERED) renderable set. This buffer
// is posted with a transfer-list entry (zero-copy) instead of the previous
// Point3D[] shape, which the structured-clone algorithm had to deep-copy
// object-by-object — measured at ~33ms for a 60k-point frame vs <1ms here.
function materializeRenderableXyzi(topic: string): { xyzi: Float32Array; count: number } {
  const { buf, pos, fill } = getTopicBuffer(topic);
  const startPos = fill < BUFFER_POINTS ? 0 : pos;
  const indices = selectRenderableIndices(buf, startPos, fill);
  const out = new Float32Array(indices.length * FLOATS_PER_POINT);
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    const o = i * FLOATS_PER_POINT;
    out[o] = buf[idx];
    out[o + 1] = buf[idx + 1];
    out[o + 2] = buf[idx + 2];
    out[o + 3] = buf[idx + 3];
  }
  return { xyzi: out, count: indices.length };
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
      // Skip the heavy decode for clouds the user isn't looking at. We still
      // post a lightweight ack (with point count) so the topic list / auto-pick
      // keeps working and the client's backpressure slot is released.
      if (activeTopic && header.topic !== activeTopic) {
        self.postMessage({ type: "cloud-skipped", topic: header.topic, n: header.n, time: header.time, frameId: header.frameId, resolvedFrame: header.resolvedFrame });
        return;
      }

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

      appendFilteredToTopicBuffer(header.topic, xyzi, header.n);
      const { xyzi: renderableXyzi, count } = materializeRenderableXyzi(header.topic);
      self.postMessage({
        type: "cloud-ready",
        topic: header.topic,
        renderableXyzi,
        count,
        // Raw single-frame count (before history accumulation) so topic ranking
        // reflects real per-frame density, not how long we've been buffering.
        frameCount: header.n,
        time: header.time,
        frameId: header.frameId,
        resolvedFrame: header.resolvedFrame,
      }, [renderableXyzi.buffer]);
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
      const { xyzi: renderableXyzi, count } = materializeRenderableXyzi(topic);
      self.postMessage(
        { type: "scan-ready", topic, renderableXyzi, count, readingsLength: rawPts.length, time: m.time, frameId: m.frameId },
        [renderableXyzi.buffer],
      );
      return;
    }

    if (msg.type === "point-cloud") {
      const m = msg as Record<string, unknown>;
      const topic = (m.topic as string) || "point-cloud";
      if (Array.isArray(m.points)) {
        const rawPts = m.points as Point3D[];
        const filtered = filterPoints(rawPts);
        appendToTopicBuffer(topic, filtered);
        const { xyzi: renderableXyzi, count } = materializeRenderableXyzi(topic);
        self.postMessage(
          { type: "cloud-ready", topic, renderableXyzi, count, time: m.time, frameId: m.frameId, resolvedFrame: m.resolvedFrame },
          [renderableXyzi.buffer],
        );
      }
      return;
    }

    // For everything else, just pass the parsed message through
    self.postMessage({ type: "message", msg });
    return;
  }

  if (type === "set-active-topic") {
    const next = String(payload || "");
    if (next !== activeTopic) {
      // Drop the old topic's history so a switch doesn't keep stale clouds in
      // memory and the new topic starts clean.
      if (activeTopic) clearTopicBuffer(activeTopic);
      activeTopic = next;
    }
    return;
  }

  if (type === "reset") {
    for (const topic of topicBuffers.keys()) clearTopicBuffer(topic);
    activeTopic = "";
    return;
  }

  if (type === "clear-topic") {
    clearTopicBuffer(payload as string);
    return;
  }
};
