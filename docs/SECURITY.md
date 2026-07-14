# Security

## Trust boundaries

- Naver application credentials authenticate one store each and are read only by the runtime account from the protected production environment.
- Google service-account credentials authenticate the worker and must have Editor access only to the target spreadsheet.
- Product detail HTML is untrusted input. It is parsed as text and is never executed.
- Google Sheets is both the operator UI and persisted sync state. Only `관리자 메모` is operator-owned during upsert.
- Pull-request code is untrusted for production. A PR runs verification only; deployment requires a verified `main` revision.
- Repository and dependency code is untrusted during release preparation. It builds as `carplate-build` without production credentials, root access, or runtime ownership.
- A GitHub deployment credential can request only `deploy <40-lowercase-hex-sha>` through a forced SSH command. The root deployer independently verifies identity, revision ancestry, fixed origin, layout, resources, and locks.
- Installed deployment scripts, systemd units, SSH policy, sudoers, `/etc` secrets, and root deployment state are privileged maintenance assets. Routine application deployment cannot update them.

## Account separation

- `carplate` runs compiled production JavaScript. It can read `app.env` and the Google key and can write only `/var/lib/naver-smartstore-car-plate-tracker/runtime`.
- `carplate-build` installs and builds candidates inside a bounded transient systemd unit. It cannot read production credentials and has no sudo permission.
- `carplate-deploy` has a locked password and a shell only because OpenSSH must invoke the forced command. Root-owned SSH restrictions disable caller-selected commands, TTY, forwarding, user rc, and password or keyboard-interactive authentication.
- The personal Oracle maintenance account remains separate from all three service accounts and keeps the only general incident-recovery path.
- Root owns the bare Git mirror, immutable releases, symlinks, deploy state, forced-command programs, systemd units, authorized key, SSH drop-in, and sudoers rule.

The sudo rule is limited to the root deployer plus one lowercase SHA argument and disables environment preservation. It is not unrestricted sudo.

## Credential handling

- Production prefers `GOOGLE_APPLICATION_CREDENTIALS=/etc/naver-smartstore-car-plate-tracker/google-service-account.json`.
- Bootstrap installs `app.env` and the Google key as `root:carplate` mode `0640`; build and deploy accounts cannot read them.
- `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` is an alternative for a secret manager, not a second simultaneous credential. Base64 is encoding, not encryption.
- `.env`, service-account credentials, Naver secrets, deployment private keys, real store data, spreadsheet IDs, and exports must not be committed.
- The dedicated GitHub deployment private key is not a personal OCI key and is scoped to the `production` environment.
- `OCI_DEPLOY_KNOWN_HOSTS` must come from an independently verified server host fingerprint. Deployment uses strict host checking and never accepts a newly discovered host key.

GitHub receives only four production environment secrets: `OCI_DEPLOY_HOST`, `OCI_DEPLOY_USER`, `OCI_DEPLOY_SSH_PRIVATE_KEY`, and `OCI_DEPLOY_KNOWN_HOSTS`. Naver, Google, spreadsheet, and application environment values remain on Oracle.

## Deployment integrity

- GitHub Actions has `contents: read`; only the deploy job can access the `production` environment.
- Pull requests never deploy, `workflow_dispatch` rejects non-`main` refs, and a failed `Verify` job blocks deployment.
- Reusable actions are pinned to full commit SHAs. Dependabot proposes reviewed GitHub Actions pin updates.
- Server deployment fetches only the compiled-in public HTTPS origin and permits initial `origin/main` head or a forward descendant of the durable deployed SHA.
- Bootstrap rejects an initial checkout that equals or is nested inside `/opt/naver-smartstore-car-plate-tracker`; the source checkout, `.git`, `.env`, and Google key must remain outside the managed application tree.
- PR #2 must use a merge commit because bootstrap records its head as `deployed-sha`. Squash or rebase merge would make the first `main` request divergent and is therefore prohibited for this migration.
- Equal and stale requests are successful no-ops. Divergent history, including a force-pushed `main`, fails closed.
- Build lifecycle scripts run in a bounded cgroup. Activation rejects surviving descendants, inherited writable descriptors, escaping links, special files, unsafe ACLs or extended attributes, and mutable release content.
- Root copies validated candidate content into new root-owned inodes, creates a non-secret `release.env`, and retains only current and previous known-good releases.

## Locks, shutdown, and crash recovery

- Scheduler and compiled `sync:once` processes share `/var/lib/naver-smartstore-car-plate-tracker/runtime/sync.lock`.
- The root deployer takes a separate deployment flock, drains the scheduler with `SIGTERM`, then holds the sync lock through activation or recovery.
- Lock ownership includes PID, Linux process start ticks, and a random token. Unknown or malformed state fails closed; operators must not delete locks by hand.
- Before changing `current`, deployment fsyncs a root-only pending activation state. It commits `deployed-sha` only after invocation-scoped health succeeds.
- `car-plate-tracker-recover.service` runs before the scheduler on every boot. Pending activation or marker/link disagreement restores the durable known-good release before credentials are read by the runtime.
- Health requires a new systemd invocation, `scheduler started`, `mode: live`, expected cron, expected `APP_REVISION`, stable PID, unchanged restart count, and 15 seconds of `active/running` state.

## Public log policy

The GitHub workflow accepts and prints only these deployment result fields: outcome, requested SHA, previous SHA, activated SHA, and an opaque diagnostic ID. The SSH entrypoint rejects extra keys, malformed output, multiple lines, non-ASCII content, and mismatched requested SHA.

Application journals, environment values, filesystem paths, store names, product counts, command environments, Naver errors, and credential-bearing URLs stay on Oracle. Do not add `journalctl`, shell tracing, environment dumps, or verbose SSH output to public workflow steps.

## Sheet mutation policy

- Missing managed tabs are created automatically.
- A legacy English managed tab is renamed only when its Korean replacement does not exist.
- Unknown tabs are never deleted or renamed.
- When both legacy and Korean tabs exist, both are preserved and only the Korean tab is managed.
- Writes are limited to columns A through U for product data and A through K for run logs.

## Rotation and incident response

Use the [automatic deployment runbook](operations/automatic-production-deployment.md) for reviewed rotation and verification.

- Suspected Naver exposure: rotate the affected store client secret, update the Oracle environment through privileged maintenance, then run the fixed-IP live smoke test.
- Suspected Google exposure: disable or delete the key, create a replacement with access only to the target spreadsheet, install it through privileged maintenance, then run the live smoke test.
- Suspected deploy-key exposure: freeze deployments, create a new dedicated key, rerun reviewed bootstrap with the new public key, replace only the GitHub environment private-key secret, verify `workflow_dispatch`, and destroy the old key.
- Oracle host-key change: verify the new fingerprint through the Oracle console or another trusted path before replacing `OCI_DEPLOY_KNOWN_HOSTS`.
- GitHub environment-secret exposure: rotate the affected key or host trust material and review Actions history and environment access.
- `deployment_recovery_failed`: treat production as unavailable until the maintenance account confirms a healthy release, durable marker, current link, and new systemd invocation.

Never repair deployment state by deleting `activation-state`, rewriting `deployed-sha`, or relinking `current` without a reviewed incident procedure that preserves the deployment lock and crash-consistency contract.
