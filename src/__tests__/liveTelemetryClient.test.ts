import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLiveTelemetryClient } from "../api/liveTelemetryClient";

// ─── Mock WebSocket ───────────────────────────────────────────────────────────

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  private listeners: Record<string, Array<(e: unknown) => void>> = {};
  static instances: MockWebSocket[] = [];

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(event: string, cb: (e: unknown) => void) {
    (this.listeners[event] ??= []).push(cb);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this._emit("close", {});
  }

  // Test helpers
  _open() {
    this.readyState = MockWebSocket.OPEN;
    this._emit("open", {});
  }

  _message(data: unknown) {
    this._emit("message", { data: JSON.stringify(data) });
  }

  _error() {
    this._emit("error", {});
  }

  private _emit(event: string, payload: unknown) {
    for (const cb of this.listeners[event] ?? []) cb(payload);
  }
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  MockWebSocket.instances = [];
  // Make window.setTimeout/clearTimeout available in Node (vitest node env)
  Object.assign(globalThis, { window: globalThis });
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function latestSocket() {
  return MockWebSocket.instances.at(-1)!;
}

function makeClient(overrides: Record<string, unknown> = {}) {
  const onMessage = vi.fn();
  const onStatus = vi.fn();
  const onOpen = vi.fn();
  const client = createLiveTelemetryClient({
    url: "ws://localhost:4000",
    onMessage,
    onStatus,
    onOpen,
    reconnectBaseMs: 100,
    reconnectMaxMs: 1000,
    _noWorker: true,
    ...overrides,
  });
  return { client, onMessage, onStatus, onOpen };
}

// ─── Connect ─────────────────────────────────────────────────────────────────

