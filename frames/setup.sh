#!/usr/bin/env bash
# Sets up a Raspberry Pi as a remote fugleramme frame on its own HDMI screen: Tailscale, fugleramme with the bundled
# BirdNET-Go, their first config, and a cage + chromium kiosk. Idempotent: every step checks first and prints ok or
# changed.
#
# frames/run.sh drives it from the Mac and prepends the frame's values to the script on stdin. The last step runs
# fugleramme's install.sh, which reboots the Pi when it changed something that needs it.
set -euo pipefail

: "${SSH_PASSWORD:?}" "${WEB_PASSWORD:?}" "${BIRDWEATHER_TOKEN:?}" "${LATITUDE:?}" "${LONGITUDE:?}" "${TS_AUTHKEY:?}"

TAG=tag:fugleramme-remote
REPO_DIR=$HOME/fugleramme
REPO_URL=https://github.com/arnegiacomo/fugleramme.git
INSTALL_URL=https://raw.githubusercontent.com/arnegiacomo/fugleramme/main/install.sh
KIOSK_UNIT=/etc/systemd/system/fugleramme-kiosk.service

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

report() { printf '%-8s %s\n' "$1" "$2"; }

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# yaml_quote VALUE prints VALUE as a single-quoted YAML scalar.
yaml_quote() { printf "'%s'" "${1//\'/\'\'}"; }

# fugleramme counts on passwordless sudo, which older Raspberry Pi OS images gave the first user: install.sh runs sudo
# with no terminal to ask on, and the admin's reboot button runs sudo -n. Granted once, with the SSH password.
passwordless_sudo() {
  local file=/etc/sudoers.d/010_$USER-nopasswd
  if sudo -n true 2>/dev/null; then
    report ok passwordless-sudo
    return
  fi
  printf '%s\n' "$SSH_PASSWORD" |
    sudo -S -p '' sh -c "printf '%s ALL=(ALL) NOPASSWD: ALL\n' '$USER' >'$file' && chmod 0440 '$file'" ||
    die "sudo with the SSH password failed, check the password in the 1Password item"
  report changed passwordless-sudo
}

tailscale_up() {
  if ! command -v tailscale >/dev/null; then
    curl -fsSL https://tailscale.com/install.sh | sh
    report changed tailscale-install
  fi
  if tailscale status >/dev/null 2>&1; then
    report ok tailscale-up
    return
  fi
  # The OAuth client secret works as an auth key with these parameters. Read from a file, so it's never in argv.
  (umask 077 && printf '%s?ephemeral=false&preauthorized=true' "$TS_AUTHKEY" >"$workdir/authkey")
  # The tailnet's DNS is Pi-hole on homelab, which the tag can't reach, so the Pi keeps its own.
  sudo tailscale up --auth-key="file:$workdir/authkey" --advertise-tags="$TAG" --accept-dns=false </dev/null
  report changed tailscale-up
}

