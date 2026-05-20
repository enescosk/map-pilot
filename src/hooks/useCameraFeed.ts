import { useCallback, useState } from "react";
import type { CameraFrameMessage, CameraStatus, CameraStreamMessage } from "../types/liveMessages";

const initialCamera: CameraStatus = {
  topic: "/zed2i/zed_node/rgb/image_rect_color/compressed",
  isActive: false,
  resolution: "Waiting",
  fps: 0,
  frameCount: 0,
};

export function useCameraFeed() {
  const [camera, setCamera] = useState<CameraStatus>(initialCamera);

  const resetCamera = useCallback(() => {
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
    setCamera((prev) => ({
      topic: packet.topic || prev.topic,
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
