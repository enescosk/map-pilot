#!/usr/bin/env bash
#
# MapPilot demo launcher — brings up the whole local stack in the correct order:
#
#   roscore → rosbridge :9090 → [rosbag play] → backend :4000 → vite :5173
#
# The bag is played BEFORE the backend subscribes, so rosbridge has already
# advertised every topic — this avoids the "advertise-before-subscribe" trap
# where the backend connects to an empty rosbridge and never receives data.
#
# NOTE: on the vehicle computer the bag is normally OFF (a second machine feeds
# rosbridge). Bag playback here is opt-in via --bag, purely for all-in-one local
# testing. Everything is backgrounded; run scripts/demo-down.sh to tear it down.
#
# Usage:
#   scripts/demo-up.sh                 # roscore+rosbridge+backend+vite (no bag)
#   scripts/demo-up.sh --bag           # also loop the default demo bag
#   scripts/demo-up.sh --bag FILE.bag  # loop a specific bag
#   scripts/demo-up.sh --help
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────
ROS_SETUP="/opt/ros/noetic/setup.bash"
WS_SETUP="/home/enescoskun/Desktop/enes_ws/devel/setup.bash"
BAG_DIR="/home/enescoskun/Desktop/enes_ws/bag"
DEFAULT_BAG="2025-07-21-16-54-43.bag"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

WS_PORT="${WS_PORT:-4000}"
VITE_PORT="${VITE_PORT:-5173}"
export LIDAR_SOURCE="${LIDAR_SOURCE:-vehicle-ros}"
export DERIVE_VEHICLE="${DERIVE_VEHICLE:-true}"

# Topics the dashboard actually consumes (keeps rosbridge light vs the full bag).
BAG_TOPICS="/rslidar_points /cloud /zed2i/zed_node/rgb/image_rect_color/compressed \
/imu/data /ekf/odometry_earth /heading /navsatfix /zed2i/zed_node/odom \
/left_laser/scan /right_laser/scan"

STATE_DIR="$PROJECT_DIR/scripts/.demo"
PID_FILE="$STATE_DIR/pids"
LOG_DIR="$STATE_DIR/logs"

# ── Args ──────────────────────────────────────────────────────────────────
PLAY_BAG=0
BAG_FILE="$DEFAULT_BAG"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bag)
      PLAY_BAG=1
      if [[ "${2:-}" != "" && "${2:-}" != --* ]]; then BAG_FILE="$2"; shift; fi
      ;;
    --help|-h)
      sed -n '2,26p' "$0" | sed 's/^#\{0,1\} \{0,1\}//'; exit 0 ;;
    *) echo "Bilinmeyen argüman: $1 (--help)"; exit 1 ;;
  esac
  shift
done

mkdir -p "$LOG_DIR"
: > "$PID_FILE"

log()  { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }

track() { echo "$1 $2" >> "$PID_FILE"; }  # "name pid"

# Wait until a TCP port is listening (or fail after ~timeout*0.5s).
wait_port() {
  local port="$1" name="$2" tries="${3:-40}"
  for ((i=0; i<tries; i++)); do
    if ss -tlnp 2>/dev/null | grep -q ":$port "; then ok "$name hazır (:$port)"; return 0; fi
    sleep 0.5
  done
  warn "$name :$port içinde açılmadı — log: $LOG_DIR/$name.log"; return 1
}

# ── Preflight ───────────────────────────────────────────────────────────────
[[ -f "$ROS_SETUP" ]] || { echo "ROS bulunamadı: $ROS_SETUP"; exit 1; }
# shellcheck disable=SC1090
source "$ROS_SETUP"
[[ -f "$WS_SETUP" ]] && source "$WS_SETUP" || warn "workspace setup yok: $WS_SETUP (custom mesajlar eksik olabilir)"

if [[ "$PLAY_BAG" == 1 && ! -f "$BAG_DIR/$BAG_FILE" ]]; then
  echo "Bag yok: $BAG_DIR/$BAG_FILE"; exit 1
fi

# Spawn a service so the TRACKED pid is the real long-lived process: `( exec … )&`
# makes the subshell BECOME the command (exec replaces it), so $! is that
# process — not a wrapper that exits and orphans its child. demo-down.sh then
# kills the tracked pid plus its descendants.
# shellcheck disable=SC2086

# ── 1. roscore ──────────────────────────────────────────────────────────────
log "roscore başlatılıyor"
( exec roscore ) > "$LOG_DIR/roscore.log" 2>&1 < /dev/null & track roscore $!
wait_port 11311 roscore

# ── 2. rosbridge :9090 ──────────────────────────────────────────────────────
log "rosbridge_websocket başlatılıyor"
( exec roslaunch rosbridge_server rosbridge_websocket.launch ) > "$LOG_DIR/rosbridge.log" 2>&1 < /dev/null & track rosbridge $!
wait_port 9090 rosbridge

# ── 3. rosbag (opsiyonel, backend'den ÖNCE) ─────────────────────────────────
if [[ "$PLAY_BAG" == 1 ]]; then
  log "rosbag oynatılıyor (loop): $BAG_FILE"
  ( cd "$BAG_DIR" && exec rosbag play --loop --clock "$BAG_FILE" --topics $BAG_TOPICS ) \
      > "$LOG_DIR/rosbag.log" 2>&1 < /dev/null & track rosbag $!
  sleep 6; ok "bag yayında (topic'ler advertise edildi)"
else
  warn "bag playback KAPALI (normal mod). Veri harici bir kaynaktan gelmeli. Lokal test için: --bag"
fi

# ── 4. backend :4000 (publisher'lar aktifken abone olur) ────────────────────
log "backend başlatılıyor (LIDAR_SOURCE=$LIDAR_SOURCE DERIVE_VEHICLE=$DERIVE_VEHICLE)"
( cd "$PROJECT_DIR" && exec env WS_PORT="$WS_PORT" node server/index.js ) > "$LOG_DIR/backend.log" 2>&1 < /dev/null & track backend $!
wait_port "$WS_PORT" backend

# ── 5. vite :5173 (npm yerine vite'ı doğrudan exec et — ara wrapper olmasın) ─
log "frontend (vite) başlatılıyor"
( cd "$PROJECT_DIR" && exec node node_modules/.bin/vite --port "$VITE_PORT" --strictPort ) > "$LOG_DIR/vite.log" 2>&1 < /dev/null & track vite $!
wait_port "$VITE_PORT" vite

# ── Özet ────────────────────────────────────────────────────────────────────
echo
ok "MapPilot ayakta"
echo "    Dashboard : http://localhost:$VITE_PORT"
echo "    Backend   : ws://localhost:$WS_PORT"
echo "    rosbridge : ws://localhost:9090"
[[ "$PLAY_BAG" == 1 ]] && echo "    Bag       : $BAG_FILE (loop)"
echo "    Loglar    : $LOG_DIR/"
echo "    Kapatmak  : scripts/demo-down.sh"
