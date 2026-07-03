import type { ReactNode } from "react";
import type { TelemetryState } from "../types/telemetry";
import { formatBoolean, formatGear, formatNumber } from "../utils/telemetryFormatters";
import { SpeedGauge } from "./SpeedGauge";
import { VehicleTopView } from "./VehicleTopView";

// Neutral placeholder shown when a value is absent — keeps empty cards uniform
// and quiet instead of scattering loud "-- km/h" / "--%" across the grid.
const NA = "—";

function CockpitMetric({
  label,
  value,
  sub,
  alert,
}: {
  label: string;
  value?: string;
  sub?: ReactNode;
  alert?: boolean;
}) {
  const empty = value === undefined;
  return (
    <div className={`cockpit-metric${alert ? " alert" : ""}${empty ? " is-empty" : ""}`}>
      <span>{label}</span>
      <strong>{value ?? NA}</strong>
      {sub !== undefined && <em>{sub}</em>}
    </div>
  );
}

export function VehicleCockpit({ telemetry, time }: { telemetry: TelemetryState; time?: string }) {
  const vehicle = telemetry.vehicle;
  const hasTelemetry = telemetry.derived || telemetry.heading !== undefined || Object.values(vehicle).some((value) => value !== undefined);
  const gps = telemetry.gps || {};
  const hasGps = gps.latitude !== undefined && gps.longitude !== undefined;

  const has = (value?: number) => Number.isFinite(value);
  const driveSub = vehicle.mode
    || (telemetry.heading !== undefined ? `heading ${formatNumber(telemetry.heading, 0)}°` : `mode ${NA}`);

  return (
    <section className="workspace-panel telemetry-card cockpit-card">
      <div className="panel-titlebar">
        <span>Araç Kokpiti</span>
        <strong>{time || "--"}</strong>
      </div>
      <div className="cockpit-layout">
        <SpeedGauge speedKmh={vehicle.speedKmh} speedMs={telemetry.speed} />
        <VehicleTopView vehicle={vehicle} />
        {!hasTelemetry && (
          <p className="panel-note cockpit-note">Telemetry unavailable for this source</p>
        )}
        <div className="cockpit-status-grid">
          <CockpitMetric
            label="Steering"
            value={has(vehicle.steeringAngle) ? `${formatNumber(vehicle.steeringAngle, 0)}°` : undefined}
            sub={`target ${has(vehicle.targetSteeringAngle) ? `${formatNumber(vehicle.targetSteeringAngle, 0)}°` : NA}`}
          />
          <CockpitMetric
            label="Brake"
            value={has(vehicle.brakePercent) ? `${formatNumber(vehicle.brakePercent, 0)}%` : undefined}
            sub={`${has(vehicle.brakePressure) ? `${formatNumber(vehicle.brakePressure, 1)} bar` : `${NA} bar`}`}
          />
          <CockpitMetric
            label="Throttle"
            value={has(vehicle.throttleSetSpeedKmh) ? `${formatNumber(vehicle.throttleSetSpeedKmh, 0)} km/h` : undefined}
            sub={`cruise ${typeof vehicle.cruiseActive === "boolean" ? formatBoolean(vehicle.cruiseActive) : NA}`}
          />
          <CockpitMetric
            label="Drive"
            value={has(vehicle.gear) ? formatGear(vehicle.gear) : undefined}
            sub={driveSub}
          />
          <CockpitMetric
            label="EPS"
            value={typeof vehicle.epsWork === "boolean" ? formatBoolean(vehicle.epsWork) : undefined}
            sub={`fault ${typeof vehicle.epsFault === "boolean" ? formatBoolean(vehicle.epsFault) : NA}`}
            alert={vehicle.epsFault === true}
          />
          <CockpitMetric
            label="Battery"
            value={has(vehicle.batterySoc) ? `${formatNumber(vehicle.batterySoc, 0)}%` : undefined}
            sub={`${has(vehicle.batteryVoltage) ? `${formatNumber(vehicle.batteryVoltage, 0)} V` : `${NA} V`}`}
          />
          <CockpitMetric
            label="Heading"
            value={telemetry.heading !== undefined ? `${formatNumber(telemetry.heading, 0)}°` : undefined}
            sub="compass"
          />
          {hasGps && (
            <>
              <CockpitMetric label="Latitude" value={`${formatNumber(gps.latitude, 5)}°`} sub="GPS" />
              <CockpitMetric label="Longitude" value={`${formatNumber(gps.longitude, 5)}°`} sub="GPS" />
              {gps.altitude !== undefined && (
                <CockpitMetric label="Altitude" value={`${formatNumber(gps.altitude, 1)} m`} sub="GPS" />
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
