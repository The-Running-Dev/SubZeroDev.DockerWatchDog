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

export ApiKey=compose-test-key
"${auth_compose[@]}" config --format json |
  jq -e '.services.watchdog | .environment.ApiKey == "compose-test-key" and (.environment | has("SupabaseUrl") | not) and ((.ports // []) | length == 0) and (.networks | has("proxy-net"))' >/dev/null

github_compose=("${auth_compose[@]}" -f compose.github-login.yaml)
export SupabaseUrl=https://project.supabase.co/auth/v1
export SupabasePublishableKey=sb_publishable_test
export AllowedUserIds=6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b
export JwtSecret=compose-test-secret

for name in SupabaseUrl SupabasePublishableKey AllowedUserIds JwtSecret; do
  if output=$(env "$name=" "${github_compose[@]}" config --quiet 2>&1); then
    echo "GitHub sign-in Compose rendered without $name" >&2
    exit 1
  fi
  if [[ "$output" != *"Set $name before enabling GitHub sign-in"* ]]; then
    printf '%s\n' "$output" >&2
    exit 1
  fi
done

"${github_compose[@]}" config --format json |
  jq -e '.services.watchdog.environment | .ApiKey == "compose-test-key" and .JwtSecret == "compose-test-secret" and .PublicUrl == "https://watchdog.subzerodev.com"' >/dev/null
