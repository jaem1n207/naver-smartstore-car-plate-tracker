# Automatic Production Deployment Design

## Goal

Deploy the newest verified `main` revision to the Oracle Cloud production server without depending on the developer's MacBook. Superseded workflow runs must never move production backward. A deployment must build an isolated release, restart the existing systemd scheduler, verify the new process invocation, and reactivate the previous known-good release without reinstalling or rebuilding when activation fails.

## Scope And Boundaries

The implementation owns:

- verification and deployment workflows under `.github/`
- reviewed deployment sources under `ops/deployment/`
- immutable application releases under `/opt/naver-smartstore-car-plate-tracker/`
- graceful scheduler shutdown and cross-process synchronization locking
- production execution from compiled JavaScript
- activation and rollback of `car-plate-tracker.service`
- an ordered, repeat-safe bootstrap and recovery runbook

The automation does not provision or mutate these external resources:

- Naver Commerce API credentials or IP allowlists
- Google service-account credentials or spreadsheet access
- Oracle Cloud networking, VM lifecycle, or billing
- production `.env` values
- GitHub repository branch protection or environment policy

Those resources remain explicit one-time or incident-response inputs. A successful deployment proves that the scheduler started with the existing server configuration; it cannot guarantee that Oracle Cloud, Naver, Google, or the network will remain available indefinitely.

## Chosen Approach

Use GitHub Actions with a dedicated, forced-command SSH key.

This approach was selected over server-side polling because deployment begins immediately after a merge and leaves a visible verification and deployment history in GitHub. It was selected over a self-hosted GitHub Actions runner because the Oracle `VM.Standard.E2.1.Micro` instance has only 1 GB RAM and should reserve its limited resources for synchronization rather than a continuously running CI agent.

The dedicated deployment key is separate from every personal SSH key and belongs to a dedicated `carplate-deploy` OS account. Its public key is stored in a root-owned authorized-keys path and restricted to a root-owned deployment entrypoint, with interactive shell access, port forwarding, agent forwarding, X11 forwarding, TTY allocation, password authentication, and user-controlled commands disabled. Personal SSH keys remain attached only to the separate maintenance account.

GitHub-hosted runners do not provide a stable outbound IP on the free tier. Direct SSH deployment therefore requires the Oracle SSH port to accept GitHub-hosted runner traffic, usually through public TCP port 22. This is an explicit tradeoff mitigated by public-key-only authentication, the per-key forced command, strict host-key checking, and normal SSH rate limiting. A future requirement for a narrow source-IP allowlist would require a paid static-IP runner, a trusted outbound tunnel, or a switch to server-side polling.

## Repository Workflow

Create `.github/workflows/deploy-production.yml` with these triggers:

- `pull_request` targeting `main`: run verification only.
- `push` to `main`: run verification, then request deployment of the exact pushed commit.
- `workflow_dispatch`: verify and redeploy the current `main` head only.

The manual trigger must reject refs other than `refs/heads/main`; it does not accept arbitrary historical revisions. Historical rollback is a separate incident-response operation and is never disguised as a normal deployment. The GitHub `production` environment must allow deployments only from `main`.

The workflow uses read-only repository permission:

```yaml
permissions:
  contents: read
```

The deployment job uses a `production-deploy` concurrency group with `cancel-in-progress: false`. One production deployment may run at a time. GitHub concurrency does not guarantee execution order, so the server independently enforces monotonic revisions and treats a superseded request as a successful no-op.

### Verification Job

The GitHub-hosted runner must:

1. Check out the event commit.
2. Install the repository-pinned pnpm and Node.js 22 release.
3. Restore only pnpm's package cache.
4. Run `pnpm install --frozen-lockfile`.
5. Install the Playwright Chromium runtime and Linux dependencies.
6. Run `pnpm test:all`.
7. Run `pnpm build`.
8. Verify that generated visual CSS did not change during the run.

