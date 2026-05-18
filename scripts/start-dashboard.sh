#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

COMPUTER_1_IP="${1:-${COMPUTER_1_IP:-172.22.78.39}}"
MQTT_URL="${MQTT_URL:-mqtt://${COMPUTER_1_IP}:1883}"

echo "Starting MapPilot dashboard backend"
echo "MQTT URL: ${MQTT_URL}"
echo
echo "Start the frontend in another terminal with:"
echo "  npm run dev"
echo

LIDAR_SOURCE=mqtt \
MQTT_URL="${MQTT_URL}" \
npm run server
