# Discord webhooks

Alerts and digests post to Discord through webhooks. Each URL is the `credential` field of an `API Credential` item in the 1Password vault `Homelab`.

| Channel | Used by | 1Password item | ExternalSecret |
|---|---|---|---|
| `#alerts` | Alertmanager | `discord-alerts-webhook` | `monitoring/alertmanager-discord` |
| `#home` | home digest | `discord-home-webhook` | `digest/digest` |
| `#repos` | repo digests | `discord-repos-webhook` | `digest/digest` |
| `#birds` | bird digest | `discord-birds-webhook` | `digest/digest` |

## Create or rotate a webhook

1. In Discord, open the channel settings, then Integrations -> Webhooks -> New Webhook. When rotating, delete the old one.
2. Copy Webhook URL, and paste it into the item's `credential` field in the 1Password app.
3. ESO syncs it within an hour. To sync now:

   ```sh
   kubectl --context homelab -n <namespace> annotate externalsecret <name> force-sync=$(date +%s) --overwrite
   ```

No restart is needed.
