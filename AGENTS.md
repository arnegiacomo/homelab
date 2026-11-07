# Homelab

GitOps repo for the single-node k3s cluster on the `homelab` host. Flux syncs `main`.

Issues live in Kaneo (`kaneo.home.arpa`), project `Homelab`, with IDs like `HOM-12`. Agents use the `kaneo` MCP server (`docs/apps.md#kaneo`). The PRD is `HOM-5`; it is the source of truth for decisions. Kaneo is private, so personal details can go there.

## Workflow

- Commit straight to `main`. Conventional commits with the Kaneo ID, subject line only: `feat: HOM-12 add blackbox probes`.
- Move the task to `in-progress` when you start and to `done` once it's verified live.
- Run `scripts/validate.sh` before every push. It must exit 0.
- After pushing, wait for the Flux Kustomizations to be Ready, then verify the issue's acceptance criteria on the live cluster. A green `validate.sh` alone is not done.

## Public repo

- Treat the repo as public, commits included. Write for strangers: the design, the config, what happened. Personal details go in Kaneo or to the owner in chat: addresses and place names, family, the ISP and anything outside the LAN, device identifiers such as MACs, and which logins exist or are missing.

## Docs

- `README.md` is the human entry point. Topic docs live in `docs/`, one per area: `bootstrap`, `mac-setup`, `secrets`, `networking`, `dns`, `monitoring`, `apps`, `updates`, `recovery`, `backups`, `discord`, `llm`, `frames`, `homeassistant`. Read an area's doc before changing it, and update the doc in the same commit as the behaviour.
- Anything that needs the owner (a manual step, something that expires) goes in `docs/owner-tasks.md`.

## Hand back to the owner before

Any disruptive live-host step:

- running bootstrap
- reboots
- stopping compose stacks
- wiping data
- router or Tailscale admin changes
- DNS cutover
- Home Assistant restarts, updates and changes to its add-ons (`docs/homeassistant.md`)

## Boundaries

- Homelab code lives in this repo and its issues in Kaneo, never in the `fugleramme` repo.
- The fugleramme devices (`fugleramme`, `fugleramme-kjokken`) are probe targets only: ICMP and HTTP. Never install anything on them.
- Remote frames (`docs/frames.md`) are set up only through `frames/run.sh`. Running it against a live frame is a hand-back step, since it can reboot it.

## Secrets

- Every secret lives in the 1Password `homelab` vault and reaches the cluster through an `ExternalSecret` (External Secrets Operator).
- Commit `ExternalSecret` manifests, never a `kind: Secret`. `validate.sh` fails on one.
- The only secrets outside ESO are the bootstrap ones (1Password service account token, Tailscale auth key, restic password). Bootstrap reads them on the Mac with `op`. Item names and fields: `docs/secrets.md`.

## Conventions

- Every name is `<name>.home.arpa`. Routing is Gateway API (`Gateway` plus `HTTPRoute`) on Traefik, plain HTTP, no Ingress objects.
- Expose a UI with an `HTTPRoute` in the app's namespace: `parentRefs: [{name: homelab, namespace: traefik}]`, `hostnames: [<name>.home.arpa]`, and a `backendRefs` entry for the Service. The shared `Gateway` `traefik/homelab` has one HTTP listener that admits routes from all namespaces. `infrastructure/config/flux-web.yaml` is the example.
- Put a new UI on Homepage (`home.home.arpa`) with `gethomepage.dev/*` annotations on its `HTTPRoute`, not in the Homepage config: at least `enabled: "true"`, `name`, `group`, `icon`, and `app` or `pod-selector` for the status. Details: `docs/apps.md#homepage`.
- `ExternalSecret`s use the `ClusterSecretStore` `onepassword` (vault `Homelab`), with `remoteRef.key: <item>/<field>`.
- Flux layers in `clusters/homelab/infrastructure.yaml`: `infra-crds` (Gateway API CRDs), then `infra-controllers` (`infrastructure/controllers`), then `infra-config` (`infrastructure/config`), then `infra-monitoring` (`infrastructure/monitoring`), then `infra-monitoring-config` (`infrastructure/monitoring-config`) and `infra-logs` (`infrastructure/logs`, Loki and Alloy). Anything that needs a controller's CRDs goes in a layer that `dependsOn` it.
- Apps go in `apps/<app>/`, listed in `apps/kustomization.yaml`. The Flux Kustomization `apps` (`clusters/homelab/apps.yaml`) applies them after `infra-config` and `infra-dns`.
- Monitoring: Prometheus picks up every `ServiceMonitor`, `PodMonitor`, `Probe`, `ScrapeConfig` and `PrometheusRule` in the cluster, no labels needed. Grafana loads every ConfigMap labelled `grafana_dashboard: "1"` (any namespace) as a dashboard. Hand-written dashboards use the datasource uids `prometheus` and `loki`.
- Give every Flux Kustomization path a `kustomization.yaml`. `validate.sh` builds every such directory under `clusters/`, `infrastructure/` and `apps/`.
