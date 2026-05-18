#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

BAG_FILE="${1:-${BAG_FILE_PATH:-/home/user/Desktop/enes_ws/bag/aractan.bag}}"
MQTT_URL="${MQTT_URL:-mqtt://localhost:1883}"

echo "Starting MapPilot vehicle simulator"
echo "Bag file: ${BAG_FILE}"
echo "MQTT URL: ${MQTT_URL}"
echo
echo "Start the broker in another terminal with:"
echo "  npm run mqtt-broker"
echo

MQTT_PUBLISH=true \
SESSION_RECORD=true \
BAG_WINDOW_SECONDS="${BAG_WINDOW_SECONDS:-0}" \
BAG_FILE_PATH="${BAG_FILE}" \
MQTT_URL="${MQTT_URL}" \
npm run server
