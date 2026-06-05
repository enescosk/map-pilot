// Vehicle control panel.
//
// Sends control envelopes through the backend's WebSocket → MQTT → mqtt_to_ros
// path. Two safety nets:
//   1. The whole panel is disabled until the user toggles "Live control".
//   2. A 3-second deadman re-arms safe mode automatically if the user stops
//      issuing inputs (any slider movement / button press counts).

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { currentTimeString } from "../utils/timeLabel";
import "./VehicleControlPanel.css";

type SendMessage = (message: unknown) => boolean;

type Mode = 0 | 1 | 2 | 3;
const MODE_LABELS: Record<Mode, string> = {
  0: "Manual",
  1: "Autonomous",
  2: "Teleoperated",
  3: "Emergency",
};

const DEADMAN_MS = 3000;
const STEER_MIN = -90;
const STEER_MAX = 90;
const SPEED_MAX = 60; // km/h cap for the UI
const BRAKE_MAX = 100;

export function VehicleControlPanel({ sendMessage }: { sendMessage: SendMessage }) {
  const [liveControl, setLiveControl] = useState(false);
  const [steer, setSteer] = useState(0);
  const [steerSpeed, setSteerSpeed] = useState(15);
  const [setSpeed, setSetSpeed] = useState(0);
  const [cruiseActive, setCruiseActive] = useState(false);
  const [brake, setBrake] = useState(0);
  const [mode, setMode] = useState<Mode>(0);
  const [lastSent, setLastSent] = useState<string>("");

  // Derived: no extra state needed
  const estopFailed = lastSent.includes("E-STOP FAILED");

  const deadmanTimer = useRef<number | undefined>(undefined);

  // Bypasses liveControl — sends zero commands on disarm so vehicle doesn't hold last command.
  function sendNeutral(steerSpeedDeg: number) {
    sendMessage({ type: "control-command", topic: "/steer_control", msgType: "beemobs_routine_manager/SteerControl", message: { desired_angle: 0, desired_angle_speed: steerSpeedDeg } });
    sendMessage({ type: "control-command", topic: "/throttle_control", msgType: "dbw_interface/CruiseControlSignals", message: { setSpeed_kmh: 0, cruiseActive: false } });
    sendMessage({ type: "control-command", topic: "/brake_control", msgType: "beemobs_routine_manager/BrakeControl", message: { brake_percent: 0 } });
  }

  function disarm() {
    // Functional update gives us the current steerSpeed without stale closure
    setSteerSpeed((s) => { sendNeutral(s); return s; });
    setLiveControl(false);
    setSteer(0);
    setSetSpeed(0);
    setCruiseActive(false);
    setBrake(0);
    setLastSent(`${currentTimeString()}  DISARMED → neutral sent`);
  }

  function armDeadman() {
    if (deadmanTimer.current) window.clearTimeout(deadmanTimer.current);
    deadmanTimer.current = window.setTimeout(disarm, DEADMAN_MS);
  }

  function send(topic: string, msgType: string, message: Record<string, unknown>) {
    if (!liveControl) return;
    const ok = sendMessage({ type: "control-command", topic, msgType, message });
    if (ok) {
      setLastSent(`${currentTimeString()}  ${topic}`);
      armDeadman();
    }
  }

  useEffect(() => {
    return () => {
      if (deadmanTimer.current) window.clearTimeout(deadmanTimer.current);
    };
  }, []);

  function sendSteer(value: number, speed: number) {
    send("/steer_control", "beemobs_routine_manager/SteerControl", {
      desired_angle: value,
      desired_angle_speed: speed,
    });
  }

  function sendThrottle(speedKmh: number, cruise: boolean) {
    send("/throttle_control", "dbw_interface/CruiseControlSignals", {
      setSpeed_kmh: Math.max(0, Math.min(255, Math.round(speedKmh))),
      cruiseActive: cruise,
    });
  }

  function sendBrake(percent: number) {
    send("/brake_control", "beemobs_routine_manager/BrakeControl", {
      brake_percent: Math.max(0, Math.min(BRAKE_MAX, Math.round(percent))),
    });
  }

  function sendMode(value: Mode) {
    send("/autonomous_mode_selection", "beemobs_routine_manager/VehicleMode", {
      mode: value,
    });
  }

  function emergencyStop() {
    // E-stop bypasses the arm toggle — send immediately regardless of disarmed state.
    const ok1 = sendMessage({
      type: "control-command",
      topic: "/brake_control",
      msgType: "beemobs_routine_manager/BrakeControl",
      message: { brake_percent: BRAKE_MAX },
    });
    const ok2 = sendMessage({
      type: "control-command",
      topic: "/autonomous_mode_selection",
      msgType: "beemobs_routine_manager/VehicleMode",
      message: { mode: 3 },
    });
    setBrake(BRAKE_MAX);
    setMode(3);
    setSetSpeed(0);
    setCruiseActive(false);
    if (!ok1 || !ok2) {
      setLastSent(`${currentTimeString()}  E-STOP FAILED — WebSocket kapalı!`);
    } else {
      setLastSent(`${currentTimeString()}  E-STOP`);
    }
  }

  const steerStyle = {
    "--steer-percent": `${((steer - STEER_MIN) / (STEER_MAX - STEER_MIN)) * 100}%`,
  } as CSSProperties;

  return (
    <section className={`vehicle-control ${liveControl ? "live" : "safe"}`}>
      <header>
        <div>
          <p className="panel-label">Operator</p>
          <h2>Vehicle Control</h2>
          <p className="control-sub">
            {liveControl ? "LIVE — commands go to the vehicle" : "SAFE — arm to send commands"}
          </p>
        </div>
        <button
          type="button"
          className={`control-arm ${liveControl ? "armed" : ""}`}
          onClick={() => {
            if (liveControl) {
              disarm();
            } else {
              setLiveControl(true);
              armDeadman();
            }
          }}
        >
          {liveControl ? "Disarm" : "Arm"}
        </button>
      </header>

      <div className={`control-body ${liveControl ? "" : "disabled"}`}>
        <div className="control-row" style={steerStyle}>
          <div className="control-row-head">
            <span>Steering</span>
            <strong>{steer.toFixed(0)}°</strong>
          </div>
          <input
            type="range"
            min={STEER_MIN}
            max={STEER_MAX}
            value={steer}
            disabled={!liveControl}
            onChange={(e) => {
              const v = Number(e.target.value);
              setSteer(v);
              sendSteer(v, steerSpeed);
            }}
            onDoubleClick={() => {
              setSteer(0);
              sendSteer(0, steerSpeed);
            }}
          />
          <div className="control-meta">
            <span>Rate {steerSpeed} °/s</span>
            <input
              type="range"
              min={1}
              max={60}
              value={steerSpeed}
              disabled={!liveControl}
              onChange={(e) => setSteerSpeed(Number(e.target.value))}
            />
          </div>
        </div>

        <div className="control-row">
          <div className="control-row-head">
            <span>Cruise speed</span>
            <strong>{setSpeed} km/h</strong>
          </div>
          <input
            type="range"
            min={0}
            max={SPEED_MAX}
            value={setSpeed}
            disabled={!liveControl}
            onChange={(e) => {
              const v = Number(e.target.value);
              setSetSpeed(v);
              sendThrottle(v, cruiseActive);
            }}
          />
          <div className="control-meta">
            <label className="control-checkbox">
              <input
                type="checkbox"
                checked={cruiseActive}
                disabled={!liveControl}
                onChange={(e) => {
                  setCruiseActive(e.target.checked);
                  sendThrottle(setSpeed, e.target.checked);
                }}
              />
              <span>Cruise active</span>
            </label>
          </div>
        </div>

        <div className="control-row">
          <div className="control-row-head">
            <span>Brake</span>
            <strong>{brake}%</strong>
          </div>
          <input
            type="range"
            min={0}
            max={BRAKE_MAX}
            value={brake}
            disabled={!liveControl}
            onChange={(e) => {
              const v = Number(e.target.value);
              setBrake(v);
              sendBrake(v);
            }}
          />
          <div className="control-meta">
            <button
              type="button"
              className="control-pulse"
              disabled={!liveControl}
              onPointerDown={() => sendBrake(BRAKE_MAX)}
              onPointerUp={() => {
                setBrake(0);
                sendBrake(0);
              }}
              onPointerLeave={() => {
                if (brake > 0) {
                  setBrake(0);
                  sendBrake(0);
                }
              }}
            >
              Hold to brake
            </button>
          </div>
        </div>

        <div className="control-row">
          <div className="control-row-head">
            <span>Mode</span>
            <strong>{MODE_LABELS[mode]}</strong>
          </div>
          <select
            value={mode}
            disabled={!liveControl}
            onChange={(e) => {
              const v = Number(e.target.value) as Mode;
              setMode(v);
              sendMode(v);
            }}
          >
            {([0, 1, 2, 3] as Mode[]).map((m) => (
              <option key={m} value={m}>{MODE_LABELS[m]}</option>
            ))}
          </select>
        </div>
      </div>

      <footer>
        <button type="button" className={`control-estop${estopFailed ? " estop-failed" : ""}`} onClick={emergencyStop}>
          E-STOP
        </button>
        <span className={`control-last${estopFailed ? " control-last--error" : ""}`}>
          {lastSent ? `Last: ${lastSent}` : "No commands sent yet"}
        </span>
      </footer>
    </section>
  );
}
