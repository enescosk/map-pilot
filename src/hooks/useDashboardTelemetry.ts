import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TelemetryMessage } from "../types/liveMessages";
import type { CockpitEvent, DecisionLogEntry, SeriesPoint, TelemetryState } from "../types/telemetry";
import { formatNumber, vectorMagnitude } from "../utils/telemetryFormatters";
import { timeLabel, timeStringToSeconds } from "../utils/timeLabel";

const MAX_SERIES_POINTS = 80;
const MAX_COCKPIT_EVENTS = 120;
// Minimum ms between React state flushes for telemetry (targets ~30 fps UI updates)
const TELEMETRY_FLUSH_MS = 33;

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
  if (exists) return events;
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

type PendingTelemetry = {
  patch: TelemetryMessage["telemetry"];
  label: string;
  isDerived: boolean;
};

export function useDashboardTelemetry() {
  const [telemetry, setTelemetry] = useState<TelemetryState>(emptyTelemetry);
  const [cockpitEvents, setCockpitEvents] = useState<CockpitEvent[]>([]);
  const [series, setSeries] = useState(emptySeries);
  const nativeSpeedSeenRef = useRef(false);

  // Batch buffer: accumulate patches between RAF ticks
  const pendingRef = useRef<PendingTelemetry[]>([]);
  const rafRef = useRef<number | undefined>(undefined);
  const lastFlushRef = useRef<number>(0);

  const flush = useCallback(() => {
    rafRef.current = undefined;
    const pending = pendingRef.current;
    if (pending.length === 0) return;
    pendingRef.current = [];
    lastFlushRef.current = Date.now();

    setTelemetry((prev) => {
      let next = prev;
      const newEvents: CockpitEvent[] = [];
      let newSeries = { ...prev } as unknown as typeof series;
      let seriesChanged = false;

      for (const { patch, label, isDerived } of pending) {
        const vehiclePatch = { ...patch.vehicle };
        if (!isDerived && (typeof patch.speed === "number" || typeof vehiclePatch.speedKmh === "number")) {
          nativeSpeedSeenRef.current = true;
        }
        if (isDerived && nativeSpeedSeenRef.current) {
          delete vehiclePatch.speedKmh;
        }

        const merged: TelemetryState = {
          ...next,
          ...patch,
          speed: isDerived && nativeSpeedSeenRef.current && typeof patch.speed === "number"
            ? next.speed
            : patch.speed ?? next.speed,
          gps: patch.gps ? { ...next.gps, ...patch.gps } : next.gps,
          acceleration: patch.acceleration ? { ...next.acceleration, ...patch.acceleration } : next.acceleration,
          angularVelocity: patch.angularVelocity ? { ...next.angularVelocity, ...patch.angularVelocity } : next.angularVelocity,
          magneticField: patch.magneticField ? { ...next.magneticField, ...patch.magneticField } : next.magneticField,
          vehicle: { ...next.vehicle, ...vehiclePatch },
        };

        const accMag = vectorMagnitude(merged.acceleration);
        const oldAccMag = vectorMagnitude(next.acceleration);
        if (accMag > 12 && oldAccMag <= 12) {
          newEvents.push({
            id: `acc-${label}-${Math.random()}`,
            timestamp: timeStringToSeconds(label),
            timeLabel: label,
            severity: "warning",
            source: "imu",
            title: "High Acceleration Spike",
            description: `Acceleration reached ${formatNumber(accMag)} m/s²`,
          });
        }
        if (next.speed > 2 && merged.speed < 0.5) {
          newEvents.push({
            id: `stop-${label}-${Math.random()}`,
            timestamp: timeStringToSeconds(label),
            timeLabel: label,
            severity: "critical",
            source: "speed",
            title: "Sudden Stop",
            description: `Speed dropped rapidly from ${formatNumber(next.speed)} to ${formatNumber(merged.speed)} m/s`,
          });
        }
        next = merged;
      }

      // Rebuild series from final merged state — only update if something changed
      setSeries((current) => {
        const last = pending[pending.length - 1];
        if (!last) return current;
        const { patch, isDerived } = last;
        let updated = current;
        if (patch.acceleration) {
          updated = { ...updated, acceleration: pushSeries(current.acceleration, vectorMagnitude(next.acceleration), last.label) };
          seriesChanged = true;
        }
        if (patch.angularVelocity) {
          updated = { ...updated, angularVelocity: pushSeries(current.angularVelocity, vectorMagnitude(next.angularVelocity), last.label) };
          seriesChanged = true;
        }
        if (typeof patch.speed === "number" && !(isDerived && nativeSpeedSeenRef.current)) {
          updated = { ...updated, speed: pushSeries(current.speed, next.speed, last.label) };
          seriesChanged = true;
        }
        if (patch.magneticField) {
          updated = { ...updated, magneticField: pushSeries(current.magneticField, vectorMagnitude(next.magneticField), last.label) };
          seriesChanged = true;
        }
        return seriesChanged ? updated : current;
      });
      void newSeries; // suppress unused warning

      if (newEvents.length > 0) {
        setCockpitEvents((events) => {
          let updated = events;
          for (const ev of newEvents) updated = appendCockpitEvent(updated, ev);
          return updated;
        });
      }

      return next;
    });
  }, []);

  const handleTelemetryMessage = useCallback((packet: TelemetryMessage) => {
    const label = timeLabel(packet.time);
    const isDerived = packet.telemetry?.derived === true;
    pendingRef.current.push({ patch: packet.telemetry, label, isDerived });

    // Schedule a flush on the next animation frame, throttled to TELEMETRY_FLUSH_MS
    if (!rafRef.current) {
      const now = Date.now();
      const sinceLast = now - lastFlushRef.current;
      if (sinceLast >= TELEMETRY_FLUSH_MS) {
        rafRef.current = requestAnimationFrame(flush);
      } else {
        rafRef.current = window.setTimeout(() => {
          rafRef.current = undefined;
          rafRef.current = requestAnimationFrame(flush);
        }, TELEMETRY_FLUSH_MS - sinceLast) as unknown as number;
      }
    }
  }, [flush]);

  // Cleanup on unmount
  useEffect(() => () => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      clearTimeout(rafRef.current);
    }
  }, []);

  const resetTelemetry = useCallback(() => {
    nativeSpeedSeenRef.current = false;
    pendingRef.current = [];
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = undefined; }
    setTelemetry(emptyTelemetry);
    setCockpitEvents([]);
    setSeries(emptySeries());
  }, [flush]);

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
