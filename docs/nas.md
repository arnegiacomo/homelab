# NAS

`nas` is a Raspberry Pi 5 (8 GB) at `192.168.142.7`. It holds the archive, which is the long-term storage, and the Macs' Time Machine backups. It is a plain host and not a k3s node, so it keeps working while the cluster is down.

## Disks

| Disk | Role |
|---|---|
| SD card | The OS. Nothing on it is worth keeping: flash a new one and run `nas/run.sh` |
| Two 2 TB NVMe SSDs on a Pimoroni NVMe Base Duo | The pool: btrfs RAID1 with the label `nas`, mounted at `/srv/nas`. 2 TB usable, and every block is on both drives |
| 2 TB USB hard drive | The backup disk: ext4 with the label `nas-backup`, mounted at `/mnt/nas-backup` |

The pool has three subvolumes, which share its space:

| Subvolume | Contents |
|---|---|
| `archive` | Long-term storage |
| `timemachine` | Time Machine backups, one sparsebundle per Mac |
| `backups` | restic repos from other hosts. Nothing writes to it yet |

- The NAS boots without the pool or the backup disk. The shares and jobs then fail, rather than write to the SD card.
- With a drive missing, the pool does not mount by itself. See [a drive fails](#a-drive-fails).
- Each SSD has one GPT partition, so the pool can be shrunk later to make room for something else.

## Shares

Samba, with one user: `arnegiacomo`, and the password from the 1Password item `nas-samba`. The NAS announces itself over mDNS, so it shows up in Finder's sidebar as `NAS`.

| Share | Address |
|---|---|
| `archive` | `smb://nas.local/archive`, or `smb://nas.home.arpa/archive` over Tailscale through `homelab` |
| `timemachine` | Picked in Time Machine settings |

### Time Machine

On each Mac: System Settings -> General -> Time Machine -> Add Backup Disk, pick `timemachine` on `NAS`, log in as the Samba user and turn on Encrypt Backup. Keep the encryption password in 1Password: the backup can't be restored without it.

The share is capped at 750 GB in total (`TIME_MACHINE_MAX_SIZE` in `nas/setup.sh`), since Time Machine otherwise grows until the pool is full. At the cap it deletes its oldest backups by itself.

## What runs

| When | Job | What |
|---|---|---|
| 02:30 | `nas-snapshot` | Read-only btrfs snapshots of `archive` and `backups` in `/srv/nas/.snapshots/<subvolume>/<date>`. The last 14 are kept |
| 03:30 | `nas-backup` | restic backs up `archive` to the backup disk. It keeps 7 daily, 4 weekly and 6 monthly snapshots, and runs `restic check` on Sundays |
| The 1st of the month | `nas-scrub` | Reads the whole pool back and repairs a bad block from the other drive |
| 05:00 | unattended-upgrades | Reboots, only when a Debian security update needs it |

- Time Machine is in neither the snapshots nor the backup: it keeps its own history, and it is already a second copy of each Mac.
- The restic repo is `/mnt/nas-backup/restic`, with the same password as the cluster's backups: the 1Password item `restic-password`, written to `/etc/homelab/restic-password`. Never replace it.
- There is no offsite copy. The pool and the backup disk sit in the same place.
- The alerts are in [monitoring](monitoring.md#nas).

## Setup

```sh
nas/run.sh   # target nas.local, or pass another
```

It's safe to run again. It never formats a disk and never reboots. It:

- installs Samba, Avahi, restic, btrfs-progs, smartmontools and node_exporter
- turns on the Pi's PCIe connector and turns off Wi-Fi in `config.txt`, and pins the address. Both apply at the next boot
- caps the journal at 200 MB, and turns on Debian security updates
- mounts the pool and creates the subvolumes, if the pool exists
- writes the Samba config and sets the Samba password
- installs the three jobs and their timers
- mounts the backup disk and creates the restic repo on it, if the disk is plugged in

## Commands

On `nas`:

| What | Command |
|---|---|
| Pool health | `sudo btrfs device stats /srv/nas`, `sudo btrfs filesystem usage /srv/nas` |
| Last scrub | `sudo btrfs scrub status /srv/nas` |
| Drive health and temperature | `sudo smartctl -a /dev/nvme0`, `sudo smartctl -a /dev/nvme1` |
| Who is connected | `sudo smbstatus` |
| Run a job now | `sudo systemctl start nas-backup` (or `nas-snapshot`, `nas-scrub`) |
| A job's last runs | `journalctl -u nas-backup` |
| Next runs | `systemctl list-timers 'nas-*'` |

For restic, as root (`sudo -i`):

```sh
export RESTIC_REPOSITORY=/mnt/nas-backup/restic RESTIC_PASSWORD_FILE=/etc/homelab/restic-password RESTIC_CACHE_DIR=/srv/nas/.restic-cache
restic snapshots
```

The backup disk's USB bridge doesn't pass SMART through, so `smartctl` can't read it. The weekly `restic check` is what notices a failing backup disk.

## Getting a file back

- **Deleted or overwritten in the last 14 days:** copy it out of the snapshot, `/srv/nas/.snapshots/archive/<date>/`.
- **Older, or the pool is gone:** from the backup disk, with the restic variables above:

  ```sh
  restic restore latest --target /srv/nas/archive-restored --include /srv/nas/archive/<path>
  ```

## A drive fails

`NasPoolDeviceErrors` or `NasPoolDegraded` fires. `sudo btrfs device stats /srv/nas` and `sudo dmesg` show which drive.

1. Shut the NAS down and swap the drive.
2. Mount the pool on the remaining drive, and find the missing drive's `devid`:

   ```sh
   sudo mount -o degraded /srv/nas
   sudo btrfs filesystem show nas
   ```

3. Partition the new drive like the old one, and rebuild onto it:

   ```sh
   echo type=linux | sudo sfdisk --label gpt /dev/nvme1n1
   sudo btrfs replace start <devid> /dev/nvme1n1p1 /srv/nas
   sudo btrfs replace status /srv/nas
   ```

4. Anything written while it was degraded has one copy only. Mirror it again:

   ```sh
   sudo btrfs balance start -dconvert=raid1,soft -mconvert=raid1,soft /srv/nas
   ```

## Building it from scratch

Hardware:

- The base goes under the Pi. If neither drive shows up and `dmesg` says `1000110000.pcie: link down`, the ribbon cable isn't seated: reseat both ends.
- Use the official 27 W supply. On a 3 A supply the Pi logged under-voltage with both SSDs busy, and it only gives the USB ports enough current for the backup disk on the 27 W one. `vcgencmd get_throttled` should print `0x0`.
- The SSDs sit between the boards without airflow. Writing at full speed for half an hour took them to 90C, their warning limit. `NasSsdTemperatureHigh` fires at 80C.

Software:

- [ ] Flash Raspberry Pi OS Lite (64-bit) with Raspberry Pi Imager: hostname `nas`, user `arnegiacomo`, your SSH key, timezone `Europe/Oslo`, no Wi-Fi.
- [ ] Give the user passwordless sudo:

  ```sh
  ssh -t nas.local "echo 'arnegiacomo ALL=(ALL) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/010_nopasswd >/dev/null && sudo chmod 0440 /etc/sudoers.d/010_nopasswd"
  ```

- [ ] `nas/run.sh`, then reboot the NAS, so the PCIe connector and the address apply.
- [ ] `nas/run.sh` again. With the old drives in place, it mounts the pool and the backup disk, and everything is back.

New drives are formatted by hand, since it wipes them. Check the device names with `lsblk` first:

```sh
# The pool, on two new SSDs
echo type=linux | sudo sfdisk --label gpt /dev/nvme0n1
echo type=linux | sudo sfdisk --label gpt /dev/nvme1n1
sudo mkfs.btrfs -L nas -d raid1 -m raid1 /dev/nvme0n1p1 /dev/nvme1n1p1

# A new backup disk
sudo wipefs -a /dev/sda
sudo mkfs.ext4 -L nas-backup /dev/sda
```

Then run `nas/run.sh`.
