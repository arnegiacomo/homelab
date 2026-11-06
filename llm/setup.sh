#!/usr/bin/env bash
# Sets up the MacBook as the model server llm.home.arpa: Homebrew, Ollama, Whisper and Piper (speech to text and
# back, for Home Assistant's voice), node_exporter, power and macOS updates. Idempotent: every step checks state first
# and prints "ok" or "changed". Re-running it also upgrades Ollama and node_exporter.
#
# Runs as the admin user, not root, since Homebrew refuses root. llm/run.sh drives it from the Mac and prepends
# LLM_PASSWORD (the user's password, for sudo) to the script on stdin.
#
# Written for the macOS /bin/bash, which is 3.2: no mapfile, and no "${array[@]}" on an empty array under set -u.
set -euo pipefail

OLLAMA_MODEL=gemma4:26b-a4b-it-qat
OLLAMA_PLIST=/Library/LaunchDaemons/homelab.ollama.plist
NODE_EXPORTER_PLIST=/Library/LaunchDaemons/homelab.node-exporter.plist
DNS_SERVERS=(192.168.142.2 1.1.1.1)
# Wyoming servers for Home Assistant's voice pipeline, installed with uv at these versions. Renovate can't see them.
WHISPER_VERSION=3.8.1
# faster-whisper 1.2.1 passes an option to av.open() that av 19 removed, and doesn't cap av, so av is pinned.
WHISPER_WITH=av==18.1.0
WHISPER_MODEL=small.en
PIPER_VERSION=2.5.2
PIPER_VOICE=en_US-lessac-medium
WYOMING_DIR=$HOME/.local/share/wyoming

export PATH=/opt/homebrew/bin:/opt/homebrew/sbin:$PATH
changes=0
upgraded=""
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

# sudo and the Homebrew installer read the password through this helper, so it's never typed or an argument.
askpass() {
  cat >"$workdir/askpass" <<'EOF'
#!/bin/sh
printf '%s\n' "$LLM_PASSWORD"
EOF
  chmod 0700 "$workdir/askpass"
  export LLM_PASSWORD SUDO_ASKPASS=$workdir/askpass
  sudo -v || die "sudo failed, check LLM_PASSWORD"
}

sudo() { command sudo -A "$@"; }

# write_file PATH MODE [root] < content replaces PATH only when the content differs, and prints ok or changed.
# With root, the file is written with sudo and owned by root.
write_file() {
  local path=$1 mode=$2 tmp=$workdir/write_file
  cat >"$tmp"
  if [[ -f $path ]] && cmp -s "$tmp" "$path"; then
    echo ok
    return
  fi
  if [[ ${3:-} == root ]]; then
    sudo install -m "$mode" -o root -g wheel "$tmp" "$path"
  else
    mkdir -p "$(dirname "$path")"
    install -m "$mode" "$tmp" "$path"
  fi
  echo changed
}

# wait_for CMD... runs CMD every 2 seconds, for up to 2 minutes.
wait_for() {
  local _
  for _ in $(seq 60); do
    if "$@" >/dev/null 2>&1; then return; fi
    sleep 2
  done
  die "timed out: $*"
}

