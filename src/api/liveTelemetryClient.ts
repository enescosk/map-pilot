import type { LiveMessage } from "../types/liveMessages";

type ClientStatus = "connecting" | "open" | "closed" | "error";

type LiveTelemetryClientOptions = {
  url: string;
  onMessage: (message: LiveMessage) => void;
  onWorkerMessage?: (ev: MessageEvent) => void;
  onStatus?: (status: ClientStatus) => void;
  onOpen?: () => void;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Override for testing — skip Web Worker creation */
  _noWorker?: boolean;
};

export function createLiveTelemetryClient({
  url,
  onMessage,
  onWorkerMessage,
  onStatus,
  onOpen,
  reconnectBaseMs = 900,
  reconnectMaxMs = 5000,
  _noWorker = false,
}: LiveTelemetryClientOptions) {
  let socket: WebSocket | undefined;
  let reconnectTimer: number | undefined;
  let manuallyClosed = false;
  let reconnectAttempt = 0;

  // Spin up a Web Worker for JSON parsing and lidar processing off main thread.
  // _noWorker=true is used in tests where Worker is not available.
  let worker: Worker | null = null;
  // Backpressure: a live LiDAR firehose (e.g. /rslidar_points at ~21 MB/s) can
  // outrun the worker. Without a guard the binary postMessage queue grows
  // unbounded until the tab is killed. We keep at most ONE binary cloud in
  // flight and coalesce the rest, always rendering the freshest frame.
  let cloudInFlight = false;
  let pendingCloud: ArrayBuffer | null = null;
  function dispatchCloud(buf: ArrayBuffer) {
    if (!worker) return;
    cloudInFlight = true;
    worker.postMessage({ type: "parse-binary", payload: buf }, [buf]);
  }
  if (!_noWorker) {
    worker = new Worker(new URL("../workers/frameWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (ev: MessageEvent) => {
      const { type } = ev.data as { type: string };
      if (type === "cloud-ready" || type === "cloud-skipped" || type === "worker-error") {
        // A binary cloud finished — release the slot and flush the freshest
        // frame we coalesced while busy.
        cloudInFlight = false;
        if (pendingCloud) {
          const next = pendingCloud;
          pendingCloud = null;
          dispatchCloud(next);
        }
      }
      if (type === "message") {
        onMessage(ev.data.msg as LiveMessage);
      } else if (onWorkerMessage) {
        onWorkerMessage(ev);
      }
    };
  }

  function clearReconnect() {
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  }

  function scheduleReconnect() {
    if (manuallyClosed || reconnectTimer) return;
    const delay = Math.min(reconnectMaxMs, reconnectBaseMs * 2 ** reconnectAttempt);
    reconnectAttempt = Math.min(reconnectAttempt + 1, 6);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  }

  function connect() {
    if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
    manuallyClosed = false;
    onStatus?.("connecting");
    socket = new WebSocket(url);

    socket.addEventListener("open", () => {
      reconnectAttempt = 0;
      onStatus?.("open");
      onOpen?.();
    });

    // Binary frames carry point-cloud data; text frames are JSON envelopes.
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) {
        // Binary point-cloud frame — pass ArrayBuffer to worker by transfer (zero copy).
        // If the worker is still chewing on a previous cloud, coalesce: keep only
        // the newest frame so we never build an unbounded backlog.
        if (worker) {
          if (cloudInFlight) {
            pendingCloud = event.data;
          } else {
            dispatchCloud(event.data);
          }
        }
        return;
      }
      if (worker) {
        worker.postMessage({ type: "parse", payload: String(event.data) });
      } else {
        try {
          const msg = JSON.parse(String(event.data)) as LiveMessage;
          if (msg && typeof msg === "object") onMessage(msg);
        } catch { /* ignore malformed */ }
      }
    });

    socket.addEventListener("close", () => {
      onStatus?.("closed");
      socket = undefined;
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      onStatus?.("error");
      socket?.close();
    });
  }

  function disconnect() {
    manuallyClosed = true;
    clearReconnect();
    socket?.close();
    socket = undefined;
    onStatus?.("closed");
    worker?.postMessage({ type: "reset" });
  }

  function send(message: unknown) {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  function terminateWorker() {
    worker?.terminate();
  }

  function setActiveTopic(topic: string) {
    worker?.postMessage({ type: "set-active-topic", payload: topic });
  }

  return {
    connect,
    disconnect,
    send,
    setActiveTopic,
    terminateWorker,
    getReadyState: () => socket?.readyState,
  };
}
