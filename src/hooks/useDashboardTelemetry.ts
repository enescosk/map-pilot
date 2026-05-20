import { useCallback, useMemo, useState } from "react";
import type { TelemetryMessage } from "../types/liveMessages";
import type { CockpitEvent, DecisionLogEntry, SeriesPoint, TelemetryState } from "../types/telemetry";
import { formatNumber, vectorMagnitude } from "../utils/telemetryFormatters";
import { timeLabel, timeStringToSeconds } from "../utils/timeLabel";

const MAX_SERIES_POINTS = 80;
const MAX_COCKPIT_EVENTS = 120;

export const emptyTelemetry: TelemetryState = {
  speed: 0,
  acceleration: {},
  angularVelocity: {},
  magneticField: {},
  gps: {},
  vehicle: {},
};

function pushSeries(series: SeriesPoint[], value: number, label: string) {
  return [...series, { value, label }].slice(-MAX_SERIES_POINTS);
}

function appendCockpitEvent(events: CockpitEvent[], event: CockpitEvent) {
  const duplicateWindowSeconds = 1.2;
  const exists = events.some((current) => (
    current.source === event.source &&
    current.title === event.title &&
    Math.abs(current.timestamp - event.timestamp) < duplicateWindowSeconds
  ));

  if (exists) {
    return events;
  }

  return [...events, event].slice(-MAX_COCKPIT_EVENTS);
}

function emptySeries() {
  return {
    acceleration: [] as SeriesPoint[],
    angularVelocity: [] as SeriesPoint[],
    speed: [] as SeriesPoint[],
    magneticField: [] as SeriesPoint[],
  };
}

export function useDashboardTelemetry() {
  const [telemetry, setTelemetry] = useState<TelemetryState>(emptyTelemetry);
  const [cockpitEvents, setCockpitEvents] = useState<CockpitEvent[]>([]);
  const [series, setSeries] = useState(emptySeries);

  const resetTelemetry = useCallback(() => {
    setTelemetry(emptyTelemetry);
    setCockpitEvents([]);
    setSeries(emptySeries());
  }, []);

  const handleTelemetryMessage = useCallback((packet: TelemetryMessage) => {
    const label = timeLabel(packet.time);

    setTelemetry((prev) => {
      const next = {
        ...prev,
        ...packet.telemetry,
        gps: { ...prev.gps, ...packet.telemetry.gps },
        acceleration: { ...prev.acceleration, ...packet.telemetry.acceleration },
        angularVelocity: { ...prev.angularVelocity, ...packet.telemetry.angularVelocity },
        magneticField: { ...prev.magneticField, ...packet.telemetry.magneticField },
        vehicle: { ...prev.vehicle, ...packet.telemetry.vehicle },
      };

      const accMag = vectorMagnitude(next.acceleration);
      const oldAccMag = vectorMagnitude(prev.acceleration);
      const speed = next.speed;
      const oldSpeed = prev.speed;

      if (accMag > 12 && oldAccMag <= 12) {
        setCockpitEvents((events) => appendCockpitEvent(events, {
          id: `acc-${packet.time}-${Math.random()}`,
          timestamp: timeStringToSeconds(packet.time),
          timeLabel: label,
          severity: "warning",
          source: "imu",
          title: "High Acceleration Spike",
          description: `Acceleration reached ${formatNumber(accMag)} m/s²`,
        }));
      }

      if (oldSpeed > 2 && speed < 0.5) {
        setCockpitEvents((events) => appendCockpitEvent(events, {
          id: `stop-${packet.time}-${Math.random()}`,
          timestamp: timeStringToSeconds(packet.time),
          timeLabel: label,
          severity: "critical",
          source: "speed",
          title: "Sudden Stop",
          description: `Speed dropped rapidly from ${formatNumber(oldSpeed)} to ${formatNumber(speed)} m/s`,
        }));
      }

      setSeries((current) => ({
        acceleration: packet.telemetry.acceleration
          ? pushSeries(current.acceleration, vectorMagnitude(next.acceleration), label)
          : current.acceleration,
        angularVelocity: packet.telemetry.angularVelocity
          ? pushSeries(current.angularVelocity, vectorMagnitude(next.angularVelocity), label)
          : current.angularVelocity,
        speed: typeof packet.telemetry.speed === "number"
          ? pushSeries(current.speed, packet.telemetry.speed, label)
          : current.speed,
        magneticField: packet.telemetry.magneticField
          ? pushSeries(current.magneticField, vectorMagnitude(next.magneticField), label)
          : current.magneticField,
      }));

      return next;
    });
  }, []);

  const decisionLogEntries: DecisionLogEntry[] = useMemo(() => (
    cockpitEvents.map((event) => ({
      id: event.id,
      time: event.timeLabel,
      source: event.source.toUpperCase(),
      message: `${event.title}: ${event.description}`,
    }))
  ), [cockpitEvents]);

  return {
    telemetry,
    series,
    cockpitEvents,
    decisionLogEntries,
    handleTelemetryMessage,
    resetTelemetry,
  };
}
