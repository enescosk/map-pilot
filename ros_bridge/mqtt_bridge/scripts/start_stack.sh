#!/usr/bin/env bash
# Source ROS + workspaces and launch the MapPilot bridge stack.
#
# Customize the WORKSPACES list and BAG_FILE for the host.

set -euo pipefail

# --- Configuration ---------------------------------------------------------
# Workspaces to source, in order. Add or remove paths to match the host setup.
WORKSPACES=(
  "/opt/ros/noetic/setup.bash"
  "/home/gcs/lutfu_eco_ws/devel/setup.bash"
  "${HOME}/ros_ws/devel/setup.bash"
)

# Default bag (override with $BAG_FILE env var if you want a different one).
BAG_FILE="${BAG_FILE:-${HOME}/Desktop/enes_ws/bag/aractan.bag}"

# Extra args forwarded to roslaunch (override with $LAUNCH_ARGS env var).
LAUNCH_ARGS="${LAUNCH_ARGS:-}"
# ---------------------------------------------------------------------------

for ws in "${WORKSPACES[@]}"; do
  if [[ -f "$ws" ]]; then
    # shellcheck disable=SC1090
    source "$ws"
  else
    echo "warning: workspace setup not found: $ws" >&2
  fi
done

exec roslaunch mqtt_bridge mappilot_stack.launch bag:="$BAG_FILE" ${LAUNCH_ARGS}
