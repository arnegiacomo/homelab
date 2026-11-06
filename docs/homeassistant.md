# Home Assistant

Home Assistant OS on a Raspberry Pi 4, `homeassistant` at `192.168.142.3`, UI on `:8123`. Its config lives in Home Assistant, not in this repo.

## SSH

`ssh homeassistant` (host entry in the dotfiles' `~/.ssh/config`) goes to the **Advanced SSH & Web Terminal** add-on.

- User `hassio`, with passwordless sudo.
- Add-on options: `ssh.authorized_keys` has the Mac's `~/.ssh/id_ed25519.pub`, and `packages: [websocat]`.
- The shell has `/config` and the `ha` CLI.

## API

The entity, device and area registries are websocket only. `scripts/ha-ws.sh` sends one websocket command over SSH and prints the response:

```sh
scripts/ha-ws.sh '{"type":"config/entity_registry/list"}' | jq '.result[] | select(.platform=="systemmonitor")'
```

## Monitoring

- Prometheus scrapes it, see [monitoring](monitoring.md#home-assistant).
- The System Monitor integration has the CPU temperature, CPU, memory and disk sensors enabled. They feed the Home Assistant tile on Homepage.
- The model server it uses is in [llm](llm.md#home-assistant).
