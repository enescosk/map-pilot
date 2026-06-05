import { formatNumber } from "../utils/telemetryFormatters";

export function SpeedGauge({ speedKmh, speedMs }: { speedKmh?: number; speedMs: number }) {
  const displaySpeed = Number.isFinite(speedKmh) ? Number(speedKmh) : speedMs * 3.6;
  const maxSpeed = 40;
  const ratio = Math.max(0, Math.min(1, displaySpeed / maxSpeed));
  const startAngle = 135;
  const sweepAngle = 270;
  const needleAngle = startAngle + ratio * sweepAngle;

  const angleToPoint = (angle: number, radius: number) => {
    const radians = (angle * Math.PI) / 180;
    return { x: 100 + Math.cos(radians) * radius, y: 100 + Math.sin(radians) * radius };
  };
  const arcPath = (start: number, end: number, radius = 66) => {
    const startPoint = angleToPoint(start, radius);
    const endPoint = angleToPoint(end, radius);
    const largeArc = Math.abs(end - start) > 180 ? 1 : 0;
    return `M ${startPoint.x.toFixed(2)} ${startPoint.y.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} 1 ${endPoint.x.toFixed(2)} ${endPoint.y.toFixed(2)}`;
  };
  const angleForSpeed = (speed: number) => startAngle + (Math.max(0, Math.min(maxSpeed, speed)) / maxSpeed) * sweepAngle;
  const needleEnd = angleToPoint(needleAngle, 57);

  return (
    <section className="speed-gauge-card" aria-label="Vehicle speed gauge">
      <div className="gauge-dial">
        <svg viewBox="0 0 200 200" role="img" aria-label={`${formatNumber(displaySpeed, 1)} km/h`}>
          <path className="gauge-track" d={arcPath(startAngle, startAngle + sweepAngle)} />
          <path className="gauge-band band-low" d={arcPath(angleForSpeed(0), angleForSpeed(14))} />
          <path className="gauge-band band-mid" d={arcPath(angleForSpeed(14.8), angleForSpeed(26))} />
          <path className="gauge-band band-high" d={arcPath(angleForSpeed(26.8), angleForSpeed(40))} />
          <path className="gauge-progress" d={arcPath(startAngle, needleAngle)} />
          <line className="gauge-needle" x1="100" y1="100" x2={needleEnd.x} y2={needleEnd.y} />
          <circle className="gauge-hub" cx="100" cy="100" r="9" />
          <text className="gauge-tick-svg" x="47" y="151">0</text>
          <text className="gauge-tick-svg" x="100" y="39">20</text>
          <text className="gauge-tick-svg" x="153" y="151">40</text>
        </svg>
        <div className="gauge-readout">
          <strong>{formatNumber(displaySpeed, 1)}</strong>
          <span>km/h</span>
        </div>
      </div>
      <div className="gauge-subreadout">
        <span>{formatNumber(speedMs)} m/s</span>
        <span>{formatNumber(ratio * 100, 0)}%</span>
      </div>
    </section>
  );
}
