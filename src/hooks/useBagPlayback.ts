import { useMemo } from "react";
import type { BagStatus } from "../types/liveMessages";
import { timeStringToSeconds } from "../utils/timeLabel";

type UseBagPlaybackArgs = {
  bagStatus: BagStatus;
  pendingSeekRatio?: number;
  isLiveSource: boolean;
  sendMessage: (message: unknown) => boolean;
  setPendingSeekRatio: (ratio: number | undefined) => void;
  onBeforeSeek?: () => void;
};

export function useBagPlayback({
  bagStatus,
  pendingSeekRatio,
  isLiveSource,
  sendMessage,
  setPendingSeekRatio,
  onBeforeSeek,
}: UseBagPlaybackArgs) {
  const currentSeconds = Math.max(
    0,
    timeStringToSeconds(bagStatus.currentTime) - timeStringToSeconds(bagStatus.startTime),
  );
  const durationSeconds = Number(bagStatus.durationSeconds || 0);
  const playbackRatio = pendingSeekRatio ?? (durationSeconds > 0 ? Math.min(currentSeconds / durationSeconds, 1) : 0);

  const frameLabel = useMemo(() => (
    bagStatus.frameCount > 0
      ? `Frame ${Math.trunc(Math.min(bagStatus.cursor, bagStatus.frameCount))} / ${Math.trunc(bagStatus.frameCount)}`
      : "Frame 0 / 0"
  ), [bagStatus.cursor, bagStatus.frameCount]);

  function sendPlaybackCommand(type: "start-lidar" | "stop-lidar") {
    return sendMessage({ type });
  }

  function seekPlayback(ratio: number) {
    if (isLiveSource) {
      return false;
    }

    const sent = sendMessage({ type: "seek-playback", ratio });
    if (sent) {
      onBeforeSeek?.();
      setPendingSeekRatio(undefined);
    }
    return sent;
  }

  function seekPlaybackBySeconds(deltaSeconds: number) {
    if (durationSeconds <= 0) {
      return false;
    }

    return seekPlayback((currentSeconds + deltaSeconds) / durationSeconds);
  }

  function previewSeek(ratio: number) {
    const clampedRatio = Math.max(0, Math.min(1, ratio));
    setPendingSeekRatio(clampedRatio);
  }

  function commitPreviewSeek(ratio?: number) {
    const targetRatio = typeof ratio === "number" ? ratio : pendingSeekRatio;
    if (typeof targetRatio === "number") {
      seekPlayback(targetRatio);
    }
  }

  return {
    currentSeconds,
    durationSeconds,
    playbackRatio,
    frameLabel,
    sendPlaybackCommand,
    seekPlayback,
    seekPlaybackBySeconds,
    previewSeek,
    commitPreviewSeek,
  };
}
