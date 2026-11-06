# Updates

Renovate, the Mend GitHub app, keeps the pinned versions up to date. Its config is `renovate.json`.

| Update | What happens |
|---|---|
| fugleramme | committed to `main` once CI is green, any time |
| other minors, patches and digests | one weekly PR, branch `renovate/weekly-updates` |
| Gateway API minors | their own weekly PR |
| k3s minors | their own weekly PR, see [k3s](#k3s) |
| majors | one weekly PR per dependency |

- Weekly means Monday between 00:00 and 06:00, Europe/Oslo.
- An update waits until its release is 3 days old. Releases without a timestamp, like those on GHCR, don't wait.
- To merge a PR, skim the release notes, check CI and merge. Flux applies it within minutes.

## Pinning

- Images are `repo:tag@sha256:<digest>`, OCI charts have a tag plus a digest, and GitHub Actions are pinned by commit SHA.
- Other versions have a `# renovate:` comment on the line above them.
- Flux checks the cosign signatures of the Flux Operator and External Secrets charts.

## Undoing an update

1. `git revert <commit>` on `main`.
2. In the same commit, add a `packageRules` entry to `renovate.json` with the dependency in `matchPackageNames` and `"allowedVersions": "<bad version"`, or the next weekly PR brings it back.
3. Run `scripts/validate.sh` and push. Flux applies the old version within minutes. Remove the rule once a fixed version is out.

Charts that migrate data or CRDs on upgrade (kube-prometheus-stack, Loki) may need fixing forward instead.

## k3s

The system-upgrade-controller upgrades k3s to the version in `infrastructure/config/k3s-upgrade.yaml`, between 00:00 and 06:00. k3s restarts, so DNS and the exit node blip for a moment.

Check the state with `kubectl -n system-upgrade get plans,jobs` and `kubectl get nodes`.

To approve a minor upgrade:

1. Read the k3s and Kubernetes release notes. Check for removed APIs, and that kube-prometheus-stack, Traefik and External Secrets support the new version.
2. Merge the PR. The upgrade runs in the next window.
3. The next morning, check `kubectl get nodes` and `flux get all -A`.

Upgrade one minor at a time.

Rolling back:

- If the upgrade Job fails before k3s restarts, revert the version in `k3s-upgrade.yaml`.
- If k3s runs but something breaks, fix forward.
- If k3s doesn't start, install the old version on the host with `curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION=<old> sh -` and revert the version in git. If that fails, [rebuild](bootstrap.md#rebuilding-from-scratch).

## Elsewhere

- Host packages: [automatic security updates](bootstrap.md#automatic-security-updates).
- Model server: [updates](llm.md#updates).
