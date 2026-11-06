# Bootstrap

Bootstrap turns a fresh Raspberry Pi OS or Debian host into the cluster. It runs from the Mac and is safe to run again. After it, Flux applies everything else from git.

## Run it

```sh
bootstrap/wizard.sh                                            # first time, or to replace a secret
STATIC_IP=192.168.142.2/24 bootstrap/run.sh pi@homelab.local
```

- The wizard stores the [bootstrap secrets](secrets.md#bootstrap-secrets) in 1Password and walks through the Tailscale admin steps.
- `run.sh` reads the secrets with `op` and sends them to the host on stdin.
- The host may reboot once. `run.sh` carries on when it's back.
- If `STATIC_IP` changes the address, bootstrap stops. Run it again.

Options, set in front of `run.sh`: `STATIC_IP`, `GATEWAY`, `PCIE_GEN`, `DNS_SERVERS`, `SUBNET_ROUTES`, `TLS_SANS` and `REBOOT_TIME`. They're described at the top of `bootstrap/bootstrap.sh`.

## What it does

1. Turns on the memory cgroup, and PCIe Gen 3 on a Pi 5. Reboots if either changed.
2. Boots to the console and removes the desktop packages.
3. Pins the host DNS to `1.1.1.1 1.0.0.1`.
4. Sets the static IP, if `STATIC_IP` is set.
5. Sets up [automatic security updates](#automatic-security-updates).
6. Installs restic and sets up the nightly [backup](backups.md).
7. Installs Tailscale as a subnet router and exit node.
8. Installs k3s, without Traefik, at the version in `infrastructure/config/k3s-upgrade.yaml`.
9. Installs the Flux Operator and applies `clusters/homelab/flux-system/flux-instance.yaml`.

## Automatic security updates

- `unattended-upgrades` installs Debian security updates every morning between 06:00 and 07:00. The config is `/etc/apt/apt.conf.d/52homelab-unattended-upgrades`.
- When an update needs a reboot, `homelab` reboots at 04:00 the next night (`REBOOT_TIME`).
- Raspberry Pi OS packages (kernel, firmware), Debian point releases and Tailscale are left out. See [owner tasks](owner-tasks.md#now-and-then).
- Log: `/var/log/unattended-upgrades/`. Dry run: `sudo unattended-upgrade --dry-run --debug`.

## Rebuilding from scratch

Before:

- [ ] Delete the old `homelab` machine in the Tailscale admin, or the new one becomes `homelab-1`.
- [ ] Leave the backup disk plugged in.

Flash:

- [ ] Flash Raspberry Pi OS Lite (64-bit) to the NVMe. Either use the network install (keyboard, HDMI and Ethernet, hold Shift at boot), or Raspberry Pi Imager on the Mac with a USB adapter.
- [ ] Imager settings: hostname `homelab`, user `pi`, your SSH key, timezone `Europe/Oslo`.
- [ ] On the Mac: `ssh-keygen -R homelab.local` and `ssh-keygen -R homelab`.

Bootstrap:

- [ ] `bootstrap/wizard.sh`. Replace the Tailscale auth key, since the old one is used up. Keep the rest unless expired.
- [ ] `STATIC_IP=192.168.142.2/24 bootstrap/run.sh pi@homelab.local`. Run it again if it stops to move the address.
- [ ] In the Tailscale admin: approve the subnet route and exit node, disable key expiry, and set the Tailscale IP to `100.91.36.35`.
- [ ] Run bootstrap once more, so the k3s certificate gets the Tailscale IP.

After:

- [ ] `scripts/mac-setup.sh`, for the new cluster's kubeconfig.
- [ ] Restore `fugleramme-data` and `fugleramme-bergen-data`, see [restore a PVC](backups.md#restore-a-pvc).
- [ ] Create a new [Headlamp token](apps.md#the-login-token).
