import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { createTopicHealthService } from "../services/topicHealthService.js";
import { BUS_EVENTS } from "../services/telemetryBus.js";

// Drive the service through its bus and read the snapshot, without timers.
function setup() {
  const bus = new EventEmitter();
  const svc = createTopicHealthService({ bus });
  svc.start(); // subscribes recordEnvelope to the bus
  const emit = (env) => bus.emit(BUS_EVENTS.ENVELOPE, env);
  return { bus, svc, emit, stop: () => svc.stop() };
}

describe("topicHealthService backend error counting", () => {
  it("counts backend-error envelopes under __backend__", () => {
    const { svc, emit, stop } = setup();
    emit({ type: "backend-error", message: "connect ECONNREFUSED" });
    emit({ type: "backend-error", message: "connect ECONNREFUSED" });
    expect(svc.getSnapshot().topics.__backend__.errorCount).toBe(2);
    stop();
  });

  it("clears retry errors when the source transitions to connected", () => {
    const { svc, emit, stop } = setup();
    // bridge is down — several retries pile up
    emit({ type: "backend-error", message: "ECONNREFUSED" });
    emit({ type: "backend-error", message: "ECONNREFUSED" });
    expect(svc.getSnapshot().topics.__backend__.errorCount).toBe(2);
    // bridge comes up
    emit({ type: "status", source: "vehicle-ros", connected: true });
    expect(svc.getSnapshot().topics.__backend__.errorCount).toBe(0);
    stop();
  });

  it("does not reset on a repeated connected status (only on the transition)", () => {
    const { svc, emit, stop } = setup();
    emit({ type: "status", source: "vehicle-ros", connected: true });
    emit({ type: "backend-error", message: "mid-session blip" });
    emit({ type: "status", source: "vehicle-ros", connected: true }); // still connected
    // the error raised while already connected is preserved
    expect(svc.getSnapshot().topics.__backend__.errorCount).toBe(1);
    stop();
  });
});
