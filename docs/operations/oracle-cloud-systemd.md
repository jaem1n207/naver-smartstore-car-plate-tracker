# Oracle Cloud systemd Operation

Use the ordered [automatic production deployment runbook](automatic-production-deployment.md) for the one-time migration, deploy key, GitHub environment, branch protection, first deployment, reboot check, rollback drill, and rotation procedures. This page is the shorter day-to-day systemd reference after that setup is complete.

The current legacy checkout at `/opt/naver-smartstore-car-plate-tracker` must be stopped and moved to `/srv/carplate-bootstrap-source` before bootstrap. The initial source cannot equal or sit below the managed `/opt` application root. PR #2 must then be merged with **Create a merge commit** so its bootstrapped head remains an ancestor of `main`; squash and rebase merge are invalid for this migration.

## Production runtime contract

Production runs immutable compiled JavaScript, not `tsx` and not `pnpm scheduler`:

```text
/usr/bin/node /opt/naver-smartstore-car-plate-tracker/current/dist/src/scheduler/main.js
```

The tracked unit is `ops/deployment/systemd/car-plate-tracker.service`. Its important boundaries are:

- Runtime account: `carplate:carplate`.
- Working directory: `/opt/naver-smartstore-car-plate-tracker/current`.
- Secret environment: `/etc/naver-smartstore-car-plate-tracker/app.env`.
- Non-secret revision: `/opt/naver-smartstore-car-plate-tracker/current/release.env`.
- Shared synchronization lock: `/var/lib/naver-smartstore-car-plate-tracker/runtime/sync.lock`.
- Startup dependency: `car-plate-tracker-recover.service` must reconcile deployment state first.
- Restart: `on-failure`, with a 10-second delay.
- Graceful stop: `SIGTERM` with `TimeoutStopSec=60min`, allowing an active sync to settle.
- Writable path: only `/var/lib/naver-smartstore-car-plate-tracker/runtime`.
- Node JIT: `MemoryDenyWriteExecute=false` is intentional.

The default application cron is five minutes, but production should normally set an hourly full sync because every non-deleted product detail is read on each run. Keep this in the protected server environment:

```dotenv
NODE_ENV=production
SYNC_CRON=0 * * * *
SYNC_LOCK_DIR=/var/lib/naver-smartstore-car-plate-tracker/runtime/sync.lock
```

The bootstrap installs `app.env` and the Google key as `root:carplate` mode `0640`. Configure exactly one Google credential source; production uses the protected file path.

## Service status

**[Oracle]**

```bash
# [Oracle]
sudo systemctl is-enabled car-plate-tracker.service
sudo systemctl is-active car-plate-tracker.service
sudo systemctl show car-plate-tracker.service --property=ActiveState,SubState,MainPID,NRestarts,InvocationID,ExecMainStatus
sudo systemctl status car-plate-tracker-recover.service --no-pager
sudo journalctl -u car-plate-tracker.service -n 100 --no-pager --output=cat
```

The expected startup record contains `scheduler started`, `mode: live`, the configured cron, and the active release SHA as `appRevision`. A completed job logs `scheduled sync completed`. A nonzero `sheetExtractionFailure` is a row-level result, not a scheduler failure; an actual job failure logs `scheduled sync failed`.

Keep detailed journal output on Oracle. Store names, counts, and application diagnostics are intentionally excluded from public GitHub Actions output.

## Routine code deployment

Merging a verified PR into `main` is the normal deployment. The workflow builds through the secretless `carplate-build` account, seals a root-owned release, drains the scheduler, takes the shared sync lock, switches `current`, and verifies the new systemd invocation.

**[GitHub UI]** To retry current `main`, open **Actions > Production Deployment > Run workflow**, select `main`, and run it. This is preferred to an Oracle shell command.

When GitHub Actions is unavailable and a server-side forward deployment is explicitly authorized, call the same locked deployer with an exact lowercase `main` SHA.

**[Oracle]**

```bash
# [Oracle]
export REQUESTED_SHA="replace-with-40-character-lowercase-main-sha"
printf '%s\n' "$REQUESTED_SHA" | grep -Ex '[0-9a-f]{40}'
sudo /usr/local/sbin/deploy-car-plate-tracker "$REQUESTED_SHA"
```

Do not run `git pull`, replace `current`, install packages as root, or edit an immutable release. Equal and stale requests are successful no-ops; divergent history fails closed.

## Privileged maintenance boundary

Routine `main` deployment does not update any of these files:

- `/usr/local/sbin/car-plate-tracker-deploy-entrypoint`
- `/usr/local/sbin/deploy-car-plate-tracker`
- `/usr/local/sbin/recover-car-plate-tracker`
- `/usr/local/lib/naver-smartstore-car-plate-tracker/`
- `/etc/systemd/system/car-plate-tracker*.service`
- `/etc/naver-smartstore-car-plate-tracker/`
- `/etc/ssh/sshd_config.d/carplate-deploy.conf`
- `/etc/sudoers.d/carplate-deploy`

Updating deployment scripts, units, secrets, deploy keys, SSH policy, or sudoers is an explicit reviewed bootstrap-maintenance operation. Follow the canonical runbook; do not copy a newly merged privileged script directly out of a release.

## Manual one-time synchronization

The scheduler and compiled CLI share the same cross-process lock. Stop the scheduler to prevent a new cron trigger, run the CLI in a transient unit using the production environment, then restart the scheduler.

**[Oracle]**

```bash
# [Oracle]
sudo systemctl stop car-plate-tracker.service
sudo systemd-run --wait --collect --service-type=exec \
  --uid=carplate \
  --gid=carplate \
  --working-directory=/opt/naver-smartstore-car-plate-tracker/current \
  --property=EnvironmentFile=/etc/naver-smartstore-car-plate-tracker/app.env \
  --property=EnvironmentFile=-/opt/naver-smartstore-car-plate-tracker/current/release.env \
  /usr/bin/node /opt/naver-smartstore-car-plate-tracker/current/dist/src/cli/sync-once.js
sudo systemctl start car-plate-tracker.service
sudo systemctl is-active car-plate-tracker.service
```

Do not manually delete `sync.lock`. The lock owner contract supports verified stale-owner recovery and fails closed on malformed or unexpected contents.

## Reboot verification

**[Oracle]**

```bash
# [Oracle]
sudo systemctl is-enabled car-plate-tracker.service
sudo reboot
```

After reconnecting:

**[Oracle]**

```bash
# [Oracle]
sudo systemctl is-active car-plate-tracker.service
sudo systemctl status car-plate-tracker-recover.service --no-pager
sudo readlink /opt/naver-smartstore-car-plate-tracker/current
sudo cat /var/lib/naver-smartstore-car-plate-tracker/deployment/deployed-sha
sudo journalctl -b -u car-plate-tracker-recover.service -u car-plate-tracker.service --no-pager --output=cat
```

The `current` link, durable `deployed-sha`, and startup `appRevision` must agree.

## Availability limits

The MacBook may be shut down after setup. GitHub-hosted runners perform deployment, and the enabled systemd unit starts after an Oracle reboot. Recovery prevents an interrupted activation from starting an uncommitted release.

systemd cannot guarantee that the VM stays powered on, GitHub can reach SSH, DNS works, the fixed IP remains allowed, credentials remain valid, Naver or Google is available, disk and swap remain sufficient, or every sync succeeds. `Restart=on-failure` restarts the process; it does not repair external services or application data. Use the [fixed-IP live smoke test](live-smoke-test.md) to verify real Naver and Google behavior.
