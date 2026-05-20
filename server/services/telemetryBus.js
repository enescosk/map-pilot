// In-process event bus that decouples sources, normalizers, and transports.
//
// Event types:
//   - "envelope":       every packet that should reach a WS client. The WS
//                       broadcaster and the MQTT publisher subscribe.
//   - "telemetry-patch": a canonical DeepPartial<CanonicalTelemetry> patch
//                       produced by the topic-map pipeline. Carries { patch,
//                       meta, invalid }. MQTT publisher and topicHealthService
//                       use this to push structured vehicle topics without
//                       re-parsing the legacy envelope.
//   - "topic-health":   periodic ({type:"topic-health", topics, time}) blob
//                       emitted by topicHealthService on a fixed cadence.
//
// The bus deliberately uses Node's EventEmitter rather than a homegrown
// observer because every subscriber is local, synchronous, and short-lived.

import { EventEmitter } from "node:events";

class TelemetryBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(32);
  }
}

export const telemetryBus = new TelemetryBus();

export const BUS_EVENTS = Object.freeze({
  ENVELOPE: "envelope",
  TELEMETRY_PATCH: "telemetry-patch",
  TOPIC_HEALTH: "topic-health",
});
