# Recovery

To rebuild the host, see [bootstrap](bootstrap.md#rebuilding-from-scratch). To restore app data, see [backups](backups.md#restore-a-pvc).

## DNS down

Clients fall back to `1.1.1.1` on their own, on the WiFi and on the tailnet. As a last resort, change the DNS in the AmpliFi app.

## Pi-hole broken

Pi-hole rebuilds from git on every start, so a restart fixes most things:

```sh
kubectl --context homelab -n dns logs deploy/pihole
kubectl --context homelab -n dns rollout restart deploy/pihole
```

While it's down, `home.arpa` names don't resolve, but the internet works.

## Homelab unreachable from the internet

UptimeRobot checks the [status endpoint](apps.md#status-endpoint) from outside. If Discord is quiet too, the homelab is probably down as a whole: check power and network, then `ssh pi@homelab`.

| Response | Cause |
|---|---|
| none, or Cloudflare error 530 / 1033 | the tunnel is down: power, network, internet, k3s or cloudflared |
| 502 | cloudflared can't reach Traefik |
| 404 | the `status` HTTPRoute is missing |
| 503 | no ready `status` pod |
