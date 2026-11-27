#!/usr/bin/env bash
# Sets up the NAS nas.home.arpa on Raspberry Pi OS Lite: the btrfs pool's mount and subvolumes, Samba with a
# Time Machine share, daily snapshots, a monthly scrub and the nightly restic backup to the USB disk.
# Idempotent: every step checks state first and prints "ok" or "changed".
#
# Runs as root on the NAS. nas/run.sh drives it from the Mac and prepends these variables to the script on stdin,
# so no secret is ever a command-line arg:
#
#   SAMBA_PASSWORD   password of the Samba user
#   RESTIC_PASSWORD  password of the restic repo on the backup disk
#
# It never formats a disk and never reboots. Until the pool and the backup disk exist, the steps that need them are skipped and
# their jobs fail: docs/nas.md has the commands.
set -euo pipefail
shopt -s inherit_errexit

POOL=/srv/nas
BACKUP_MNT=/mnt/nas-backup
SHARE_USER=arnegiacomo
# Time Machine fills whatever it is given, and the pool is shared.
TIME_MACHINE_MAX_SIZE=750G
REBOOT_TIME=05:00
CONFIG_TXT=/boot/firmware/config.txt
STATIC_IP=192.168.142.7/24
GATEWAY=192.168.142.1
# Not the Pi-hole in the cluster: the NAS has to work while the cluster is down.
DNS_SERVERS=1.1.1.1,1.0.0.1

export DEBIAN_FRONTEND=noninteractive
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

# job NAME CALENDAR MOUNTS DESCRIPTION < script installs the script as /usr/local/sbin/NAME and runs it on a
# systemd timer. RequiresMountsFor makes it fail without MOUNTS, rather than write to an empty mountpoint on the
# SD card. Prints ok or changed.
job() {
  local name=$1 calendar=$2 mounts=$3 description=$4 script unit timer
  script=$(write_file "/usr/local/sbin/$name" 0755)
  unit=$(write_file "/etc/systemd/system/$name.service" 0644 <<EOF
[Unit]
Description=$description
RequiresMountsFor=$mounts

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/$name
Nice=10
IOSchedulingClass=idle
EOF
  )
  timer=$(write_file "/etc/systemd/system/$name.timer" 0644 <<EOF
[Unit]
Description=$description

[Timer]
OnCalendar=$calendar
Persistent=true

[Install]
WantedBy=timers.target
EOF
  )
  if [[ "$script $unit $timer" != *changed* ]] && systemctl is-enabled -q "$name.timer" &&
    systemctl is-active -q "$name.timer"; then
    echo ok
    return
  fi
  systemctl daemon-reload
  systemctl enable -q --now "$name.timer"
  echo changed
}

