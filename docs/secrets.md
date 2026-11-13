# Secrets

Every secret lives in the 1Password vault `Homelab`. The cluster reads them through External Secrets Operator, with `ExternalSecret`s on the `onepassword` ClusterSecretStore. The repo never holds a plain `Secret`; `scripts/validate.sh` fails on one.

What expires is in [owner tasks](owner-tasks.md#things-that-expire).

## Bootstrap secrets

`bootstrap/run.sh` reads these on the Mac. `bootstrap/wizard.sh` creates the first two, `scripts/op-items.sh` the restic password.

| 1Password reference | What |
|---|---|
| `op://homelab/onepassword-service-account/credential` | 1Password service account for ESO, read-only on `Homelab` |
| `op://homelab/tailscale-auth-key/credential` | Single-use Tailscale auth key |
| `op://homelab/restic-password/password` | Password of the backup repo. Never replace it |

## Cluster secrets

`scripts/op-items.sh` creates `pihole-admin`, `grafana-admin`, `kaneo-postgres` and `kaneo-auth-secret` with generated values. The rest are created by hand.

| Item | Fields | What |
|---|---|---|
| `pihole-admin` | `password` | Pi-hole web and API |
| `grafana-admin` | `username`, `password` | Grafana admin |
| `fugleramme-tunnel` | `credential` | Cloudflare tunnel credentials JSON |
| `homeassistant-token` | `credential` | Home Assistant token for Prometheus |
| `discord-*-webhook` | `credential` | Discord webhooks, see [Discord](discord.md) |
| `github-digest-token` | `credential` | GitHub token for the [digests](apps.md#digests), read-only on `homelab` and `fugleramme`. Public repos, such as `fugleramme/clients`, are readable without being listed |
| `headlamp-token` | `credential` | Headlamp login, see [Headlamp](apps.md#the-login-token) |
| `kaneo-postgres` | `password` | Kaneo database password |
| `kaneo-auth-secret` | `password` | Kaneo session signing key |

## Model server and frames

| 1Password reference | What |
|---|---|
| `op://homelab/llm-admin/password` | Admin user `llm` on the model server. Created by `scripts/op-items.sh` |
| `op://homelab/tailscale-frames/credential` | Tailscale OAuth client that logs frames in |
| `op://homelab/fugleramme-<name>/...` | One item per frame, created by `frames/item.sh` |
