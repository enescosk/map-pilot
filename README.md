# MapPilot

React dashboard — canlı araç telemetrisi, LiDAR, kamera, GPS ve offline bag oynatma.

---

## Sabit Bilgiler

| | IP |
|---|---|
| Dashboard bilgisayarı | `172.22.78.39` |
| Araç bilgisayarı | `172.22.78.35` |

Bag dosyaları her iki bilgisayarda da aynı yerde:

```
~/Desktop/enes_ws/bag/
```

---

## 1. Tek Bilgisayar — Geliştirme / Offline

```bash
npm install        # ilk kurulumda bir kez
npm run server     # backend  — ws://localhost:4000
npm run dev        # frontend — http://localhost:5173
```

Bag dosyası otomatik olarak `~/Desktop/enes_ws/bag/` içindeki son değiştirilen `.bag` dosyasını seçer.
UI'dan bağlantı kurmaya gerek yok — offline modda direkt oynatılır.

---

## 2. İki Bilgisayarlı Test — Rosbridge (Önerilen)

### Dashboard bilgisayarı (172.22.78.39) — 2 terminal

**Terminal 1 — Backend:**
```bash
cd ~/map-pilot
npm run server
```

**Terminal 2 — Frontend:**
```bash
cd ~/map-pilot
npm run dev
```

Tarayıcıda `http://localhost:5173` aç.
Sağ paneldeki **Bağlantı** kutusunda:
- Mod: `Rosbridge (direkt)`
- Araç IP: `172.22.78.35`
- **Bağlan** butonuna tıkla

### Araç bilgisayarı (172.22.78.35) — 1 terminal

```bash
roslaunch rosbridge_server rosbridge_websocket.launch
```

> rosbridge varsayılan olarak `9090` portunu kullanır. Başka port varsa UI'daki IP alanına `172.22.78.35:PORT` yaz.

---

## 3. İki Bilgisayarlı Test — MQTT Köprüsü

Dashboard → MQTT broker → Araç ROS bridge zinciri. Rosbridge çalışmıyorsa bu modu kullan.

### Dashboard bilgisayarı (172.22.78.39) — 3 terminal

**Terminal 1 — MQTT Broker:**
```bash
cd ~/map-pilot
node server/mqttBroker.js
```

**Terminal 2 — Backend:**
```bash
cd ~/map-pilot
npm run server
```

**Terminal 3 — Frontend:**
```bash
cd ~/map-pilot
npm run dev
```

UI'da:
- Mod: `MQTT köprü`
- Broker IP: `172.22.78.39`
- **Bağlan**

### Araç bilgisayarı (172.22.78.35) — 1 terminal

```bash
MQTT_HOST=172.22.78.39 python3 ~/ros_ws/src/mqtt_bridge/scripts/ros_to_mqtt.py
```

---

## 4. Offline Bag Oynatma (Tek Bilgisayar)

```bash
cd ~/map-pilot
npm run server
npm run dev
```

UI'da bağlantı kurmana gerek yok. Backend `~/Desktop/enes_ws/bag/` içindeki en son `.bag` dosyasını otomatik seçer.
Farklı bir dosya seçmek için UI'daki **Bag** açılır menüsünü kullan.

---

## Vehicle Control

Sağ panelde **Vehicle Control**:

| Element | Davranış |
|---------|----------|
| **Arm** | Canlı kontrolü etkinleştirir |
| **Deadman timer** | 3 sn içinde girdi gelmezse otomatik disarm, nötr komut gönderir |
| **Disarm** | Nötr komut gönderip paneli devre dışı bırakır |
| **E-STOP** | `brake_percent=100` + `mode=Emergency` — klavyeden `Space` ile de tetiklenir |

> Fiziksel acil stop her zaman önceliklidir. Dashboard E-STOP yazılım tabanlıdır.

---

## Ortam Değişkenleri (Gerekirse)

Normalde UI'dan ayarlanır. Terminal'den override etmek istersen:

| Değişken | Varsayılan | Açıklama |
|----------|------------|----------|
| `LIDAR_SOURCE` | `bag` | `bag`, `vehicle-ros`, `mqtt` |
| `ROSBRIDGE_URL` | `ws://localhost:9090` | Araç rosbridge adresi |
| `MQTT_URL` | `mqtt://localhost:1883` | MQTT broker adresi |
| `MQTT_HOST` | `localhost` | `ros_to_mqtt.py` için broker IP |
| `BAG_DIRECTORY` | `~/Desktop/enes_ws/bag` | Bag dizini |
| `WS_PORT` | `4000` | Backend WebSocket portu |
