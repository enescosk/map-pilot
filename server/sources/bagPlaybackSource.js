import fs from "node:fs";
import path from "node:path";
import rosbag from "rosbag";
import { normalizeFrame } from "../normalizers/index.js";
import { normalizeVehicleTelemetry } from "../normalizers/vehicle.js";
import { timeToString, timeToSeconds, secondsToTime } from "../normalizers/helpers.js";

// Re-export for any external caller that previously imported from here.
// Phase 4 will move these consumers to the new module paths directly.
export { normalizeFrame, normalizeVehicleTelemetry };

const BAG_EXPORT_PATH = process.env.BAG_EXPORT_PATH || "data/bag-export.jsonl";
const BAG_FILE_PATH = process.env.BAG_FILE_PATH || BAG_EXPORT_PATH;
const BAG_PLAYBACK_INTERVAL_MS = Number(process.env.BAG_PLAYBACK_INTERVAL_MS || 180);
const BAG_PLAYBACK_BATCH_SIZE = Number(process.env.BAG_PLAYBACK_BATCH_SIZE || 24);
const BAG_READ_CHUNK_SECONDS = Number(process.env.BAG_READ_CHUNK_SECONDS || 0.35);
const BAG_PLAYBACK_RATE = Number(process.env.BAG_PLAYBACK_RATE || 1);
const BAG_WINDOW_SECONDS = Number(process.env.BAG_WINDOW_SECONDS || 60);
const MAX_PLAYBACK_QUEUE = Number(process.env.MAX_PLAYBACK_QUEUE || 50000);
const MAX_TOPIC_SAMPLES = Number(process.env.MAX_TOPIC_SAMPLES || 80);
const MIN_CAMERA_INTERVAL_SECONDS = Number(process.env.MIN_CAMERA_INTERVAL_SECONDS || 0.08);
const MIN_POINT_CLOUD_INTERVAL_SECONDS = Number(process.env.MIN_POINT_CLOUD_INTERVAL_SECONDS || 0.08);
const MIN_SCAN_INTERVAL_SECONDS = Number(process.env.MIN_SCAN_INTERVAL_SECONDS || 0.06);
const MIN_TELEMETRY_INTERVAL_SECONDS = Number(process.env.MIN_TELEMETRY_INTERVAL_SECONDS || 0.12);
const ROSBAG_TOPIC_HINTS = [
  "scan",
  "points",
  "image",
  "camera",
  "odom",
  "navsat",
  "gps",
  "imu",
  "velocity",
  "speed",
  "steer",
  "eps",
  "brake",
  "ehb",
  "throttle",
  "motor",
  "autonomous",
  "rc_unit",
  "vcu",
  "/tf",
];

const DEFAULT_ROSBAG_TOPIC_PATTERNS = [
  /\/zed2i\/zed_node\/rgb\/image_rect_color\/compressed$/i,
  /\/zed2i\/zed_node\/left\/image_rect_color\/compressed$/i,
  /\/out\/compressed$/i,
  /\/camera\/image_raw$/i,
  /^\/cloud$/i,
  /\/rslidar_points$/i,
  /\/m1\/rslidar_points$/i,
  /\/helios\/rslidar_points$/i,
  /\/zed2i\/zed_node\/point_cloud\/cloud_registered$/i,
  /\/left_laser\/scan$/i,
  /\/right_laser\/scan$/i,
  /\/ekf\/odometry_earth$/i,
  /\/zed2i\/zed_node\/odom$/i,
  /^\/heading$/i,
  /\/navsatfix$/i,
  /^\/imu\/data$/i,
  /\/imu\/data$/i,
  /\/VelocityInformation$/i,
  /\/eps_response$/i,
  /\/EHB_BrakingResponse$/i,
  /\/fb_motor_driver_report$/i,
  /\/rc_unit_report$/i,
  /\/autonomous_report$/i,
  /\/throttle_control$/i,
  /\/vcu_eps_control$/i,
  /\/vcu_ehb_control$/i,
  /\/steer_control$/i,
  /\/brake_control$/i,
  /\/autonomous_mode_selection$/i,
  /^\/tf$/i,
  /^\/tf_static$/i,
];

