# MapPilot

MapPilot is a local React dashboard for robot mapping, camera, LiDAR, health, and dataset playback.

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

## Desktop `enes_ws` Bag Playback

The backend now defaults to the ROS1 bags in `~/Desktop/enes_ws/bag` and streams them into the cockpit:

```bash
npm run server
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

## Live LiDAR Sources

Bag playback is the default. Direct serial LiDAR is still available:

```bash
LIDAR_SOURCE=direct npm run server
```

ROS bridge LiDAR:

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
- `sensor_msgs/PointCloud2` exported as `{ "points": [{ "x": 1, "y": 2, "z": 0 }] }`: shown in the LiDAR scan panel as a top-down projection.
- Camera/image topics with `message.src`, `message.dataUrl`, or base64 `message.data`: shown in the camera panel.
- Any other topic: listed in Bag Details with a payload preview.

For real `.bag` or `.db3` files, export them first with ROS tooling into this JSONL shape. That keeps the web app independent of ROS binary bag formats while preserving every topic detail in the Bag Details panel.
