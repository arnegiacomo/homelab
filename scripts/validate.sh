#!/usr/bin/env bash
# Validates the repo. Run before every push; CI runs it on every push to main.
set -euo pipefail

cd "$(dirname "$0")/.."

crd_catalog='https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'

echo "==> no plain Secrets"
# Only top-level kinds (column 0), so references like `valuesFrom: - kind: Secret` pass.
if grep -rlE --include='*.yaml' --include='*.yml' --exclude-dir=.git \
  "^kind:[[:space:]]*[\"']?Secret[\"']?[[:space:]]*$" .; then
  echo "plain Secret manifests found; use an ExternalSecret instead" >&2
  exit 1
fi

echo "==> gitleaks"
# Scans every commit, not just the tree, so a secret added and removed again is still caught before a push.
gitleaks git --redact --no-banner .

echo "==> shellcheck"
find . -name '*.sh' -not -path './.git/*' -exec shellcheck {} +

echo "==> kustomize build | kubeconform"
# Every dir with a kustomization.yaml, so new Flux Kustomization paths are picked up without editing this script.
# Core kinds always have a schema, so -ignore-missing-schemas only skips CRDs missing from the catalog.
find clusters infrastructure apps -name kustomization.yaml | sort | while read -r file; do
  dir=$(dirname "$file")
  echo "--> $dir"
  kustomize build "$dir" | kubeconform -strict -summary -ignore-missing-schemas \
    -schema-location default -schema-location "$crd_catalog"
done
