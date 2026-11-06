#!/usr/bin/env bash
# Sends one command to Home Assistant's websocket API and prints the response.
# Runs inside the Advanced SSH add-on, which may use the API with the Supervisor token. See docs/homeassistant.md.
#
#   scripts/ha-ws.sh '{"type":"config/entity_registry/list"}' | jq '.result'
set -euo pipefail

[[ $# -eq 1 ]] || { echo "usage: $0 '<json command without id>'" >&2; exit 1; }

# The id is set here. The command goes over stdin, so its quotes don't need escaping for the remote shell.
jq -c '. + {id: 1}' <<<"$1" | ssh homeassistant '
  read -r cmd
  token=$(sudo cat /run/s6/container_environment/SUPERVISOR_TOKEN)
  printf "{\"type\":\"auth\",\"access_token\":\"%s\"}\n%s\n" "$token" "$cmd" \
    | websocat -n --max-messages-rev 3 -B 100000000 ws://supervisor/core/websocket \
    | tail -n 1
'
