import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock mqtt ───────────────────────────────────────────────────────────────

const { mockPublish, mockEnd, mockOn, mockConnect } = vi.hoisted(() => {
  const mockPublish = vi.fn();
  const mockEnd    = vi.fn();
  const mockOn     = vi.fn();
  const mockConnect = vi.fn(() => ({ publish: mockPublish, end: mockEnd, on: mockOn }));
  return { mockPublish, mockEnd, mockOn, mockConnect };
});

vi.mock("mqtt", () => ({
  default: { connect: mockConnect },
}));

import { createControlPublisher } from "../transport/controlPublisher.js";

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Topic validation ─────────────────────────────────────────────────────────

describe("publish — topic validation", () => {
  it("rejects a topic not in the whitelist", () => {
    const pub = createControlPublisher();
    const result = pub.publish({ topic: "/some_random_topic", msgType: "any/Type", message: {} });
    expect(result).toEqual({ ok: false, reason: "topic /some_random_topic not allowed" });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("rejects an undefined topic", () => {
    const pub = createControlPublisher();
    expect(pub.publish({ topic: undefined, message: {} }).ok).toBe(false);
  });

  it("rejects a null topic", () => {
    const pub = createControlPublisher();
    expect(pub.publish({ topic: null, message: {} }).ok).toBe(false);
  });
});

// ─── msgType validation ───────────────────────────────────────────────────────

describe("publish — msgType validation", () => {
  it("rejects a wrong msgType for a known topic", () => {
    const pub = createControlPublisher();
    const result = pub.publish({
      topic: "/steer_control",
      msgType: "wrong/Type",
      message: { desired_angle: 5 },
    });
    expect(result).toEqual({
      ok: false,
      reason: "msgType wrong/Type != expected beemobs_routine_manager/SteerControl",
    });
  });

  it("accepts when msgType matches the whitelist exactly", () => {
    const pub = createControlPublisher();
    const result = pub.publish({
      topic: "/steer_control",
      msgType: "beemobs_routine_manager/SteerControl",
      message: { desired_angle: 10 },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts when msgType is omitted (topic-only check)", () => {
    const pub = createControlPublisher();
    const result = pub.publish({ topic: "/steer_control", message: { desired_angle: 0 } });
    expect(result.ok).toBe(true);
  });
});

// ─── Envelope and MQTT topic ──────────────────────────────────────────────────

describe("publish — envelope structure", () => {
  it("returns ok:true with the correct mqttTopic", () => {
    const pub = createControlPublisher({ topicRoot: "map-pilot" });
    const result = pub.publish({ topic: "/steer_control", message: { desired_angle: 15 } });
    expect(result).toEqual({ ok: true, mqttTopic: "map-pilot/control/steer_control" });
  });

  it("publishes a correctly shaped envelope", () => {
    const pub = createControlPublisher({ topicRoot: "test-root" });
    pub.publish({ topic: "/brake_control", message: { brake_percent: 50 } });

    expect(mockPublish).toHaveBeenCalledOnce();
    const [mqttTopic, rawPayload] = mockPublish.mock.calls[0];
    expect(mqttTopic).toBe("test-root/control/brake_control");

    const envelope = JSON.parse(rawPayload);
    expect(envelope.topic).toBe("/brake_control");
    expect(envelope.type).toBe("beemobs_routine_manager/BrakeControl");
    expect(envelope.message).toEqual({ brake_percent: 50 });
    expect(typeof envelope.time).toBe("string"); // ISO timestamp
  });

  it("uses empty object when message is omitted", () => {
    const pub = createControlPublisher();
    pub.publish({ topic: "/throttle_control" });
    const envelope = JSON.parse(mockPublish.mock.calls[0][1]);
    expect(envelope.message).toEqual({});
  });

  it("builds topic path correctly for all whitelisted topics", () => {
    const pub = createControlPublisher({ topicRoot: "root" });
    const cases = [
      ["/throttle_control",          "dbw_interface/CruiseControlSignals"],
      ["/vcu_eps_control",           "dbw_interface/VCU_EPS_Control"],
      ["/vcu_ehb_control",           "dbw_interface/VCU_EHB_CONTROL"],
      ["/steer_control",             "beemobs_routine_manager/SteerControl"],
      ["/brake_control",             "beemobs_routine_manager/BrakeControl"],
      ["/autonomous_mode_selection", "beemobs_routine_manager/VehicleMode"],
    ];
    for (const [topic, expectedType] of cases) {
      vi.clearAllMocks();
      const result = pub.publish({ topic, message: {} });
      expect(result.ok, `topic ${topic} should be ok`).toBe(true);
      expect(result.mqttTopic).toBe(`root/control${topic}`);
      const envelope = JSON.parse(mockPublish.mock.calls[0][1]);
      expect(envelope.type).toBe(expectedType);
    }
  });
});

// ─── MQTT client lifecycle ────────────────────────────────────────────────────

describe("MQTT client lifecycle", () => {
  it("does not create the MQTT client until first publish", () => {
    createControlPublisher();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("reuses the same MQTT client across multiple publishes", () => {
    const pub = createControlPublisher();
    pub.publish({ topic: "/steer_control", message: {} });
    pub.publish({ topic: "/brake_control", message: {} });
    expect(mockConnect).toHaveBeenCalledOnce();
  });

  it("stop() calls client.end(true) after a publish", () => {
    const pub = createControlPublisher();
    pub.publish({ topic: "/steer_control", message: {} });
    pub.stop();
    expect(mockEnd).toHaveBeenCalledWith(true);
  });

  it("stop() is safe to call when no connection has been made", () => {
    const pub = createControlPublisher();
    expect(() => pub.stop()).not.toThrow();
    expect(mockEnd).not.toHaveBeenCalled();
  });

  it("isConnected() starts false", () => {
    const pub = createControlPublisher();
    expect(pub.isConnected()).toBe(false);
  });
});

// ─── allowed export ───────────────────────────────────────────────────────────

describe("allowed", () => {
  it("exposes the whitelist map with all expected topics", () => {
    const pub = createControlPublisher();
    const topics = Object.keys(pub.allowed);
    expect(topics).toContain("/steer_control");
    expect(topics).toContain("/brake_control");
    expect(topics).toContain("/throttle_control");
    expect(topics).toContain("/vcu_eps_control");
    expect(topics).toContain("/vcu_ehb_control");
    expect(topics).toContain("/autonomous_mode_selection");
  });
});
