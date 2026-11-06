# Apps

Everything in `apps/`, applied by the Flux Kustomization `apps`.

## fugleramme

Two instances of [fugleramme](https://github.com/arnegiacomo/fugleramme) in the `fugleramme` namespace:

| Instance | Local | Public | Reads from |
|---|---|---|---|
| `fugleramme` | `fugleramme-pi5.home.arpa` | `fugleramme.arnegiacomo.dev` | BirdNET-Go on `fugleramme-kjokken` |
| `fugleramme-bergen` | `fugleramme-bergen.home.arpa` | `fugleramme-bergen.arnegiacomo.dev` | the five BirdWeather stations nearest Bergen |

- Each keeps `/data`, including `settings.json`, on its own PVC. The admin UI is `/admin` on the local name.
- `cloudflared` runs the tunnel for the public hosts and `status.arnegiacomo.dev`, with the config in `apps/fugleramme/cloudflared-config.yml`. Only the page and its assets are public. The credentials are in the 1Password item `fugleramme-tunnel`.
- `/admin` on the public hosts redirects to the fugleramme docs. That's a Cloudflare redirect rule, not in git.
- A new public host needs an ingress rule in `cloudflared-config.yml` and a proxied CNAME to `<tunnel>.cfargotunnel.com` in Cloudflare DNS, with the `tunnel:` ID from that file.

## Status endpoint

`https://status.arnegiacomo.dev` answers `ok`. UptimeRobot checks it every 5 minutes from outside, which covers the homelab being down as a whole. The path is Cloudflare, the tunnel, Traefik, then an nginx pod (`apps/status`). See [recovery](recovery.md#homelab-unreachable-from-the-internet).

## Homepage

The overview at `home.home.arpa`, with its config in `apps/homepage/config`.

- Cluster UIs show up from the `gethomepage.dev/*` annotations on their `HTTPRoute`.
- Devices off the cluster and the public pages are in `config/services.yaml`. The group order and columns are in `settings.yaml`.
- Widget credentials come from the ExternalSecret `homepage` as `HOMEPAGE_VAR_*`.

## Digests

The `digest` app (`apps/digest`) writes daily summaries with the local model on the [model server](llm.md) and posts them to Discord. Each digest is a CronJob that runs a TypeScript file from `src/` with Bun.

| CronJob | When | Channel | Content |
|---|---|---|---|
| `home-digest` | 07:00 | `#home` | Yesterday's commits, alerts, outages and peaks, and today's weather |
| `fugleramme-digest` | 07:05 | `#repos` | What needs a reply, activity and numbers for `arnegiacomo/fugleramme` |
| `bird-digest` | 07:10 | `#birds` | In Norwegian: yesterday's birds on both frames, newcomers and a bird of the day, with a collage |

- If Ollama or a source is down, the job fails without posting, and `KubeJobFailed` fires.
- Homepage shows the home and bird digests as tiles, from the ConfigMap `digest-latest`.
- State between runs is in the ConfigMap `digest-state`.
- To add a digest, write `src/<name>.ts`, add it to `digest-code` in `kustomization.yaml`, and add a CronJob to `digests.yaml` with the container named `digest`.
- To watch another repo, copy the `fugleramme-digest` CronJob and give the GitHub token access to the repo.
- `DRY_RUN=1` prints instead of posting.

To run one now and follow it:

```sh
kubectl --context homelab -n digest create job --from=cronjob/home-digest home-digest-manual
kubectl --context homelab -n digest logs -f job/home-digest-manual
```

## Headlamp

A read-only cluster map with the Flux plugin, at `headlamp.home.arpa`. You log in with a token for the ServiceAccount `headlamp-viewer`, which can read everything except Secrets and write nothing.

### The login token

The token lasts a year and lives in the 1Password item `headlamp-token`. To create it:

```sh
kubectl --context homelab -n headlamp create token headlamp-viewer --duration=8760h | pbcopy
```

Paste it into `headlamp-token` in 1Password, then into Headlamp's login page.

To revoke every token, delete the ServiceAccount. Flux puts it back, and you create a new token as above:

```sh
kubectl --context homelab -n headlamp delete serviceaccount headlamp-viewer
flux --context homelab reconcile kustomization apps
```
