#!/usr/bin/env bash
# Draws the floorplan and publishes it to Home Assistant: the drawings, the card and the dashboard.
# See docs/homeassistant.md#floorplan.
#
# Usage: floorplan/run.sh [data-dir], default /Volumes/archive/homelab/floorplan
set -euo pipefail

cd "$(dirname "$0")/.."

dir=${1:-/Volumes/archive/homelab/floorplan}

# Sends one websocket command to Home Assistant and fails unless it succeeds. Prints the result.
ha() {
  scripts/ha-ws.sh "$1" | jq -c 'if .success then .result else error(.error.message) end'
}

node floorplan/floorplan.ts "$dir"

# The drawings and the card go over as one tar stream. Without COPYFILE_DISABLE, macOS adds a ._ file for each.
ssh homeassistant 'sudo mkdir -p /config/www/floorplan'
(cd "$dir" && COPYFILE_DISABLE=1 tar -cf - floorplan-*.svg) | ssh homeassistant 'sudo tar -xof - -C /config/www/floorplan'
ssh homeassistant 'sudo tee /config/www/floorplan/card.js >/dev/null' <floorplan/card.js

# Home Assistant caches /local files, so the card's address carries a hash of its content.
card="/local/floorplan/card.js?v=$(shasum -a 256 floorplan/card.js | cut -c1-8)"
resource=$(ha '{"type":"lovelace/resources"}' | jq -r '.[] | select(.url | startswith("/local/floorplan/card.js")) | .id')
if [[ -z $resource ]]; then
  ha "$(jq -nc --arg url "$card" '{type: "lovelace/resources/create", res_type: "module", url: $url}')" >/dev/null
else
  ha "$(jq -nc --arg id "$resource" --arg url "$card" '{type: "lovelace/resources/update", resource_id: $id, res_type: "module", url: $url}')" >/dev/null
fi

if ! ha '{"type":"lovelace/dashboards/list"}' | jq -e 'any(.[]; .url_path == "floor-plan")' >/dev/null; then
  ha '{"type":"lovelace/dashboards/create","url_path":"floor-plan","title":"Floorplan","icon":"mdi:floor-plan","mode":"storage","show_in_sidebar":true,"require_admin":false}' >/dev/null
fi
ha "$(jq -c '{type: "lovelace/config/save", url_path: "floor-plan", config: .}' "$dir/dashboard.json")" >/dev/null

echo "published to http://homeassistant.home.arpa:8123/floor-plan"