packages() {
  local p missing=()
  for p in unattended-upgrades btrfs-progs samba avahi-daemon smartmontools restic prometheus-node-exporter; do
    if ! installed "$p"; then missing+=("$p"); fi
  done
  if ((${#missing[@]} == 0)); then
    report ok packages
    return
  fi
  apt-get update -q
  # Samba recommends winbind and the AD domain controller, which a standalone file server has no use for.
  apt-get install -y -q --no-install-recommends "${missing[@]}"
  report changed packages "${missing[*]}"
}

# The Pi 5 keeps its PCIe connector off unless a HAT+ announces itself. The NVMe Base Duo doesn't, so without
# pciex1 the NVMes never show up. The NAS is wired, so the Wi-Fi radio is off. The lines must be under [all], since
# lines under a filter like [cm5] only apply to that board. config.txt is only read at boot.
config_txt() {
  local line added=()
  for line in dtparam=pciex1 dtoverlay=disable-wifi; do
    if grep -qxF "$line" "$CONFIG_TXT"; then continue; fi
    if [[ -n $(tail -c 1 "$CONFIG_TXT") ]]; then echo >>"$CONFIG_TXT"; fi
    if [[ $(grep '^\[' "$CONFIG_TXT" | tail -n 1 || true) != '[all]' ]]; then printf '\n[all]\n' >>"$CONFIG_TXT"; fi
    echo "$line" >>"$CONFIG_TXT"
    added+=("$line")
  done
  if ((${#added[@]} == 0)); then
    report ok config.txt
    return
  fi
  report changed config.txt "${added[*]}, reboot the NAS to apply"
}

# Pins the LAN address on the NAS, since the router doesn't reliably apply DHCP reservations. Only the stored
# profile changes, so the SSH session survives and the address moves at the next boot.
static_ip() {
  local conn
  conn=$(nmcli -g GENERAL.CONNECTION device show eth0)
  if [[ $(nmcli -g ipv4.method,ipv4.addresses,ipv4.gateway,ipv4.dns connection show "$conn" | paste -sd' ') == \
    "manual $STATIC_IP $GATEWAY $DNS_SERVERS" ]]; then
    report ok static-ip "$STATIC_IP"
    return
  fi
  nmcli connection modify "$conn" ipv4.method manual ipv4.addresses "$STATIC_IP" ipv4.gateway "$GATEWAY" \
    ipv4.dns "$DNS_SERVERS"
  report changed static-ip "$STATIC_IP, reboot the NAS to apply"
}

# The journal is the only steady writer to the SD card.
journal() {
  local status
  status=$(write_file /etc/systemd/journald.conf.d/homelab.conf 0644 <<'EOF'
# Written by nas/setup.sh
[Journal]
SystemMaxUse=200M
EOF
  )
  if [[ $status == changed ]]; then systemctl restart systemd-journald; fi
  report "$status" journal "capped at 200M"
}

# Security updates from Debian only. Pi OS has no security suite of its own, and its archive also ships the kernel,
# firmware and bootloader, so those stay manual. The NAS reboots at REBOOT_TIME only when an update needs it,
# after the night's jobs. This file comes after the package's 20auto-upgrades and 50unattended-upgrades, so it
# overrides them.
unattended_upgrades() {
  local status
  status=$(write_file /etc/apt/apt.conf.d/52homelab-unattended-upgrades 0644 <<EOF
// Written by nas/setup.sh
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
#clear Unattended-Upgrade::Origins-Pattern;
Unattended-Upgrade::Origins-Pattern {
  "origin=Debian,codename=\${distro_codename}-security,label=Debian-Security";
};
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "$REBOOT_TIME";
EOF
  )
  report "$status" unattended-upgrades "reboot at $REBOOT_TIME when required"
}

# Mounts the pool and creates its subvolumes. nofail lets the NAS boot without it. There is no `degraded` option:
# with a drive missing the mount fails and the shares disappear, rather than the pool quietly running on one drive.
pool() {
  local sub
  if ! grep -q '^LABEL=nas ' /etc/fstab; then
    echo "LABEL=nas $POOL btrfs noatime,nofail,x-systemd.device-timeout=30s 0 0" >>/etc/fstab
    mkdir -p "$POOL"
    systemctl daemon-reload
    report changed fstab "$POOL"
  fi
  if mountpoint -q "$POOL"; then
    report ok pool
  elif [[ -e /dev/disk/by-label/nas ]]; then
    mount "$POOL"
    report changed pool "mounted $POOL"
  else
    report skip pool "no filesystem labelled nas, so the shares and jobs fail until the NVMes are formatted"
    return
  fi
  for sub in archive backups timemachine; do
    if [[ -d $POOL/$sub ]]; then continue; fi
    btrfs subvolume create "$POOL/$sub" >/dev/null
    report changed subvolume "$sub"
  done
  for sub in archive timemachine; do
    if [[ $(stat -c %U "$POOL/$sub") == "$SHARE_USER" ]]; then continue; fi
    chown "$SHARE_USER:$SHARE_USER" "$POOL/$sub"
    report changed owner "$sub"
  done
}

# One Samba user for both shares. Samba announces itself over mDNS through Avahi, including the Time Machine
# share, so Macs find it without an address. The fruit module is what makes macOS treat it as an Apple server.
samba() {
  local conf hash
  conf=$(write_file /etc/samba/smb.conf 0644 <<EOF
# Written by nas/setup.sh
[global]
  server role = standalone server
  server min protocol = SMB2
  disable netbios = yes
  smb ports = 445
  map to guest = never
  logging = systemd
  load printers = no
  printcap name = /dev/null
  disable spoolss = yes
  vfs objects = catia fruit streams_xattr
  fruit:metadata = stream
  fruit:nfs_aces = no

[archive]
  path = $POOL/archive
  valid users = $SHARE_USER
  read only = no

[timemachine]
  path = $POOL/timemachine
  valid users = $SHARE_USER
  read only = no
  fruit:time machine = yes
  fruit:time machine max size = $TIME_MACHINE_MAX_SIZE
EOF
  )
  testparm -s >/dev/null 2>&1 || die "smb.conf does not parse, run testparm on the NAS"
  # Samba keeps its own password database. The hash only tells a later run whether the password changed.
  hash=$(printf '%s' "$SAMBA_PASSWORD" | sha256sum | write_file /etc/homelab/samba-password.sha256 0600)
  if [[ $hash == changed ]] || ! pdbedit -L -u "$SHARE_USER" >/dev/null 2>&1; then
    printf '%s\n%s\n' "$SAMBA_PASSWORD" "$SAMBA_PASSWORD" | smbpasswd -s -a "$SHARE_USER" >/dev/null
    report changed samba-password "$SHARE_USER"
  fi
  # NetBIOS is off, so nmbd has nothing to do and would only fail.
  if systemctl is-enabled -q nmbd 2>/dev/null || systemctl is-active -q nmbd; then
    systemctl disable -q --now nmbd
    report changed nmbd disabled
  fi
  if [[ $conf == changed ]]; then systemctl restart smbd; fi
  systemctl enable -q --now smbd avahi-daemon
  report "$conf" samba "archive, timemachine capped at $TIME_MACHINE_MAX_SIZE"
}

# Read-only snapshots of the subvolumes that hold originals, under .snapshots/<subvolume>/<date>. Time Machine
# keeps its own history, so it has none.
snapshots() {
  local status
  status=$(job nas-snapshot '*-*-* 02:30' "$POOL" 'Snapshot the archive and backups subvolumes' <<'EOF'
#!/bin/sh
# Written by nas/setup.sh
set -eu
keep=14
today=$(date +%F)
for sub in archive backups; do
  dir=/srv/nas/.snapshots/$sub
  mkdir -p "$dir"
  if [ ! -d "$dir/$today" ]; then btrfs subvolume snapshot -r "/srv/nas/$sub" "$dir/$today" >/dev/null; fi
  # The names are dates, so they sort by age.
  find "$dir" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort | head -n -"$keep" | while read -r old; do
    btrfs subvolume delete "$dir/$old" >/dev/null
  done
done
EOF
  )
  report "$status" snapshots "daily at 02:30, 14 kept"
}

# A scrub reads everything back and repairs a bad copy from the good one. It exits non-zero on an error it
# couldn't repair, which leaves the timestamp behind.
scrub() {
  local status
  status=$(job nas-scrub monthly "$POOL" 'Scrub the pool' <<'EOF'
#!/bin/sh
# Written by nas/setup.sh
set -eu
dir=/var/lib/prometheus/node-exporter
btrfs scrub start -B -q /srv/nas
mkdir -p "$dir"
# node-exporter only reads *.prom, so it never sees a half-written file.
cat >"$dir/scrub.prom.tmp" <<PROM
# HELP nas_scrub_last_success_timestamp_seconds When the last scrub of the pool finished without unrepaired errors.
# TYPE nas_scrub_last_success_timestamp_seconds gauge
nas_scrub_last_success_timestamp_seconds $(date +%s)
PROM
mv "$dir/scrub.prom.tmp" "$dir/scrub.prom"
EOF
  )
  report "$status" scrub monthly
}

# Nightly restic backup of the archive to the USB disk labelled nas-backup. Time Machine is left out: it is
# already a second copy of each Mac.
backups() {
  local fstab=ok password status
  if ! grep -q '^LABEL=nas-backup ' /etc/fstab; then
    echo "LABEL=nas-backup $BACKUP_MNT ext4 defaults,nofail,x-systemd.device-timeout=5s 0 2" >>/etc/fstab
    mkdir -p "$BACKUP_MNT"
    systemctl daemon-reload
    fstab=changed
  fi
  password=$(printf '%s\n' "$RESTIC_PASSWORD" | write_file /etc/homelab/restic-password 0600)
  status=$(job nas-backup '*-*-* 03:30' "$POOL $BACKUP_MNT" 'Back up the archive to the USB disk with restic' <<'EOF'
#!/bin/sh
# Written by nas/setup.sh
set -eu
export RESTIC_REPOSITORY=/mnt/nas-backup/restic RESTIC_PASSWORD_FILE=/etc/homelab/restic-password
# On the pool, to keep the cache's writes off the SD card.
export RESTIC_CACHE_DIR=/srv/nas/.restic-cache
dir=/var/lib/prometheus/node-exporter
restic backup --quiet /srv/nas/archive
restic forget --quiet --prune --keep-daily 7 --keep-weekly 4 --keep-monthly 6
# Sundays: check the repo structure, without reading back all the data.
if [ "$(date +%u)" = 7 ]; then restic check --quiet; fi
mkdir -p "$dir"
cat >"$dir/backup.prom.tmp" <<PROM
# HELP nas_backup_last_success_timestamp_seconds When the last backup and prune succeeded.
# TYPE nas_backup_last_success_timestamp_seconds gauge
nas_backup_last_success_timestamp_seconds $(date +%s)
PROM
mv "$dir/backup.prom.tmp" "$dir/backup.prom"
EOF
  )
  if [[ "$fstab $password $status" == *changed* ]]; then
    report changed backups "nightly at 03:30"
  else
    report ok backups
  fi
  backup_disk
}

# Mounts the disk if it's plugged in, and creates the restic repo on it once.
backup_disk() {
  if mountpoint -q "$BACKUP_MNT"; then
    report ok backup-disk
  elif [[ -e /dev/disk/by-label/nas-backup ]]; then
    mount "$BACKUP_MNT"
    report changed backup-disk "mounted $BACKUP_MNT"
  else
    report skip backup-disk "no disk labelled nas-backup, so the nightly backup fails until one is plugged in"
    return
  fi
  if [[ -f $BACKUP_MNT/restic/config ]]; then
    report ok backup-repo
    return
  fi
  RESTIC_PASSWORD_FILE=/etc/homelab/restic-password restic init --quiet --repo "$BACKUP_MNT/restic"
  report changed backup-repo "$BACKUP_MNT/restic"
}

main() {
  [[ $EUID -eq 0 ]] || die "run as root, use nas/run.sh"
  [[ -n ${SAMBA_PASSWORD:-} ]] || die "SAMBA_PASSWORD is required, use nas/run.sh"
  [[ -n ${RESTIC_PASSWORD:-} ]] || die "RESTIC_PASSWORD is required, use nas/run.sh"

  packages
  config_txt
  static_ip
  journal
  unattended_upgrades
  pool
  samba
  snapshots
  scrub
  backups

  if ((changes == 0)); then echo "no changes"; else echo "$changes changed"; fi
}

# stdin is the script itself when run through `bash -s`, so keep commands from reading it.
main </dev/null
