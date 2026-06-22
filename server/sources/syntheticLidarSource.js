// Synthetic LiDAR source — generates a realistic point cloud + telemetry stream
// without any hardware. Used for local verification of the dashboard / LiDAR
// panel (screenshots, manual QA). Enable with LIDAR_SOURCE=synthetic.
//
// Scene: a vehicle at the origin driving down a corridor. We emit a roof-mounted
// spinning-LiDAR style cloud each frame: ground plane, two side walls, a few
// box obstacles, and a couple of pillars — all with plausible intensity values.

const TOPIC = "/rslidar_points";
const FRAME_ID = "rslidar";
const SCAN_HZ = 10;

function rand(min, max) {
  return min + Math.random() * (max - min);
}

// Build one frame of points. `t` is elapsed seconds, used to animate the scene
// (corridor scrolling toward the ego) so the view looks alive across frames.
function buildFrame(t) {
  const points = [];
  const scroll = (t * 4) % 12; // obstacles drift toward the ego at 4 m/s

  // Ground plane — sparse grid out to ~30 m with a little height noise.
  for (let i = 0; i < 4500; i++) {
    const x = rand(0.5, 32);
    const y = rand(-9, 9);
    const z = rand(-0.06, 0.06) - 1.6; // ground sits ~1.6 m below the sensor
    points.push({ x, y, z, intensity: rand(20, 70) });
  }

  // Two side walls (corridor) at y = ±8, rising to ~3 m.
  for (const side of [-1, 1]) {
    for (let i = 0; i < 2600; i++) {
      const x = rand(0.5, 32);
      const y = side * rand(7.6, 8.0);
      const z = rand(-1.6, 3.0);
      points.push({ x, y, z, intensity: rand(120, 200) });
    }
  }

  // Box obstacles ahead — give them strong returns so they pop in intensity mode.
  const boxes = [
    { cx: 8 - scroll + 12, cy: 2.5, w: 1.8, d: 1.8, h: 1.6 },
    { cx: 14 - scroll, cy: -3.0, w: 2.2, d: 4.4, h: 1.5 },
    { cx: 22 - scroll, cy: 1.0, w: 1.6, d: 1.6, h: 2.2 },
  ];
  for (const box of boxes) {
    if (box.cx < 1) continue;
    for (let i = 0; i < 1400; i++) {
      const x = box.cx + rand(-box.d / 2, box.d / 2);
      const y = box.cy + rand(-box.w / 2, box.w / 2);
      const z = rand(-1.6, -1.6 + box.h);
      points.push({ x, y, z, intensity: rand(180, 255) });
    }
  }

  // A couple of thin pillars.
  for (const pillar of [{ cx: 6, cy: -5.5 }, { cx: 18, cy: 5.0 }]) {
    for (let i = 0; i < 500; i++) {
      const x = pillar.cx + rand(-0.18, 0.18);
      const y = pillar.cy + rand(-0.18, 0.18);
      const z = rand(-1.6, 2.4);
      points.push({ x, y, z, intensity: rand(200, 255) });
    }
  }

  return points;
}

export function createSyntheticLidarSource({ emit }) {
  let timer;
  let telemetryTimer;
  let running = false;
  const startMs = Date.now();

  function getStatus() {
    return { type: "status", connected: running, source: "synthetic" };
  }

  function emitFrame() {
    const t = (Date.now() - startMs) / 1000;
    const points = buildFrame(t);
    emit({
      type: "point-cloud",
      topic: TOPIC,
      source: "synthetic",
      frameId: FRAME_ID,
      resolvedFrame: FRAME_ID,
      time: new Date().toISOString(),
      points,
    });
  }

  function emitTelemetry() {
    const t = (Date.now() - startMs) / 1000;
    const speed = 4 + Math.sin(t / 3) * 1.5; // m/s
    emit({
      type: "telemetry",
      source: "synthetic",
      topic: "/synthetic",
      time: new Date().toISOString(),
      telemetry: {
        speed,
        vehicle: { speedKmh: Number((speed * 3.6).toFixed(1)) },
        acceleration: { x: Math.sin(t) * 0.4, y: Math.cos(t) * 0.2, z: 9.81 },
        angularVelocity: { x: 0, y: 0, z: Math.sin(t / 2) * 0.05 },
        gps: { latitude: 41.015 + t * 1e-5, longitude: 28.979 + t * 1e-5 },
      },
    });
  }

  function start() {
    if (running) return;
    running = true;
    emit(getStatus());
    emitFrame();
    emitTelemetry();
    timer = setInterval(emitFrame, 1000 / SCAN_HZ);
    telemetryTimer = setInterval(emitTelemetry, 100);
  }

  function stop() {
    running = false;
    if (timer) clearInterval(timer);
    if (telemetryTimer) clearInterval(telemetryTimer);
    timer = undefined;
    telemetryTimer = undefined;
    emit(getStatus());
  }

  return { getStatus, start, stop };
}
