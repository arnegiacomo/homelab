# Owner tasks

Everything that needs a human. The rest runs on its own.

## Open

- [ ] Disaster-recovery drill: rebuild `homelab` from scratch and restore from the backups, see [bootstrap](bootstrap.md#rebuilding-from-scratch).

## When it comes up

- **Renovate PR:** review and merge, or close. See [updates](updates.md).
- **Discord alert:** each alert says what to look at. Homepage, Grafana and Headlamp show the state.
- **UptimeRobot email:** see [recovery](recovery.md#homelab-unreachable-from-the-internet).
- **`BackupMissing`:** check that the backup disk is plugged in, and `journalctl -u homelab-backup` on `homelab`.
- **`RebootRequired`:** the automatic reboot isn't working. Check `/var/log/unattended-upgrades/` and reboot by hand.
- **After a power cut:** nothing, everything starts on its own.

## Now and then

- On `homelab`: `sudo apt full-upgrade`, and reboot if it installed a kernel. The kernel, firmware, Debian point releases and Tailscale don't update on their own. The `Homelab node` dashboard shows pending updates.
- `llm/run.sh`, to upgrade Ollama and node_exporter on the model server.
- Major macOS upgrades on `llm`, by hand over Screen Sharing, then `llm/run.sh`.

## Things that expire

| What | When | What to do |
|---|---|---|
| GitHub digest token (`github-digest-token`) | The expiry picked when created | Regenerate `homelab-digest` under GitHub's fine-grained tokens and put it in 1Password. Until then the digests fail. |
| Headlamp token | 1 year | See [Headlamp](apps.md#the-login-token). |
| Tailscale keys on the Mac and phone | The tailnet's key expiry | Log in again when asked. |
| Home Assistant token (`homeassistant-token`) | 10 years | New long-lived token in Home Assistant, put it in 1Password. |
| Discord webhooks, Cloudflare tunnel credentials, 1Password service account, Tailscale OAuth client | Never | Rotate only if leaked. |
| Restic password (`restic-password`) | Never | Never replace it: the backups can't be read without it. |
