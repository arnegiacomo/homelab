# Mac setup

`scripts/mac-setup.sh` sets up the Mac to manage the cluster. It's safe to run again.

```sh
brew bundle --file ~/dotfiles/Brewfile   # kubectl, k9s, shellcheck
scripts/mac-setup.sh
```

`op` needs 1Password -> Settings -> Developer -> Integrate with 1Password CLI.

It:

1. Checks for kubectl, k9s and shellcheck. `/opt/homebrew/bin` has to come before `/usr/local/bin` on PATH, since OrbStack links an older kubectl there.
2. Installs flux, flux-operator, kustomize, kubeconform, gitleaks and the 1Password CLI with brew.
3. Starts the Tailscale app.
4. Copies the k3s kubeconfig from `homelab` over SSH into `~/.kube/config`, as two contexts. The old file is kept as `~/.kube/config.bak`.
   - `homelab`: `https://homelab:6443`, over Tailscale
   - `homelab-lan`: `https://homelab.local:6443`, on the home network
5. Checks that at least one of them answers.

Overrides: `SSH_TARGET` (default `pi@homelab.local`), `API_SERVER` and `LAN_API_SERVER`.
