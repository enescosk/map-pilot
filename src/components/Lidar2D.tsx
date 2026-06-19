import { useEffect, useMemo, useRef } from "react";
import type { LidarReading, Point3D } from "../types/liveMessages";
import { scanReadingsToPoints } from "../utils/lidarProcessing";

// =====================================================================
// Lidar2D — Foxglove-style top-down view
//
// Screen mapping (right-handed, north-up):
//   ROS x (forward)  →  screen up   (decreasing y)
//   ROS y (left)     →  screen left (decreasing x)
//
// Inputs:
//   readings  — LaserScan polar samples (degrees + distance)
//   points    — full 3D point cloud (used in preference if non-empty)
// =====================================================================
export function Lidar2D({ readings, points }: { readings: LidarReading[]; points?: Point3D[] }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Prefer the 3D cloud (projected top-down by ignoring z); fall back to polar readings.
  const flatPoints = useMemo(() => {
    if (points && points.length > 0) {
      return points
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
        .map((p) => ({
          x: p.x,
          y: p.y,
          intensity: Number(p.intensity || 0),
          distance: Math.hypot(p.x, p.y),
        }));
    }
    return scanReadingsToPoints(readings).map((p) => ({
      x: p.x,
      y: p.y,
      intensity: Number(p.intensity || 0),
      distance: Math.hypot(p.x, p.y),
    }));
  }, [points, readings]);

  // Auto-pick a nice range bound that contains 95% of points.
  const maxRange = useMemo(() => {
    if (flatPoints.length === 0) return 10;
    const sorted = flatPoints.map((p) => p.distance).sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 10;
    const niceValues = [2, 5, 10, 20, 30, 50, 80, 120, 200];
    return niceValues.find((v) => v >= p95) || Math.ceil(p95);
  }, [flatPoints]);

  // Draw on every change (and on resize).
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) return undefined;

    const draw = () => {
      const rect = wrapper.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Background
      ctx.fillStyle = "#070b12";
      ctx.fillRect(0, 0, width, height);

      const cx = width / 2;
      const cy = height / 2;
      // 90% of the half-extent maps to maxRange — leaves room for labels.
      const scale = (Math.min(width, height) * 0.45) / maxRange;

      // Grid (light)
      ctx.strokeStyle = "rgba(40, 70, 110, 0.35)";
      ctx.lineWidth = 1;
      const gridStep = maxRange <= 10 ? 1 : maxRange <= 30 ? 5 : maxRange <= 100 ? 10 : 25;
      for (let r = gridStep; r <= maxRange; r += gridStep) {
        const sx = r * scale;
        ctx.beginPath();
        ctx.moveTo(cx - sx, 0);
        ctx.lineTo(cx - sx, height);
        ctx.moveTo(cx + sx, 0);
        ctx.lineTo(cx + sx, height);
        ctx.moveTo(0, cy - sx);
        ctx.lineTo(width, cy - sx);
        ctx.moveTo(0, cy + sx);
        ctx.lineTo(width, cy + sx);
        ctx.stroke();
      }

      // Range rings
      const ringDistances = [1, 2, 5, 10, 20, 30, 50, 80, 100, 150].filter((d) => d <= maxRange);
      ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
      for (const d of ringDistances) {
        ctx.strokeStyle = "rgba(56, 189, 248, 0.28)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, d * scale, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = "rgba(148, 163, 184, 0.7)";
        ctx.fillText(`${d}m`, cx + d * scale + 3, cy - 3);
      }

      // Cardinal axes — forward = up
      ctx.strokeStyle = "rgba(56, 189, 248, 0.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, height);
      ctx.moveTo(0, cy);
      ctx.lineTo(width, cy);
      ctx.stroke();

      // Points — color by distance; close obstacles glow red.
      const CLOSE_OBSTACLE_M = 2;
      for (const p of flatPoints) {
        // ROS x (forward) → screen up (y decreases as you go up)
        // ROS y (left)    → screen left (x decreases as you go left)
        const sx = cx - p.y * scale;
        const sy = cy - p.x * scale;
        if (sx < 0 || sx > width || sy < 0 || sy > height) continue;
        const t = Math.min(1, p.distance / maxRange);
        let color: string;
        if (p.distance <= CLOSE_OBSTACLE_M) {
          color = "rgba(248, 113, 113, 0.95)"; // red — close obstacle
        } else {
          // Turbo-ish ramp from cyan (near) to magenta (far)
          const hue = 190 - t * 200;
          color = `hsl(${hue}, 90%, 60%)`;
        }
        ctx.fillStyle = color;
        ctx.fillRect(sx - 1, sy - 1, 2, 2);
      }

      // Ego vehicle marker — triangle pointing up (forward)
      ctx.save();
      ctx.translate(cx, cy);
      ctx.fillStyle = "#fbbf24";
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, -14);
      ctx.lineTo(-9, 9);
      ctx.lineTo(0, 5);
      ctx.lineTo(9, 9);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // Direction labels
      ctx.fillStyle = "rgba(251, 191, 36, 0.95)";
      ctx.font = "bold 11px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText("FRONT", cx - 18, 14);
      ctx.fillStyle = "rgba(148, 163, 184, 0.7)";
      ctx.fillText("BACK", cx - 16, height - 6);
      ctx.fillText("LEFT", 4, cy - 4);
      ctx.fillText("RIGHT", width - 36, cy - 4);
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [flatPoints, maxRange]);

  return (
    <div ref={wrapperRef} className="lidar-2d-stage">
      <canvas ref={canvasRef} style={{ display: "block" }} />
      <div className="lidar-2d-hud">
        <span>{flatPoints.length.toLocaleString()} pts</span>
        <span>Range {maxRange} m</span>
      </div>
    </div>
  );
}
