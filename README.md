# MapPilot

MapPilot is a local React dashboard for robot mapping, camera, LiDAR, health, live vehicle telemetry, and offline dataset playback.

## Run

```bash
npm install
npm run dev
```

In a second terminal:

```bash
npm run server
```

The frontend connects to `ws://localhost:4000`.

## Topic-First Live Architecture

Production and realistic tests should use live topics as the primary input:

```text
ROS topics or MQTT topics
→ MapPilot backend source adapter
→ normalizers / derived telemetry fallback
→ WebSocket live telemetry stream
→ React dashboard
```

Bag playback is still available, but it is an offline test/debug source:

```text
bag playback
→ same normalizers
→ same WebSocket live telemetry stream
→ React dashboard
```

For realistic bag testing on a ROS machine, prefer `rosbag play`. That republishes the recorded data as normal ROS topics, and MapPilot consumes those topics through the live ROS or MQTT source.

### Which Mode Should I Use?

- Real robot / live ROS: use `npm run live-ros` with `ROSBRIDGE_URL=ws://ROBOT_IP:9090`.
- Bag replay as realistic live topics: run `rosbag play` on the ROS machine, then use `npm run live-ros` from MapPilot.
- Offline bag debugging on the dashboard machine: use `npm run offline-bag`.
- MQTT dashboard / remote bridge: use `npm run dashboard-mqtt` with `MQTT_URL=mqtt://BROKER_IP:1883`.
- Direct serial LiDAR bench work: use `LIDAR_SOURCE=direct npm run server`.

### Two-Computer Live Test Setup

Computer A, the ROS machine:

- runs ROS and the vehicle/sensor stack
- runs `rosbridge_server` or a ROS-to-MQTT bridge
- optionally runs `rosbag play` to republish a bag as live ROS topics

Computer B, the MapPilot machine:

- runs the MapPilot backend and frontend
- connects to Computer A through rosbridge or MQTT
- displays scan, point-cloud, camera, odometry, IMU, heading, GPS, and vehicle telemetry through the same dashboard pipeline

## Live ROS Topic Mode

Use this mode when Computer B can reach Computer A's `rosbridge_server`.

On Computer A:

```bash
roslaunch rosbridge_server rosbridge_websocket.launch
# Optional realistic test input:
rosbag play /path/to/2025-07-21-16-54-43.bag --clock
```

On Computer B:

```bash
ROSBRIDGE_URL=ws://COMPUTER_A_IP:9090 npm run live-ros
npm run dev
```

Open `http://localhost:5173/`.

The live ROS source defaults to these topic families:

- `/scan`, `/left_laser/scan`, `/right_laser/scan`
- `/rslidar_points`, `/m1/rslidar_points`, `/cloud`
- `/camera/image_raw`, `/out/compressed`
- `/imu/data`, `/zed2i/zed_node/imu/data`
- `/ekf/odometry_earth`, `/zed2i/zed_node/odom`
- `/heading`
- `/navsatfix`
- existing vehicle/CAN topics such as `/VelocityInformation`, `/eps_response`, `/EHB_BrakingResponse`, `/throttle_control`, `/steer_control`, `/brake_control`

Override the list when a robot publishes different names:

```bash
LIVE_ROS_TOPICS=/scan,/rslidar_points,/out/compressed,/imu/data,/ekf/odometry_earth,/heading,/navsatfix ROSBRIDGE_URL=ws://COMPUTER_A_IP:9090 npm run live-ros
```

`VEHICLE_TOPICS` is still supported as a backward-compatible alias, but `LIVE_ROS_TOPICS` is preferred for new setups.

## Live MQTT Topic Mode

The MQTT source supports two ingestion styles:

1. Already-normalized MapPilot event envelopes on `map-pilot/events/#`.
2. Raw ROS-like JSON frames on `map-pilot/raw/#`, normalized by the backend.

Example raw MQTT payload:

```json
{
  "topic": "/ekf/odometry_earth",
  "type": "nav_msgs/Odometry",
  "time": "1753106099.511656684",
  "message": {
    "twist": { "twist": { "linear": { "x": 4.1, "y": 0, "z": 0 } } }
  }
}
```

Run a local development broker:

```bash
npm run mqtt-broker
```

Run MapPilot as an MQTT dashboard:

```bash
MQTT_URL=mqtt://COMPUTER_A_IP:1883 npm run dashboard-mqtt
npm run dev
```

If your ROS-to-MQTT bridge publishes raw frames elsewhere, override the subscriptions:

```bash
MQTT_RAW_TOPICS=robot/raw/# MQTT_URL=mqtt://COMPUTER_A_IP:1883 npm run dashboard-mqtt
```