`pnpm test:all` remains the verification contract and includes static, unit, integration, E2E, visual, and deployment-operation checks. Linux visual tests must use Playwright's pinned Chromium, a bundled Korean-capable font, fixed locale, timezone, viewport, device scale, and worker count. Linux snapshots are generated in the same pinned execution image used by CI and committed alongside the macOS snapshots. The workflow uploads expected, actual, diff, trace, and screenshot diagnostics when Playwright verification fails.

The deployment job cannot run when verification fails.

### Deployment Job

The deployment job receives only these GitHub `production` environment secrets:

- `OCI_DEPLOY_HOST`: reserved Oracle public IPv4 address or trusted hostname
- `OCI_DEPLOY_USER`: fixed dedicated SSH account, `carplate-deploy`
- `OCI_DEPLOY_SSH_PRIVATE_KEY`: dedicated deployment private key
- `OCI_DEPLOY_KNOWN_HOSTS`: pre-verified SSH host-key entry for the production server

Naver credentials, Google credentials, spreadsheet identifiers, and `.env` contents must not be copied to GitHub.

The job writes the SSH key and known-hosts entry to temporary mode-`0600` files, then connects with:

- `BatchMode=yes`
- `IdentitiesOnly=yes`
- `StrictHostKeyChecking=yes`
- an explicit known-hosts file
- a bounded connection timeout and a deployment timeout longer than the scheduler's graceful-stop limit

It sends only `deploy <40-character-github-sha>`. The server-side forced command rejects every other command shape.

GitHub Actions and reusable actions must be pinned to immutable full commit SHAs. Dependabot monitors GitHub Actions references so those pins can be reviewed and updated without floating tags.

## Production Release Layout

Use this server layout:

```text
/opt/naver-smartstore-car-plate-tracker/
  repository.git/          # root-owned mirror with a pinned public GitHub origin
  candidates/
    <git-sha>/              # disposable carplate-build workspace
  releases/
    <git-sha>/              # sealed root-owned source, production node_modules, and dist
  current -> releases/<git-sha>
  previous -> releases/<git-sha>

/etc/naver-smartstore-car-plate-tracker/
  app.env                   # root:carplate mode 0640 production environment
  google-service-account.json

/var/lib/naver-smartstore-car-plate-tracker/
  runtime/                  # carplate:carplate; runtime coordination only
    sync.lock/
  deployment/               # root:root; never writable by runtime/build/deploy users
    deployed-sha
    activation-state
    deploy.lock
```

The existing repository-root `.env` moves to `/etc/naver-smartstore-car-plate-tracker/app.env`. The Google credential is also owned by `root:carplate` with mode `0640`. Neither file is readable by the build or deployment account or copied into a release. Each release contains a non-secret `release.env` with its `APP_REVISION` for startup logging.

The systemd unit uses:

- `WorkingDirectory=/opt/naver-smartstore-car-plate-tracker/current`
- `EnvironmentFile=/etc/naver-smartstore-car-plate-tracker/app.env`
- `EnvironmentFile=-/opt/naver-smartstore-car-plate-tracker/current/release.env`
- `ExecStart=/usr/bin/node /opt/naver-smartstore-car-plate-tracker/current/dist/src/scheduler/main.js`
- a required recovery oneshot ordered before the scheduler service
- a graceful `SIGTERM` stop and a bounded `TimeoutStopSec` long enough for a full synchronization to finish
- `NoNewPrivileges=true`, an empty capability set, strict system protection, a private temporary directory, and narrowly scoped read access required by the runtime

The release build installs all locked dependencies, runs `pnpm build`, then prunes development dependencies before activation. Production therefore runs the compiled scheduler and does not require `tsx`, TypeScript, Playwright, or Tailwind. The systemd hardening must still permit Node.js JIT execution and outbound HTTPS to Naver and Google.

The bootstrap runbook migrates the current single checkout and systemd unit into this layout once. Routine application deployments do not modify `app.env`, Google credentials, or the systemd unit.

## Server Deployment Entrypoints

Track canonical, testable script sources under `ops/deployment/`. The bootstrap procedure installs reviewed copies as root-owned, non-writable files outside the repository:

