# MapPilot Live Telemetry Architecture

This document describes the live-telemetry pipeline that lands in Phase 3 of the
MapPilot refactor. The product goal is a live vehicle-monitoring platform; bag
playback stays as a development/test feature feeding the same pipeline.

Phase 3 introduced the new modules, the canonical schema, the topic map, the
telemetry store, the legacy adapter, and routed the first four vehicle signals
(speed, steering, brake, throttle) through the new pipeline.

Phase 4 adds the in-process telemetry bus, the topic-health service with
stale-data detection, snapshot-on-connect for new dashboard clients, and moves
MQTT republish out of `server/index.js` into a dedicated publisher subscribed
to the bus. The topic map now covers 11 vehicle topics + LaserScan. Phase 5
(frontend hooks, types, v2 protocol) is still TODO.

---

## 1. Goals & non-goals

**Goals**

- One clear data path from source → normalizer → store → transport.
- Single source of truth for topic mapping and unit conversion.
- Validation that flags bad data instead of crashing.
- Rate-limited logging so a misbehaving publisher cannot flood the console.
- Zero UI regressions during the migration.

**Non-goals (Phase 4)**

- Splitting bagPlaybackSource into per-engine files (still 770 LOC — folded into a later cleanup).
- Changing the WebSocket wire protocol consumed by App.tsx. (Phase 5)
- Frontend refactor (types/, hooks/, utils/, dead-component cleanup). (Phase 5)

---

## 2. Data flow (Phase 4)

```
   Sources (server/sources/)                       Normalizer dispatcher
   ┌─────────────────────────────┐                 ┌──────────────────────────┐
   │ bagPlaybackSource           │                 │ server/normalizers/index │
   │ vehicleRosSource            │ raw frame       │   ┌────────────────────┐ │
   │ rosBridgeLidarSource        ├────────────────▶│   │ topicMap match?    │ │
   │ mqttBridgeSource            │                 │   └─yes─┬───────────┬──┘ │
   │ directLidarSource           │                 │        │           │ no │
   └────────────┬────────────────┘                 │   extract→store    │    │
                │                                  │   →legacyAdapter   │    │
                │ envelope (emit callback)         │        │           │    │
                │                                  │   bus.emit('       │    │
                ▼                                  │   telemetry-patch')│    │
   ┌──────────────────────────────────────────┐    │        │           │    │
   │ services/telemetryBus.js (EventEmitter)  │◀───┤        │     legacy path│
   │                                          │    │        │     (scan,pcd, │
   │  events:                                 │    │        │      imu,gps,…)│
   │   - "envelope"                           │    │        │           │    │
   │   - "telemetry-patch"                    │    │        ▼           │    │
   │   - "topic-health"                       │    │   return envelope ←┘    │
   └──┬───────────┬────────────────────────┬──┘    └──────────────────────────┘
      │           │                        │
      ▼           ▼                        ▼
   WebSocket   MQTT publisher          topicHealthService (1 Hz)
   broadcast   transport/              services/topicHealthService.js
              mqttPublisher.js          │
                                        │  emits { type:"topic-health", … }
                                        └──▶ back onto the bus → WS clients
```

Phase-3 envelope parity is preserved; the bus is the new fan-out point and the
WS broadcaster + MQTT publisher are subscribers, not callers.

---

## 3. Canonical telemetry schema

Defined as JSDoc + `createEmptyTelemetry()` in [server/schema/telemetry.js](../server/schema/telemetry.js).
Numeric leaves are `{ value, unit }` envelopes; the legacy adapter unwraps them
back to plain numbers for today's dashboard. The full shape (abbreviated):

```js
{
  schemaVersion: 1,
  sourceName: "bag-playback" | "vehicle-ros" | ...,
  sourceTopic: string,
  monoTimestampMs: number,
  sensorTimestamp?: string,

  vehicle: {
    speedMps:               { value, unit: "m/s" }   | undefined,
    speedKmh:               { value, unit: "km/h" }  | undefined,
    steeringAngleDeg:       { value, unit: "deg" }   | undefined,
    steeringSpeedDegPerSec: { value, unit: "deg/s" } | undefined,
    steeringTorqueNm:       { value, unit: "Nm" }    | undefined,
    epsTempC?: number, epsWork?: boolean, epsFault?: boolean,

    throttle?: {
      source: "cruise" | "pedal",
      setSpeedKmh?, cruiseActive?, pedalPercent?, targetSpeedKmh?
    },

    brake?: {
      pressureBar?, targetPressureBar?, pedalRaw?, faultLevel?, percent?,
      parking?, active?
    },
  },

  imu?, gps?, odom?, lidar?, camera?,
  health:   { topics: { ... }, sources: { ... } },
  validity: { fields: string[], invalid: [{ field, reason }, ...] },
}
```

