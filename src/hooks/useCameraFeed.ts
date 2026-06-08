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

export function useCameraFeed() {
  const [camera, setCamera] = useState<CameraStatus>(initialCamera);
  const pinnedTopicRef = useRef<string | null>(null);

  const resetCamera = useCallback(() => {
    pinnedTopicRef.current = null;
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

  const handleCameraFrame = useCallback((packet: CameraFrameMessage) => {
    const incomingTopic = packet.topic || "";
    if (pinnedTopicRef.current === null) {
      pinnedTopicRef.current = incomingTopic;
    } else if (incomingTopic && incomingTopic !== pinnedTopicRef.current) {
      // Upgrade to a better topic (e.g. zed2i rgb arrives after a generic topic).
      if (cameraTopicScore(incomingTopic) > cameraTopicScore(pinnedTopicRef.current)) {
        pinnedTopicRef.current = incomingTopic;
      } else {
        return;
      }
    }
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
  }, []);

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
    handleCameraStream,
  };
}
