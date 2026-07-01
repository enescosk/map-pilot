#!/usr/bin/env bash
#
# Tears down the MapPilot stack started by demo-up.sh. Reads the tracked PIDs
# and stops them in reverse order (vite → backend → rosbag → rosbridge →
# roscore). The system MQTT broker (:1883) is never touched — demo-up doesn't
# start it.
#
# Usage: scripts/demo-down.sh
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$PROJECT_DIR/scripts/.demo"
PID_FILE="$STATE_DIR/pids"

ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }

# Kill a PID and all of its descendants (children first). roscore/roslaunch/
# rosbag each spawn helper children; killing only the parent would orphan them.
kill_tree() {
  local pid="$1" sig="${2:-TERM}"
  [[ -z "$pid" ]] && return
  local c
  for c in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$c" "$sig"; done
  kill -"$sig" "$pid" 2>/dev/null
}

if [[ ! -f "$PID_FILE" ]]; then
  warn "PID dosyası yok ($PID_FILE) — demo-up.sh çalışmamış olabilir."
  exit 0
fi

# Kill in reverse start order so dependents go before their master.
mapfile -t LINES < "$PID_FILE"
for ((i=${#LINES[@]}-1; i>=0; i--)); do
  name="${LINES[$i]%% *}"
  pid="${LINES[$i]##* }"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill_tree "$pid" TERM && ok "$name ($pid) + alt süreçleri durduruldu"
  else
    warn "$name ($pid) zaten kapalı"
  fi
done

# roslaunch/roscore spawn children (rosmaster, rosout, rosbridge_websocket).
# Give them a moment, then sweep any stragglers this stack owns.
sleep 2
pkill -TERM -f "rosbridge_server rosbridge_websocket" 2>/dev/null || true
pkill -TERM -f "rosmaster --core"                     2>/dev/null || true
pkill -TERM -f "rosout"                               2>/dev/null || true

: > "$PID_FILE"
echo
ok "Stack kapatıldı. (Sistem MQTT broker :1883'e dokunulmadı.)"
