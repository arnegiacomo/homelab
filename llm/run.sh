#!/usr/bin/env bash
# Runs llm/setup.sh on the model server over SSH, with the admin password read from 1Password.
#
# Usage: llm/run.sh [ssh-target], default llm@192.168.142.4
set -euo pipefail

cd "$(dirname "$0")/.."

target=${1:-llm@192.168.142.4}
LLM_PASSWORD_REF=${LLM_PASSWORD_REF:-op://homelab/llm-admin/password}

password=$(op read "$LLM_PASSWORD_REF")

# Prepended to the script on stdin, so the password never shows up in argv.
{
  printf 'LLM_PASSWORD=%q\n' "$password"
  cat llm/setup.sh
} | ssh -o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=10 "$target" bash -s
