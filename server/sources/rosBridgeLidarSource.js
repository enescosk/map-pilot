import WebSocket from "ws";

const ROSBRIDGE_URL = process.env.ROSBRIDGE_URL || "ws://localhost:9090";
const ROS_SCAN_TOPIC = process.env.ROS_SCAN_TOPIC || "/scan";
const MAX_SCAN_POINTS = Number(process.env.MAX_SCAN_POINTS || 180);

export function createRosBridgeLidarSource({ emit }) {
  let rosSocket;
  let subscribed = false;
  let connected = false;

  function emitStatus() {
    emit({
      type: "status",
      connected,
      source: "rosbridge",
      topic: ROS_SCAN_TOPIC,
    });
  }

  function getStatus() {
    return {
      type: "status",
      connected,
      source: "rosbridge",
      topic: ROS_SCAN_TOPIC,
    };
  }

  function laserScanToReadings(scan) {
    if (!scan || !Array.isArray(scan.ranges)) {
      return [];
    }

    const step = Math.max(1, Math.ceil(scan.ranges.length / MAX_SCAN_POINTS));
    const angleMin = Number(scan.angle_min || 0);
    const angleIncrement = Number(scan.angle_increment || 0);
    const rangeMin = Number(scan.range_min || 0);
    const rangeMax = Number(scan.range_max || Number.POSITIVE_INFINITY);
    const readings = [];

    for (let i = 0; i < scan.ranges.length; i += step) {
      const distance = Number(scan.ranges[i]);
      if (!Number.isFinite(distance) || distance < rangeMin || distance > rangeMax) {
        continue;
      }

      const angle = ((angleMin + i * angleIncrement) * 180) / Math.PI;
      readings.push({
        angle: Number(((angle + 360) % 360).toFixed(1)),
        distance: Number(distance.toFixed(3)),
      });
    }

    return readings;
  }

  function subscribeToScan() {
    if (!rosSocket || rosSocket.readyState !== WebSocket.OPEN || subscribed) {
      return;
    }

    rosSocket.send(
      JSON.stringify({
        op: "subscribe",
        topic: ROS_SCAN_TOPIC,
        throttle_rate: 100,
      }),
    );
    subscribed = true;
    connected = true;
    emitStatus();
    console.log(`Subscribed to ROS topic ${ROS_SCAN_TOPIC} through ${ROSBRIDGE_URL}`);
  }

  function unsubscribeFromScan() {
    if (!rosSocket || rosSocket.readyState !== WebSocket.OPEN || !subscribed) {
      return;
    }

    rosSocket.send(
      JSON.stringify({
        op: "unsubscribe",
        topic: ROS_SCAN_TOPIC,
      }),
    );
    subscribed = false;
    connected = false;
    emitStatus();
  }

  function connect() {
    if (rosSocket && rosSocket.readyState <= WebSocket.OPEN) {
      subscribeToScan();
      return;
    }

    rosSocket = new WebSocket(ROSBRIDGE_URL);

    rosSocket.on("open", () => {
      subscribeToScan();
    });

    rosSocket.on("message", (data) => {
      const packet = JSON.parse(data.toString());
      if (packet.op !== "publish" || packet.topic !== ROS_SCAN_TOPIC) {
        return;
      }

      const readings = laserScanToReadings(packet.msg);
      if (readings.length > 0) {
        emit({
          type: "scan",
          readings,
          source: "rosbridge",
          topic: ROS_SCAN_TOPIC,
        });
      }
    });

    rosSocket.on("close", () => {
      subscribed = false;
      connected = false;
      emitStatus();
    });

    rosSocket.on("error", (error) => {
      console.error("ROS bridge error:", error.message);
      connected = false;
      emitStatus();
    });
  }

  function start() {
    connect();
  }

  function stop() {
    unsubscribeFromScan();
  }

  return {
    getStatus,
    start,
    stop,
  };
}
