#!/usr/bin/env bash
# Runs frames/setup.sh on a remote fugleramme frame over SSH, with its values read from the 1Password item
# fugleramme-<name> (see frames/item.sh) and the Tailscale OAuth client from tailscale-frames. Safe to run again.
#
# Usage: frames/run.sh <ssh-target> <name>, e.g. frames/run.sh pi@fugleramme-tromso-pi.local tromso
set -euo pipefail

cd "$(dirname "$0")/.."

[[ $# == 2 ]] || {
  echo "usage: frames/run.sh <ssh-target> <name>" >&2
  exit 1
}
target=$1
item=op://homelab/fugleramme-$2

ssh_password=$(op read "$item/password")
web_password=$(op read "$item/web-password")
birdweather_token=$(op read "$item/birdweather-token")
latitude=$(op read "$item/latitude")
longitude=$(op read "$item/longitude")
ts_authkey=$(op read op://homelab/tailscale-frames/credential)

# The first run logs in with the password, every run after that with the key.
ssh-copy-id "$target"

# Prepended to the script on stdin, so the secrets never show up in argv.
status=0
{
  printf 'SSH_PASSWORD=%q\n' "$ssh_password"
  printf 'WEB_PASSWORD=%q\n' "$web_password"
  printf 'BIRDWEATHER_TOKEN=%q\n' "$birdweather_token"
  printf 'LATITUDE=%q\n' "$latitude"
  printf 'LONGITUDE=%q\n' "$longitude"
  printf 'TS_AUTHKEY=%q\n' "$ts_authkey"
  cat frames/setup.sh
} | ssh -o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=10 "$target" bash -s || status=$?

if [[ $status == 255 ]]; then
  echo "Lost the connection, most likely install.sh rebooting the Pi. Run this again once it's back up."
  exit 0
fi
exit "$status"
