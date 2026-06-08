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
  if (!_noWorker) {
    worker = new Worker(new URL("../workers/frameWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (ev: MessageEvent) => {
      const { type } = ev.data as { type: string };
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

    socket.addEventListener("message", (event) => {
      if (worker) {
        // Send raw string to worker — zero JSON.parse on main thread
        worker.postMessage({ type: "parse", payload: String(event.data) });
      } else {
        // Fallback: parse on main thread (test/no-worker mode)
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

  return {
    connect,
    disconnect,
    send,
    terminateWorker,
    getReadyState: () => socket?.readyState,
  };
}
