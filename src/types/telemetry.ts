export type Vector3 = {
  x?: number;
  y?: number;
  z?: number;
};

export type GpsFix = {
  latitude?: number;
  longitude?: number;
  altitude?: number;
};

export type VehicleTelemetry = {
  speedKmh?: number;
  steeringAngle?: number;
  steeringSpeed?: number;
  steeringTorque?: number;
  targetSteeringAngle?: number;
  targetSteeringSpeed?: number;
  epsTemperature?: number;
  epsWork?: boolean;
  epsFault?: boolean;
  brakePressure?: number;
  targetBrakePressure?: number;
  brakePedal?: number;
  brakePercent?: number;
  brakeFaultLevel?: number;
  parkingBrake?: boolean;
  brakeSystemActive?: boolean;
  brakingEnable?: number;
  throttleSetSpeedKmh?: number;
  throttlePedalPercent?: number;
  throttleTargetSpeedKmh?: number;
  throttleKind?: string;
  throttleSource?: string;
  cruiseActive?: boolean;
  rpm?: number;
  tripDistance?: number;
  gear?: number;
  batterySoc?: number;
  batteryVoltage?: number;
  ignition?: boolean;
  leftSignal?: boolean;
  rightSignal?: boolean;
  emergency?: boolean;
  handbrake?: boolean;
  autonomousManualSelect?: boolean;
  mode?: string;
};

export type TelemetryState = {
  speed: number;
  acceleration: Vector3;
  angularVelocity: Vector3;
  magneticField: Vector3;
  gps: GpsFix;
  vehicle: VehicleTelemetry;
  pose?: {
    position?: Vector3;
    orientation?: Vector3 & { w?: number };
  };
  invalidFields?: string[];
};

export type SeriesPoint = {
  label: string;
  value: number;
};

export type CockpitEvent = {
  id: string;
  timestamp: number;
  timeLabel: string;
  severity: "warning" | "critical" | "info";
  source: "imu" | "speed" | "system";
  title: string;
  description?: string;
};

export type DecisionLogEntry = {
  id: string;
  time: string;
  source: string;
  message: string;
};

export type TopicHealthEntry = {
  kind?: string;
  sourceName?: string;
  lastSeenMs?: number;
  ageMs?: number;
  ttlMs?: number;
  isStale?: boolean;
  hitCount?: number;
  errorCount?: number;
  invalidCount?: number;
  lastError?: string;
  lastInvalid?: {
    field: string;
    reason: string;
  };
};

export type SourceHealthEntry = {
  connected: boolean;
  lastStatusMs?: number;
  topic?: string;
};

export type TopicHealthState = {
  time?: string;
  topics: Record<string, TopicHealthEntry>;
  sources: Record<string, SourceHealthEntry>;
};
