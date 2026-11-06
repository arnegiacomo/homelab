# Monitoring

Everything runs in the `monitoring` namespace. Grafana is at `grafana.home.arpa`, with the login from the 1Password item `grafana-admin`. Alerts go to Discord.

## Metrics and dashboards

- kube-prometheus-stack (`infrastructure/monitoring`): Prometheus, Alertmanager, Grafana, node-exporter and kube-state-metrics.
- Prometheus keeps 30 days, up to 18 GB.
- Prometheus picks up every `ServiceMonitor`, `PodMonitor`, `Probe`, `ScrapeConfig` and `PrometheusRule` in the cluster.
- Dashboards are ConfigMaps labelled `grafana_dashboard: "1"`. Change them in git; UI edits aren't saved.
- The homelab's own dashboards are in `infrastructure/monitoring-config`: `Homelab node`, `Homelab uptime`, `Home Assistant` and `Flux Performance`.

After changing the Grafana password in 1Password, reset it:

```sh
op read op://Homelab/grafana-admin/password | kubectl --context homelab -n monitoring exec -i deploy/kube-prometheus-stack-grafana -c grafana -- grafana cli admin reset-admin-password --password-from-stdin
```

## Uptime probes

The blackbox exporter probes every 30 seconds. The probes are in `infrastructure/monitoring-config/probes.yaml`.

| Job | Targets |
|---|---|
| `icmp` | router, homeassistant, fugleramme, fugleramme-kjokken |
| `http-lan` | Home Assistant `:8123`, Ollama `:11434/api/version`, the frames' `:8080/health` and `:8090` |
| `http-cluster` | the cluster UIs |
| `http-public` | the public fugleramme pages and `status.arnegiacomo.dev` |
| `wyoming` | Whisper `:10300` and Piper `:10200` on the model server |
| `dns-home-arpa` | Pi-hole answers `homelab.home.arpa` |
| `dns-external` | Pi-hole answers `example.com` |

To add a target, add it to the matching `Probe`. A new device by IP also needs a `device` relabel rule in that `Probe`.

## Logs

Loki and Alloy (`infrastructure/logs`), with the Grafana datasource `Loki`. Retention is 30 days.

- Pod logs, labelled `namespace`, `pod`, `container`, `app` and `stream`.
- The host's journal, labelled `job="journal"`, `unit`, `priority`, `hostname` and `transport`. Kernel messages: `{job="journal", transport="kernel"}`.

## Alerts

Alertmanager posts to `#alerts` on Discord, see [Discord](discord.md). Its config is `alertmanager.config` in `kube-prometheus-stack.yaml`. The homelab rules, on top of the chart's, are in `infrastructure/monitoring-config/alerts.yaml`:

| Alert | Fires when |
|---|---|
| `NodeDiskUsageHigh` | `/` is over 85% full for 15m |
| `NodeTemperatureHigh` | the SoC is over 75C for 10m |
| `RebootRequired` | a reboot has been pending for 2 days |
| `BackupMissing` | the last successful backup is over 26h old |
| `ProbeFailed` | a probe fails for 5m |
| `PiholeDown` | both DNS probes fail for 2m |
| `BlackboxExporterDown` | probe scrapes fail for 5m |
| `CertificateExpiringSoon` | a public certificate expires within 14 days |
| `FluxResourceNotReady` | a Kustomization or HelmRelease is not Ready for 15m |
| `K3sUpgradeJobFailed` | a k3s upgrade Job failed |

To send a test alert:

```sh
kubectl --context homelab -n monitoring port-forward svc/kube-prometheus-stack-alertmanager 9093
curl -XPOST localhost:9093/api/v2/alerts -H 'Content-Type: application/json' -d "[{\"labels\":{\"alertname\":\"TestAlert\"},\"annotations\":{\"summary\":\"Test alert\"},\"endsAt\":\"$(date -u -v+2M +%Y-%m-%dT%H:%M:%SZ)\"}]"
```

## Home Assistant

- The `ScrapeConfig` `homeassistant` scrapes `192.168.142.3:8123/api/prometheus` every 60 seconds. Metrics start with `hass_`.
- Home Assistant needs `prometheus:` with `namespace: hass` in its `configuration.yaml`.
- The token is the long-lived access token `homelab-prometheus` in Home Assistant, stored in the 1Password item `homeassistant-token`. To rotate it, create a new token, replace `credential`, and delete the old token.

## Model server

The `ScrapeConfig` `llm` scrapes node_exporter on `192.168.142.4:9100`, and the `http-lan` probe checks Ollama. macOS updates restart the Mac, which can briefly fire `ProbeFailed` and `TargetDown`.
