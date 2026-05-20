import { useCallback, useEffect, useRef, useState } from "react";
import { createLiveTelemetryClient } from "../api/liveTelemetryClient";
import type { LiveMessage } from "../types/liveMessages";

type UseLiveTelemetryArgs = {
  url: string;
  onMessage: (message: LiveMessage) => void;
  onOpen?: () => void;
};

export function useLiveTelemetry({ url, onMessage, onOpen }: UseLiveTelemetryArgs) {
  const [connected, setConnected] = useState(false);
  const clientRef = useRef<ReturnType<typeof createLiveTelemetryClient> | undefined>(undefined);
  const onMessageRef = useRef(onMessage);
  const onOpenRef = useRef(onOpen);

  useEffect(() => {
    onMessageRef.current = onMessage;
    onOpenRef.current = onOpen;
  }, [onMessage, onOpen]);

  useEffect(() => {
    const client = createLiveTelemetryClient({
      url,
      onMessage: (message) => onMessageRef.current(message),
      onOpen: () => onOpenRef.current?.(),
      onStatus: (status) => setConnected(status === "open"),
    });
    clientRef.current = client;
    client.connect();

    return () => {
      client.disconnect();
      clientRef.current = undefined;
    };
  }, [url]);

  const sendMessage = useCallback((message: unknown) => (
    clientRef.current?.send(message) ?? false
  ), []);

  return {
    connected,
    sendMessage,
    connect: () => clientRef.current?.connect(),
    disconnect: () => clientRef.current?.disconnect(),
  };
}
