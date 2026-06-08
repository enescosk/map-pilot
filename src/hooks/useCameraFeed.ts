import { useCallback, useRef, useState } from "react";
import type { CameraFrameMessage, CameraStatus, CameraStreamMessage } from "../types/liveMessages";

const initialCamera: CameraStatus = {
  topic: "/zed2i/zed_node/rgb/image_rect_color/compressed",
  isActive: false,
  resolution: "Waiting",
  fps: 0,
  frameCount: 0,
};

// Higher score = more preferred. zed2i rgb > zed2i left > compressed > anything else.
function cameraTopicScore(topic: string): number {
  const t = topic.toLowerCase();
  if (t.includes("zed2i") && t.includes("rgb")) return 3;
  if (t.includes("zed2i")) return 2;
  if (t.includes("compressed")) return 1;
  return 0;
}

export type CameraBitmapHandler = (bmp: ImageBitmap) => void;

export function useCameraFeed() {
  const [camera, setCamera] = useState<CameraStatus>(initialCamera);
  const pinnedTopicRef = useRef<string | null>(null);
  // Latest ImageBitmap goes here. CameraPanel reads via getBitmapTarget() each frame
  // so we never trigger React re-renders for the image payload itself.
  const bitmapRef = useRef<ImageBitmap | null>(null);
  const bitmapListenersRef = useRef<Set<CameraBitmapHandler>>(new Set());

  const subscribeBitmap = useCallback((cb: CameraBitmapHandler) => {
    bitmapListenersRef.current.add(cb);
    return () => { bitmapListenersRef.current.delete(cb); };
  }, []);

  const resetCamera = useCallback(() => {
    pinnedTopicRef.current = null;
    if (bitmapRef.current) { bitmapRef.current.close(); bitmapRef.current = null; }
    setCamera((prev) => ({
      ...prev,
      isActive: false,
      frameSrc: "",
      resolution: "Waiting",
      fps: 0,
      frameCount: 0,
      lastTime: "",
    }));
  }, []);

  const acceptTopic = useCallback((incomingTopic: string): boolean => {
    if (pinnedTopicRef.current === null) {
      pinnedTopicRef.current = incomingTopic;
      return true;
    }
    if (!incomingTopic || incomingTopic === pinnedTopicRef.current) return true;
    if (cameraTopicScore(incomingTopic) > cameraTopicScore(pinnedTopicRef.current)) {
      pinnedTopicRef.current = incomingTopic;
      return true;
    }
    return false;
  }, []);

  // Legacy JSON path (base64 data URL fallback)
  const handleCameraFrame = useCallback((packet: CameraFrameMessage) => {
    const incomingTopic = packet.topic || "";
    if (!acceptTopic(incomingTopic)) return;
    setCamera((prev) => ({
      topic: incomingTopic || prev.topic,
      isActive: true,
      frameSrc: packet.src || prev.frameSrc,
      streamUrl: packet.streamUrl || prev.streamUrl,
      resolution: packet.resolution || prev.resolution,
      fps: Number(packet.fps || prev.fps),
      frameCount: prev.frameCount + 1,
      issue: packet.issue || "",
      lastTime: packet.time,
    }));
  }, [acceptTopic]);

  // Binary path: ImageBitmap from worker. Stored in ref; subscribers paint to their canvas.
  const handleCameraBitmap = useCallback((packet: {
    topic: string; time: string; resolution: string; fps: number; bitmap: ImageBitmap;
  }) => {
    if (!acceptTopic(packet.topic)) {
      packet.bitmap.close();
      return;
    }
    // Close previous bitmap to free GPU memory, then store new one.
    if (bitmapRef.current) bitmapRef.current.close();
    bitmapRef.current = packet.bitmap;
    for (const cb of bitmapListenersRef.current) {
      try { cb(packet.bitmap); } catch { /* ignore listener errors */ }
    }
    setCamera((prev) => ({
      topic: packet.topic || prev.topic,
      isActive: true,
      frameSrc: "binary",
      streamUrl: prev.streamUrl,
      resolution: packet.resolution || prev.resolution,
      fps: Number(packet.fps || prev.fps),
      frameCount: prev.frameCount + 1,
      issue: "",
      lastTime: packet.time,
    }));
  }, [acceptTopic]);

  const handleCameraStream = useCallback((packet: CameraStreamMessage) => {
    setCamera((prev) => ({
      ...prev,
      topic: packet.topic || prev.topic,
      isActive: true,
      streamUrl: packet.streamUrl,
      resolution: packet.resolution || "Stream",
      issue: "",
      lastTime: packet.time || prev.lastTime,
    }));
  }, []);

  return {
    camera,
    resetCamera,
    handleCameraFrame,
    handleCameraBitmap,
    handleCameraStream,
    subscribeBitmap,
    bitmapRef,
  };
}
