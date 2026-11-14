# Kitchen Pi

`kitchen` is a Raspberry Pi 4B (8 GB, SD card) on Wi-Fi with a USB mic. It runs [BirdNET-Go](https://github.com/tphakala/birdnet-go) in Docker on `:8090`, and has room for other small jobs.

It has no screen and no fugleramme of its own. The `fugleramme` instance in the cluster reads its BirdNET-Go for the public page (`apps.md#fugleramme`), and the bird digest reads it as the station `kjøkken`.

## Layout

Everything is in `~/birdnet-go` on the Pi:

- `docker-compose.yml`, a copy of `kitchen/docker-compose.yml` in this repo
- `config/`, with BirdNET-Go's `config.yaml`. Its own UI owns the file
- `data/`, with the database `birdnet.db` and the audio clips. BirdNET-Go prunes clips when the disk is 80% full

## Setting it up

1. Flash Raspberry Pi OS Lite (64-bit) with Raspberry Pi Imager: hostname `kitchen`, the Wi-Fi, and SSH with your key.
2. Give the user passwordless sudo, then install Docker:

   ```sh
   ssh kitchen.local 'curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER'
   ```

3. Restore `config/` and `data/` into `~/birdnet-go` from a backup, or start empty and add the mic under Settings -> Audio.
4. [Deploy](#deploying) the compose file.

## Deploying

After changing `kitchen/docker-compose.yml`, for example the image tag:

```sh
scp kitchen/docker-compose.yml kitchen.local:birdnet-go/
ssh kitchen.local 'cd birdnet-go && docker compose up -d'
```

Renovate opens a PR for a new image tag. Merging it changes nothing on the Pi until you deploy. Read BirdNET-Go's release notes first: a release can migrate the database.

## Getting in

`ssh kitchen.local`, or `kitchen.home.arpa` over Tailscale through `homelab`. BirdNET-Go is `http://kitchen.home.arpa:8090`.
