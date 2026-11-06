# Networking

The LAN is `192.168.142.0/24`. The hosts are in the [README](../README.md#hosts).

## Tailscale

- `homelab` is a subnet router for `192.168.142.0/24`, an exit node, and the nameserver for `home.arpa`. Its Tailscale IP is `100.91.36.35`.
- The tailnet's global nameservers are `100.91.36.35` and `1.1.1.1`, set in the Tailscale admin.
- The subnet route and exit node are approved in the Tailscale admin, and `homelab` has key expiry disabled.

## Names

Every local name is `<name>.home.arpa`, answered by Pi-hole (see [DNS](dns.md)).

- Cluster UIs, all on `192.168.142.2`: `home`, `grafana`, `pihole`, `flux`, `headlamp`, `fugleramme-pi5`, `fugleramme-bergen`
- Devices: `homelab`, `homeassistant`, `llm`, `fugleramme`, `fugleramme-kjokken`

Traefik serves the cluster UIs over plain HTTP.
