#!/usr/bin/env bash
# Turns a fresh Raspberry Pi OS or Debian host into the single-node k3s cluster.
# Idempotent: every step checks state first and prints "ok" or "changed".
#
# Runs as root on the host. bootstrap/run.sh drives it from the Mac and prepends
# these variables to the script on stdin, so no secret is ever a command-line arg:
#
#   OP_SERVICE_ACCOUNT_TOKEN  1Password service account token, for ESO
#   TAILSCALE_AUTH_KEY        only used while the host isn't logged in to Tailscale
#   RESTIC_PASSWORD           password of the restic repo on the backup disk
#   FLUX_INSTANCE_YAML        clusters/<cluster>/flux-system/flux-instance.yaml
#   K3S_VERSION               the version pinned in infrastructure/config/k3s-upgrade.yaml
#
# Optional overrides:
#
#   DNS_SERVERS    host resolvers, default "1.1.1.1 1.0.0.1"
#   SUBNET_ROUTES  Tailscale subnet routes, comma separated, default the LAN of the default route
#   TLS_SANS       extra k3s API SANs, space separated. Hostname, hostname.local, the LAN IP
#                  and the Tailscale name and IP are always included.
#   REBOOT_TIME    host local time for the automatic reboot after an update that needs one, default 04:00
#   PCIE_GEN       PCIe link speed set in config.txt on a Pi 5, default 3. Empty skips it.
#   STATIC_IP      address with prefix length for the default-route connection, e.g. 192.168.142.2/24.
#                  Unset leaves the address alone.
#   GATEWAY        gateway for STATIC_IP, default the current default route
#
# Exits 100 after scheduling a reboot, and 1 after scheduling an address change. Run it again once the host is back.
set -euo pipefail
shopt -s inherit_errexit

# renovate: datasource=docker depName=ghcr.io/controlplaneio-fluxcd/charts/flux-operator
FLUX_OPERATOR_VERSION=0.62.1 # keep in sync with clusters/homelab/flux-system/flux-operator.yaml
# renovate: datasource=github-releases depName=helm/helm
HELM_VERSION=v4.3.1
# renovate: datasource=github-releases depName=restic/restic extractVersion=^v(?<version>.+)$
RESTIC_VERSION=0.19.1
CMDLINE=/boot/firmware/cmdline.txt
CONFIG_TXT=/boot/firmware/config.txt

# Fixed list from the Pi OS bookworm and trixie desktop images. autoremove takes the libraries.
DESKTOP_PACKAGES=(
  rpd-wayland-core rpd-wayland-extras rpd-x-core rpd-x-extras rpd-common rpd-applications rpd-developer
  rpd-graphics rpd-preferences rpd-utilities rpd-theme rpd-plym-splash lxpanel-pi pcmanfm-pi
  lightdm lightdm-gtk-greeter pi-greeter piwiz raspberrypi-ui-mods
  lxde lxde-core lxde-common lxpanel lxsession lxterminal openbox openbox-lxde-session pcmanfm
  wayfire labwc wf-panel-pi squeekboard kanshi xwayland
  xserver-xorg xserver-xorg-core xserver-common
  wayvnc realvnc-vnc-server rpi-connect
  cups cups-browsed cups-client cups-daemon system-config-printer hplip pi-printer-support
  chromium rpi-chromium-mods firefox rpi-firefox-mods
  thonny geany vlc mousepad galculator evince rpi-imager rp-bookshelf rp-prefapps rc-gui gui-pkinst gui-updater
)

export DEBIAN_FRONTEND=noninteractive
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
changes=0
reboot_for=()
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

installed() {
  dpkg-query -W -f="\${Status}" "$1" 2>/dev/null | grep -q 'install ok installed'
}

# write_file PATH MODE < content replaces PATH only when the content differs, and prints ok or changed.
write_file() {
  local path=$1 mode=$2 tmp="$workdir/write_file"
  cat >"$tmp"
  if [[ -f $path ]] && cmp -s "$tmp" "$path"; then
    echo ok
    return
  fi
  install -D -m "$mode" "$tmp" "$path"
  echo changed
}

