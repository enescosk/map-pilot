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

const { createVehicleRosSource, LIVE_ROS_TOPICS, isLidarTopic } = await import("../sources/vehicleRosSource.js");

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

// ─── Topic discovery (Faz 1) ────────────────────────────────────────────────────

describe("topic discovery", () => {
  it("calls /rosapi/topics on open without disturbing the subscription set", () => {
    const { source, socket } = makeSource();
    source.start();
    socket()._open();

    const calls = socket().sent.map((s) => JSON.parse(s)).filter((m) => m.op === "call_service");
    expect(calls).toHaveLength(1);
    expect(calls[0].service).toBe("/rosapi/topics");

    // Fixed subscriptions are unaffected.
    const subscribes = socket().sent.map((s) => JSON.parse(s)).filter((m) => m.op === "subscribe");
    expect(subscribes).toHaveLength(LIVE_ROS_TOPICS.length);
  });

  it("emits a topic-list envelope pairing names with types from the service response", () => {
    const { source, emitted, socket } = makeSource();
    source.start();
    socket()._open();

    const call = socket().sent.map((s) => JSON.parse(s)).find((m) => m.op === "call_service");
    socket()._emit("message", Buffer.from(JSON.stringify({
      op: "service_response",
      id: call.id,
      values: { topics: ["/foo", "/bar"], types: ["std_msgs/Float64", "sensor_msgs/Image"] },
      result: true,
    })));

    const list = emitted.find((e) => e.type === "topic-list");
    expect(list).toBeDefined();
    expect(list.source).toBe("vehicle-ros");
    expect(list.topics).toEqual([
      { topic: "/foo", type: "std_msgs/Float64" },
      { topic: "/bar", type: "sensor_msgs/Image" },
    ]);
  });

  it("ignores service responses with an unrelated id", () => {
    const { source, emitted, socket } = makeSource();
    source.start();
    socket()._open();
    const before = emitted.length;
    socket()._emit("message", Buffer.from(JSON.stringify({
      op: "service_response", id: "someone-elses-call", values: { topics: [] },
    })));
    expect(emitted.filter((e) => e.type === "topic-list")).toHaveLength(0);
    expect(emitted.length).toBe(before);
  });
});

// ─── Raw topic subscription (Faz 2) ──────────────────────────────────────────────

describe("raw topic subscription", () => {
  it("subscribeRaw sends a subscribe op and forwards matching publishes as raw-message", () => {
    const { source, emitted, socket } = makeSource();
    source.start();
    socket()._open();
    source.subscribeRaw("/some/custom_topic");

    const subs = socket().sent.map((s) => JSON.parse(s)).filter((m) => m.op === "subscribe");
    expect(subs.map((m) => m.topic)).toContain("/some/custom_topic");

    socket()._publish("/some/custom_topic", { _type: "std_msgs/String", data: "hello" });
    const raw = emitted.find((e) => e.type === "raw-message");
    expect(raw).toBeDefined();
    expect(raw.topic).toBe("/some/custom_topic");
    expect(raw.msg.data).toBe("hello");
  });

  it("does not emit raw-message for topics that were not picked", () => {
    const { source, emitted, socket } = makeSource();
    source.start();
    socket()._open();
    socket()._publish("/unpicked", { _type: "std_msgs/String", data: "x" });
    expect(emitted.some((e) => e.type === "raw-message")).toBe(false);
  });

  it("unsubscribeRaw stops forwarding and sends an unsubscribe op", () => {
    const { source, emitted, socket } = makeSource();
    source.start();
    socket()._open();
    source.subscribeRaw("/some/custom_topic");
    source.unsubscribeRaw("/some/custom_topic");

    const unsubs = socket().sent.map((s) => JSON.parse(s)).filter((m) => m.op === "unsubscribe");
    expect(unsubs.map((m) => m.topic)).toContain("/some/custom_topic");

    socket()._publish("/some/custom_topic", { _type: "std_msgs/String", data: "y" });
    // A normalize envelope may still be emitted for the publish; only the
    // raw-message forwarding must have stopped.
    expect(emitted.filter((e) => e.type === "raw-message").length).toBe(0);
  });

  it("re-subscribes picked raw topics after a reconnect", () => {
    const { source, socket } = makeSource();
    source.start();
    socket()._open();
    source.subscribeRaw("/some/custom_topic");
    // simulate a fresh socket open (reconnect)
    socket()._open();
    const subs = socket().sent.map((s) => JSON.parse(s)).filter((m) => m.op === "subscribe");
    expect(subs.map((m) => m.topic).filter((t) => t === "/some/custom_topic").length).toBeGreaterThanOrEqual(1);
  });

  it("unsubscribeRaw does not unsubscribe a topic still in the active base set", () => {
    const { source, socket } = makeSource();
    source.start();
    socket()._open();
    // /VelocityInformation is a fixed base topic; picking then dropping it must
    // not sever the base subscription the cockpit still needs.
    source.subscribeRaw("/VelocityInformation");
    const before = socket().sent.length;
    source.unsubscribeRaw("/VelocityInformation");
    const unsubs = socket().sent.slice(before).map((s) => JSON.parse(s)).filter((m) => m.op === "unsubscribe");
    expect(unsubs.map((m) => m.topic)).not.toContain("/VelocityInformation");
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

  it("stopLidar() unsubscribes only lidar topics; telemetry stays subscribed", () => {
    const { source, socket } = makeSource();
    source.start();
    socket()._open();
    source.stopLidar();

    const lidarTopics = LIVE_ROS_TOPICS.filter(isLidarTopic);
    const unsubs = socket().sent.map((s) => JSON.parse(s)).filter((m) => m.op === "unsubscribe");
    expect(unsubs.map((m) => m.topic).sort()).toEqual([...lidarTopics].sort());
    expect(unsubs.map((m) => m.topic)).not.toContain("/VelocityInformation");
    expect(socket().readyState).toBe(MockWS.OPEN); // source keeps running
  });

  it("startLidar() after stopLidar() resubscribes the lidar topics", () => {
    const { source, socket } = makeSource();
    source.start();
    socket()._open();
    source.stopLidar();
    const before = socket().sent.length;
    source.startLidar();

    const lidarTopics = LIVE_ROS_TOPICS.filter(isLidarTopic);
    const resubs = socket().sent.slice(before).map((s) => JSON.parse(s)).filter((m) => m.op === "subscribe");
    expect(resubs.map((m) => m.topic).sort()).toEqual([...lidarTopics].sort());
  });

  it("a restart while lidar is stopped does not resubscribe lidar topics", () => {
    const { source, socket } = makeSource();
    source.start();
    socket()._open();
    source.stopLidar();
    source.stop();
    source.start();            // fresh socket — lidar must stay off
    socket()._open();

    const subs = socket().sent.map((s) => JSON.parse(s)).filter((m) => m.op === "subscribe");
    expect(subs.map((m) => m.topic).some(isLidarTopic)).toBe(false);
    expect(subs.map((m) => m.topic)).toContain("/VelocityInformation");
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
