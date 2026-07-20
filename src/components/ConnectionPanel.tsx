import { memo, useState } from "react";

type SourceMode = "vehicle-ros" | "mqtt";

type Props = {
  onConnect: (source: SourceMode, rosbridgeUrl: string, mqttUrl: string) => void;
  currentSource: string;
  connected: boolean;
  backendError?: string | null;
};

function stored(key: string, fallback: string): string {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}

function save(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

function ConnectionPanel({ onConnect, currentSource, connected, backendError }: Props) {
  const [source, setSource] = useState<SourceMode>(() => {
    const s = stored("mp_source", "vehicle-ros");
    return (s === "mqtt" ? "mqtt" : "vehicle-ros") as SourceMode;
  });
  const [vehicleIp, setVehicleIp] = useState(() => stored("mp_vehicle_ip", window.location.hostname));
  const [mqttIp, setMqttIp] = useState(() => stored("mp_mqtt_ip", window.location.hostname));

  function handleConnect() {
    save("mp_source", source);
    save("mp_vehicle_ip", vehicleIp);
    save("mp_mqtt_ip", mqttIp);
    const rosbridgeUrl = `ws://${vehicleIp}:9090`;
    const mqttUrl = `mqtt://${mqttIp}:1883`;
    onConnect(source, rosbridgeUrl, mqttUrl);
  }

  const isLive = currentSource === "vehicle-ros" || currentSource === "mqtt";

  return (
    <section className="workspace-panel connection-panel">
      <h2>Bağlantı</h2>

      <div className="conn-row">
        <label>Mod</label>
        <select value={source} onChange={(e) => setSource(e.currentTarget.value as SourceMode)}>
          <option value="vehicle-ros">Rosbridge (direkt)</option>
          <option value="mqtt">MQTT köprü</option>
        </select>
      </div>

      {source === "vehicle-ros" && (
        <div className="conn-row">
          <label>Araç IP</label>
          <input
            type="text"
            value={vehicleIp}
            onChange={(e) => setVehicleIp(e.currentTarget.value)}
            placeholder="192.168.1.x"
            spellCheck={false}
          />
          <span className="conn-hint">ws://{vehicleIp}:9090</span>
        </div>
      )}

      {source === "mqtt" && (
        <div className="conn-row">
          <label>Broker IP</label>
          <input
            type="text"
            value={mqttIp}
            onChange={(e) => setMqttIp(e.currentTarget.value)}
            placeholder="192.168.1.x"
            spellCheck={false}
          />
          <span className="conn-hint">mqtt://{mqttIp}:1883</span>
        </div>
      )}

      <div className="conn-row">
        <label>Durum</label>
        <span className={connected && isLive ? "status-pill good" : "status-pill muted"}>
          {connected && isLive ? `Bağlı — ${currentSource}` : "Bağlı değil"}
        </span>
      </div>

      <button type="button" className="conn-btn" onClick={handleConnect}>
        Bağlan
      </button>

      {backendError && (
        <p className="conn-error" role="alert">{backendError}</p>
      )}
    </section>
  );
}

export default memo(ConnectionPanel);