# retry N CMD... runs CMD up to N times, 5 seconds apart.
retry() {
  local n=$1 i
  shift
  for ((i = 1; i <= n; i++)); do
    if "$@" >/dev/null 2>&1; then return; fi
    sleep 5
  done
  die "timed out: $*"
}

kubectl() { k3s kubectl "$@"; }

default_dev() { ip -4 route show default | awk '{ print $5; exit }'; }
default_gw() { ip -4 route show default | awk '{ print $3; exit }'; }
lan_ip() { ip -4 -o addr show dev "$(default_dev)" scope global | awk '{ sub("/.*", "", $4); print $4; exit }'; }
lan_subnet() { ip -4 route show dev "$(default_dev)" proto kernel scope link | awk '{ print $1; exit }'; }

packages() {
  local p missing=()
  for p in curl ca-certificates jq unattended-upgrades bzip2 smartmontools; do
    if ! installed "$p"; then missing+=("$p"); fi
  done
  if ((${#missing[@]} == 0)); then
    report ok packages
    return
  fi
  apt-get update -q
  apt-get install -y -q "${missing[@]}"
  report changed packages "${missing[*]}"
}

# k3s needs the memory cgroup, which Raspberry Pi kernels disable by default.
cmdline() {
  local line flag added=()
  if [[ ! -f $CMDLINE ]]; then
    report ok cmdline "not a Raspberry Pi"
    return
  fi
  line=$(<"$CMDLINE")
  for flag in cgroup_memory=1 cgroup_enable=memory; do
    if [[ " $line " != *" $flag "* ]]; then
      line+=" $flag"
      added+=("$flag")
    fi
  done
  if ((${#added[@]})); then
    cp "$CMDLINE" "$CMDLINE.bak"
    printf '%s\n' "$line" >"$CMDLINE"
    report changed cmdline "added ${added[*]}"
  else
    report ok cmdline
  fi
  if ! grep -qw memory /sys/fs/cgroup/cgroup.controllers; then reboot_for+=("memory cgroup"); fi
}

# The Pi 5 links the NVMe at PCIe Gen 2 by default. The line must be under [all], since lines under a filter
# like [cm5] only apply to that board. Only the last pciex1_gen line counts, as a later one would override it.
pcie() {
  local gen=${PCIE_GEN-3} model setting
  model=$(tr -d '\0' 2>/dev/null </proc/device-tree/model || true)
  if [[ ! -f $CONFIG_TXT || $model != *"Raspberry Pi 5"* ]]; then
    report ok pcie "not a Raspberry Pi 5"
    return
  fi
  if [[ -z $gen ]]; then
    report skip pcie "PCIE_GEN is empty"
    return
  fi
  # Prints the last pciex1_gen value if it's under [all] (or before any filter), then 1 if the file ends under [all].
  setting=$(awk '
    BEGIN { all = 1 }
    /^[[:space:]]*\[/ { all = /^[[:space:]]*\[all\]/; next }
    /^[[:space:]]*dtparam=pciex1_gen=/ { gen = all ? substr($1, index($1, "_gen=") + 5) : "" }
    END { print gen, all }
  ' "$CONFIG_TXT")
  if [[ $setting == "$gen "* ]]; then
    report ok pcie "dtparam=pciex1_gen=$gen"
    return
  fi
  cp "$CONFIG_TXT" "$CONFIG_TXT.bak"
  if [[ -n $(tail -c 1 "$CONFIG_TXT") ]]; then echo >>"$CONFIG_TXT"; fi
  if [[ $setting != *" 1" ]]; then printf '\n[all]\n' >>"$CONFIG_TXT"; fi
  echo "dtparam=pciex1_gen=$gen" >>"$CONFIG_TXT"
  reboot_for+=("PCIe Gen $gen")
  report changed pcie "dtparam=pciex1_gen=$gen"
}

# One reboot for everything the steps before it changed. run.sh waits for it and runs bootstrap again.
reboot_if_needed() {
  if ((${#reboot_for[@]} == 0)); then return; fi
  echo "rebooting in 5 seconds for: ${reboot_for[*]}"
  systemd-run --on-active=5s systemctl reboot >/dev/null
  exit 100
}

desktop() {
  local p purge=()
  if [[ $(systemctl get-default) != multi-user.target ]]; then
    systemctl set-default multi-user.target
    report changed boot-target multi-user.target
  else
    report ok boot-target
  fi
  for p in "${DESKTOP_PACKAGES[@]}"; do
    if installed "$p"; then purge+=("$p"); fi
  done
  if ((${#purge[@]} == 0)); then
    report ok desktop-packages
    return
  fi
  apt-get purge -y -q --autoremove "${purge[@]}"
  report changed desktop-packages "purged ${#purge[@]} plus autoremove"
}

# The host must never resolve through the in-cluster Pi-hole.
dns() {
  local servers=${DNS_SERVERS:-1.1.1.1 1.0.0.1} dev conn
  if ! systemctl is-active -q NetworkManager 2>/dev/null; then
    report skip dns "no NetworkManager, pin $servers by hand"
    return
  fi
  dev=$(default_dev)
  conn=$(nmcli -g GENERAL.CONNECTION device show "$dev")
  if [[ $(nmcli -g ipv4.dns connection show "$conn") == "${servers// /,}" &&
    $(nmcli -g ipv4.ignore-auto-dns connection show "$conn") == yes ]]; then
    report ok dns "$conn"
    return
  fi
  nmcli connection modify "$conn" ipv4.dns "$servers" ipv4.ignore-auto-dns yes
  nmcli device reapply "$dev"
  report changed dns "$conn: $servers"
}

# The router doesn't reliably apply DHCP reservations, so the LAN address can be pinned instead.
# The change runs as a detached systemd unit a few seconds after bootstrap exits, so the SSH session ends
# cleanly before the address moves, and a dropped session can't leave it half done.
static_ip() {
  local dev conn gw want have old
  if [[ -z ${STATIC_IP:-} ]]; then
    report skip static-ip "STATIC_IP not set"
    return
  fi
  [[ $STATIC_IP == */* ]] || die "STATIC_IP needs a prefix length, e.g. 192.168.142.2/24"
  if ! systemctl is-active -q NetworkManager 2>/dev/null; then
    report skip static-ip "no NetworkManager, set $STATIC_IP by hand"
    return
  fi
  dev=$(default_dev)
  conn=$(nmcli -g GENERAL.CONNECTION device show "$dev")
  gw=${GATEWAY:-$(default_gw)}
  want=$(printf '%s\n' manual "$STATIC_IP" "$gw")
  have=$(nmcli -g ipv4.method,ipv4.addresses,ipv4.gateway connection show "$conn")
  if [[ $have == "$want" ]] && ip -4 -o addr show dev "$dev" | grep -qF " $STATIC_IP "; then
    report ok static-ip "$conn: $STATIC_IP via $gw"
    return
  fi
  mapfile -t old <<<"$have"
  systemd-run --unit=homelab-static-ip --collect --on-active=5s --quiet \
    bash -c "$(declare -f static_ip_job); static_ip_job \"\$@\"" static_ip_job \
    "$conn" "$dev" "$STATIC_IP" "$gw" "${old[0]}" "${old[1]:-}" "${old[2]:-}"
  report changed static-ip "$conn: $STATIC_IP via $gw"
  echo "moving $conn to $STATIC_IP in 5 seconds. Run bootstrap again against the new address."
  echo "It reverts if the address isn't up within 45 seconds, see journalctl -u homelab-static-ip."
  exit 1
}

# static_ip_job CONN DEV ADDR GW OLD_METHOD OLD_ADDRS OLD_GW runs in the unit static_ip starts.
static_ip_job() {
  local conn=$1 dev=$2 addr=$3 gw=$4
  nmcli connection modify "$conn" ipv4.method manual ipv4.addresses "$addr" ipv4.gateway "$gw"
  if nmcli --wait 45 connection up "$conn" && ip -4 -o addr show dev "$dev" | grep -qF " $addr "; then
    echo "$conn: $addr via $gw"
    return
  fi
  echo "$addr didn't come up on $dev, reverting $conn" >&2
  nmcli connection modify "$conn" ipv4.method "$5" ipv4.addresses "$6" ipv4.gateway "$7"
  nmcli connection up "$conn"
  return 1
}

# Subnet routers and exit nodes need forwarding. k3s turns it on at runtime, this keeps it across boots.
forwarding() {
  local status
  status=$(write_file /etc/sysctl.d/99-tailscale.conf 0644 <<'EOF'
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
EOF
  )
  if [[ $status == changed ]]; then sysctl -q -p /etc/sysctl.d/99-tailscale.conf; fi
  report "$status" ip-forwarding
}

# The Debian default of 128 inotify instances runs out with log shippers and a few dozen pods.
inotify() {
  local status
  status=$(write_file /etc/sysctl.d/99-inotify.conf 0644 <<'EOF'
fs.inotify.max_user_instances = 1024
fs.inotify.max_user_watches = 524288
EOF
  )
  if [[ $status == changed ]]; then sysctl -q -p /etc/sysctl.d/99-inotify.conf; fi
  report "$status" inotify-limits
}

# Security updates from Debian only. Pi OS has no security suite of its own, and its archive also ships the kernel,
# firmware and bootloader, so those stay manual. The host reboots at REBOOT_TIME only when an update needs it.
# This file comes after the package's 20auto-upgrades and 50unattended-upgrades, so it overrides them.
unattended_upgrades() {
  local time=${REBOOT_TIME:-04:00} status
  status=$(write_file /etc/apt/apt.conf.d/52homelab-unattended-upgrades 0644 <<EOF
// Written by bootstrap/bootstrap.sh
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
#clear Unattended-Upgrade::Origins-Pattern;
Unattended-Upgrade::Origins-Pattern {
  "origin=Debian,codename=\${distro_codename}-security,label=Debian-Security";
};
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "$time";
EOF
  )
  report "$status" unattended-upgrades "reboot at $time when required"
}

# Writes the reboot-required flag and pending update counts for node-exporter's textfile collector, every 15 minutes.
apt_metrics() {
  local script unit timer
  script=$(write_file /usr/local/sbin/apt-metrics 0755 <<'EOF'
#!/bin/sh
# Written by bootstrap/bootstrap.sh
set -eu
dir=/var/lib/prometheus/node-exporter
sim=$(apt-get -s -o Debug::NoLocking=true dist-upgrade)
total=$(printf '%s\n' "$sim" | grep -c '^Inst ' || true)
security=$(printf '%s\n' "$sim" | grep -c '^Inst .*Debian-Security:' || true)
reboot=0
if [ -f /run/reboot-required ]; then reboot=1; fi
mkdir -p "$dir"
# node-exporter only reads *.prom, so it never sees a half-written file.
cat >"$dir/apt.prom.tmp" <<PROM
# HELP node_reboot_required 1 when /run/reboot-required exists.
# TYPE node_reboot_required gauge
node_reboot_required $reboot
# HELP apt_upgrades_pending Packages that apt-get dist-upgrade would upgrade or install.
# TYPE apt_upgrades_pending gauge
apt_upgrades_pending $total
# HELP apt_security_upgrades_pending Pending upgrades from the Debian security origin.
# TYPE apt_security_upgrades_pending gauge
apt_security_upgrades_pending $security
PROM
mv "$dir/apt.prom.tmp" "$dir/apt.prom"
EOF
  )
  unit=$(write_file /etc/systemd/system/apt-metrics.service 0644 <<'EOF'
[Unit]
Description=Write apt metrics for node-exporter
After=apt-daily.service apt-daily-upgrade.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/apt-metrics
EOF
  )
  timer=$(write_file /etc/systemd/system/apt-metrics.timer 0644 <<'EOF'
[Unit]
Description=Write apt metrics for node-exporter every 15 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=15min

[Install]
WantedBy=timers.target
EOF
  )
  if [[ "$script $unit $timer" != *changed* ]] && systemctl is-enabled -q apt-metrics.timer &&
    systemctl is-active -q apt-metrics.timer; then
    report ok apt-metrics
    return
  fi
  systemctl daemon-reload
  systemctl enable -q --now apt-metrics.timer
  systemctl start apt-metrics.service
  report changed apt-metrics
}

# Debian's restic is too old for `restore --delete` and `snapshot:subfolder`, so this installs the pinned release.
restic_install() {
  local arch bz2 url
  if [[ $(restic version 2>/dev/null) == "restic $RESTIC_VERSION "* ]]; then
    report ok restic
    return
  fi
  arch=$(dpkg --print-architecture)
  bz2="restic_${RESTIC_VERSION}_linux_$arch.bz2"
  url="https://github.com/restic/restic/releases/download/v$RESTIC_VERSION"
  curl -fsSL "$url/$bz2" -o "$workdir/$bz2"
  curl -fsSL "$url/SHA256SUMS" -o "$workdir/SHA256SUMS"
  (cd "$workdir" && sha256sum -c --quiet --ignore-missing SHA256SUMS)
  bunzip2 "$workdir/$bz2"
  install -m 0755 "$workdir/${bz2%.bz2}" /usr/local/bin/restic
  report changed restic "$RESTIC_VERSION"
}

# Nightly restic backup of the local-path PVCs to the USB disk labelled homelab-backup, see docs/backups.md.
# RequiresMountsFor makes the backup fail without the disk, rather than write the repo to the empty mountpoint.
backups() {
  local fstab=ok password script unit timer
  if ! grep -q '^LABEL=homelab-backup ' /etc/fstab; then
    echo 'LABEL=homelab-backup /mnt/homelab-backup ext4 defaults,nofail,x-systemd.device-timeout=5s 0 2' >>/etc/fstab
    fstab=changed
  fi
  password=$(printf '%s\n' "$RESTIC_PASSWORD" | write_file /etc/homelab/restic-password 0600)
  script=$(write_file /usr/local/sbin/homelab-backup 0755 <<'EOF'
#!/bin/sh
# Written by bootstrap/bootstrap.sh
set -eu
export RESTIC_REPOSITORY=/mnt/homelab-backup/restic RESTIC_PASSWORD_FILE=/etc/homelab/restic-password
export RESTIC_CACHE_DIR=/var/cache/restic
dir=/var/lib/prometheus/node-exporter
# Prometheus and Loki data changes a lot and starts empty after a rebuild, so monitoring's PVCs are left out.
restic backup --quiet --exclude '*_monitoring_*' /var/lib/rancher/k3s/storage
restic forget --quiet --prune --keep-daily 7 --keep-weekly 4 --keep-monthly 6
# Sundays: check the repo structure, without reading back all the data.
if [ "$(date +%u)" = 7 ]; then restic check --quiet; fi
mkdir -p "$dir"
cat >"$dir/backup.prom.tmp" <<PROM
# HELP homelab_backup_last_success_timestamp_seconds When the last backup and prune succeeded.
# TYPE homelab_backup_last_success_timestamp_seconds gauge
homelab_backup_last_success_timestamp_seconds $(date +%s)
PROM
mv "$dir/backup.prom.tmp" "$dir/backup.prom"
EOF
  )
  unit=$(write_file /etc/systemd/system/homelab-backup.service 0644 <<'EOF'
[Unit]
Description=Back up the local-path PVCs to the USB disk with restic
RequiresMountsFor=/mnt/homelab-backup

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/homelab-backup
Nice=10
IOSchedulingClass=idle
EOF
  )
  timer=$(write_file /etc/systemd/system/homelab-backup.timer 0644 <<'EOF'
[Unit]
Description=Back up the local-path PVCs every night

[Timer]
OnCalendar=*-*-* 03:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
  )
  if [[ "$fstab $password $script $unit $timer" != *changed* ]] && systemctl is-enabled -q homelab-backup.timer &&
    systemctl is-active -q homelab-backup.timer; then
    report ok backups
  else
    mkdir -p /mnt/homelab-backup
    systemctl daemon-reload
    systemctl enable -q --now homelab-backup.timer
    report changed backups "nightly at 03:00"
  fi
  backup_disk
}

# Mounts the disk if it's plugged in, and creates the restic repo on it once.
backup_disk() {
  local mnt=/mnt/homelab-backup
  if mountpoint -q "$mnt"; then
    report ok backup-disk
  elif [[ -e /dev/disk/by-label/homelab-backup ]]; then
    mount "$mnt"
    report changed backup-disk "mounted $mnt"
  else
    report skip backup-disk "no disk labelled homelab-backup, so the nightly backup fails until one is plugged in"
    return
  fi
  if [[ -f $mnt/restic/config ]]; then
    report ok backup-repo
    return
  fi
  RESTIC_PASSWORD_FILE=/etc/homelab/restic-password restic init --quiet --repo "$mnt/restic"
  report changed backup-repo "$mnt/restic"
}

tailscale_install() {
  if command -v tailscale >/dev/null; then
    report ok tailscale-install
    return
  fi
  curl -fsSL https://tailscale.com/install.sh | sh
  report changed tailscale-install
}

# accept-dns=false keeps tailscale from rewriting the host resolvers (see dns).
tailscale_up() {
  local routes=${SUBNET_ROUTES:-$(lan_subnet)} state want have
  state=$(tailscale status --json 2>/dev/null | jq -r .BackendState || true)
  if [[ $state != Running ]]; then
    [[ -n ${TAILSCALE_AUTH_KEY:-} ]] || die "TAILSCALE_AUTH_KEY is required to log in to Tailscale"
    (umask 077 && printf '%s' "$TAILSCALE_AUTH_KEY" >"$workdir/ts-key")
    tailscale up --auth-key="file:$workdir/ts-key" --advertise-routes="$routes" --advertise-exit-node --accept-dns=false
    report changed tailscale-up "$routes, exit node"
    return
  fi
  want=$(jq -nr --arg r "$routes" '[($r | split(",")[]), "0.0.0.0/0", "::/0"] | sort | join(",") + " false"')
  have=$(tailscale debug prefs | jq -r '((.AdvertiseRoutes // []) | sort | join(",")) + " \(.CorpDNS)"')
  if [[ $have == "$want" ]]; then
    report ok tailscale-up
    return
  fi
  tailscale set --advertise-routes="$routes" --advertise-exit-node --accept-dns=false
  report changed tailscale-up "$routes, exit node"
}

k3s_config() {
  local host ts_name extra=() sans=() san status
  host=$(hostname)
  ts_name=$(tailscale status --json | jq -r '.Self.DNSName | rtrimstr(".")')
  read -ra extra <<<"${TLS_SANS:-}"
  for san in "$host" "$host.local" "$ts_name" "$(lan_ip)" "$(tailscale ip -4)" "${extra[@]}"; do
    if [[ -n $san ]]; then sans+=("$san"); fi
  done
  # 0640 plus the sudo user's group lets the Mac copy the kubeconfig over SSH without sudo.
  status=$(
    {
      echo "# Written by bootstrap/bootstrap.sh"
      echo "disable:"
      echo "  - traefik"
      echo "tls-san:"
      printf '  - %s\n' "${sans[@]}"
      echo 'write-kubeconfig-mode: "0640"'
      echo "write-kubeconfig-group: $(id -gn "${SUDO_USER:-root}")"
    } | write_file /etc/rancher/k3s/config.yaml 0600
  )
  if [[ $status == changed ]] && systemctl is-active -q k3s; then systemctl restart k3s; fi
  report "$status" k3s-config "${sans[*]}"
}

# Installed once. After that the system-upgrade-controller Plan upgrades it.
k3s_install() {
  if systemctl is-enabled -q k3s 2>/dev/null; then
    report ok k3s-install
  else
    curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="$K3S_VERSION" sh -
    report changed k3s-install "$K3S_VERSION"
  fi
  retry 60 kubectl wait --for=condition=Ready node --all --timeout=5s
}

helm_install() {
  local arch tgz
  if [[ $(helm version --template '{{.Version}}' 2>/dev/null) == "$HELM_VERSION" ]]; then
    report ok helm
    return
  fi
  arch=$(dpkg --print-architecture)
  tgz="helm-$HELM_VERSION-linux-$arch.tar.gz"
  curl -fsSL "https://get.helm.sh/$tgz" -o "$workdir/$tgz"
  curl -fsSL "https://get.helm.sh/$tgz.sha256sum" -o "$workdir/$tgz.sha256sum"
  (cd "$workdir" && sha256sum -c --quiet "$tgz.sha256sum")
  tar -xzf "$workdir/$tgz" -C "$workdir" "linux-$arch/helm"
  install -m 0755 "$workdir/linux-$arch/helm" /usr/local/bin/helm
  report changed helm "$HELM_VERSION"
}

# Installed once. After that Flux upgrades it from clusters/homelab/flux-system/flux-operator.yaml.
flux_operator() {
  if helm status flux-operator --namespace flux-system >/dev/null 2>&1; then
    report ok flux-operator
    return
  fi
  helm install flux-operator oci://ghcr.io/controlplaneio-fluxcd/charts/flux-operator \
    --version "$FLUX_OPERATOR_VERSION" --namespace flux-system --create-namespace --wait
  report changed flux-operator "$FLUX_OPERATOR_VERSION"
}

# secret NAMESPACE NAME KEY VALUE [ARGS...] creates or updates a Secret, with VALUE on stdin.
secret() {
  local ns=$1 name=$2 key=$3 value=$4 out
  shift 4
  if ! kubectl get namespace "$ns" >/dev/null 2>&1; then kubectl create namespace "$ns" >/dev/null; fi
  out=$(printf '%s' "$value" |
    kubectl create secret generic "$name" --namespace "$ns" --from-file="$key=/dev/stdin" "$@" --dry-run=client -o yaml |
    kubectl apply -f -)
  if [[ $out == *unchanged ]]; then report ok "secret $ns/$name"; else report changed "secret $ns/$name"; fi
}

# Applied once. After that Flux manages the FluxInstance from git.
flux_instance() {
  if kubectl --namespace flux-system get fluxinstance flux >/dev/null 2>&1; then
    report ok flux-instance
  else
    printf '%s\n' "$FLUX_INSTANCE_YAML" | kubectl apply -f - >/dev/null
    report changed flux-instance
  fi
  kubectl --namespace flux-system wait fluxinstance/flux --for=condition=Ready --timeout=10m >/dev/null
}

main() {
  [[ $EUID -eq 0 ]] || die "run as root"
  [[ -n ${OP_SERVICE_ACCOUNT_TOKEN:-} ]] || die "OP_SERVICE_ACCOUNT_TOKEN is required"
  [[ -n ${RESTIC_PASSWORD:-} ]] || die "RESTIC_PASSWORD is required"
  [[ -n ${FLUX_INSTANCE_YAML:-} ]] || die "FLUX_INSTANCE_YAML is required"
  [[ -n ${K3S_VERSION:-} ]] || die "K3S_VERSION is required"

  packages
  cmdline
  pcie
  reboot_if_needed
  desktop
  dns
  static_ip
  forwarding
  inotify
  unattended_upgrades
  apt_metrics
  restic_install
  backups
  tailscale_install
  tailscale_up
  k3s_config
  k3s_install
  helm_install
  flux_operator
  secret external-secrets onepassword-service-account token "$OP_SERVICE_ACCOUNT_TOKEN"
  flux_instance

  if ((changes == 0)); then echo "no changes"; else echo "$changes changed"; fi
}

# stdin is the script itself when run through `bash -s`, so keep commands from reading it.
main </dev/null
