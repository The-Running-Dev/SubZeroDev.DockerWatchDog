#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "$0")"
export TUNNEL_TOKEN=compose-test-token
unset ApiKey

compose=(docker compose --env-file /dev/null -f docker-compose.yml -f compose.tunnel.yaml)
auth_compose=("${compose[@]}" -f compose.auth.yaml)

# Existing stacks using only the base files can still render without an environment key.
"${compose[@]}" config --format json |
  jq -e '.services.watchdog.environment | has("ApiKey") | not' >/dev/null

check_missing_key() {
  local output
  if output=$("${auth_compose[@]}" config --quiet 2>&1); then
    echo "Provisioned Compose rendered without a Watchdog API key" >&2
    exit 1
  fi
  if [[ "$output" != *"Set ApiKey before deploying the VPS Watchdog"* ]]; then
    printf '%s\n' "$output" >&2
    exit 1
  fi
}

check_missing_key
ApiKey='' check_missing_key

ApiKey=compose-test-key "${auth_compose[@]}" config --format json |
  jq -e '.services.watchdog | .environment.ApiKey == "compose-test-key" and ((.ports // []) | length == 0) and (.networks | has("proxy-net"))' >/dev/null
