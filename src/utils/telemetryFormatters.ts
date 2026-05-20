import type { Vector3 } from "../types/telemetry";

export function vectorMagnitude(vector?: Vector3) {
  if (!vector) {
    return 0;
  }

  return Math.hypot(Number(vector.x || 0), Number(vector.y || 0), Number(vector.z || 0));
}

export function formatNumber(value?: number, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : "--";
}

export function formatDuration(seconds?: number) {
  if (!Number.isFinite(seconds)) {
    return "00:00";
  }

  const total = Math.max(0, Math.floor(Number(seconds)));
  const minutes = Math.floor(total / 60);
  const remainingSeconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

export function formatFileSize(bytes?: number) {
  const size = Number(bytes || 0);
  if (size >= 1_073_741_824) {
    return `${(size / 1_073_741_824).toFixed(1)} GB`;
  }
  if (size >= 1_048_576) {
    return `${(size / 1_048_576).toFixed(1)} MB`;
  }
  return `${Math.max(0, Math.round(size / 1024))} KB`;
}

export function formatBoolean(value?: boolean) {
  if (typeof value !== "boolean") {
    return "--";
  }

  return value ? "On" : "Off";
}

export function formatGear(value?: number) {
  switch (Number(value)) {
    case 0:
      return "N";
    case 1:
      return "D";
    case 2:
      return "R";
    default:
      return Number.isFinite(value) ? String(value) : "--";
  }
}