`RANGE_GUARDS` in the same file lists the allowed numeric ranges per field.
Out-of-range values land in `validity.invalid` but are **not** dropped.

---

## 4. Topic mapping

Single declarative table at [server/mapping/topicMap.js](../server/mapping/topicMap.js). Each entry has:

| field    | type   | purpose                                                    |
|----------|--------|------------------------------------------------------------|
| id       | string | log/diagnostic label                                       |
| topic    | RegExp | case-insensitive match against the ROS topic name          |
| type     | RegExp | case-insensitive match against `msg._type`                 |
| extract  | fn     | `(msg) => DeepPartial<CanonicalTelemetry>` (with `{value, unit}` leaves) |

Phase-4 routed topics:

| ROS topic                       | Canonical fields                                                                 |
|---------------------------------|----------------------------------------------------------------------------------|
| `/VelocityInformation`          | `vehicle.speedMps`, `vehicle.speedKmh`                                           |
| `/eps_response`                 | `vehicle.steeringAngleDeg`, `.steeringSpeedDegPerSec`, `.steeringTorqueNm`, `.epsTempC`, `.epsWork`, `.epsFault` |
| `/vcu_eps_control`              | `vehicle.targetSteeringAngleDeg`, `.targetSteeringSpeedDegPerSec`, `.epsWorkCommand` |
| `/steer_control`                | `vehicle.targetSteeringAngleDeg`, `.targetSteeringSpeedDegPerSec`                |
| `/EHB_BrakingResponse`          | `vehicle.brake.{pressureBar,pedalRaw,faultLevel,parking,active}`                 |
| `/vcu_ehb_control`              | `vehicle.brake.{targetPressureBar,brakingEnable}`, `vehicle.commandedSpeedKmh`   |
| `/brake_control`                | `vehicle.brake.percent`                                                          |
| `/throttle_control`             | `vehicle.throttle.{kind:"targetSpeed",setSpeedKmh,cruiseActive,source:"cruise"}` |
| `/fb_motor_driver_report`       | `vehicle.drivetrain.{rpm,gear,tripDistance}`                                     |
| `/rc_unit_report`               | `vehicle.state.{batterySoc,batteryVoltage,ignition,emergency,handbrake,leftSignal,rightSignal}` |
| `/autonomous_mode_selection`    | `vehicle.state.mode`                                                             |

`/scan`, `/rslidar_points`, camera, IMU, GPS, and odom still go through the
legacy `normalizeFrameLegacy` path (point-cloud/camera have no canonical
schema yet — they are physically large and structurally different from scalar
telemetry).

### Throttle discriminator

`vehicle.throttle.kind` encodes what the signal actually IS, not where it came
from. Values: `"targetSpeed"`, `"pedalPercent"`, `"command"`, `"unknown"`. The
existing `/throttle_control` topic publishes a cruise *target speed* in km/h,
so it produces `kind: "targetSpeed"`. A future pedal-feedback topic produces
`kind: "pedalPercent"`. Consumers must not conflate them.

### Adding a new topic

1. Add an entry to `TOPIC_MAP` in [server/mapping/topicMap.js](../server/mapping/topicMap.js). Wrap numeric outputs with `vu(value, unit)`.
2. (Optional) Add a corresponding `RANGE_GUARDS` row in [server/schema/telemetry.js](../server/schema/telemetry.js).
3. Extend [server/transport/legacyAdapter.js](../server/transport/legacyAdapter.js) so the new canonical field is also emitted under its legacy name. Keep field order matching the legacy normalizer (see the brake section for an example) — the existing UI is order-tolerant, but byte-for-byte parity makes regression diffing trivial.
4. Add a smoke-test case in the same style as the parity script in §10.

Unknown topics that hit the legacy `normalizeFrame` are emitted with `type: "bag-frame"` and the raw payload, never silently dropped.

---

## 5. Source adapters

All sources expose the same surface:

```js
createXxxSource({ emit, ...config }) => { start(), stop(), getStatus(), seek?() }
```