function readExportFile(filePath = BAG_EXPORT_PATH) {
  const absolutePath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(absolutePath)) {
    console.warn(`Bag export not found at ${absolutePath}`);
    return { absolutePath, frames: [] };
  }

  const raw = fs.readFileSync(absolutePath, "utf8").trim();
  if (!raw) {
    return { absolutePath, frames: [] };
  }

  if (raw.startsWith("[")) {
    return { absolutePath, frames: JSON.parse(raw) };
  }

  return {
    absolutePath,
    frames: raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}

function summarizeTopics(frames) {
  const topicMap = new Map();

  for (const frame of frames) {
    const topic = frame.topic || "unknown";
    const current = topicMap.get(topic) || {
      topic,
      type: frame.type || frame.msgType || "unknown",
      count: 0,
      lastTime: "",
      sample: "",
    };

    current.count += 1;
    current.type = frame.type || frame.msgType || current.type;
    current.lastTime = frame.time || frame.timestamp || current.lastTime;
    current.sample = JSON.stringify(frame.message || frame.msg || frame.payload || frame).slice(0, 180);
    topicMap.set(topic, current);
  }

  return [...topicMap.values()].slice(0, MAX_TOPIC_SAMPLES);
}

function summarizeRosbagTopics(bag) {
  const countsByConnection = new Map();
  const countsByTopic = new Map();

  for (const chunkInfo of bag.chunkInfos || []) {
    for (const connection of chunkInfo.connections || []) {
      countsByConnection.set(
        connection.conn,
        (countsByConnection.get(connection.conn) || 0) + Number(connection.count || 0),
      );
    }
  }

  for (const connection of Object.values(bag.connections || {})) {
    const topic = connection.topic || "unknown";
    const current = countsByTopic.get(topic) || {
      topic,
      type: connection.type || connection.datatype || "unknown",
      count: 0,
      lastTime: "",
      sample: "",
    };

    current.count += countsByConnection.get(connection.conn) || 0;
    current.type = connection.type || connection.datatype || current.type;
    current.sample = connection.messageDefinition?.split("\n").find(Boolean) || "";
    countsByTopic.set(topic, current);
  }

  return [...countsByTopic.values()].sort((left, right) => right.count - left.count);
}

function getThrottleInterval(topic, type) {
  const lowerTopic = topic.toLowerCase();
  const lowerType = type.toLowerCase();

  if (lowerType.includes("compressedimage") || lowerType.includes("image")) {
    return MIN_CAMERA_INTERVAL_SECONDS;
  }

  if (lowerType.includes("pointcloud") || lowerTopic.includes("rslidar_points") || lowerTopic.includes("point_cloud")) {
    return MIN_POINT_CLOUD_INTERVAL_SECONDS;
  }

  if (lowerType.includes("laserscan") || lowerTopic.includes("scan")) {
    return MIN_SCAN_INTERVAL_SECONDS;
  }

  if (
    lowerType.includes("imu") ||
    lowerType.includes("odometry") ||
    lowerType.includes("navsatfix") ||
    lowerType.includes("magneticfield") ||
    lowerType.includes("velocityinformation") ||
    lowerType.includes("eps_response") ||
    lowerType.includes("ehb_brakingresponse") ||
    lowerType.includes("fb_motordriver") ||
    lowerType.includes("fb_omux_to_autonomous") ||
    lowerType.includes("autonomousheardbit") ||
    lowerType.includes("cruisecontrolsignals") ||
    lowerType.includes("vcu_eps_control") ||
    lowerType.includes("vcu_ehb_control") ||
    lowerType.includes("steercontrol") ||
    lowerType.includes("brakecontrol") ||
    lowerType.includes("vehiclemode") ||
    lowerTopic.includes("imu") ||
    lowerTopic.includes("navsat") ||
    lowerTopic.includes("velocity") ||
    lowerTopic.includes("eps") ||
    lowerTopic.includes("brake") ||
    lowerTopic.includes("ehb") ||
    lowerTopic.includes("motor") ||
    lowerTopic.includes("steer") ||
    lowerTopic.includes("throttle") ||
    lowerTopic.includes("autonomous") ||
    lowerTopic.includes("rc_unit") ||
    lowerTopic.includes("vcu")
  ) {
    return MIN_TELEMETRY_INTERVAL_SECONDS;
  }

  return 0.2;
}

