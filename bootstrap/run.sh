#!/usr/bin/env bash
# Runs bootstrap/bootstrap.sh on a host over SSH, with the bootstrap secrets read from 1Password.
# If bootstrap reboots the host, waits for it to come back and runs it again.
#
# Usage: bootstrap/run.sh <ssh-target>, e.g. bootstrap/run.sh pi@homelab.local
#
# The secret references can be overridden, e.g. if the service account token lives in another vault.
# DNS_SERVERS, SUBNET_ROUTES, TLS_SANS, REBOOT_TIME, PCIE_GEN, STATIC_IP and GATEWAY are passed through when set
# (see bootstrap.sh).
set -euo pipefail

cd "$(dirname "$0")/.."

target=${1:?usage: bootstrap/run.sh <ssh-target>}
cluster=${CLUSTER:-homelab}
OP_SA_TOKEN_REF=${OP_SA_TOKEN_REF:-op://homelab/onepassword-service-account/credential}
TAILSCALE_AUTH_KEY_REF=${TAILSCALE_AUTH_KEY_REF:-op://homelab/tailscale-auth-key/credential}
RESTIC_PASSWORD_REF=${RESTIC_PASSWORD_REF:-op://homelab/restic-password/password}

command -v op >/dev/null || {
  echo "op not found, run bootstrap/wizard.sh first" >&2
  exit 1
}

sa_token=$(op read "$OP_SA_TOKEN_REF")
ts_key=$(op read "$TAILSCALE_AUTH_KEY_REF")
restic_password=$(op read "$RESTIC_PASSWORD_REF")
flux_instance=$(<"clusters/$cluster/flux-system/flux-instance.yaml")
k3s_version=$(awk '$1 == "version:" { print $2; exit }' infrastructure/config/k3s-upgrade.yaml)

# Assignments prepended to the script on stdin, so secrets never show up in argv on either side.
header=$(
  printf 'OP_SERVICE_ACCOUNT_TOKEN=%q\n' "$sa_token"
  printf 'TAILSCALE_AUTH_KEY=%q\n' "$ts_key"
  printf 'RESTIC_PASSWORD=%q\n' "$restic_password"
  printf 'FLUX_INSTANCE_YAML=%q\n' "$flux_instance"
  printf 'K3S_VERSION=%q\n' "$k3s_version"
  for var in DNS_SERVERS SUBNET_ROUTES TLS_SANS REBOOT_TIME PCIE_GEN STATIC_IP GATEWAY; do
    if [[ -n ${!var+set} ]]; then printf '%s=%q\n' "$var" "${!var}"; fi
  done
)

ssh_opts=(-o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=10)

run() {
  { printf '%s\n' "$header"; cat bootstrap/bootstrap.sh; } | ssh "${ssh_opts[@]}" "$target" sudo bash -s
}

boot_id() {
  ssh "${ssh_opts[@]}" "$target" cat /proc/sys/kernel/random/boot_id 2>/dev/null
}

before=$(boot_id)
rc=0
run || rc=$?
if ((rc != 100)); then exit "$rc"; fi

echo "waiting for $target to reboot"
after=""
for _ in $(seq 120); do
  sleep 5
  after=$(boot_id || true)
  if [[ -n $after && $after != "$before" ]]; then break; fi
done
if [[ -z $after || $after == "$before" ]]; then
  echo "$target did not come back within 10 minutes" >&2
  exit 1
fi

rc=0
run || rc=$?
if ((rc == 100)); then
  echo "bootstrap asked for another reboot, see the reasons above" >&2
  exit 1
fi
exit "$rc"