- `/usr/local/sbin/car-plate-tracker-deploy-entrypoint`: validates `SSH_ORIGINAL_COMMAND` and invokes the deployer with the validated SHA.
- `/usr/local/sbin/deploy-car-plate-tracker`: performs release preparation, activation, and rollback.
- `/usr/local/sbin/recover-car-plate-tracker`: reconciles an interrupted activation before the scheduler may start.

Updating these privileged installed copies is an explicit bootstrap-maintenance operation; ordinary application deployment never replaces a root-owned executable from repository contents.

The dedicated public key is stored for `carplate-deploy` with `restrict` and a forced command pointing to the entrypoint. The account has a locked password, no personal key, no application ownership, and no general sudo permission. A root-owned SSH configuration block and authorized-keys directory prevent the account from replacing its own key restrictions. The existing maintenance account and personal key remain independent for incident recovery.

The forced entrypoint and privileged deployer independently validate the command and SHA. They use absolute executable paths, a fixed safe `PATH`, and a sanitized environment. A narrowly scoped sudo rule permits `carplate-deploy` to invoke only the privileged deployer; the deployer accepts no caller-selected executable, path, URL, environment assignment, or extra argument.

The root-owned Git mirror fetches from one compiled-in HTTPS repository URL. Candidate install and build commands run as a separate unprivileged `carplate-build` account with no sudo permission and no read access to production environment or Google credentials. Repository code and dependency lifecycle scripts never run as root or as the credential-bearing runtime account.

The complete untrusted build phase runs inside a transient systemd service or equivalent dedicated cgroup with `KillMode=control-group`, `RuntimeMaxSec`, `MemoryMax`, `TasksMax`, and a writable view limited to its candidate and package-store paths. The deployer waits for the unit, terminates the complete cgroup on timeout or exit, and verifies that no descendant remains before examining output. A child process, inherited writable file descriptor, or daemonized lifecycle script must not survive into activation.

Root never seals the builder's existing inodes in place. It validates the stopped candidate, rejects special files and links that escape the candidate, strips unintended ACLs and extended attributes, and copies validated content without following links into a new root-owned temporary release. It creates `release.env` with no-follow, exclusive file operations, applies `root:carplate` read-only ownership, and atomically renames the temporary release into `releases/<sha>`. This copy boundary prevents a former build process from retaining a writable descriptor to production runtime code.

## Monotonic Deployment

Under the exclusive deployment lock, the deployer must:

1. Validate the request as exactly `deploy <40 lowercase hexadecimal characters>`.
2. Fetch `origin/main` into the root-owned `repository.git` from the single pinned public origin.
3. Verify that the requested SHA exists in the fetched `origin/main` history.
4. Read the last successfully activated SHA from `deployed-sha` when present.
5. Return success without changing production when the requested SHA equals the deployed SHA.
6. Return success as a stale no-op when the requested SHA is an ancestor of the deployed SHA.
7. Continue only when the deployed SHA is an ancestor of the requested SHA.
8. Reject divergent history, including a force-pushed `main`, for manual review.

The first automated deployment may proceed without `deployed-sha`; this is the controlled migration from the current PR branch checkout. `deployed-sha` changes only after the new service invocation passes health verification.

Integration tests must cover requests A then B, B then A, equal revisions, divergent revisions, and an absent initial marker.

## Synchronization Drain And Locks

The scheduler tracks its active synchronization promise. On `SIGTERM`, it stops accepting new cron triggers, waits for the active synchronization to settle, logs the shutdown result, and exits. The systemd stop timeout must exceed the expected maximum full-sync duration; an expired timeout is a deployment failure rather than silent success.

Scheduler runs and `sync:once` use the same cross-process synchronization lock at `/var/lib/naver-smartstore-car-plate-tracker/runtime/sync.lock`. Only the runtime directory is writable by `carplate`; durable deployment state remains root-only under `/var/lib/naver-smartstore-car-plate-tracker/deployment`. The lock records its owning PID and supports stale-owner recovery after a verified dead process. A deployment:

1. Acquires the deployment lock with a documented timeout.
2. Requests a graceful systemd stop so no new scheduled sync can begin.
3. Waits for and holds the synchronization lock before preparing or activating a release.
4. Holds both locks through activation, health verification, or rollback.

