import type { SeriesPoint } from "../types/telemetry";

export function SparkChart({ title, value, unit, data, color }: {
  title: string;
  value: string;
  unit: string;
  data: SeriesPoint[];
  color: string;
}) {
  const width = 320;
  const height = 106;
  const max = Math.max(...data.map((point) => Math.abs(point.value)), 1);
  const points = data
    .map((point, index) => {
      const x = data.length <= 1 ? 0 : (index / (data.length - 1)) * width;
      const y = height - (Math.abs(point.value) / max) * (height - 18) - 9;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <section className="chart-panel">
      <div className="panel-topline">
        <span>{title}</span>
        <strong>{value} {unit}</strong>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title} chart`}>
        <path d="M0 20 H320 M0 53 H320 M0 86 H320" className="chart-grid" />
        <polyline points={points} fill="none" stroke={color} strokeWidth="2.5" />
      </svg>
    </section>
  );
}
