import { useEffect, useRef } from "react";
import type { CameraStatus } from "../types/liveMessages";

type CameraPanelProps = {
  camera: CameraStatus;
};

function CameraPanel({ camera }: CameraPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const prevSrcRef = useRef<string>("");

  useEffect(() => {
    const src = camera.frameSrc;
    if (!src || src === prevSrcRef.current) return;
    prevSrcRef.current = src;

    const canvas = canvasRef.current;
    if (!canvas) return;

    // Use createImageBitmap for off-main-thread decode where supported
    if (typeof createImageBitmap === "function" && src.startsWith("data:")) {
      fetch(src)
        .then((r) => r.blob())
        .then((blob) => createImageBitmap(blob))
        .then((bmp) => {
          canvas.width = bmp.width;
          canvas.height = bmp.height;
          canvas.getContext("2d")?.drawImage(bmp, 0, 0);
          bmp.close();
        })
        .catch(() => {
          // Fallback: direct img draw
          const img = new Image();
          img.onload = () => {
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext("2d")?.drawImage(img, 0, 0);
          };
          img.src = src;
        });
    } else {
      const img = new Image();
      img.onload = () => {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext("2d")?.drawImage(img, 0, 0);
      };
      img.src = src;
    }
  }, [camera.frameSrc]);

  return (
    <article className="panel camera-panel">
      <div className="panel-heading split-heading">
        <div>
          <p className="panel-label">Camera</p>
          <h2>{camera.name}</h2>
        </div>
        <span className={camera.isActive ? "system-pill active" : "system-pill inactive"}>
          {camera.isActive ? "Active" : "Inactive"}
        </span>
      </div>

      <div className={camera.isActive ? "camera-feed active" : "camera-feed"}>
        {camera.frameSrc ? (
          <canvas ref={canvasRef} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
        ) : (
          <>
            <div className="camera-crosshair horizontal" />
            <div className="camera-crosshair vertical" />
            <span>{camera.isActive ? "Live Camera Feed" : "No Camera Feed"}</span>
          </>
        )}
      </div>

      <div className="camera-metrics">
        <span>Mode: {camera.mode}</span>
        <span>Resolution: {camera.resolution}</span>
        <span>FPS: {camera.fps}</span>
      </div>

      {!camera.isActive && camera.issue && <p className="panel-alert">{camera.issue}</p>}
    </article>
  );
}

export default CameraPanel;
