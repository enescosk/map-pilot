import type { TelemetryState, TopicHealthState } from "./telemetry";

export type LidarReading = {
  angle: number;
  distance: number;
  angleRadians?: number;
  intensity?: number;
};

export type Point3D = {
  x: number;
  y: number;
  z: number;
  intensity?: number;
  seen?: number;
};

export type CameraStatus = {
  name?: string;
  topic: string;
  isActive: boolean;
  mode?: string;
  resolution: string;
  fps: number;
  issue?: string;
  frameSrc?: string;
  streamUrl?: string;
  frameCount: number;
  lastTime?: string;
};

export type BagTopicSummary = {
  topic: string;
  type: string;
  count: number;
  lastTime?: string;
  sample?: string;
};

export type BagStatus = {
  connected: boolean;
  playing: boolean;
  source: string;
  path: string;
  frameCount: number;
  cursor: number;
  topics: BagTopicSummary[];
  currentTime?: string;
  startTime?: string;
  endTime?: string;
  durationSeconds?: number;
};

export type BackendStatusMessage = {
  type: "backend-status";
  connected: boolean;
};

export type StatusMessage = {
  type: "status";
  connected: boolean;
  source?: string;
  topic?: string;
};

export type BagListMessage = {
  type: "bag-list";
  files?: BagFileOption[];
  selectedPath?: string;
  directory?: string;
};

export type BagFileOption = {
  name: string;
  path: string;
  size: number;
  modifiedAt: number;
};

export type LatestFrame = {
  topic: string;
  time?: string;
  messageType: string;
  preview: string;
};

export type ResetPlaybackMessage = {
  type: "reset-playback";
  path?: string;
};

export type ScanMessage = {
  type: "scan";
  readings?: LidarReading[];
  scan?: unknown;
  source?: string;
  topic?: string;
  time?: string;
  frameId?: string;
};

export type PointCloudMessage = {
  type: "point-cloud";
  readings?: LidarReading[];
  points?: Point3D[];
  source?: string;
  topic?: string;
  time?: string;
  frameId?: string;
  resolvedFrame?: string;
};

export type CameraFrameMessage = {
  type: "camera-frame";
  src: string;
  source?: string;
  topic?: string;
  time?: string;
  streamUrl?: string;
  resolution?: string;
  fps?: number;
  issue?: string;
};

export type CameraStreamMessage = {
  type: "camera-stream";
  streamUrl: string;
  source?: string;
  topic?: string;
  time?: string;
  resolution?: string;
};

export type TelemetryMessage = {
  type: "telemetry";
  source?: string;
  topic?: string;
  time?: string;
  telemetry: Partial<TelemetryState>;
};

export type BagFrameMessage = {
  type: "bag-frame";
  source?: string;
  topic?: string;
  time?: string;
  messageType?: string;
  payload?: unknown;
};

export type BagStatusMessage = BagStatus & {
  type: "bag-status";
};

export type TopicHealthMessage = TopicHealthState & {
  type: "topic-health";
};

export type BackendErrorMessage = {
  type: "backend-error";
  message?: string;
  topic?: string;
};

export type UnknownLiveMessage = {
  type?: string;
  [key: string]: unknown;
};

export type LiveMessage =
  | BackendStatusMessage
  | StatusMessage
  | BagListMessage
  | ResetPlaybackMessage
  | ScanMessage
  | PointCloudMessage
  | CameraFrameMessage
  | CameraStreamMessage
  | TelemetryMessage
  | BagFrameMessage
  | BagStatusMessage
  | TopicHealthMessage
  | BackendErrorMessage;