function addSeconds(time, seconds) {
  if (!seconds || seconds <= 0) {
    return undefined;
  }

  return {
    sec: time.sec + Math.floor(seconds),
    nsec: time.nsec,
  };
}

function chooseRosbagTopics(topics) {
  const requestedTopics = (process.env.BAG_TOPICS || "")
    .split(",")
    .map((topic) => topic.trim())
    .filter(Boolean);

  if (requestedTopics.length > 0) {
    return requestedTopics;
  }

  const selected = [];
  for (const pattern of DEFAULT_ROSBAG_TOPIC_PATTERNS) {
    const match = topics.find((topic) => pattern.test(topic.topic));
    if (match && !selected.includes(match.topic)) {
      selected.push(match.topic);
    }
  }

  if (selected.length > 0) {
    return preferPrimaryDerivedTelemetryTopics(selected);
  }

  const hintedTopics = topics
    .filter((topic) => ROSBAG_TOPIC_HINTS.some((hint) => topic.topic.toLowerCase().includes(hint)))
    .slice(0, 32)
    .map((topic) => topic.topic);

  if (hintedTopics.length > 0) {
    return hintedTopics;
  }

  return topics.slice(0, 32).map((topic) => topic.topic);
}

function preferPrimaryDerivedTelemetryTopics(selectedTopics) {
  const hasEkfOdom = selectedTopics.some((topic) => /\/ekf\/odometry_earth$/i.test(topic));
  const hasPrimaryImu = selectedTopics.some((topic) => /^\/imu\/data$/i.test(topic));

  return selectedTopics.filter((topic) => {
    if (hasEkfOdom && /\/zed2i\/zed_node\/odom$/i.test(topic)) {
      return false;
    }
    if (hasPrimaryImu && /\/zed2i\/zed_node\/imu\/data$/i.test(topic)) {
      return false;
    }
    return true;
  });
}

function createJsonPlaybackSource({ emit, filePath }) {
  const { absolutePath, frames } = readExportFile(filePath);
  let timer;
  let cursor = 0;
  let playing = false;
  const topics = summarizeTopics(frames);

  const startTime = frames.length > 0 ? frames[0].time || frames[0].timestamp || "" : "";
  const endTime = frames.length > 0 ? frames[frames.length - 1].time || frames[frames.length - 1].timestamp || "" : "";
  const durationSeconds = timeToSeconds(endTime) - timeToSeconds(startTime);

  function emitStatus() {
    emit({
      type: "status",
      connected: playing && frames.length > 0,
      source: "bag-playback",
      topic: "recorded-bag",
    });
    emit({
      type: "bag-status",
      connected: frames.length > 0,
      playing,
      source: "bag-playback",
      path: absolutePath,
      frameCount: frames.length,
      cursor,
      topics,
      currentTime: frames[cursor] ? frames[cursor].time || frames[cursor].timestamp || "" : "",
      startTime,
      endTime,
      durationSeconds,
    });
  }

  function getStatus() {
    return {
      type: "status",
      connected: playing && frames.length > 0,
      source: "bag-playback",
      topic: "recorded-bag",
    };
  }

  function publishNextFrame() {
    if (frames.length === 0) {
      stop();
      return;
    }

    const frame = frames[cursor];
    emit(normalizeFrame(frame));
    cursor = (cursor + 1) % frames.length;
    emitStatus();
  }

  function start() {
    if (playing) {
      return;
    }

    playing = true;
    emitStatus();
    publishNextFrame();
    timer = setInterval(publishNextFrame, BAG_PLAYBACK_INTERVAL_MS);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    playing = false;
    emitStatus();
  }

  return {
    getStatus,
    start,
    stop,
  };
}

