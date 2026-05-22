# MapPilot Bridge systemd Service

Auto-starts the MapPilot ROS/MQTT bridge stack at boot. Only useful on the
vehicle computer (or any machine where you want the bridges running without
manual `roslaunch`).

## Install

```bash
sudo cp /home/enescoskun/Desktop/map-pilot-main/ros_bridge/systemd/mappilot-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mappilot-bridge.service
```

## Status / logs

```bash
sudo systemctl status mappilot-bridge.service
sudo journalctl -u mappilot-bridge.service -f
```

## Customize

The unit calls `scripts/start_stack.sh`, which sources every workspace listed
in its `WORKSPACES` array and forwards `BAG_FILE` / `LAUNCH_ARGS` env vars to
`roslaunch`. Edit the script (not the unit) to add workspaces or change the
default bag.

Per-instance overrides go in a drop-in file so you do not edit the shipped
unit:

```bash
sudo systemctl edit mappilot-bridge.service
```

```ini
[Service]
Environment=BAG_FILE=/home/enescoskun/Desktop/enes_ws/bag/2025-07-21-16-53-56.bag
Environment=LAUNCH_ARGS=run_reverse:=false
```

## Disable

```bash
sudo systemctl disable --now mappilot-bridge.service
```

## Why not a user service?

A `--user` systemd unit only runs while the user is logged in (with linger
disabled). Running the bridges through the system manager keeps them up
across reboots even when no one is signed in on the vehicle computer.
