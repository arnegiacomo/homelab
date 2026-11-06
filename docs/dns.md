# DNS

Pi-hole and unbound run in the `dns` namespace (`infrastructure/dns`). Pi-hole answers on port 53 on `192.168.142.2` and `100.91.36.35`, and forwards to unbound, which resolves from the root servers with DNSSEC.

- UI: `pihole.home.arpa`, with the password from the 1Password item `pihole-admin`.
- Local records: `FTLCONF_dns_hosts` in `infrastructure/dns/pihole.yaml`, one `<ip> <name>.home.arpa` per line.
- Other settings: `FTLCONF_*` env in the same file.
- Blocklists: `infrastructure/dns/adlists.list`, one URL per line.
- Pods resolve `home.arpa` through CoreDNS, which forwards it to Pi-hole (ConfigMap `coredns-custom` in `kube-system`).
- The host itself uses `1.1.1.1` and `1.0.0.1`.

When DNS is down, see [recovery](recovery.md).

## Git is the source of truth

Pi-hole resets to the repo on every start (`infrastructure/dns/pihole-start.sh`). Settings, lists and allow or deny entries changed in the UI are gone after the next restart, so change them in git.

The gravity database and the query log are on the PVC `pihole-ftl-db`, so blocking works right after a restart, also without internet.

## The 1.1.1.1 fallback

Clients get `1.1.1.1` as their second DNS server, so DNS keeps working when Pi-hole is down. Some lookups go there anyway, so a few ads get through.

The HaGeZi Encrypted DNS Bypass list stops Chrome from switching to encrypted DNS. It also blocks encrypted DNS set up by name on purpose, like Firefox DoH or Android Private DNS.
