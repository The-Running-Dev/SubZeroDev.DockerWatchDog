# VPS Watchdog deployment

This OpenTofu root manages the `watchdog.subzerodev.com` tunnel and the Portainer Git stack through SubZeroDev.Infra `modules/app`. The managed stack uses `vps/docker-compose.yml` with separate tunnel, API-key and GitHub sign-in overlays. The root `docker-compose.yml` is for QNAP. The API-key overlay requires a nonempty `ApiKey` so a missing stack value fails rendering before it can override file-based auth. Existing stacks using the base files retain their configuration until the overlay is applied.

The image follows `:latest` and Watchdog can update itself. There is no deploy job. Record the actual image digest before an approved cutover. The host file `/srv/watchdog/config.overrides.json` remains mounted. The stack key takes precedence over any `ApiKey` in that file. OpenTofu stores encrypted state in R2 under `apps/watchdog.tfstate`. Run it through `./deploy/tofu.ps1`.

## Prepare the Kuma cutover

1. Record the running image digest, current Watchdog auth status, Kuma version, notification fields and monitor assignments. Check which other machine callers use Watchdog, including CI jobs calling `/restart-project`. Inspect only the necessary Docker fields to avoid exposing environment secrets.
2. From the Kuma container, confirm `watchdog` resolves on `proxy-net`, port 80 is reachable and `http://watchdog/health` returns Watchdog JSON. Verify both containers are on a trusted Docker network and Watchdog has no host port published. The internal HTTP request carries the key without TLS. The public hostname goes through Cloudflare Access, which does not accept Watchdog's API key as an Access credential.
3. Reuse the active Watchdog key if available, or generate a new strong key in the owner's secret manager, such as 48 random alphanumeric characters. Make it available as the sensitive `TF_VAR_watchdog_api_key` input in the owner environment and transfer it privately to Kuma. Key generation is independent of OpenTofu apply. Keep it out of command history, logs, screenshots and tracked configuration. Treat it and Kuma backups as privileged because the key grants access to protected Watchdog routes beyond `/restart`.
4. Show the owner the redacted notification diff, affected callers, stack plan, validation target and rollback. Obtain explicit approval before saving production settings or deploying. Stage the Kuma notification and other callers before activating the new key. If an existing key is being rotated, coordinate a maintenance window because the application accepts one key at a time.

| Kuma field | Value |
| --- | --- |
| Notification type | Webhook |
| Method and body | POST, standard `application/json` Kuma payload |
| URL | `http://watchdog/restart` |
| Additional Headers | `{"x-api-key":"<watchdog-api-key>"}` |
| Monitor description | `container-<exact-Docker-container-name>` |

Preserve existing notification assignments. The public URL and the port/network configuration do not need to change for this rollout. Keep browser identity changes separate from service authentication.

## Prepare GitHub sign-in

The managed deployment adds `vps/compose.github-login.yaml` for browser sign-in. Confirm the intended Supabase project, supply its Auth URL through `TF_VAR_oidc_issuer` and the allowed Supabase user ID through `TF_VAR_owner_subject`. Set `TF_VAR_supabase_publishable_key` or supply the project's `SUPABASE_PUBLISHABLE_KEY` through the Dashboard's `TF_VAR_secrets`. Ensure the issuer and key refer to the same project and add `https://watchdog.subzerodev.com/api/auth/callback` to its redirect allowlist.

OpenTofu generates a persistent `JwtSecret` for browser sessions. Reuse the staged `TF_VAR_watchdog_api_key` for Kuma and CI. Existing stacks with just the base files or API-key overlay can continue to render until OpenTofu applies the browser sign-in overlay.

## Apply and verify after approval

1. Review `./deploy/tofu.ps1 plan` with the staged key and GitHub sign-in settings available in the owner environment. For an existing stack, check which overlays and environment values change. For first adoption, also review the planned tunnel, DNS and Portainer stack resources. Use an approved apply once the callers are ready.
2. Use Kuma's notification test. A standard test payload has null monitor and heartbeat and returns `200 {"status":"healthy"}` without restarting a container. Verify the Watchdog response through the internal route. Kuma's generic success message and `/health` alone do not prove authenticated delivery or a real restart. An uncredentialed notification-test payload must return 401 after activation.
3. Use an approved disposable container and monitor for a real down event. Correlate the notification, the Watchdog log for source `uptime-kuma`, one Docker restart, a changed container `StartedAt` and service recovery. Check that recovery and an uncredentialed request do not restart that target. Verify other machine callers and browser access separately.
4. In an isolated fixture, confirm that Kuma surfaces wrong-key, unreachable endpoint, missing target and Docker command failures. Record observed timeout and retry behavior. Keep sanitized evidence of the revision, status and timestamps. A successful restart response confirms Docker completed the command. Service recovery is a separate check.

Before cutover, preserve the prior working image, stack configuration, notification settings and assignments, and credential versions. If verification fails, stop and restore the matching Watchdog configuration and Kuma settings together under the approved rollback. Keep Cloudflare Access in place. Verify the restored path with the disposable monitor. Keep the prior key until the rollback window closes.

## Repository checks

`pnpm test` runs the authenticated webhook tests with a fake Docker runner. `bash vps/check-auth-compose.sh` uses Docker Compose and `jq` with dummy values to verify base rendering, required key interpolation, and the absence of host port publishing. These checks do not contact Kuma or mutate a Docker stack. `pnpm test:docker` separately exercises the updater and health monitor against an isolated Docker fixture.
