import { useMemo } from "react";
import type { GpsFix } from "../types/telemetry";
import { formatNumber } from "../utils/telemetryFormatters";
import { EmptyState } from "./EmptyState";

type GpsTrailPoint = {
  latitude: number;
  longitude: number;
};

export function MapPanel({ gps, speed }: { gps: GpsFix; speed: number }) {
  const lat = Number(gps.latitude);
  const lon = Number(gps.longitude);
  const hasFix = Number.isFinite(lat) && Number.isFinite(lon);
  const mapCenter = useMemo<GpsTrailPoint | undefined>(() => {
    if (!hasFix) {
      return undefined;
    }

    const snap = 0.0025;
    return {
      latitude: Math.round(lat / snap) * snap,
      longitude: Math.round(lon / snap) * snap,
    };
  }, [hasFix, lat, lon]);

  const mapSrc = mapCenter
    ? `https://www.openstreetmap.org/export/embed.html?bbox=${mapCenter.longitude - 0.006}%2C${mapCenter.latitude - 0.004}%2C${mapCenter.longitude + 0.006}%2C${mapCenter.latitude + 0.004}&layer=mapnik&marker=${mapCenter.latitude}%2C${mapCenter.longitude}`
    : "";

  return (
    <section className="workspace-panel map-workspace">
      <div className="panel-titlebar">
        <span>Map</span>
        <strong>{hasFix ? `${formatNumber(lat, 5)}, ${formatNumber(lon, 5)}` : "No fix"}</strong>
      </div>
      {mapSrc ? <iframe title="OpenStreetMap vehicle position" src={mapSrc} /> : <EmptyState icon="map" title="GPS bekleniyor" hint="Konum sabitlenince harita yüklenecek" connecting />}
      <div className="metric-strip">
        <span>Speed {formatNumber(speed)} m/s</span>
        <span>Alt {formatNumber(gps.altitude)} m</span>
      </div>
    </section>
  );
}