describe("connect", () => {
  it("creates a WebSocket and emits connecting status", () => {
    const { client, onStatus } = makeClient();
    client.connect();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(onStatus).toHaveBeenCalledWith("connecting");
  });

  it("emits open status and calls onOpen after socket opens", () => {
    const { client, onStatus, onOpen } = makeClient();
    client.connect();
    latestSocket()._open();
    expect(onStatus).toHaveBeenCalledWith("open");
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("does not create a second socket if already connecting", () => {
    const { client } = makeClient();
    client.connect();
    client.connect(); // second call should be a no-op
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("does not create a second socket if already open", () => {
    const { client } = makeClient();
    client.connect();
    latestSocket()._open();
    client.connect();
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});

// ─── Reconnect ───────────────────────────────────────────────────────────────

describe("reconnect — exponential backoff", () => {
  it("schedules a reconnect after close (base delay = 100 ms)", () => {
    const { client } = makeClient();
    client.connect();
    latestSocket()._open();
    latestSocket().close();

    expect(MockWebSocket.instances).toHaveLength(1); // no new socket yet

    vi.advanceTimersByTime(100);
    expect(MockWebSocket.instances).toHaveLength(2); // reconnected
  });

  it("doubles the delay on the second failure (exponential backoff)", () => {
    const { client } = makeClient();
    client.connect();
    latestSocket()._open();
    latestSocket().close();   // attempt 1 → delay 100 ms

    vi.advanceTimersByTime(100);  // reconnect fires
    latestSocket().close();       // attempt 2 → delay 200 ms

    vi.advanceTimersByTime(100);  // not enough
    expect(MockWebSocket.instances).toHaveLength(2);

    vi.advanceTimersByTime(100);  // now 200 ms total → fires
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it("caps delay at reconnectMaxMs", () => {
    // _open() resets reconnectAttempt to 0, so we must close WITHOUT opening
    // to accumulate the backoff counter.
    // base=100, max=300 → consecutive-fail delays: 100, 200, 300, 300, …
    const { client } = makeClient({ reconnectBaseMs: 100, reconnectMaxMs: 300 });
    client.connect();

    // Failure 1 (attempt=0) → delay = 100 ms
    latestSocket().close();
    vi.advanceTimersByTime(100);         // fires → socket 2
    // Failure 2 (attempt=1) → delay = 200 ms
    latestSocket().close();
    vi.advanceTimersByTime(200);         // fires → socket 3
    // Failure 3 (attempt=2) → delay = min(300, 400) = 300 ms (cap kicks in)
    latestSocket().close();
    vi.advanceTimersByTime(299);         // not yet
    expect(MockWebSocket.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);           // 300 ms total → fires
    expect(MockWebSocket.instances).toHaveLength(4);
    // Failure 4 (attempt=3) → delay = min(300, 800) = 300 ms (still capped)
    latestSocket().close();
    vi.advanceTimersByTime(299);
    expect(MockWebSocket.instances).toHaveLength(4);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(5);
  });

  it("resets reconnect attempt count after a successful open", () => {
    const { client } = makeClient();
    client.connect();

    // First failure
    latestSocket()._open();
    latestSocket().close();
    vi.advanceTimersByTime(100);

    // Successful reconnect
    latestSocket()._open();
    latestSocket().close(); // new failure → should use base delay (100 ms) again

    vi.advanceTimersByTime(50); // not there yet
    expect(MockWebSocket.instances).toHaveLength(2);

    vi.advanceTimersByTime(60); // 110 ms total → fires
    expect(MockWebSocket.instances).toHaveLength(3);
  });
});

// ─── Disconnect ──────────────────────────────────────────────────────────────

describe("disconnect", () => {
  it("closes the socket and emits closed status", () => {
    const { client, onStatus } = makeClient();
    client.connect();
    latestSocket()._open();
    client.disconnect();
    expect(onStatus).toHaveBeenCalledWith("closed");
  });

  it("does not schedule a reconnect after manual disconnect", () => {
    const { client } = makeClient();
    client.connect();
    latestSocket()._open();
    client.disconnect();

    const countBefore = MockWebSocket.instances.length;
    vi.advanceTimersByTime(5000); // wait far past any delay
    expect(MockWebSocket.instances.length).toBe(countBefore);
  });
});

// ─── send ─────────────────────────────────────────────────────────────────────

describe("send", () => {
  it("returns false when not connected", () => {
    const { client } = makeClient();
    client.connect(); // still CONNECTING, not OPEN
    expect(client.send({ type: "ping" })).toBe(false);
  });

  it("returns true and sends JSON when socket is open", () => {
    const { client } = makeClient();
    client.connect();
    latestSocket()._open();
    const result = client.send({ type: "start-lidar" });
    expect(result).toBe(true);
    expect(latestSocket().sent).toEqual(['{"type":"start-lidar"}']);
  });

  it("returns false after disconnect", () => {
    const { client } = makeClient();
    client.connect();
    latestSocket()._open();
    client.disconnect();
    expect(client.send({ type: "ping" })).toBe(false);
  });
});

// ─── Message parsing ─────────────────────────────────────────────────────────

describe("message parsing", () => {
  it("forwards valid JSON messages to onMessage", () => {
    const { client, onMessage } = makeClient();
    client.connect();
    latestSocket()._open();
    latestSocket()._message({ type: "telemetry", speed: 5 });
    expect(onMessage).toHaveBeenCalledWith({ type: "telemetry", speed: 5 });
  });

  it("does not call onMessage for invalid JSON", () => {
    const { client, onMessage } = makeClient();
    client.connect();
    latestSocket()._open();
    // Bypass _message helper to inject raw bad data
    const sock = latestSocket() as unknown as { _emit: (e: string, p: unknown) => void };
    sock._emit("message", { data: "not-json{{" });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("does not call onMessage for non-object JSON (e.g. a raw number)", () => {
    const { client, onMessage } = makeClient();
    client.connect();
    latestSocket()._open();
    const sock = latestSocket() as unknown as { _emit: (e: string, p: unknown) => void };
    sock._emit("message", { data: "42" });
    expect(onMessage).not.toHaveBeenCalled();
  });
});

// ─── Error handling ───────────────────────────────────────────────────────────

describe("error handling", () => {
  it("emits error status and then triggers close/reconnect", () => {
    const { client, onStatus } = makeClient();
    client.connect();
    latestSocket()._open();
    latestSocket()._error();
    expect(onStatus).toHaveBeenCalledWith("error");

    // After error, socket.close() is called internally → close event fires → reconnect
    vi.advanceTimersByTime(100);
    expect(MockWebSocket.instances.length).toBeGreaterThan(1);
  });
});