// ── TF Utilities ────────────────────────────────────────────────────────────

/** Quaternion multiply: returns q1 * q2 */
function quatMul(q1, q2) {
  return {
    x: q1.w*q2.x + q1.x*q2.w + q1.y*q2.z - q1.z*q2.y,
    y: q1.w*q2.y - q1.x*q2.z + q1.y*q2.w + q1.z*q2.x,
    z: q1.w*q2.z + q1.x*q2.y - q1.y*q2.x + q1.z*q2.w,
    w: q1.w*q2.w - q1.x*q2.x - q1.y*q2.y - q1.z*q2.z,
  };
}

/** Rotate vector v by quaternion q */
function quatRotate(q, v) {
  const { x, y, z, w } = q;
  const ix =  w*v.x + y*v.z - z*v.y;
  const iy =  w*v.y + z*v.x - x*v.z;
  const iz =  w*v.z + x*v.y - y*v.x;
  const iw = -x*v.x - y*v.y - z*v.z;
  return {
    x: ix*w + iw*(-x) + iy*(-z) - iz*(-y),
    y: iy*w + iw*(-y) + iz*(-x) - ix*(-z),
    z: iz*w + iw*(-z) + ix*(-y) - iy*(-x),
  };
}

/** Apply transform T to point p: p_out = T.rotation * p + T.translation */
function applyTransform(T, p) {
  const rotated = quatRotate(T.rotation, p);
  return {
    x: rotated.x + T.translation.x,
    y: rotated.y + T.translation.y,
    z: rotated.z + T.translation.z,
  };
}

/** Compose two transforms: T_AB followed by T_BC → T_AC */
function composeTransforms(T_AB, T_BC) {
  const translation = applyTransform(T_AB, T_BC.translation);
  const rotation = quatMul(T_AB.rotation, T_BC.rotation);
  return { translation, rotation };
}

/** Identity transform */
const IDENTITY_TF = { translation: {x:0,y:0,z:0}, rotation: {x:0,y:0,z:0,w:1} };

// ── Rosbag Playback Source ───────────────────────────────────────────────────

