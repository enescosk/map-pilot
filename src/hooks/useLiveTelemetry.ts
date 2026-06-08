import { useCallback, useEffect, useRef, useState } from "react";
import { createLiveTelemetryClient } from "../api/liveTelemetryClient";
import type { LiveMessage } from "../types/liveMessages";

type UseLiveTelemetryArgs = {
  url: string;
  onMessage: (message: LiveMessage) => void;
  onWorkerMessage?: (ev: MessageEvent) => void;
  onOpen?: () => void;
};

export type WsStatus = "connecting" | "open" | "closed" | "error";

export function useLiveTelemetry({ url, onMessage, onWorkerMessage, onOpen }: UseLiveTelemetryArgs) {
  const [connected, setConnected] = useState(false);
  const [wsStatus, setWsStatus] = useState<WsStatus>("closed");
  const clientRef = useRef<ReturnType<typeof createLiveTelemetryClient> | undefined>(undefined);
  const onMessageRef = useRef(onMessage);
  const onWorkerMessageRef = useRef(onWorkerMessage);
  const onOpenRef = useRef(onOpen);

  useEffect(() => {
    onMessageRef.current = onMessage;
    onWorkerMessageRef.current = onWorkerMessage;
    onOpenRef.current = onOpen;
  }, [onMessage, onWorkerMessage, onOpen]);

  useEffect(() => {
    const client = createLiveTelemetryClient({
      url,
      onMessage: (message) => onMessageRef.current(message),
      onWorkerMessage: (ev) => onWorkerMessageRef.current?.(ev),
      onOpen: () => onOpenRef.current?.(),
      onStatus: (status) => {
        setWsStatus(status);
        setConnected(status === "open");
      },
    });
    clientRef.current = client;
    client.connect();

    return () => {
      client.disconnect();
      client.terminateWorker();
      clientRef.current = undefined;
    };
  }, [url]);

  const sendMessage = useCallback((message: unknown) => (
    clientRef.current?.send(message) ?? false
  ), []);

  return {
    connected,
    wsStatus,
    sendMessage,
    connect: () => clientRef.current?.connect(),
    disconnect: () => clientRef.current?.disconnect(),
  };
}