`emit(packet)` is called with a fully-formed WS envelope. Sources never touch
the WebSocket or MQTT layers directly; that is `server/index.js`'s job.

Current sources (`server/sources/`):

- `bagPlaybackSource.js` — rosbag (.bag) + JSONL playback.
- `vehicleRosSource.js` — rosbridge subscriber for vehicle topics.
- `rosBridgeLidarSource.js` — rosbridge subscriber for a single `/scan` topic.
- `mqttBridgeSource.js` — MQTT relay (consumes already-normalized events).
- `directLidarSource.js` — RPLIDAR serial.

All five emit through `normalizeFrame` (or relay pre-normalized payloads), so
the canonical pipeline applies uniformly.

---

## 6. Normalizer & validation rules

[server/normalizers/index.js](../server/normalizers/index.js) is the dispatcher. For each frame:

1. Match against `TOPIC_MAP`. If hit:
   - `extract(message)` → `{ vehicle: ... }` patch (canonical, with units).
   - `telemetryStore.applyUpdate(patch, meta)` — deep-merges, updates per-leaf
     timestamps, runs range guards, populates `validity.invalid`.
   - `legacyAdapter.toLegacyTelemetry(patch, invalid)` — unwraps `{value,unit}`
     back to plain numbers, renames canonical fields to their legacy names, and
     attaches `invalidFields: [...]` when applicable.
   - Returns the legacy envelope `{ type:"telemetry", source, topic, time, telemetry }`.
2. Otherwise, runs the legacy `normalizeFrameLegacy` path (scan / pcd / img /
   imu / gps / odom / vehicle fallback / bag-frame) unchanged.

### Validation

Validation runs inside `telemetryStore.applyUpdate`:

- **Finite check**: every numeric leaf must satisfy `Number.isFinite`.
- **Range guard**: looked up via dotted path in `RANGE_GUARDS`.
- **Out-of-range**: recorded as `{ field, reason: "out-of-range[min,max]" }`.

Offenders are appended to `telemetry.invalidFields` on the emitted envelope so
the UI can render a "stale/bad" indicator without dropping the value entirely.

### Rate-limited logging

[server/services/healthRegistry.js](../server/services/healthRegistry.js)
implements a per-topic token bucket (default 10 s cooldown). At most one log
line per topic per cooldown window is written; raw counters stay accurate and
will surface via `health.topics[topic]` in Phase 4 snapshots.

---

## 7. Telemetry store, bus, and staleness model

### `services/telemetryBus.js`

In-process `EventEmitter` exposed as a module-scoped singleton. Three event
kinds:

- `"envelope"` — every packet headed for the WS broadcaster (also forwarded to
  MQTT events/* and to topicHealthService).
- `"telemetry-patch"` — emitted by the dispatcher after a canonical route.
  Carries `{ patch, meta, invalid }`. Consumed by `mqttPublisher` to publish
  structured `${MQTT_TOPIC_ROOT}/vehicle/*` topics without re-parsing the
  legacy envelope.
- `"topic-health"` — periodic snapshot from topicHealthService.

### `services/telemetryStore.js`

Unchanged from Phase 3: in-memory canonical state, deep-merge + range guards,
per-leaf `lastUpdateMs`. `reset()` is now called on `load-bag` so a new bag
does not inherit the previous run's vehicle state.

### `services/topicHealthService.js`

- Subscribes to `"envelope"` and `"telemetry-patch"`.
- Maintains `Map<topic, { kind, lastSeenMs, hitCount, ttlMs, invalidCount, errorCount, … }>`
  and `Map<source, { connected, lastStatusMs, topic }>`.
- `tick()` runs at 1 Hz, computes `isStale = ageMs > ttlMs`, and emits a
  `{ type: "topic-health", time, topics, sources }` envelope onto the bus.
- TTL defaults (overridable per topic):
    - vehicle scalar telemetry: 1500 ms
    - LiDAR scan: 2000 ms
    - point-cloud: 2000 ms
    - camera frame/stream: 2000 / 5000 ms
    - IMU / GPS / odometry: 3000 ms (matched by topic substring override)
    - fallback: 5000 ms
- The WS broadcaster forwards `topic-health` envelopes to all clients (1 Hz —
  not a flood; frontend can render a per-topic indicator off it).

Out-of-range or NaN values are still reported through `validity.invalid` on the
store and (counted, rate-limited) in `healthRegistry`.

---

## 8. WebSocket protocol

### v1 (current, legacy)

Single endpoint at `ws://<host>:WS_PORT`. Server emits one of:

```
{ type: "backend-status", connected }
{ type: "status", connected, source, topic }
{ type: "bag-list", files, selectedPath, directory }
{ type: "bag-status", connected, playing, source, path, frameCount, cursor, topics, currentTime, startTime, endTime, durationSeconds }
{ type: "reset-playback", path }
{ type: "scan", source, topic, time, readings: [{angle, distance, ...}] }
{ type: "point-cloud", source, topic, time, points: [...], readings: [...], frameId }
{ type: "camera-frame", source, topic, time, src, resolution, fps }
{ type: "camera-stream", source, topic, streamUrl, ... }
{ type: "telemetry", source, topic, time, telemetry: { speed?, vehicle?: {...}, imu?, gps?, ... , invalidFields? } }
{ type: "bag-frame", source, topic, time, messageType, payload }
{ type: "backend-error", message }
{ type: "topic-health", time, topics: { [topic]: { kind, sourceName, lastSeenMs, ageMs, ttlMs, isStale, hitCount, errorCount, invalidCount } }, sources: { [source]: { connected, lastStatusMs, topic } } }
```

### Snapshot on connect (Phase 4)

When a new dashboard WS opens, `server/index.js` sends — in order:
1. `{ type: "backend-status", connected: true }`
2. Current source status (`type: "status"`).
3. Cached latest `telemetry` envelope (if any has streamed in this session).
4. Latest `topic-health` snapshot.
5. `bag-list`.

This means a freshly opened tab can paint a meaningful UI immediately even
before the next telemetry packet arrives.

Client → server commands (also JSON over the same socket):

```
{ type: "start-lidar" }
{ type: "stop-lidar" }
{ type: "list-bags" }
{ type: "load-bag", path }
{ type: "seek-playback", ratio }
```

### v2 (canonical, Phase 5 target — NOT YET ACTIVE)

Will use discriminated envelopes:

```
{ kind: "snapshot",  telemetry: CanonicalTelemetry }
{ kind: "delta",     patch, topic, monoTimestampMs }
{ kind: "scan"|"point-cloud"|"camera-frame"|"bag-status"|"command-ack"|... }
```

Negotiated via query param (e.g. `?protocol=v2`). When the frontend has fully
migrated, the legacy adapter and the v1 emission are removed.

---

## 9. Command channel

Same WebSocket. The router lives inline in `server/index.js` (`wss.on("connection")`).
Phase 4 lifts this into `server/services/commandRouter.js`.

---

## 10. Bag playback specifics

`server/sources/bagPlaybackSource.js` still hosts:

- **JSONL playback** (`createJsonPlaybackSource`) — for pre-exported test fixtures.
- **Rosbag binary playback** (`createRosbagPlaybackSource`) — for real .bag files,
  with per-topic throttling, sorted queue, seek support, TF tree loading.

Both engines emit through `normalizeFrame` (imported from the new location).
Phase 4 splits this file into `server/sources/bagPlayback/{index,jsonPlayback,rosbagPlayback,topicSelection,throttling}.js`.

---

## 11. How to run

```sh
# Dev server (frontend)
npm run dev

# Bag playback backend (default LIDAR_SOURCE=bag)
npm run server

# Live vehicle telemetry over rosbridge
npm run vehicle-live   # = LIDAR_SOURCE=vehicle-ros + MQTT_PUBLISH=true

# Standalone MQTT broker (Aedes)
npm run mqtt-broker

# Dashboard fed from MQTT
npm run dashboard-mqtt # = LIDAR_SOURCE=mqtt
```

Bag-related env vars (`server/sources/bagPlaybackSource.js`): `BAG_FILE_PATH`,
`BAG_DIRECTORY`, `BAG_PLAYBACK_RATE`, `BAG_WINDOW_SECONDS`, `BAG_TOPICS`,
`BAG_READ_CHUNK_SECONDS`. Lidar density limits (`server/config/env.js`):
`MAX_SCAN_POINTS`, `MAX_POINT_CLOUD_POINTS`.

### Smoke-testing the new pipeline

```sh
node --input-type=module -e "
import('./server/normalizers/index.js').then(({ normalizeFrame }) => {
  const env = normalizeFrame({
    topic: '/VelocityInformation',
    type:  'project_msg/VelocityInformation',
    time:  '1700000000.0',
    message: { VelocityMS: 250, VelocityKMH: 90 },
  });
  console.log(JSON.stringify(env));
});
"
# Expected: {"type":"telemetry","source":"bag-playback","topic":"/VelocityInformation","time":"1700000000.0","telemetry":{"speed":2.5,"vehicle":{"speedKmh":9}}}
```

---

## 12. Debugging topic connection problems

| Symptom                                  | Where to look                                                                 |
|------------------------------------------|-------------------------------------------------------------------------------|
| No telemetry at all                      | `getStatus()` envelope; `LIDAR_SOURCE` env var; check `wss.on("listening")` log |
| Specific topic is silent                 | `healthRegistry.snapshot()` for the topic; verify it matches a `TOPIC_MAP` regex |
| Value visibly wrong on UI                | Add a console.log in [server/transport/legacyAdapter.js](../server/transport/legacyAdapter.js); check the canonical store via `telemetryStore.getSnapshot()` |
| Value flagged stale (Phase 4)            | Inspect `health.topics[topic].lastUpdateMs` vs. TTL                            |
| Out-of-range warning floods              | Check `RANGE_GUARDS` in [server/schema/telemetry.js](../server/schema/telemetry.js); cooldown raised in `healthRegistry.createRegistry({ cooldownMs })` |
| Vehicle ROS source not subscribing       | `ROSBRIDGE_URL` env var; rosbridge at default `ws://localhost:9090`            |
| Bag file not found                       | `BAG_DIRECTORY` + `BAG_FILE_PATH`; server logs `Selected bag: ...`             |

---

## 13. Migration history & remaining TODOs

**Phase 3 (done)**

- New modules: `server/{config,schema,mapping,normalizers,services,transport}/`
- 4 signals (`/VelocityInformation`, `/eps_response`, `/EHB_BrakingResponse`, `/throttle_control`) routed through the canonical pipeline.
- Byte-for-byte legacy envelope parity for those 4 signals.
- Backwards import `vehicleRosSource → bagPlaybackSource` removed.
- bagPlaybackSource trimmed from 1296 → 770 LOC; helpers/parsers/normalizers live in `server/normalizers/`.

**Phase 4 (done)**

- `services/telemetryBus.js` — EventEmitter fan-out for envelopes + canonical patches + topic-health.
- `services/topicHealthService.js` — last-seen tracking, per-kind TTLs, 1 Hz `topic-health` envelope emission.
- `transport/mqttPublisher.js` — subscribes to bus; publishes events/* and `vehicle/{speed,steering,brake,throttle,state,health}` from canonical patches (no more re-parsing in index.js).
- `mapping/topicMap.js` — extended from 4 to 11 routed topics: + `/vcu_eps_control`, `/steer_control`, `/vcu_ehb_control`, `/brake_control`, `/fb_motor_driver_report`, `/rc_unit_report`, `/autonomous_mode_selection`. Throttle gains a `kind` discriminant.
- `transport/legacyAdapter.js` — extended for drivetrain/state/commanded fields.
- `rosBridgeLidarSource.js` — local `laserScanToReadings` removed; uses `normalizers/laserScan.js`.
- `server/index.js` — 260 → 200 LOC, no MQTT/normalization logic, snapshot-on-connect (backend-status + status + cached telemetry + topic-health + bag-list).

**Phase 5 (TODO)**

- `src/types/` mirror of the canonical schema.
- `src/api/liveTelemetryClient.ts` (WS lifecycle + exponential reconnect backoff).
- `src/hooks/{useLiveTelemetry,useBagPlayback,useLidarStream,useCameraStream,useCockpitEvents,useTopicHealth}.ts`.
- `src/utils/{lidarProcessing,telemetryFormatters,pointCloudColor,timeLabel,series,cockpitEvents}.ts`.
- Extract `Lidar3DView` and `LidarCanvas2D` components.
- Wire up the 7 currently-dead components in `src/components/`; add a topic-health/staleness indicator.
- Negotiate v2 protocol; once App.tsx is fully on v2, delete the legacy adapter.

**Deferred backend cleanup**

- Split `bagPlaybackSource.js` into `sources/bagPlayback/{index,jsonPlayback,rosbagPlayback,topicSelection,throttling}.js`.
- Lift the WS command handler into `server/services/commandRouter.js`.
