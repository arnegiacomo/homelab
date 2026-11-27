#!/usr/bin/env bash
# Runs nas/setup.sh on the NAS over SSH, with the Samba and restic passwords read from 1Password.
#
# Usage: nas/run.sh [ssh-target], default nas.local
set -euo pipefail

cd "$(dirname "$0")/.."

target=${1:-nas.local}
SAMBA_PASSWORD_REF=${SAMBA_PASSWORD_REF:-op://homelab/nas-samba/password}
RESTIC_PASSWORD_REF=${RESTIC_PASSWORD_REF:-op://homelab/restic-password/password}

samba_password=$(op read "$SAMBA_PASSWORD_REF")
restic_password=$(op read "$RESTIC_PASSWORD_REF")

# Prepended to the script on stdin, so the passwords never show up in argv.
{
  printf 'SAMBA_PASSWORD=%q\n' "$samba_password"
  printf 'RESTIC_PASSWORD=%q\n' "$restic_password"
  cat nas/setup.sh
} | ssh -o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=10 "$target" sudo bash -s