function createRosbagPlaybackSource({ emit, filePath }) {
  const absolutePath = path.resolve(process.cwd(), filePath || BAG_FILE_PATH);
  let bagPromise;
  let cachedBag;
  let timer;
  let playing = false;
  let completed = false;
  let cursor = 0;
  let queue = [];
  let topics = [];
  let selectedTopics = [];
  let playbackStartTime;
  let playbackReadTime;
  let currentTime = "";
  let readGeneration = 0;
  let reading = false;
  let lastStatusEmitMs = 0;
  let wallPlaybackStartMs = 0;
  let bagPlaybackBaseSeconds = 0;
  const lastQueuedTimeByTopic = new Map();
  let latestOdomPose = null;

  // TF tree: child_frame_id → { parent_frame_id, translation, rotation }
  const tfTree = new Map();
  let tfLoaded = false;

  /** Load /tf_static (and all /tf) into tfTree from the full bag */
  async function loadTransforms(bag) {
    if (tfLoaded) return;
    tfLoaded = true;
    try {
      // Open a fresh handle so TF reads don't interfere with playback reads
      const tfBag = await rosbag.open(absolutePath);
      const connObj = tfBag.connections || {};
      const connTopics = new Set(Object.values(connObj).map((c) => c.topic));
      const tfTopics = ["/tf", "/tf_static"].filter((t) => connTopics.has(t));
      if (tfTopics.length === 0) {
        console.log("No /tf or /tf_static topics found in bag");
        return;
      }
      await tfBag.readMessages({ topics: tfTopics }, (result) => {
        try {
          const transforms = result.message?.transforms || [];
          for (const tf of transforms) {
            const child = tf.child_frame_id?.replace(/^\//, "");
            const parent = tf.header?.frame_id?.replace(/^\//, "");
            if (!child || !parent) continue;
            const t = tf.transform?.translation || {x:0,y:0,z:0};
            const r = tf.transform?.rotation || {x:0,y:0,z:0,w:1};
            if (!tfTree.has(child)) {
              tfTree.set(child, {
                parent,
                translation: { x: Number(t.x||0), y: Number(t.y||0), z: Number(t.z||0) },
                rotation:    { x: Number(r.x||0), y: Number(r.y||0), z: Number(r.z||0), w: Number(r.w??1) },
              });
            }
          }
        } catch (innerErr) {
          // individual message parse error — skip
        }
      });
      console.log(`TF tree loaded: ${tfTree.size} frames →`, [...tfTree.keys()].join(", "));
    } catch (err) {
      console.warn("Could not load TF transforms (will render in sensor frame):", err.message);
    }
  }

  /** Walk tfTree upward from frameId to targetFrame, compose transform chain */
  function resolveTransform(frameId, targetFrame, maxDepth = 12) {
    const clean = (f) => f?.replace(/^\//, "") || "";
    const src = clean(frameId);
    const dst = clean(targetFrame);
    if (!src || src === dst) return IDENTITY_TF;

    // Build path from src → dst by walking to root
    let T = IDENTITY_TF;
    let current = src;
    for (let depth = 0; depth < maxDepth; depth++) {
      if (current === dst) return T;
      const node = tfTree.get(current);
      if (!node) break;
      T = composeTransforms(node, T);
      current = node.parent;
    }
    // If we never reached dst, return identity (render in sensor frame)
    return current === dst ? T : null;
  }

  /** Apply a transform chain to an array of Point3D objects */
  function transformPoints(points, T) {
    if (!T || (T.translation.x === 0 && T.translation.y === 0 && T.translation.z === 0 &&
               T.rotation.x === 0 && T.rotation.y === 0 && T.rotation.z === 0 && Math.abs(T.rotation.w - 1) < 1e-6)) {
      return points; // identity → no-op
    }
    return points.map((p) => {
      const out = applyTransform(T, p);
      return { x: Number(out.x.toFixed(3)), y: Number(out.y.toFixed(3)), z: Number(out.z.toFixed(3)), intensity: p.intensity };
    });
  }

  async function loadBag() {
    if (!bagPromise) {
      bagPromise = rosbag.open(absolutePath);
    }

    const bag = await bagPromise;
    cachedBag = bag;
    if (topics.length === 0) {
      topics = summarizeRosbagTopics(bag);
      selectedTopics = chooseRosbagTopics(topics);
      // Pre-load TF in background so transforms are ready
      void loadTransforms(bag);
    }

    return bag;
  }

  function emitStatus() {
    lastStatusEmitMs = Date.now();
    const durationSeconds = cachedBag
      ? Number((timeToSeconds(cachedBag.endTime) - timeToSeconds(cachedBag.startTime)).toFixed(3))
      : 0;
    emit({
      type: "status",
      connected: playing && !completed,
      source: "rosbag-playback",
      topic: selectedTopics.join(", ") || "recorded-bag",
    });
    emit({
      type: "bag-status",
      connected: fs.existsSync(absolutePath),
      playing,
      source: "rosbag-playback",
      path: absolutePath,
      frameCount: topics.reduce((total, topic) => total + topic.count, 0),
      cursor,
      topics: topics.slice(0, MAX_TOPIC_SAMPLES),
      currentTime,
      startTime: cachedBag?.startTime ? timeToString(cachedBag.startTime) : "",
      endTime: cachedBag?.endTime ? timeToString(cachedBag.endTime) : "",
      durationSeconds,
    });
  }

  function getStatus() {
    return {
      type: "status",
      connected: playing && !completed,
      source: "rosbag-playback",
      topic: selectedTopics.join(", ") || "recorded-bag",
    };
  }

  function resetPlaybackClock(time) {
    wallPlaybackStartMs = Date.now();
    bagPlaybackBaseSeconds = timeToSeconds(time);
  }

  function getDuePlaybackSeconds() {
    if (!wallPlaybackStartMs) {
      return Number.POSITIVE_INFINITY;
    }

    return bagPlaybackBaseSeconds + ((Date.now() - wallPlaybackStartMs) / 1000) * BAG_PLAYBACK_RATE;
  }

  function publishQueuedFrame() {
    let published = 0;
    const maxPublished = Math.max(BAG_PLAYBACK_BATCH_SIZE, Math.ceil(BAG_PLAYBACK_BATCH_SIZE * BAG_PLAYBACK_RATE));
    const duePlaybackSeconds = getDuePlaybackSeconds();
    while (queue.length > 0 && published < maxPublished) {
      const dueIndex = queue.findIndex((packet) => !packet.time || timeToSeconds(packet.time) <= duePlaybackSeconds);
      if (dueIndex < 0) {
        break;
      }

      const cameraIndex = queue.findIndex(
        (packet, index) =>
          index < maxPublished &&
          packet.type === "camera-frame" &&
          (!packet.time || timeToSeconds(packet.time) <= duePlaybackSeconds),
      );
      const packet = cameraIndex >= 0 ? queue.splice(cameraIndex, 1)[0] : queue.splice(dueIndex, 1)[0];
      if (packet) {
        published += 1;
        currentTime = packet.time || currentTime;
        emit(packet);
      }
    }

    const shouldEmitStatus = published > 0 || Date.now() - lastStatusEmitMs > 800;
    if (shouldEmitStatus) {
      emitStatus();
    }

    if (completed && queue.length === 0) {
      stop();
      return;
    }

    if (playing && !completed && !reading && queue.length < BAG_PLAYBACK_BATCH_SIZE * 2) {
      void readNextSegment(readGeneration);
    }
  }

  async function readNextSegment(generation) {
    if (reading) {
      return;
    }

    reading = true;
    try {
      const bag = await loadBag();
      const startTime = playbackReadTime || playbackStartTime || bag.startTime;
      const windowEndTime = addSeconds(playbackStartTime || bag.startTime, BAG_WINDOW_SECONDS) || bag.endTime;
      const segmentEndTime = secondsToTime(
        Math.min(
          timeToSeconds(startTime) + BAG_READ_CHUNK_SECONDS,
          timeToSeconds(windowEndTime),
          timeToSeconds(bag.endTime),
        ),
      );
      emitStatus();
      await bag.readMessages(
        {
          topics: selectedTopics,
          startTime,
          endTime: segmentEndTime,
        },
        (result) => {
          if (generation !== readGeneration) {
            return;
          }

          const resultType = topics.find((topic) => topic.topic === result.topic)?.type || "";
          const lowerResultType = resultType.toLowerCase();
          const lowerResultTopic = result.topic.toLowerCase();
          const isPointCloud =
            lowerResultType.includes("pointcloud") ||
            lowerResultTopic.includes("rslidar_points") ||
            lowerResultTopic.includes("point_cloud");
          const resultSeconds = timeToSeconds(result.timestamp);
          const throttleInterval = getThrottleInterval(result.topic, resultType);
          const lastQueuedTime = lastQueuedTimeByTopic.get(result.topic) ?? Number.NEGATIVE_INFINITY;

          currentTime = timeToString(result.timestamp);
          cursor += 1;

          // Always capture odom pose even if throttled, for point cloud transforms
          if ((lowerResultType.includes("odometry") || lowerResultTopic.includes("odom")) && result.message?.pose?.pose) {
            latestOdomPose = result.message.pose.pose;
          }

          if (resultSeconds - lastQueuedTime < throttleInterval) {
            return;
          }

          if (isPointCloud && queue.some((queuedPacket) => queuedPacket.type === "point-cloud" && queuedPacket.topic === result.topic)) {
            return;
          }

          const packet = normalizeFrame({
            topic: result.topic,
            type: resultType,
            time: timeToString(result.timestamp),
            message: result.message,
          });

          if (packet.type === "point-cloud") {
            queue = queue.filter((queuedPacket) => queuedPacket.type !== "point-cloud" || queuedPacket.topic !== packet.topic);

            // Keep points in sensor frame — stable and always visible
            if (packet.frameId && packet.points?.length > 0) {
              packet.resolvedFrame = packet.frameId;
            }
          }

          queue.push(packet);
          queue.sort((a, b) => timeToSeconds(a.time) - timeToSeconds(b.time));
          lastQueuedTimeByTopic.set(result.topic, resultSeconds);
          if (queue.length > MAX_PLAYBACK_QUEUE) {
            queue = queue.slice(Math.floor(MAX_PLAYBACK_QUEUE / -2));
          }
        },
      );
      if (generation === readGeneration) {
        playbackReadTime = segmentEndTime;
        completed = timeToSeconds(segmentEndTime) >= timeToSeconds(windowEndTime) || timeToSeconds(segmentEndTime) >= timeToSeconds(bag.endTime);
      }
    } catch (error) {
      if (generation !== readGeneration) {
        return;
      }
      console.error("Failed to read rosbag:", error.message);
      completed = true;
      playing = false;
      emitStatus();
    } finally {
      if (generation === readGeneration) {
        reading = false;
      }
    }
  }

  async function start() {
    if (playing) {
      if (!completed && !reading && queue.length === 0) {
        void readNextSegment(readGeneration);
      }
      return;
    }

    playing = true;
    completed = false;
    cursor = 0;
    queue = [];
    lastQueuedTimeByTopic.clear();
    const bag = await loadBag();
    playbackStartTime = playbackStartTime || bag.startTime;
    playbackReadTime = playbackStartTime;
    currentTime = timeToString(playbackStartTime);
    resetPlaybackClock(playbackStartTime);
    emitStatus();
    readGeneration += 1;
    void readNextSegment(readGeneration);
    timer = setInterval(publishQueuedFrame, BAG_PLAYBACK_INTERVAL_MS);
  }

  async function seek(ratio) {
    const bag = await loadBag();
    const duration = timeToSeconds(bag.endTime) - timeToSeconds(bag.startTime);
    const clampedRatio = Math.max(0, Math.min(1, Number(ratio) || 0));
    const targetSeconds = timeToSeconds(bag.startTime) + duration * clampedRatio;

    latestOdomPose = null;
    playbackStartTime = secondsToTime(targetSeconds);
    playbackReadTime = playbackStartTime;
    currentTime = timeToString(playbackStartTime);
    resetPlaybackClock(playbackStartTime);
    queue = [];
    lastQueuedTimeByTopic.clear();
    cursor = Math.round(topics.reduce((total, topic) => total + topic.count, 0) * clampedRatio);
    completed = false;
    readGeneration += 1;

    if (!playing) {
      playing = true;
      if (timer) {
        clearInterval(timer);
      }
      timer = setInterval(publishQueuedFrame, BAG_PLAYBACK_INTERVAL_MS);
    }

    emitStatus();
    void readNextSegment(readGeneration);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }

    playing = false;
    readGeneration += 1;
    reading = false;
    emitStatus();
  }

  return {
    getStatus,
    seek,
    start,
    stop,
  };
}

export function createBagPlaybackSource({ emit, filePath } = {}) {
  const playbackPath = filePath || BAG_FILE_PATH || BAG_EXPORT_PATH;
  if (playbackPath.toLowerCase().endsWith(".bag")) {
    return createRosbagPlaybackSource({ emit, filePath: playbackPath });
  }

  return createJsonPlaybackSource({ emit, filePath: playbackPath });
}
