import type { LiveMessage } from "../types/liveMessages";

type ClientStatus = "connecting" | "open" | "closed" | "error";

type LiveTelemetryClientOptions = {
  url: string;
  onMessage: (message: LiveMessage) => void;
  onStatus?: (status: ClientStatus) => void;
  onOpen?: () => void;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
};

function parseLiveMessage(raw: string): LiveMessage | undefined {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as LiveMessage;
    }
  } catch (error) {
    console.error("Invalid backend message:", error);
  }
  return undefined;
}

export function createLiveTelemetryClient({
  url,
  onMessage,
  onStatus,
  onOpen,
  reconnectBaseMs = 900,
  reconnectMaxMs = 5000,
}: LiveTelemetryClientOptions) {
  let socket: WebSocket | undefined;
  let reconnectTimer: number | undefined;
  let manuallyClosed = false;
  let reconnectAttempt = 0;

  function clearReconnect() {
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  }

  function scheduleReconnect() {
    if (manuallyClosed || reconnectTimer) {
      return;
    }

    const delay = Math.min(reconnectMaxMs, reconnectBaseMs * 2 ** reconnectAttempt);
    reconnectAttempt = Math.min(reconnectAttempt + 1, 6);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  }

  function connect() {
    if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
      return;
    }

    manuallyClosed = false;
    onStatus?.("connecting");
    socket = new WebSocket(url);

    socket.addEventListener("open", () => {
      reconnectAttempt = 0;
      onStatus?.("open");
      onOpen?.();
    });

    socket.addEventListener("message", (event) => {
      const message = parseLiveMessage(String(event.data));
      if (message) {
        onMessage(message);
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
  }

  function send(message: unknown) {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  return {
    connect,
    disconnect,
    send,
    getReadyState: () => socket?.readyState,
  };
}