## Vehicle Computer MQTT Publisher

MapPilot can also run on the vehicle/ROS computer as a bridge that reads ROS topics via rosbridge and republishes normalized MapPilot envelopes to MQTT. This is useful when the dashboard computer cannot connect directly to rosbridge.

### Vehicle/ROS computer

Start a MQTT broker. You can use the bundled development broker:

```bash
npm run mqtt-broker
```

In another terminal, subscribe to live vehicle topics and publish them to MQTT:

```bash
ROSBRIDGE_URL=ws://localhost:9090 MQTT_URL=mqtt://localhost:1883 npm run vehicle-live
```

If the topic list differs on the vehicle, override it with `LIVE_ROS_TOPICS`:

```bash
LIVE_ROS_TOPICS=/VelocityInformation,/eps_response,/EHB_BrakingResponse,/steer_control,/brake_control,/scan,/rslidar_points,/imu/data ROSBRIDGE_URL=ws://localhost:9090 MQTT_URL=mqtt://localhost:1883 npm run vehicle-live
```

Published MQTT topics:

```text
map-pilot/events/<event-type>
map-pilot/vehicle/health
map-pilot/vehicle/state
map-pilot/vehicle/speed
map-pilot/vehicle/steering
map-pilot/vehicle/brake
```

### Dashboard computer

Subscribe to the vehicle computer's MQTT broker:

```bash
MQTT_URL=mqtt://VEHICLE_COMPUTER_IP:1883 npm run dashboard-mqtt
```

In another terminal:

```bash
npm run dev
```

Open:

```text
http://localhost:5173/
```

## ROS Bridge Package (`ros_bridge/mqtt_bridge`)

A ROS1 catkin package that runs directly on the vehicle computer to bridge ROS topics and MQTT in both directions. Use this when rosbridge_server is not desirable (e.g. you want raw native ROS performance and a single MQTT entry point).

Contents:

- `scripts/ros_to_mqtt.py` — subscribes to vehicle CAN and standard sensor topics, publishes JSON envelopes to `map-pilot/raw/<topic>`.
- `scripts/mqtt_to_ros.py` — subscribes to `map-pilot/control/+`, publishes accepted control commands back onto ROS.
- `launch/mappilot_stack.launch` — single-command stack: rosbridge + rosbag + both bridges.

### Build

```bash
# On the vehicle computer, with ROS1 Noetic and any custom message workspaces sourced:
mkdir -p ~/ros_ws/src && cd ~/ros_ws/src
ln -s /path/to/map-pilot/ros_bridge/mqtt_bridge .
cd ~/ros_ws && catkin_make
source devel/setup.bash
```

### Run

```bash
source /opt/ros/noetic/setup.bash
source /path/to/custom_msgs_ws/devel/setup.bash   # if dbw_interface / beemobs_routine_manager are needed
source ~/ros_ws/devel/setup.bash
roslaunch mqtt_bridge mappilot_stack.launch
```

CLI overrides:

```bash
# different bag
roslaunch mqtt_bridge mappilot_stack.launch bag:=/path/to/another.bag
# disable reverse bridge (read-only mode)
roslaunch mqtt_bridge mappilot_stack.launch run_reverse:=false
# disable forward bridge (rosbridge-only mode)
roslaunch mqtt_bridge mappilot_stack.launch run_bridge:=false
```

### Dashboard side

Once the bridges are running, point any MapPilot dashboard at the broker:

```bash
MQTT_URL=mqtt://VEHICLE_COMPUTER_IP:1883 npm run dashboard-mqtt
```

Drive the vehicle from the dashboard by publishing envelopes to `map-pilot/control/<topic>`:

```bash
mosquitto_pub -h VEHICLE_COMPUTER_IP -t "map-pilot/control/steer_control" \
  -m '{"topic":"/steer_control","type":"beemobs_routine_manager/SteerControl","message":{"desired_angle":15.0,"desired_angle_speed":3.0}}'
```

The reverse bridge whitelists `/throttle_control`, `/vcu_eps_control`, `/vcu_ehb_control`, `/steer_control`, `/brake_control`, `/autonomous_mode_selection` — other topics are rejected so a malformed payload cannot create arbitrary publishers.

### Run on boot

A systemd unit is shipped under `ros_bridge/systemd/`. See its README for install/upgrade/uninstall steps. The unit calls the same `start_stack.sh` wrapper, so manual runs and the boot-managed run stay in sync.

### Mosquitto for remote dashboards

If the dashboard runs on a different machine, the broker must accept external connections. Add `/etc/mosquitto/conf.d/mappilot.conf`:

