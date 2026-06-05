import { type CSSProperties } from "react";
import type { TelemetryState } from "../types/telemetry";
import { formatBoolean, formatGear, formatNumber } from "../utils/telemetryFormatters";
import { SpeedGauge } from "./SpeedGauge";
import { VehicleTopView } from "./VehicleTopView";

export function VehicleCockpit({ telemetry, time }: { telemetry: TelemetryState; time?: string }) {
  const vehicle = telemetry.vehicle;
  const steeringAngle = Number(vehicle.steeringAngle || 0);
  const hasTelemetry = telemetry.derived || telemetry.heading !== undefined || Object.values(vehicle).some((value) => value !== undefined);
  const steeringStyle = {
    "--steering-angle": `${Math.max(-90, Math.min(90, steeringAngle))}deg`,
  } as CSSProperties;

  return (
    <section className="workspace-panel telemetry-card cockpit-card">
      <div className="panel-titlebar">
        <span>Vehicle Cockpit</span>
        <strong>{time || "--"}</strong>
      </div>
      <div className="cockpit-layout">
        <SpeedGauge speedKmh={vehicle.speedKmh} speedMs={telemetry.speed} />
        <VehicleTopView vehicle={vehicle} />
        {!hasTelemetry && (
          <p className="panel-note cockpit-note">Telemetry unavailable for this source</p>
        )}
        <div className="cockpit-status-grid">
          <div className="cockpit-metric">
            <span>Steering</span>
            <strong>{formatNumber(vehicle.steeringAngle, 0)}°</strong>
            <em>target {formatNumber(vehicle.targetSteeringAngle, 0)}°</em>
          </div>
          <div className="steering-wheel-widget" style={steeringStyle} aria-label="Steering angle">
            <div className="steering-wheel">
              <span />
            </div>
          </div>
          <div className="cockpit-metric">
            <span>Brake</span>
            <strong>{formatNumber(vehicle.brakePercent, 0)}%</strong>
            <em>{formatNumber(vehicle.brakePressure, 1)} bar</em>
          </div>
          <div className="cockpit-metric">
            <span>Throttle</span>
            <strong>{formatNumber(vehicle.throttleSetSpeedKmh, 0)}</strong>
            <em>cruise {formatBoolean(vehicle.cruiseActive)}</em>
          </div>
          <div className="cockpit-metric">
            <span>Drive</span>
            <strong>{formatGear(vehicle.gear)}</strong>
            <em>{vehicle.mode || (telemetry.heading !== undefined ? `heading ${formatNumber(telemetry.heading, 0)}°` : "mode --")}</em>
          </div>
          <div className={vehicle.epsFault ? "cockpit-metric alert" : "cockpit-metric"}>
            <span>EPS</span>
            <strong>{formatBoolean(vehicle.epsWork)}</strong>
            <em>fault {formatBoolean(vehicle.epsFault)}</em>
          </div>
          <div className="cockpit-metric">
            <span>Battery</span>
            <strong>{formatNumber(vehicle.batterySoc, 0)}%</strong>
            <em>{formatNumber(vehicle.batteryVoltage, 0)} V</em>
          </div>
        </div>
      </div>
    </section>
  );
}