packages() {
  local missing=() pkg
  for pkg in git chromium cage; do
    dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
  done
  if [[ ${#missing[@]} == 0 ]]; then
    report ok packages
    return
  fi
  sudo apt-get update </dev/null
  sudo apt-get install -y --no-install-recommends "${missing[@]}" </dev/null
  report changed "packages (${missing[*]})"
}

# Cloned here rather than by install.sh, so the first config is in place before BirdNET-Go and the frame first start.
# install.sh later moves an existing checkout to the latest release on its own.
checkout() {
  if [[ -d $REPO_DIR/.git ]]; then
    report ok checkout
    return
  fi
  local tag
  tag=$(curl -fsSL https://api.github.com/repos/arnegiacomo/fugleramme/releases/latest |
    sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')
  [[ -n $tag ]] || die "could not find fugleramme's latest release"
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$tag" "$REPO_URL" "$REPO_DIR"
  report changed "checkout ($tag)"
}

# Only written when missing: after that, BirdNET-Go's own UI owns the file.
birdnet_config() {
  local config=$REPO_DIR/detector/config/config.yaml
  if [[ -f $config ]]; then
    report ok birdnet-config
    return
  fi
  BIRDWEATHER="  birdweather:
    enabled: true
    id: $(yaml_quote "$BIRDWEATHER_TOKEN")" \
    awk '
      /^  latitude:/ { print "  latitude: " ENVIRON["LATITUDE"]; next }
      /^  longitude:/ { print "  longitude: " ENVIRON["LONGITUDE"]; next }
      { print }
      /^realtime:/ { print ENVIRON["BIRDWEATHER"] }
    ' "$config.template" >"$config"
  cat >>"$config" <<EOF

security:
  basicauth:
    enabled: true
    password: $(yaml_quote "$WEB_PASSWORD")
EOF
  chmod 0600 "$config"
  report changed birdnet-config
}

# Only written when missing: after that, the admin page owns the file. The frame reads BirdNET-Go with the same
# password it signs in with.
frame_settings() {
  local file=$REPO_DIR/detector/data/settings.json
  if [[ -f $file ]]; then
    report ok frame-settings
    return
  fi
  mkdir -p "$(dirname "$file")"
  python3 - "$file" <<'EOF'
import json, os, sys

password = os.environ["WEB_PASSWORD"]
settings = {
    "mode": "collage",
    # A TV, not a panel: its own shape, at its own resolution.
    "web_lock": False,
    "web_aspect": "16:9",
    "web_resolution": "4K",
    "lookback_hours": 168,
    "name_key": True,
    "primary_language": "no",
    "auto_update": True,
    "require_sign_in": True,
    "admin_password": password,
    "detector_password": password,
}
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump(settings, f, indent=2)
EOF
  report changed frame-settings
}

# cage draws its own pointer in the middle of the screen, which the page's cursor: none can't reach. A theme whose
# cursors are one transparent pixel hides it, as in fugleramme-gosim's tv-pi/pi-setup.sh. XCURSOR_THEME in the kiosk
# unit picks it, and since cage loads the theme named "default" whatever that says, the user's default points at it too.
invisible_cursor() {
  local dir=/usr/share/icons/invisible/cursors name
  if [[ -f $dir/default && -L $HOME/.icons/default/cursors ]]; then
    report ok invisible-cursor
    return
  fi
  python3 - "$workdir/cursor" <<'PY'
import struct, sys
# Xcursor: file header, one table-of-contents entry, one 1x1 image chunk, all transparent.
IMAGE, SIZE = 0xFFFD0002, 1
header = b"Xcur" + struct.pack("<III", 16, 0x10000, 1)
toc = struct.pack("<III", IMAGE, SIZE, 16 + 12)
chunk = struct.pack("<IIIIIIIII", 36, IMAGE, SIZE, 1, 1, 1, 0, 0, 0) + struct.pack("<I", 0)
open(sys.argv[1], "wb").write(header + toc + chunk)
PY
  sudo install -D -m 0644 "$workdir/cursor" "$dir/default"
  for name in left_ptr arrow pointer hand1 hand2 text xterm watch wait progress crosshair grab grabbing; do
    sudo ln -sf default "$dir/$name"
  done
  printf '[Icon Theme]\nName=invisible\n' | sudo tee /usr/share/icons/invisible/index.theme >/dev/null
  mkdir -p "$HOME/.icons/default"
  ln -sfn "$dir" "$HOME/.icons/default/cursors"
  report changed invisible-cursor
}

# From fugleramme's docs/screens.md, plus a wait for the frame, so chromium never opens on an error page it then
# keeps showing, --incognito, so pulling the plug never leaves a "restore pages?" bubble on the screen, and no
# first-run, keyring or translate prompts.
kiosk() {
  cat >"$workdir/kiosk" <<EOF
[Unit]
Description=Fugleramme HDMI kiosk
After=systemd-user-sessions.service getty@tty1.service fugleramme-frame.service
Conflicts=getty@tty1.service

[Service]
User=$USER
PAMName=login
TTYPath=/dev/tty1
TTYReset=yes
TTYVHangup=yes
StandardInput=tty-force
Environment=XCURSOR_THEME=invisible
ExecStartPre=/bin/sh -c 'until curl -fs -o /dev/null http://localhost:8080/health; do sleep 2; done'
TimeoutStartSec=infinity
ExecStart=/usr/bin/cage -- /usr/bin/chromium --kiosk --incognito --ozone-platform=wayland --noerrdialogs --disable-infobars --no-first-run --password-store=basic --disable-features=Translate http://localhost:8080/
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  if [[ -f $KIOSK_UNIT ]] && cmp -s "$workdir/kiosk" "$KIOSK_UNIT"; then
    report ok kiosk
    return
  fi
  sudo install -m 0644 "$workdir/kiosk" "$KIOSK_UNIT"
  sudo systemctl daemon-reload
  # The login prompt and the kiosk conflict on tty1, and with both enabled systemd often drops the kiosk on boot.
  sudo systemctl disable getty@tty1.service
  sudo systemctl enable fugleramme-kiosk.service
  if systemctl is-active -q fugleramme-frame; then sudo systemctl restart fugleramme-kiosk.service; fi
  report changed kiosk
}

# No boot text, logo or rainbow splash on their TV after a power cut. Takes effect on the next boot.
quiet_boot() {
  local cmdline=/boot/firmware/cmdline.txt config=/boot/firmware/config.txt arg changed=0
  for arg in quiet loglevel=3 logo.nologo vt.global_cursor_default=0; do
    grep -qw -- "$arg" "$cmdline" && continue
    sudo sed -i "1 s|\$| $arg|" "$cmdline"
    changed=1
  done
  if ! grep -q '^disable_splash=1' "$config"; then
    echo 'disable_splash=1' | sudo tee -a "$config" >/dev/null
    changed=1
  fi
  if [[ $changed == 0 ]]; then
    report ok quiet-boot
    return
  fi
  report changed "quiet-boot (on the next boot)"
}

# SSH over the USB-C cable, the way in when both Wi-Fi and Tailscale are out. Checked here rather than left to
# install.sh, which skips it when the package is already there, as it is on Trixie images. Takes effect on the next
# boot, which install.sh does on a first run.
usb_gadget() {
  # Not grep -q: it stops reading at the match, and under pipefail the SIGPIPE it leaves status with fails the check.
  if sudo rpi-usb-gadget status 2>/dev/null | grep 'mode is on' >/dev/null; then
    report ok usb-gadget
    return
  fi
  dpkg -s rpi-usb-gadget >/dev/null 2>&1 || sudo apt-get install -y rpi-usb-gadget </dev/null
  sudo rpi-usb-gadget on >/dev/null
  report changed "usb-gadget (on the next boot)"
}

# Last, since it may reboot. -y takes every default: the bundled BirdNET-Go, ports 8080 and 8090, USB gadget mode.
fugleramme_install() {
  if systemctl is-enabled -q fugleramme-frame 2>/dev/null; then
    report ok fugleramme-install
    return
  fi
  report changed "fugleramme-install (reboots the Pi at the end if it needs to)"
  curl -fsSL "$INSTALL_URL" | bash -s -- -y
}

main() {
  passwordless_sudo
  export WEB_PASSWORD BIRDWEATHER_TOKEN LATITUDE LONGITUDE
  tailscale_up
  packages
  checkout
  birdnet_config
  frame_settings
  invisible_cursor
  kiosk
  quiet_boot
  usb_gadget
  fugleramme_install
}

# Called last: bash reads the script from stdin, so nothing runs until all of it is read and no command can swallow
# the rest of it.
main
