#!/usr/bin/env bash
# Sets up this Mac as a client for the homelab cluster.
# Idempotent: every step checks state first and prints "ok" or "changed".
#
# kubectl, k9s and shellcheck come from the dotfiles Brewfile (brew bundle --file ~/dotfiles/Brewfile).
# This script only checks for them, and installs the other tools itself.
#
# Optional overrides:
#
#   SSH_TARGET  host to read the k3s kubeconfig from, default pi@homelab.local
#   API_SERVER      API server the homelab context points at, default https://homelab:6443 (MagicDNS)
#   LAN_API_SERVER  API server the homelab-lan context points at, default https://homelab.local:6443
set -euo pipefail

SSH_TARGET=${SSH_TARGET:-pi@homelab.local}
API_SERVER=${API_SERVER:-https://homelab:6443}
LAN_API_SERVER=${LAN_API_SERVER:-https://homelab.local:6443}
KUBE_CONFIG=$HOME/.kube/config
FORMULAE=(fluxcd controlplaneio-fluxcd/tap/flux-operator kustomize kubeconform gitleaks)
CASKS=(1password-cli)
DOTFILES_TOOLS=(kubectl k9s shellcheck)

changes=0
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

report() {
  printf '%-8s %s%s\n' "$1" "$2" "${3:+ ($3)}"
  if [[ $1 == changed ]]; then changes=$((changes + 1)); fi
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

dotfiles_tools() {
  local tool
  for tool in "${DOTFILES_TOOLS[@]}"; do
    command -v "$tool" >/dev/null || die "$tool not found, run: brew bundle --file ~/dotfiles/Brewfile"
    report ok "$tool" "$(command -v "$tool")"
  done
  # OrbStack links its own, older kubectl into /usr/local/bin, so brew's bin dir has to come first.
  [[ $(command -v kubectl) == "$(brew --prefix)/bin/kubectl" ]] ||
    die "kubectl resolves to $(command -v kubectl), put $(brew --prefix)/bin ahead of /usr/local/bin on PATH"
}

brew_packages() {
  local formula cask
  # Installing a formula by its full tap name taps it and trusts only that formula.
  for formula in "${FORMULAE[@]}"; do
    if brew list --formula "$formula" >/dev/null 2>&1; then report ok "brew $formula"; continue; fi
    brew install --formula "$formula" >/dev/null
    report changed "brew $formula"
  done
  for cask in "${CASKS[@]}"; do
    if brew list --cask "$cask" >/dev/null 2>&1; then report ok "brew cask $cask"; continue; fi
    brew install --cask "$cask" >/dev/null
    report changed "brew cask $cask"
  done
}

tailscale() {
  [[ -d /Applications/Tailscale.app ]] || die "Tailscale app not found, run: brew bundle --file ~/dotfiles/Brewfile"
  if pgrep -qx Tailscale; then
    report ok "tailscale running"
  else
    open -a Tailscale
    report changed "tailscale running"
  fi
  # Start at login is a setting in the app. This key is where the standalone (non App Store) build keeps it.
  if [[ $(defaults read io.tailscale.ipn.macsys TailscaleStartOnLogin 2>/dev/null) == 1 ]]; then
    report ok "tailscale starts at login"
  else
    report hint "tailscale starts at login" "turn on Launch at login in the Tailscale settings"
  fi
}

# The k3s kubeconfig names everything "default" and points at 127.0.0.1.
# Make two copies: homelab points at the API over Tailscale, homelab-lan at the API on the home network.
# Both are merged into ~/.kube/config.
kubeconfig() {
  local raw=$workdir/k3s.yaml fetched=$workdir/homelab.yaml fetched_lan=$workdir/homelab-lan.yaml
  local merged=$workdir/merged current backup=
  ssh -o BatchMode=yes -o ConnectTimeout=5 "$SSH_TARGET" cat /etc/rancher/k3s/k3s.yaml >"$raw"
  sed -e "s#server: https://127.0.0.1:6443#server: $API_SERVER#" -e 's/: default$/: homelab/' "$raw" >"$fetched"
  sed -e "s#server: https://127.0.0.1:6443#server: $LAN_API_SERVER#" -e 's/: default$/: homelab-lan/' "$raw" >"$fetched_lan"
  kubectl --kubeconfig "$fetched" config get-contexts homelab >/dev/null ||
    die "unexpected kubeconfig format from $SSH_TARGET"

  # The fetched files come first so changed homelab entries replace the old ones.
  # Then put back the existing current-context, so the homelab one only wins when none was set.
  current=$(kubectl --kubeconfig "$KUBE_CONFIG" config current-context 2>/dev/null || true)
  KUBECONFIG=$fetched:$fetched_lan:$KUBE_CONFIG kubectl config view --flatten >"$merged"
  if [[ -n $current ]]; then kubectl --kubeconfig "$merged" config use-context "$current" >/dev/null; fi

  if [[ -f $KUBE_CONFIG ]] && cmp -s "$merged" "$KUBE_CONFIG"; then
    report ok "kubeconfig contexts homelab, homelab-lan"
    return
  fi
  if [[ -f $KUBE_CONFIG ]]; then
    cp -p "$KUBE_CONFIG" "$KUBE_CONFIG.bak"
    backup="backup in $KUBE_CONFIG.bak"
  fi
  install -d -m 700 "$HOME/.kube"
  install -m 600 "$merged" "$KUBE_CONFIG"
  report changed "kubeconfig contexts homelab, homelab-lan" "$backup"
}

# Tailscale may be off at home and the LAN is unreachable away from it, so only fail when neither answers.
api() {
  local context server reachable=0
  for context in homelab homelab-lan; do
    server=$API_SERVER
    if [[ $context == homelab-lan ]]; then server=$LAN_API_SERVER; fi
    if kubectl --context "$context" --request-timeout=5s get --raw /readyz >/dev/null 2>&1; then
      report ok "cluster API reachable" "$context, $server"
      reachable=1
    else
      report hint "cluster API not reachable" "$context, $server"
    fi
  done
  ((reachable)) || die "cluster API not reachable over Tailscale or the LAN"
}

main() {
  command -v brew >/dev/null || die "Homebrew not found, see https://brew.sh"
  dotfiles_tools
  brew_packages
  tailscale
  kubeconfig
  api
  if ((changes == 0)); then echo "no changes"; else echo "$changes changed"; fi
}

main
