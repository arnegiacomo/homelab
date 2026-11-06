# Homelab

A single-node k3s cluster on a Raspberry Pi 5, `homelab`. Flux keeps it in sync with `main`. Everything after bootstrap lives in this repo.

## Hosts

| Host | IP | What |
|---|---|---|
| router | 192.168.142.1 | AmpliFi. DHCP, hands out DNS `192.168.142.2, 1.1.1.1` |
| homelab | 192.168.142.2 | Raspberry Pi 5, k3s |
| homeassistant | 192.168.142.3 | Home Assistant OS, `:8123` |
| llm | 192.168.142.4 | MacBook Pro model server, Ollama `:11434` |
| fugleramme | 192.168.142.5 | Bird frame: app `:8080`, BirdNET-Go `:8090` |
| fugleramme-kjokken | 192.168.142.6 | Bird frame: app `:8080`, BirdNET-Go `:8090` |

## URLs

The `home.arpa` names work at home and over Tailscale.

| URL | What |
|---|---|
| http://home.home.arpa | Homepage, the overview |
| http://grafana.home.arpa | Grafana |
| http://pihole.home.arpa/admin/ | Pi-hole |
| http://flux.home.arpa | Flux web UI |
| http://headlamp.home.arpa | Headlamp, read-only cluster map |
| http://kaneo.home.arpa | Kaneo, the issue tracker |
| http://homeassistant.home.arpa:8123 | Home Assistant |
| http://fugleramme-pi5.home.arpa/admin, http://fugleramme-bergen.home.arpa/admin | fugleramme admin |
| https://fugleramme.arnegiacomo.dev, https://fugleramme-bergen.arnegiacomo.dev | fugleramme, public |
| https://status.arnegiacomo.dev | Status endpoint |

## Commands

```sh
bootstrap/wizard.sh                 # store the bootstrap secrets in 1Password
bootstrap/run.sh pi@homelab.local   # bootstrap the host
scripts/mac-setup.sh                # set up the Mac to reach the cluster
llm/run.sh                          # set up or update the model server
frames/run.sh <ssh-target> <name>   # set up or update a remote frame
scripts/op-items.sh                 # create the generated 1Password items
scripts/validate.sh                 # validate the repo, before every push
scripts/ha-ws.sh '<json>'           # send one command to Home Assistant's websocket API

kubectl --context homelab get nodes
k9s --context homelab
flux --context homelab get all -A
```

All the setup scripts are safe to run again. `validate.sh` needs kustomize, kubeconform, shellcheck and gitleaks. CI runs it on every push and pull request.

## Layout

| Path | Contents |
|---|---|
| `bootstrap/` | Turns a fresh Pi OS or Debian host into the cluster |
| `clusters/homelab/` | Flux entrypoint |
| `infrastructure/` | Controllers and their config |
| `apps/` | Apps |
| `llm/` | Model server setup |
| `frames/` | Remote frame setup |
| `scripts/` | Repo tooling |
| `docs/` | Docs |

## Docs

- [Owner tasks](docs/owner-tasks.md): what needs a human, and what expires
- [Bootstrap](docs/bootstrap.md): setting up and rebuilding the host
- [Mac setup](docs/mac-setup.md)
- [Secrets](docs/secrets.md)
- [Networking](docs/networking.md)
- [DNS](docs/dns.md)
- [Monitoring](docs/monitoring.md)
- [Discord webhooks](docs/discord.md)
- [Apps](docs/apps.md)
- [Updates](docs/updates.md)
- [Backups](docs/backups.md)
- [Recovery](docs/recovery.md)
- [Model server](docs/llm.md)
- [Remote frames](docs/frames.md)
- [Home Assistant](docs/homeassistant.md)
