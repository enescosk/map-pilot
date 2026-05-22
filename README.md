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
