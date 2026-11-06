#!/usr/bin/env bash
# Creates the 1Password items the cluster reads through ESO (ClusterSecretStore `onepassword`), the restic
# password bootstrap reads, and the model server's admin login.
# Items that already exist are left alone, so running it again is safe.
#
# Usage: scripts/op-items.sh [ssh-target], default pi@homelab. The target is only used to copy
# the fugleramme tunnel credentials off the host.
set -euo pipefail

VAULT=${VAULT:-Homelab}
target=${1:-pi@homelab}
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

ensure() {
  local title=$1
  shift
  if op item get "$title" --vault "$VAULT" >/dev/null 2>&1; then
    echo "ok       $title"
    return
  fi
  "$@" >/dev/null
  echo "changed  $title"
}

# The credentials JSON goes into a 0600 template file so it never shows up in argv.
tunnel_item() {
  (umask 077 && ssh -o BatchMode=yes "$target" 'cat /home/pi/fugleramme/cloudflared/*.json' |
    jq '{title: "fugleramme-tunnel", category: "API_CREDENTIAL",
      fields: [{id: "credential", label: "credential", type: "CONCEALED", value: tojson}]}' >"$workdir/tunnel.json")
  op item create --vault "$VAULT" --template "$workdir/tunnel.json"
}

ensure pihole-admin op item create --vault "$VAULT" --category password --title pihole-admin \
  --generate-password=letters,digits,32
ensure grafana-admin op item create --vault "$VAULT" --category login --title grafana-admin \
  --generate-password=letters,digits,32 username=admin
ensure fugleramme-tunnel tunnel_item
ensure llm-admin op item create --vault "$VAULT" --category login --title llm-admin \
  --generate-password=letters,digits,24 username=llm
ensure restic-password op item create --vault "$VAULT" --category password --title restic-password \
  --generate-password=letters,digits,32
ensure kaneo-postgres op item create --vault "$VAULT" --category password --title kaneo-postgres \
  --generate-password=letters,digits,32
ensure kaneo-auth-secret op item create --vault "$VAULT" --category password --title kaneo-auth-secret \
  --generate-password=letters,digits,64