```text
listener 1883 0.0.0.0
allow_anonymous true
```

Then `sudo systemctl restart mosquitto`.

## Connecting to the Vehicle (Full Drive Mode)

This section covers the full two-machine setup where the dashboard sends real control commands to the vehicle.

```
Dashboard PC                          Vehicle PC (araç bilgisayarı)
─────────────────                     ──────────────────────────────
npm run dev          ◄── WebSocket ── npm run vehicle-live
npm run dashboard-mqtt ──── MQTT ────► mqtt_to_ros.py ──► ROS topics
                     ◄─── MQTT ──── ros_to_mqtt.py ◄── ROS topics
```

### Prerequisites on the vehicle PC

1. **ROS 1 Noetic** installed and sourced.
2. **Custom message packages** built in your workspace:
   - `dbw_interface` (CruiseControlSignals, VCU_EPS_Control, VCU_EHB_CONTROL)
   - `beemobs_routine_manager` (SteerControl, BrakeControl, VehicleMode)
3. **Node.js 18+** — only needed if you run the MapPilot MQTT publisher on the vehicle.
4. **Mosquitto** (or any MQTT broker) on the vehicle:
   ```bash
   sudo apt install mosquitto mosquitto-clients
   sudo systemctl start mosquitto
   ```

### Step 1 — Vehicle PC: build and source the ROS bridge

```bash
mkdir -p ~/ros_ws/src
cd ~/ros_ws/src
ln -s /path/to/map-pilot/ros_bridge/mqtt_bridge .
cd ~/ros_ws
catkin_make
```

Source everything in order (add to `~/.bashrc` for convenience):

```bash
source /opt/ros/noetic/setup.bash
source /path/to/dbw_interface_ws/devel/setup.bash   # custom msgs
source ~/ros_ws/devel/setup.bash
```

### Step 2 — Vehicle PC: launch the full bridge stack

```bash
roslaunch mqtt_bridge mappilot_stack.launch
```

This single command starts:
- `rosbridge_server` (needed for the MapPilot MQTT publisher)
- `ros_to_mqtt.py` — reads vehicle ROS topics, publishes to MQTT
- `mqtt_to_ros.py` — receives dashboard control commands from MQTT, publishes to ROS

If the MQTT broker is on a different host, override via environment variables (added in the latest update):

```bash
MQTT_HOST=192.168.1.10 MQTT_PORT=1883 roslaunch mqtt_bridge mappilot_stack.launch
```

Or set per-bridge for the Python scripts directly:

```bash
MQTT_HOST=192.168.1.10 rosrun mqtt_bridge mqtt_to_ros.py
MQTT_HOST=192.168.1.10 rosrun mqtt_bridge ros_to_mqtt.py
```

> **Allowed control topics** (anything else is rejected by the whitelist):
> `/throttle_control`, `/vcu_eps_control`, `/vcu_ehb_control`,
> `/steer_control`, `/brake_control`, `/autonomous_mode_selection`

### Step 3 — Vehicle PC: start the MapPilot bridge

In a second terminal on the vehicle PC, subscribe to live ROS topics and forward them to MQTT:

```bash
ROSBRIDGE_URL=ws://localhost:9090 MQTT_URL=mqtt://localhost:1883 npm run vehicle-live
```

If your topic names differ from the defaults, override:

```bash
LIVE_ROS_TOPICS=/VelocityInformation,/eps_response,/EHB_BrakingResponse,/steer_control,/brake_control,/scan,/rslidar_points,/imu/data \
ROSBRIDGE_URL=ws://localhost:9090 \
MQTT_URL=mqtt://localhost:1883 \
npm run vehicle-live
```

### Step 4 — Dashboard PC: connect and open

```bash
# In terminal 1 — backend
MQTT_URL=mqtt://VEHICLE_IP:1883 npm run dashboard-mqtt

# In terminal 2 — frontend
npm run dev
```

Open `http://localhost:5173/` and switch to **Control** mode in the top bar.

### Step 5 — Sending commands from the dashboard

The **Vehicle Control** panel is in the right sidebar under Control mode.

| Element | Behaviour |
|---------|-----------|
| **Arm** button | Enables live control. All sliders become active. |
| **Deadman timer** | If no input is received for **3 seconds**, the panel automatically disarms and sends a neutral command (`steer=0`, `throttle=0`, `brake=0`) to the vehicle. |
| **Disarm** button | Immediately sends neutral commands before disabling the panel. |
| **E-STOP** | Sends `brake_percent=100` and `mode=Emergency` regardless of arm state. If the WebSocket is closed the button flashes yellow — the command did **not** reach the vehicle. |