All manual code deployments use the same deployer and deployment lock. Manual `sync:once` uses the shared synchronization lock. Tests cover concurrent deployment rejection, deployment during a delayed sync, graceful `SIGTERM`, stale-lock recovery, and lock release after failure.

## Release Preparation And Activation

After monotonic validation and lock acquisition, the deployer must:

1. Verify that the configured 2 GB swap is active and that bounded free-disk and free-memory requirements are met.
2. Stop and drain `car-plate-tracker.service` before memory-intensive build work.
3. Export a disposable `candidates/<sha>` workspace owned by the secretless `carplate-build` account.
4. Run `pnpm install --frozen-lockfile` as `carplate-build` with a bounded timeout and sanitized environment.
5. Run `pnpm build` as `carplate-build` with the repository's bounded Node heap and a bounded timeout.
6. Run the release's focused startup validation without live Naver or Google calls.
7. Prune development dependencies from the completed release.
8. Stop the complete build cgroup and verify that it is empty.
9. Validate and copy the candidate into a separate sealed release, including a safely created non-secret `release.env`.
10. Record and fsync a pending activation containing the previous and candidate SHAs.
11. Point `previous` to the old `current` target.
12. Atomically switch and fsync `current` to the completed release.
13. Start `car-plate-tracker.service`.
14. Verify the new systemd invocation.
15. Atomically write and fsync `deployed-sha`, then clear and fsync the pending activation state.
16. Retain the current and previous known-good releases and remove only older inactive releases.

An install or build failure leaves the `current` symlink untouched. The deployer restarts the existing current release and reports deployment failure.

## Invocation Health Check

Before starting the candidate, capture the prior systemd state and journal position. After startup:

1. Obtain the new systemd `InvocationID`.
2. Inspect logs for that invocation only.
3. Require a structured `scheduler started` record containing `mode: live`, the configured cron, and the requested `APP_REVISION`.
4. Require the unit to remain `active/running` for a bounded stabilization period.
5. Reject an increased restart count, failed state, or missing current-invocation startup record.

The same invocation-scoped health check applies after rollback. An old `scheduler started` message or a process briefly alive inside a restart loop must not pass.

## Rollback And Failure Semantics

If activation or health verification fails, the deployer atomically switches `current` back to `previous`, starts it, and verifies the restored invocation. Rollback performs no fetch, package installation, or build and therefore remains available during a registry outage, candidate OOM, or damaged candidate `node_modules`.

Activation is crash-consistent across process failure, kernel failure, and VM power loss. Before changing `current`, the deployer atomically writes and fsyncs a root-owned activation journal containing the known-good SHA, candidate SHA, and `pending` state. It fsyncs the symlink parent after switching. Only after health verification does it atomically write and fsync `deployed-sha`, clear the pending state, and fsync the state directory.

`car-plate-tracker-recover.service` is a root-owned oneshot ordered before `car-plate-tracker.service` on every boot. A pending activation or disagreement between `current` and `deployed-sha` makes recovery restore the recorded known-good symlink before the scheduler can read credentials or start. A crash after candidate health but before marker commit therefore rolls back conservatively. Bootstrap initializes `deployed-sha` from a manually verified known-good release before enabling the scheduler; otherwise the first request must equal the fetched `origin/main` head and complete a dedicated initialization path.

The Action output is an allowlist containing only outcome, requested SHA, prior SHA, activated SHA, and an opaque server-side diagnostic ID. Application journal records, store names, product counts, filesystem paths, and server environment details remain on Oracle and are never returned to the public repository's Action logs. The output must distinguish:

- New revision deployed and scheduler stabilized.
- Request was already deployed or superseded; production was unchanged.
- Candidate preparation failed; the existing release restarted successfully.
- Candidate activation failed; the previous release was reactivated successfully.
- Deployment and recovery both failed; manual intervention is required.

The deployer uses an exit trap with a non-recursive recovery state so an unexpected failure cannot silently leave the service stopped. Logs never print `.env`, private keys, Google credential JSON, Naver secrets, command environments, or credential-bearing URLs.

