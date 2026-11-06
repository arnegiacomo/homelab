#!/usr/bin/env bash
# Creates the 1Password item fugleramme-<name> that frames/run.sh reads. Asks for the frame's values, including the
# SSH password set in Raspberry Pi Imager, and generates the web password. An item that already exists is left alone.
#
# Usage: frames/item.sh <name>
set -euo pipefail

VAULT=${VAULT:-Homelab}
title=fugleramme-${1:?usage: frames/item.sh <name>}
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

if op item get "$title" --vault "$VAULT" >/dev/null 2>&1; then
  echo "ok       $title"
  exit 0
fi

read -rp "SSH username: " USERNAME
read -rsp "SSH password: " SSH_PASSWORD && echo
read -rp "Latitude: " LATITUDE
read -rp "Longitude: " LONGITUDE
read -rsp "BirdWeather token: " BIRDWEATHER_TOKEN && echo
read -rp "Wi-Fi SSID: " WIFI_SSID
read -rsp "Wi-Fi password: " WIFI_PASSWORD && echo
# Letters and digits only, so it can be typed by hand from the note.
WEB_PASSWORD=$(head -c 1000 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c 1-20)
export TITLE=$title USERNAME LATITUDE LONGITUDE BIRDWEATHER_TOKEN WIFI_SSID WIFI_PASSWORD SSH_PASSWORD WEB_PASSWORD

# Built from the environment into a 0600 template file, so no value shows up in argv.
(umask 077 && jq -n '
  def field($id; $type): {id: $id, label: $id, type: $type};
  {title: env.TITLE, category: "LOGIN", fields: [
    field("username"; "STRING") + {purpose: "USERNAME", value: env.USERNAME},
    field("password"; "CONCEALED") + {purpose: "PASSWORD", value: env.SSH_PASSWORD},
    field("web-password"; "CONCEALED") + {value: env.WEB_PASSWORD},
    field("birdweather-token"; "CONCEALED") + {value: env.BIRDWEATHER_TOKEN},
    field("latitude"; "STRING") + {value: env.LATITUDE},
    field("longitude"; "STRING") + {value: env.LONGITUDE},
    field("wifi-ssid"; "STRING") + {value: env.WIFI_SSID},
    field("wifi-password"; "CONCEALED") + {value: env.WIFI_PASSWORD}
  ]}' >"$workdir/item.json")
op item create --vault "$VAULT" --template "$workdir/item.json" >/dev/null
echo "changed  $title"
