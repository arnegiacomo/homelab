#!/usr/bin/env bash
# Prints a note for the owner of a remote frame, in Norwegian: the addresses and passwords from its 1Password item.
#
# Usage: frames/note.sh <name> | pbcopy
set -euo pipefail

name=${1:?usage: frames/note.sh <name>}
item=op://homelab/fugleramme-$name
host=fugleramme-$name-pi.local

web_password=$(op read "$item/web-password")
station=$(op read "$item/birdweather-station-id")
username=$(op read "$item/username")
ssh_password=$(op read "$item/password")

cat <<EOF
Fuglerammen

Bildet: http://$host:8080
Innstillinger: http://$host:8080/admin
BirdNET-Go: http://$host:8090
Passord til begge: $web_password

Offentlig side: https://fugleramme-$name.arnegiacomo.dev
BirdWeather: https://app.birdweather.com/stations/$station

SSH: ssh $username@$host
Passord: $ssh_password
EOF
