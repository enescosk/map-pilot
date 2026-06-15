import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock the `ws` library with a controllable fake socket ─────────────────────

class MockWS {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = MockWS.CONNECTING;
    this.sent = [];
    this.handlers = {};
    MockWS.instances.push(this);
  }

  on(event, cb) { (this.handlers[event] ??= []).push(cb); }
  send(data) { this.sent.push(data); }
  close() { this.readyState = MockWS.CLOSED; this._emit("close"); }

  // test helpers
  _open() { this.readyState = MockWS.OPEN; this._emit("open"); }
  _publish(topic, msg) { this._emit("message", Buffer.from(JSON.stringify({ op: "publish", topic, msg }))); }
  _raw(str) { this._emit("message", str); }
  _error(err) { this._emit("error", err || new Error("boom")); }
  _emit(event, arg) { for (const cb of this.handlers[event] ?? []) cb(arg); }
}

vi.mock("ws", () => ({ default: MockWS }));

const { createVehicleRosSource, LIVE_ROS_TOPICS } = await import("../sources/vehicleRosSource.js");

beforeEach(() => { MockWS.instances = []; });

function makeSource() {
  const emitted = [];
  const source = createVehicleRosSource({ emit: (e) => emitted.push(e), url: "ws://test:9090" });
  return { source, emitted, socket: () => MockWS.instances.at(-1) };
}

// ─── Connect / subscribe ───────────────────────────────────────────────────────

describe("start / subscribe", () => {
  it("opens a socket to the configured url", () => {
    const { source, socket } = makeSource();
    source.start();
    expect(MockWS.instances).toHaveLength(1);
    expect(socket().url).toBe("ws://test:9090");
  });

  it("emits open status and subscribes to every live topic on open", () => {
    const { source, emitted, socket } = makeSource();
    source.start();
    socket()._open();

    const status = emitted.find((e) => e.type === "status");
    expect(status.connected).toBe(true);
    expect(status.source).toBe("vehicle-ros");

    const subscribes = socket().sent.map((s) => JSON.parse(s)).filter((m) => m.op === "subscribe");
    expect(subscribes).toHaveLength(LIVE_ROS_TOPICS.length);
    expect(subscribes.map((m) => m.topic)).toEqual(expect.arrayContaining(["/VelocityInformation", "/rslidar_points"]));
  });

  it("is idempotent: a second start() while OPEN does not open a new socket", () => {
    const { source, socket } = makeSource();
    source.start();
    socket()._open();
    source.start();
    expect(MockWS.instances).toHaveLength(1);
  });

  it("replaces a stale non-open socket on restart", () => {
    const { source, socket } = makeSource();
    source.start();           // socket 1, still CONNECTING (never opened)
    source.start();           // stale → close + new socket
    expect(MockWS.instances).toHaveLength(2);
    expect(socket().url).toBe("ws://test:9090");
  });
});

// ─── Message handling ──────────────────────────────────────────────────────────

describe("message handling", () => {
  it("normalizes a publish frame and emits telemetry", () => {
    const { source, emitted, socket } = makeSource();
    source.start();
    socket()._open();
    socket()._publish("/VelocityInformation", { _type: "dbw_interface/VelocityInformation", VelocityMS: 154 });

    const telemetry = emitted.find((e) => e.type === "telemetry");
    expect(telemetry).toBeDefined();
    expect(telemetry.telemetry.speed).toBeCloseTo(1.54); // 154 * 0.01
  });

  it("ignores non-publish ops", () => {
    const { source, emitted, socket } = makeSource();
    source.start();
    socket()._open();
    const before = emitted.length;
    socket()._emit("message", Buffer.from(JSON.stringify({ op: "status", level: "info" })));
    expect(emitted.length).toBe(before);
  });

  it("ignores publish frames with no topic or msg", () => {
    const { source, emitted, socket } = makeSource();
    source.start();
    socket()._open();
    const before = emitted.length;
    socket()._emit("message", Buffer.from(JSON.stringify({ op: "publish" })));
    expect(emitted.length).toBe(before);
  });

  it("emits a backend-error on malformed JSON", () => {
    const { source, emitted, socket } = makeSource();
    source.start();
    socket()._open();
    socket()._raw("not-json{{");
    expect(emitted.some((e) => e.type === "backend-error")).toBe(true);
  });
});

// ─── Lifecycle ──────────────────────────────────────────────────────────────────

describe("lifecycle", () => {
  it("close event flips connected to false and emits status", () => {
    const { source, emitted, socket } = makeSource();
    source.start();
    socket()._open();
    socket().close();
    const last = emitted.filter((e) => e.type === "status").at(-1);
    expect(last.connected).toBe(false);
  });

  it("stop() unsubscribes, closes the socket and reports disconnected", () => {
    const { source, emitted, socket } = makeSource();
    source.start();
    socket()._open();
    const sock = socket();
    source.stop();
    const unsubs = sock.sent.map((s) => JSON.parse(s)).filter((m) => m.op === "unsubscribe");
    expect(unsubs).toHaveLength(LIVE_ROS_TOPICS.length);
    expect(sock.readyState).toBe(MockWS.CLOSED);
    expect(source.getStatus().connected).toBe(false);
  });

  it("error event emits a backend-error", () => {
    const { source, emitted, socket } = makeSource();
    source.start();
    socket()._open();
    socket()._error(new Error("ECONNREFUSED"));
    const err = emitted.find((e) => e.type === "backend-error");
    expect(err.message).toMatch(/ECONNREFUSED/);
  });
});
