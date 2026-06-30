import { useEffect, useState } from "react";
import type { CameraStatus } from "../types/liveMessages";
import { EmptyState } from "./EmptyState";

export function CameraViewer({ camera }: { camera: CameraStatus }) {
  const [displaySrc, setDisplaySrc] = useState(camera.frameSrc || "");
  const cameraSrc = camera.streamUrl || displaySrc;

  useEffect(() => {
    if (camera.streamUrl) {
      return;
    }

    if (camera.frameSrc && camera.frameSrc !== displaySrc) {
      let cancelled = false;
      const image = new Image();
      image.onload = () => {
        if (!cancelled) {
          setDisplaySrc(camera.frameSrc || "");
        }
      };
      image.src = camera.frameSrc;

      return () => {
        cancelled = true;
      };
    }
  }, [camera.frameSrc, camera.streamUrl, displaySrc]);

  return (
    <section className="workspace-panel camera-workspace">
      <div className="panel-titlebar">
        <span>{camera.topic || "/camera"}</span>
        <strong>{camera.isActive ? "Live" : "Waiting"}</strong>
      </div>
      <div className="camera-stage">
        {cameraSrc ? (
          <img src={cameraSrc} alt="Live camera feed" />
        ) : (
          <EmptyState icon="camera" title="Kamera bekleniyor" hint="Canlı görüntü için araca bağlanın" connecting />
        )}
      </div>
      <div className="metric-strip">
        <span>{camera.issue || camera.resolution}</span>
        <span>{camera.frameCount} frames</span>
        <span>{camera.lastTime || "--"}</span>
      </div>
    </section>
  );
}
