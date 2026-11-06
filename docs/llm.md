# Model server

A headless MacBook Pro (M1 Max, 32 GB), `llm` at `192.168.142.4`. It runs Ollama for Home Assistant and the digests, and Whisper and Piper for Home Assistant's voice. It isn't part of k3s.

| Service | Address |
|---|---|
| Ollama | `http://192.168.142.4:11434`, OpenAI API under `/v1`. No auth |
| Whisper, speech to text | `:10300`, Wyoming protocol. No auth |
| Piper, text to speech | `:10200`, Wyoming protocol. No auth |
| node_exporter | `:9100` |
| SSH | `ssh llm@192.168.142.4`, password in the 1Password item `llm-admin` |
| Screen Sharing | `vnc://192.168.142.4` |

## Setup

```sh
llm/run.sh   # target llm@192.168.142.4, or pass another
```

It's safe to run again and doesn't reboot the Mac. It:

- sets the DNS servers to `192.168.142.2, 1.1.1.1`
- installs Homebrew, `ollama`, `node_exporter` and `uv`, and upgrades them on later runs
- turns off sleep, also with the lid closed, and turns on wake on network and automatic macOS updates
- runs node_exporter, Ollama, Whisper and Piper as LaunchDaemons (`homelab.*`), so they start at boot without a login. Logs are in `~/Library/Logs/`
- pulls and loads the model

## Settings

In `llm/setup.sh`:

| Setting | Value |
|---|---|
| `OLLAMA_MODEL` | `gemma4:26b-a4b-it-qat` |
| `OLLAMA_CONTEXT_LENGTH` | `16384`, the same as Home Assistant's context window |
| `OLLAMA_KEEP_ALIVE` | `-1`, keep the model loaded |
| `OLLAMA_NUM_PARALLEL` | `1` |
| `WHISPER_MODEL` | `small.en` |
| `PIPER_VOICE` | `en_US-lessac-medium` |

`ssh llm@192.168.142.4 /opt/homebrew/bin/ollama ps` shows what's loaded.

## Home Assistant

In the Home Assistant UI, using the IP, not `llm.home.arpa`:

1. Add the **Ollama** integration, URL `http://192.168.142.4:11434`.
2. Add a conversation agent on it: model `gemma4:26b-a4b-it-qat`, control Home Assistant with **Assist**, context window `16384`, keep alive `-1`, thinking off.
3. Add the **Wyoming Protocol** integration twice: `192.168.142.4` port `10300` (Whisper) and port `10200` (Piper).
4. Settings -> Voice assistants -> add `Local`: language English, the Ollama agent, **Prefer handling commands locally** on, speech-to-text faster-whisper, text-to-speech piper with `en_US-lessac-medium`. Make it the preferred assistant.
5. Settings -> Voice assistants -> Expose: expose fewer than 25 entities, only what you talk about.

When a device action fails, Settings -> System -> Logs says why.

## Updates

- Ollama and node_exporter: `llm/run.sh`.
- Whisper and Piper: change `WHISPER_VERSION` or `PIPER_VERSION` in `llm/setup.sh`, then `llm/run.sh`.
- macOS updates install on their own. Major upgrades are installed by hand over Screen Sharing, then `llm/run.sh`.

## Rebuilding from scratch

You need an HDMI display, a USB keyboard and mouse, and the USB-C Ethernet dongle.

- [ ] Sign out of the Apple Account first, or Activation Lock asks for it after the erase.
- [ ] Check that `llm-admin` is in 1Password (`scripts/op-items.sh` creates it).
- [ ] System Settings -> General -> Transfer or Reset -> Erase All Content and Settings.
- [ ] Plug in the Ethernet dongle.
- [ ] Setup Assistant: no Apple Account, account name `llm` with the password from `llm-admin`, FileVault off, Location Services off, time zone Oslo.
- [ ] System Settings -> General -> Sharing: computer name `llm`, Remote Login on with full disk access, Screen Sharing on.
- [ ] System Settings -> Network -> the USB LAN -> TCP/IP: manual, `192.168.142.4`, mask `255.255.255.0`, router `192.168.142.1`. A new dongle also needs a new reservation on the router.
- [ ] From your Mac: `ssh-keygen -R 192.168.142.4`, then `ssh-copy-id -i ~/.ssh/id_ed25519.pub llm@192.168.142.4`.
- [ ] Turn off Wi-Fi: `ssh -t llm@192.168.142.4 'sudo networksetup -setairportpower en0 off'`.
- [ ] `llm/run.sh`.
- [ ] Unplug the display and keyboard, close the lid, and check that `ssh llm@192.168.142.4 hostname` answers.
