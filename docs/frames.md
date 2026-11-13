# Remote frames

A remote frame is a Raspberry Pi with fugleramme, BirdNET-Go and a mic at someone else's place, showing the collage on their TV. It uploads to a BirdWeather station, and a fugleramme instance in the cluster reads that station for the public page. Tailscale is only for support and the Homepage tiles.

| Frame | Pi | Public page |
|---|---|---|
| `tromso` | `fugleramme-tromso-pi` | `fugleramme-tromso.arnegiacomo.dev` |

`frames/run.sh` sets up the Pi. The cluster side is added by hand per frame:

- a Pi-hole record `fugleramme-<name>.home.arpa` pointing at the Pi's Tailscale IP, in `infrastructure/dns/pihole.yaml`. Homepage reaches it through `homelab`
- a nested group with a Kiosk and a BirdNET-Go tile under `Frames` in `apps/homepage/config/services.yaml`, and its name under `Frames` in `settings.yaml`
- a fugleramme instance, tunnel rule and public DNS record (`apps.md#fugleramme`)

## Once per tailnet

In the Tailscale admin:

1. Add the tag to the access controls, so tagged frames reach nothing and your own devices reach them. This replaces the default allow-all rule:

   ```json
   "tagOwners": {
     "tag:fugleramme-remote": ["autogroup:admin"]
   },
   "grants": [
     {"src": ["autogroup:member"], "dst": ["*"], "ip": ["*"]}
   ]
   ```

2. Settings -> Trust credentials: create an OAuth client with the `auth_keys` write scope and the tag `tag:fugleramme-remote`. Store the secret in 1Password as `tailscale-frames`, field `credential`.

## A new frame

1. `frames/item.sh <name>` asks for the frame's values and stores them in the 1Password item `fugleramme-<name>`.
2. Flash Raspberry Pi OS Lite (64-bit) with Raspberry Pi Imager: hostname `fugleramme-<name>-pi`, the username and SSH password from the item, their Wi-Fi, and SSH with password login.
3. Boot it on Ethernet at home and run `frames/run.sh <user>@fugleramme-<name>-pi.local <name>`. The first run reboots the Pi. Run it again: every step should print `ok`.
4. In BirdNET-Go (`http://fugleramme-<name>-pi.local:8090`), add the mic under Settings -> Audio.
5. `frames/note.sh <name> | pbcopy` copies a note for the frame's owner, in Norwegian, with the addresses and passwords.

## What `frames/run.sh` sets up

- passwordless sudo for the user
- Tailscale, logged in with the OAuth client and tagged `tag:fugleramme-remote`
- fugleramme at the latest release, with BirdNET-Go on `:8090` and the frame on `:8080`
- BirdNET-Go's `config.yaml` and fugleramme's `settings.json`, only when missing. After that, their own UIs own them
- the HDMI kiosk, `cage` with `chromium`, as a systemd unit
- quiet boot, and USB gadget mode for SSH over the USB-C cable

## Getting in

`ssh <user>@fugleramme-<name>-pi` over Tailscale, or `.local` on their network. The web UIs are `:8080/admin` and `:8090`.