> **Safety rule:** Always keep a hand near the physical emergency stop. The dashboard E-STOP is software-only and depends on a live WebSocket + MQTT chain.

### Troubleshooting

| Symptom | Check |
|---------|-------|
| E-STOP button flashes yellow | WebSocket to backend is closed — check `npm run dashboard-mqtt` on the dashboard PC |
| Panel stays disarmed after 3 s | Deadman timer fired — move a slider to re-arm |
| Vehicle ignores steering commands | Verify `mqtt_to_ros.py` is running on the vehicle and `MQTT_HOST` is correct |
| No telemetry on dashboard | Check `ros_to_mqtt.py` is running and topic names match |
| `mqtt_to_ros.py` can't connect | Set `MQTT_HOST=<broker_ip>` — default is `localhost` |

## Desktop `enes_ws` Bag Playback

Offline bag playback remains available for test/debug work. It is not the primary production input. The backend defaults to the ROS1 bags in `~/Desktop/enes_ws/bag`:

```bash
npm run offline-bag
```

The UI bag picker lists files from that directory, including `aractan.bag` and `uzaktan.bag`. You can override the directory or first selected file:

```bash
BAG_DIRECTORY=/path/to/bags npm run server
BAG_FILE_PATH=/path/to/file.bag npm run server
```

The Beemobs/DBW messages in those bags are normalized into the Vehicle State panel:

- `/VelocityInformation`: speed in m/s and km/h.
- `/eps_response`, `/vcu_eps_control`, `/steer_control`: steering state and commands.
- `/EHB_BrakingResponse`, `/vcu_ehb_control`, `/brake_control`: brake state and commands.
- `/throttle_control`, `/autonomous_mode_selection`, `/rc_unit_report`, `/fb_motor_driver_report`: drive mode, throttle, battery, gear, signals, and EPS status.

## Legacy/Single-Sensor Sources

Direct serial LiDAR is still available for bench testing:

```bash
LIDAR_SOURCE=direct npm run server
```

The older single-topic ROS bridge LiDAR adapter is also available, but `npm run live-ros` is preferred for topic-first testing:

```bash
LIDAR_SOURCE=ros ROSBRIDGE_URL=ws://localhost:9090 ROS_SCAN_TOPIC=/scan npm run server
```

## Bag Playback

The dashboard can play the ROS1 bag on the Desktop directly:

```bash
LIDAR_SOURCE=bag BAG_FILE_PATH=/home/user/Desktop/2025-12-17-18-32-05.bag npm run server
```

For the camera-rich July recording, use the ZED compressed image stream plus LiDAR, IMU, odometry, and GPS:

```bash
LIDAR_SOURCE=bag BAG_FILE_PATH=/home/user/Desktop/2025-07-21-16-54-43.bag BAG_WINDOW_SECONDS=45 BAG_PLAYBACK_INTERVAL_MS=70 BAG_PLAYBACK_BATCH_SIZE=32 BAG_TOPICS=/zed2i/zed_node/rgb/image_rect_color/compressed,/rslidar_points,/left_laser/scan,/right_laser/scan,/imu/data,/zed2i/zed_node/imu/mag,/zed2i/zed_node/odom,/navsatfix,/tf,/tf_static npm run server
```

The bag is large, so playback reads the first 60 seconds by default. Use `BAG_WINDOW_SECONDS=0` for the full file, or provide a comma-separated topic list:

```bash
LIDAR_SOURCE=bag BAG_FILE_PATH=/home/user/Desktop/2025-12-17-18-32-05.bag BAG_TOPICS=/m1/rslidar_points,/helios/rslidar_points npm run server
```

The dashboard can also play a JSON/JSONL export through the same WebSocket path:

```bash
LIDAR_SOURCE=bag BAG_EXPORT_PATH=data/sample-bag-export.jsonl npm run server
```

The export file can be JSON array or JSONL. Each frame should look like this:

```json
{"topic":"/scan","type":"sensor_msgs/LaserScan","time":"00:00:00.000","message":{"angle_min":-3.14,"angle_increment":0.01,"range_min":0.12,"range_max":12,"ranges":[1.2,1.4,1.8]}}
```

Supported playback fields:

- `sensor_msgs/LaserScan`: shown in the LiDAR scan panel.
- `sensor_msgs/PointCloud2`: shown in the 3D LiDAR workspace and top-down projection.
- Camera/image topics with `message.src`, `message.dataUrl`, or base64 `message.data`: shown in the camera panel.
- Any other topic: listed in Bag Details with a payload preview.

MapPilot can read ROS1 `.bag` files directly. JSON/JSONL exports are still useful for small fixtures and custom tests.
