import * as THREE from "three";

export function setTurboColor(color: THREE.Color, value: number) {
  const t = Math.max(0, Math.min(1, value));
  if (t < 0.2) {
    color.setHSL(0.62 - t * 0.7, 1, 0.55);
  } else if (t < 0.45) {
    color.setHSL(0.48 - (t - 0.2) * 0.5, 1, 0.5);
  } else if (t < 0.7) {
    color.setHSL(0.32 - (t - 0.45) * 0.45, 1, 0.5);
  } else {
    color.setHSL(0.11 - (t - 0.7) * 0.36, 1, 0.52);
  }
}

export function createPointSpriteTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) {
    return undefined;
  }

  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 31);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.45, "rgba(255,255,255,0.92)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

export function sourceModeInfo(source: string) {
  switch (source) {
    case "vehicle-ros":
      return { label: "vehicle-ros", kind: "Live ROS", waiting: "Waiting for live ROS topics..." };
    case "mqtt":
      return { label: "mqtt", kind: "Live MQTT", waiting: "Waiting for MQTT topics..." };
    case "rosbridge":
      return { label: "ros", kind: "Legacy live ROS", waiting: "Waiting for ROS scan topic..." };
    case "direct-serial":
      return { label: "direct", kind: "Bench live", waiting: "Waiting for direct LiDAR scan..." };
    default:
      return { label: source || "none", kind: "Source pending", waiting: "Waiting for backend source status..." };
  }
}

export function sourceHealthLabel(connected: boolean, isLiveSource: boolean, isStale: boolean) {
  if (isStale) return "topic stale";
  if (!isLiveSource) return connected ? "ready" : "idle";
  return connected ? "connected" : "disconnected";
}