## GitHub And Server Hardening

- Protect `main`, require pull requests and the verification job, block force pushes and deletion, and disallow bypass where the repository plan permits it.
- Add `CODEOWNERS` coverage for `.github/workflows/`, `ops/deployment/`, `package.json`, and `pnpm-lock.yaml`; require an independent code-owner approval when a second trusted maintainer is available.
- Never use `pull_request_target` for this workflow.
- Keep production secrets scoped to the `production` environment and deployment job only.
- Do not use `StrictHostKeyChecking=no` or discover the host key during deployment.
- Verify the SSH host fingerprint through the existing trusted personal session or Oracle console before saving `OCI_DEPLOY_KNOWN_HOSTS`.
- Do not store a personal OCI private key in GitHub.
- Do not grant the deployment key an unrestricted shell or reuse the maintenance account.
- Keep forced-command scripts, authorized keys, Git state, symlinks, and deployed-state files owned by `root:root` and not writable by `carplate-deploy`, `carplate-build`, or `carplate`.
- Limit passwordless sudo to the exact deployment entrypoint when the selected SSH account does not already have the required boundary.
- Review workflow, package lifecycle, lockfile, and deployment-script changes as production-control code. With fully automatic deployment, trusted changes merged into `main` intentionally control the runtime; the forced key limits a leaked GitHub secret to monotonic deployment requests and does not grant shell access.

## Operating Model

After one-time setup, merging a PR into `main` is the normal deployment operation. The developer's MacBook may be shut down because GitHub-hosted runners perform verification and connect directly to Oracle Cloud, while systemd keeps the scheduler enabled across VM reboots.

`workflow_dispatch` provides a manual redeploy of current `main` without an SSH session. Direct server commands remain for incident recovery and privileged deployment-script updates.

Credential rotation, schedule changes, unit changes, operating-system maintenance, and historical rollback continue to follow the operations runbook. The runbook covers the existing VM, separation of `carplate`, `carplate-build`, `carplate-deploy`, and the maintenance account, Node and pnpm versions, persistent swap, directory migration, external environment file, forced key, root-owned authorized-keys path, narrow sudo boundary, host-key verification, GitHub environment secrets, branch protection, first deployment, reboot check, rollback drill, and deploy-key rotation.

## Verification Contract

Implementation must cover:

- Static: workflow YAML validation, `actionlint`, `shellcheck`, shell syntax, typecheck, lint, and formatting.
- Unit: forced-command parsing, SHA validation, monotonic revision decisions, lock ownership, stale-lock recovery, health-result parsing, and secret-safe errors.
- Integration: command shims for successful preparation, stale no-op, rejected revision, active-sync drain, install/build failure, service-start failure, successful symlink rollback, and failed rollback.
- Isolation: daemonized writer, inherited writable descriptor, escaping symlink, special file, surviving child, build timeout, and unsafe metadata rejection.
- Crash consistency: injected termination after every activation-state transition and boot-time reconciliation of pending, committed, missing, and mismatched markers.
- E2E: structural proof that pull-request events cannot reach deployment, non-`main` manual events are rejected, a verified `main` event emits only the forced command, and a newer deployed SHA cannot be replaced by an older request.
- Visual: deterministic macOS and pinned-Linux Chromium snapshots with failure artifacts.
- Production smoke: one `workflow_dispatch` deployment followed by `systemctl is-enabled`, invocation-scoped `systemctl is-active`, deployed SHA, and recent scheduler-log checks.

The canonical scripts live in the repository so tests execute the same sources that the bootstrap installs. `test:all` includes the deployment-operation test suite. Branch protection and GitHub environment policy are verified during setup through GitHub settings or `gh api`; Playwright does not pretend to test remote repository policy.

No automated test calls the live Naver Commerce API or writes to the production Google Sheet. The production smoke deployment verifies process startup only; the existing fixed-IP live smoke procedure remains the explicit test for real Naver and Google synchronization.

## References

- [GitHub Actions workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [GitHub Actions concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- [GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [GitHub manually running workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
- [Playwright visual comparisons](https://playwright.dev/docs/test-snapshots)
