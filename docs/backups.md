# Backups

Every night at 03:00, restic backs up the k3s PVCs on `homelab` to a USB disk, except the ones in `monitoring`. Everything else is rebuilt from git. There is no offsite copy.

- The disk is ext4 with the label `homelab-backup`, mounted at `/mnt/homelab-backup`. Without it, `homelab` still boots and the backup fails.
- The repo is `/mnt/homelab-backup/restic`. Its password is the 1Password item `restic-password`, written to `/etc/homelab/restic-password`. Never replace it: the backups can't be read without it.
- It keeps 7 daily, 4 weekly and 6 monthly snapshots, and runs `restic check` on Sundays.
- `BackupMissing` fires when the last successful backup is over 26 hours old.
- Bootstrap sets it all up. If the disk is plugged in, it also creates the repo.

## Commands

On `homelab`, as root (`sudo -i`):

```sh
export RESTIC_REPOSITORY=/mnt/homelab-backup/restic RESTIC_PASSWORD_FILE=/etc/homelab/restic-password RESTIC_CACHE_DIR=/var/cache/restic
```

| What | Command |
|---|---|
| Back up now | `systemctl start homelab-backup` |
| Last runs | `journalctl -u homelab-backup` |
| Next run | `systemctl list-timers homelab-backup` |
| Snapshots | `restic snapshots` |
| PVCs in the latest snapshot | `restic ls latest /var/lib/rancher/k3s/storage` |
| Disk health | `smartctl -a /dev/sda` |

## Restore a PVC

Each PVC is a directory named `pvc-<uid>_<namespace>_<pvc>`. The example restores `fugleramme-bergen-data`.

1. On a rebuild, wait until Flux has started the app once. Then stop it:

   ```sh
   kubectl --context homelab -n fugleramme scale deploy/fugleramme-bergen --replicas 0
   ```

2. On `homelab`, as root with the env above:

   ```sh
   storage=/var/lib/rancher/k3s/storage
   old=$(restic ls latest "$storage" | grep '_fugleramme_fugleramme-bergen-data$')
   new=$(ls -d "$storage"/*_fugleramme_fugleramme-bergen-data)
   restic restore "latest:$old" --target "$new" --delete
   ```

   For an older snapshot, use its ID instead of `latest` in both commands. On a rebuild, pick the last snapshot from before the rebuild.

3. Start it again:

   ```sh
   kubectl --context homelab -n fugleramme scale deploy/fugleramme-bergen --replicas 1
   ```

## Restore Kaneo

Kaneo's backup is the nightly `pg_dump` in the PVC `kaneo-dump`, not its live database directory.

1. Restore the `kaneo-dump` PVC like any other, see above.
2. Load the dump into the running database:

   ```sh
   kubectl --context homelab -n kaneo scale deploy/kaneo --replicas 0
   kubectl --context homelab -n kaneo create job kaneo-restore --from=cronjob/kaneo-dump --dry-run=client -o json |
     jq '.spec.template.spec.containers[0].command = ["pg_restore", "-h", "postgres", "-U", "kaneo", "-d", "kaneo", "--clean", "--if-exists", "/dump/kaneo.dump"]' |
     kubectl --context homelab apply -f -
   kubectl --context homelab -n kaneo wait job/kaneo-restore --for=condition=complete
   kubectl --context homelab -n kaneo scale deploy/kaneo --replicas 1
   ```

## A new disk

Format it on `homelab`, then run bootstrap:

```sh
sudo mkfs.ext4 -L homelab-backup /dev/sda
```