# A manual IP address gets no DNS servers from DHCP, so they're set on the network service of the default route.
# These are the ones the router hands out.
dns() {
  local dev service have
  dev=$(route -n get default | awk '$1 == "interface:" { print $2 }')
  service=$(networksetup -listnetworkserviceorder | awk -v dev="$dev" '
    /^\([0-9]+\) / { sub(/^\([0-9]+\) /, ""); name = $0 }
    index($0, "Device: " dev ")") { print name; exit }')
  [[ -n $service ]] || die "no network service for $dev"
  have=$(networksetup -getdnsservers "$service" | paste -sd ' ' -)
  if [[ $have == "${DNS_SERVERS[*]}" ]]; then
    report ok dns "$service"
    return
  fi
  sudo networksetup -setdnsservers "$service" "${DNS_SERVERS[@]}"
  wait_for curl -sS -o /dev/null https://github.com
  report changed dns "$service: ${DNS_SERVERS[*]}"
}

homebrew() {
  if [[ -x /opt/homebrew/bin/brew ]]; then
    report ok homebrew
    return
  fi
  curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$workdir/brew-install.sh"
  NONINTERACTIVE=1 /bin/bash "$workdir/brew-install.sh"
  report changed homebrew
}

# formula NAME installs NAME, or upgrades it when brew has a newer version.
formula() {
  local name=$1
  if ! brew list --formula "$name" >/dev/null 2>&1; then
    brew install --quiet "$name"
    report changed "$name" installed
  elif [[ -n $(brew outdated --formula --quiet "$name" || true) ]]; then
    brew upgrade --quiet "$name"
    upgraded+=" $name "
    report changed "$name" upgraded
  else
    report ok "$name"
  fi
}

# Apple silicon laptops have no "restart after power failure" setting. On a power cut the battery takes over.
power() {
  local have
  have=$(pmset -g | awk '$1 ~ /^(sleep|disksleep|womp|SleepDisabled)$/ { v[$1] = $2 }
    END { print v["sleep"], v["disksleep"], v["womp"], v["SleepDisabled"] }')
  if [[ $have == "0 0 1 1" ]]; then
    report ok power
    return
  fi
  sudo pmset -a sleep 0 disksleep 0
  sudo pmset -c womp 1
  sudo pmset -a disablesleep 1
  report changed power "no sleep, also with the lid closed"
}

# Security responses, system data files and macOS updates install on their own. macOS never installs a major
# upgrade on its own, so those stay an owner task.
updates() {
  local plist=/Library/Preferences/com.apple.SoftwareUpdate key set=""
  # macOS drops the AutomaticCheckEnabled key at times while checking stays on, so ask softwareupdate instead.
  if [[ $(softwareupdate --schedule) != *"turned on"* ]]; then
    sudo softwareupdate --schedule on >/dev/null
    set+=" schedule"
  fi
  for key in AutomaticDownload CriticalUpdateInstall ConfigDataInstall AutomaticallyInstallMacOSUpdates; do
    if [[ $(defaults read "$plist" "$key" 2>/dev/null) == 1 ]]; then continue; fi
    sudo defaults write "$plist" "$key" -bool true
    set+=" $key"
  done
  if [[ -z $set ]]; then report ok updates; else report changed updates "${set# }"; fi
}

# launchd_job DOMAIN PLIST WRITTEN UPGRADED loads the job in PLIST into DOMAIN, reloads it when WRITTEN is changed,
# and restarts it when UPGRADED is yes. Prints ok or changed.
launchd_job() {
  local domain=$1 plist=$2 written=$3 upgraded=$4 job
  job=$domain/$(basename "$plist" .plist)
  if [[ $written == ok ]] && sudo launchctl print "$job" >/dev/null 2>&1; then
    if [[ $upgraded == yes ]]; then
      sudo launchctl kickstart -k "$job"
      echo changed
    else
      echo ok
    fi
    return
  fi
  if sudo launchctl print "$job" >/dev/null 2>&1; then
    sudo launchctl bootout "$job"
    while sudo launchctl print "$job" >/dev/null 2>&1; do sleep 1; done
  fi
  sudo launchctl bootstrap "$domain" "$plist"
  echo changed
}

# A LaunchDaemon, so the metrics are up without a login. It needs no privileges, so it runs as nobody.
node_exporter_job() {
  local written
  written=$(write_file "$NODE_EXPORTER_PLIST" 0644 root <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>homelab.node-exporter</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node_exporter</string>
    <string>--web.listen-address=:9100</string>
  </array>
  <key>UserName</key>
  <string>nobody</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
EOF
  )
  report "$(launchd_job system "$NODE_EXPORTER_PLIST" "$written" \
    "$([[ $upgraded == *" node_exporter "* ]] && echo yes || echo no)")" node-exporter ":9100"
  wait_for curl -fsS http://localhost:9100/metrics
}

# A LaunchDaemon as the admin user, so it starts at boot without a login. Metal works outside a login session.
# OLLAMA_CONTEXT_LENGTH must match the context window Home Assistant asks for, or Ollama reloads the model.
ollama_job() {
  local written
  written=$(write_file "$OLLAMA_PLIST" 0644 root <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>homelab.ollama</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/ollama</string>
    <string>serve</string>
  </array>
  <key>UserName</key>
  <string>$(id -un)</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
    <key>OLLAMA_HOST</key>
    <string>0.0.0.0:11434</string>
    <key>OLLAMA_KEEP_ALIVE</key>
    <string>-1</string>
    <key>OLLAMA_CONTEXT_LENGTH</key>
    <string>16384</string>
    <key>OLLAMA_NUM_PARALLEL</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/ollama.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/ollama.log</string>
</dict>
</plist>
EOF
  )
  report "$(launchd_job system "$OLLAMA_PLIST" "$written" \
    "$([[ $upgraded == *" ollama "* ]] && echo yes || echo no)")" ollama ":11434"
  wait_for curl -fsS http://localhost:11434/api/version
}

# wyoming_tool NAME VERSION [WITH] installs the Python package NAME at VERSION in its own environment, with uv, plus
# the extra requirement WITH, e.g. a pinned dependency.
wyoming_tool() {
  local name=$1 version=$2 with=${3:-} want
  want="$name v$version${with:+ [with: $with]}"
  if uv tool list --show-with 2>/dev/null | grep -qxF "$want"; then
    report ok "$name" "$version"
    return
  fi
  if [[ -n $with ]]; then
    uv tool install --quiet --force --python 3.12 --with "$with" "$name==$version"
  else
    uv tool install --quiet --force --python 3.12 "$name==$version"
  fi
  upgraded+=" $name "
  report changed "$name" "$version${with:+, $with}"
}

# wyoming_job LABEL PORT ARGS... runs a Wyoming server as a LaunchDaemon as the admin user, listening on PORT on every
# address, so Home Assistant can reach it. Its log is ~/Library/Logs/LABEL.log.
wyoming_job() {
  local label=$1 port=$2 plist=/Library/LaunchDaemons/homelab.$1.plist written arg args=""
  shift 2
  for arg in "$@" --uri "tcp://0.0.0.0:$port"; do args+="    <string>$arg</string>"$'\n'; done
  written=$(write_file "$plist" 0644 root <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>homelab.$label</string>
  <key>ProgramArguments</key>
  <array>
$args  </array>
  <key>UserName</key>
  <string>$(id -un)</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/$label.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/$label.log</string>
</dict>
</plist>
EOF
  )
  report "$(launchd_job system "$plist" "$written" \
    "$([[ $upgraded == *"$label "* ]] && echo yes || echo no)")" "$label" ":$port"
  wait_for nc -z localhost "$port"
}

# Speech to text. English only, which is faster and more accurate than detecting the language. The model downloads on
# the first start.
whisper_job() {
  mkdir -p "$WYOMING_DIR/whisper"
  wyoming_job whisper 10300 "$HOME/.local/bin/wyoming-faster-whisper" --model "$WHISPER_MODEL" --language en \
    --compute-type int8 --cpu-threads 8 --data-dir "$WYOMING_DIR/whisper"
}

# Text to speech. The voice downloads on the first start.
piper_job() {
  mkdir -p "$WYOMING_DIR/piper"
  wyoming_job piper 10200 "$HOME/.local/bin/wyoming-piper" --voice "$PIPER_VOICE" --data-dir "$WYOMING_DIR/piper"
}

# Pulls the model and loads it, so the first request doesn't wait for it. OLLAMA_KEEP_ALIVE keeps it loaded until
# Ollama restarts.
model() {
  local list
  list=$(ollama list)
  if awk 'NR > 1 { print $1 }' <<<"$list" | grep -qxF "$OLLAMA_MODEL"; then
    report ok model "$OLLAMA_MODEL"
  else
    ollama pull "$OLLAMA_MODEL"
    report changed model "pulled $OLLAMA_MODEL"
  fi
  if [[ $(ollama ps) == *"$OLLAMA_MODEL"* ]]; then
    report ok model-loaded
    return
  fi
  curl -fsS http://localhost:11434/api/generate -d "{\"model\": \"$OLLAMA_MODEL\"}" >/dev/null
  report changed model-loaded
}

main() {
  [[ $(uname -s) == Darwin ]] || die "run this on the Mac model server"
  [[ $EUID -ne 0 ]] || die "run as the admin user, not root"
  [[ -n ${LLM_PASSWORD:-} ]] || die "LLM_PASSWORD is required, use llm/run.sh"

  askpass
  dns
  homebrew
  brew update --quiet >/dev/null
  formula ollama
  formula node_exporter
  formula uv
  power
  updates
  node_exporter_job
  ollama_job
  model
  wyoming_tool wyoming-faster-whisper "$WHISPER_VERSION" "$WHISPER_WITH"
  wyoming_tool wyoming-piper "$PIPER_VERSION"
  whisper_job
  piper_job

  if ((changes == 0)); then echo "no changes"; else echo "$changes changed"; fi
}

# stdin is the script itself when run through `bash -s`, so keep commands from reading it.
main </dev/null
