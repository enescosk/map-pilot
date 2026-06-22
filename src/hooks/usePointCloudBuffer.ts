import { useCallback, useEffect, useRef } from "react";
import type { LidarReading, Point3D } from "../types/liveMessages";

export type PendingPointCloudPacket = {
  topic: string;
  points: Point3D[];
  readings?: LidarReading[];
  frameCount?: number;
  frameId?: string;
  resolvedFrame?: string;
  time?: string;
};

type UsePointCloudBufferArgs = {
  flushMs: number;
  onFlush: (packets: PendingPointCloudPacket[]) => void;
};

export function usePointCloudBuffer({ flushMs, onFlush }: UsePointCloudBufferArgs) {
  const pendingRef = useRef<Map<string, PendingPointCloudPacket>>(new Map());
  const timerRef = useRef<number | undefined>(undefined);
  const onFlushRef = useRef(onFlush);

  useEffect(() => {
    onFlushRef.current = onFlush;
  }, [onFlush]);

  const flush = useCallback(() => {
    timerRef.current = undefined;
    const pending = [...pendingRef.current.values()];
    pendingRef.current.clear();
    if (pending.length > 0) {
      onFlushRef.current(pending);
    }
  }, []);

  const enqueue = useCallback((packet: PendingPointCloudPacket) => {
    pendingRef.current.set(packet.topic, packet);
    if (!timerRef.current) {
      timerRef.current = window.setTimeout(flush, flushMs);
    }
  }, [flush, flushMs]);

  const clear = useCallback(() => {
    pendingRef.current.clear();
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }, []);

  useEffect(() => clear, [clear]);

  return { enqueue, clear, flush };
}
