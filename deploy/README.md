# deploy

OpenTofu root that puts the VPS Watchdog under SubZeroDev.Infra's `modules/app`: a Cloudflare tunnel with `watchdog.subzerodev.com`, and a Portainer Git stack (`vps/docker-compose.yml` + `vps/compose.tunnel.yaml`). The QNAP `docker-compose.yml` is not used. State: R2 bucket `subzerodev-tofu-state`, key `apps/watchdog.tfstate`, encrypted. Run everything through `deploy/tofu.ps1`.

The image follows `:latest` and the watchdog updates itself, so there is no deploy job. Its config is the host file `/srv/watchdog/config.overrides.json`, untouched by any of this.

## Public endpoints

`watchdog.subzerodev.com` signs in with GitHub through the Dashboard's Supabase project: `TF_VAR_oidc_issuer` and `TF_VAR_owner_subject` give the project and the one allowed user, and the publishable key comes from `TF_VAR_supabase_publishable_key` or, failing that, `SUPABASE_PUBLISHABLE_KEY` in the Dashboard's `TF_VAR_secrets` (nothing else is read from it). The Supabase project must allow `https://watchdog.subzerodev.com/api/auth/callback` as a redirect URL. Tofu generates `JwtSecret` and `ApiKey`; every route but `/health` and `/api/auth/*` then needs a login or the `x-api-key` header. Point the Uptime Kuma webhook at `http://watchdog/restart` (both are on `proxy-net`) with the header `{"x-api-key": "<key>"}`, the key from `./deploy/tofu.ps1 output -raw api_key`.

## Image and repository cut-over

The stack points at `The-Running-Dev/SubZeroDev.DockerWatchDog` (renamed from Docker-Watchdog), so a `plan` shows the stack's repository URL change. The stack follows `main`: merging the `image:` change in `vps/docker-compose.yml` moves the VPS to `ghcr.io/the-running-dev/subzerodev-watchdog` on the next redeploy. Merge it only after the parity check.

## First adoption

1. Merge the PR that adds these files to `main`.
2. `./deploy/tofu.ps1 plan`. Expect: a tunnel, the `watchdog` record repointed, and a new stack `watchdog`.
3. Apply, check `https://watchdog.subzerodev.com`, then a second `plan` shows no changes.
