# Automatic Production Deployment Runbook

This is the canonical, ordered migration and operations guide for the Oracle production worker. It is written for a frontend developer who is comfortable with GitHub and a terminal but does not administer Linux every day.

The currently open implementation pull request is **PR #2**. Do not use an older PR number when checking or merging this work.

## Read this first

- Replace every `replace-with-...` value locally. Never paste a real host, key, Naver credential, Google credential, spreadsheet ID, or environment file into Git, a PR, an issue, or a public Actions log.
- Keep one trusted personal maintenance login to Oracle. The `carplate-deploy` key is only for GitHub Actions and cannot open an interactive shell.
- `ops/deployment/bootstrap.sh` is an explicit privileged maintenance operation. It installs reviewed scripts, SSH restrictions, sudoers, systemd units, credentials, users, and the initial release.
- A routine `main` deployment does **not** update privileged scripts, systemd units, `/etc` secrets, SSH policy, or sudoers. It fetches one verified SHA, builds it as `carplate-build`, seals an immutable release, switches `current`, and verifies the new service invocation.
- The existing checkout is currently `/opt/naver-smartstore-car-plate-tracker`, the same path bootstrap owns as `APP_ROOT`. Move the entire checkout outside `/opt` before bootstrap. The bootstrap rejects an initial source that equals or is nested inside `APP_ROOT`; otherwise the old `.git`, `.env`, and Google credential could remain inside the managed application tree.
- Do not run the first `workflow_dispatch` until PR #2 has been merged into `main` with **Create a merge commit**. The initial deployed SHA is the PR head. Squash merge and rebase merge create a `main` history that does not contain that SHA, so the monotonic deployer rejects the first request as divergent.

## 1. Define local names

Use the reserved Oracle host name or public IP only in your local shell. Do not commit these values.

**[MacBook]**

```bash
# [MacBook]
export OCI_DEPLOY_HOST="replace-with-reserved-oracle-host"
export OCI_MAINTENANCE_USER="replace-with-personal-maintenance-user"
export DEPLOY_KEY="$HOME/.ssh/carplate-github-deploy"
export DEPLOY_KNOWN_HOSTS="$HOME/.ssh/carplate-github-known-hosts"
```

Set the current and destination checkout paths. At this point the existing checkout is still under `/opt`; Step 3 moves it before bootstrap.

**[Oracle]**

```bash
# [Oracle]
export CURRENT_CHECKOUT="/opt/naver-smartstore-car-plate-tracker"
export BOOTSTRAP_SOURCE="/srv/carplate-bootstrap-source"
export ENV_SOURCE="$CURRENT_CHECKOUT/.env"
export GOOGLE_JSON_SOURCE="$CURRENT_CHECKOUT/google-service-account.json"
```

If the Google key is already elsewhere, set `GOOGLE_JSON_SOURCE` to that protected absolute path. Do not print either secret file.

## 2. Back up and record the current state

Record the checkout and service state before changing anything. An empty `git status --short` is expected; stop if you cannot explain local changes.

**[Oracle]**

```bash
# [Oracle]
sudo -u carplate -H git -C "$CURRENT_CHECKOUT" status --short
sudo -u carplate -H git -C "$CURRENT_CHECKOUT" branch --show-current
sudo -u carplate -H git -C "$CURRENT_CHECKOUT" rev-parse HEAD
sudo systemctl is-enabled car-plate-tracker.service 2>/dev/null || true
sudo systemctl is-active car-plate-tracker.service 2>/dev/null || true
sudo systemctl cat car-plate-tracker.service 2>/dev/null || true
```

Create a root-only backup without displaying secret contents. Keep it until the first deployment, reboot check, and live smoke test all pass.

**[Oracle]**

```bash
# [Oracle]
export BACKUP_DIR="/var/backups/carplate-pre-bootstrap-$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -d -m 0700 -o root -g root "$BACKUP_DIR"
sudo test -f "$ENV_SOURCE"
sudo test -f "$GOOGLE_JSON_SOURCE"
sudo install -m 0600 -o root -g root "$ENV_SOURCE" "$BACKUP_DIR/app.env"
sudo install -m 0600 -o root -g root "$GOOGLE_JSON_SOURCE" "$BACKUP_DIR/google-service-account.json"
if sudo test -f /etc/systemd/system/car-plate-tracker.service; then sudo cp -a /etc/systemd/system/car-plate-tracker.service "$BACKUP_DIR/"; fi
sudo -u carplate -H git -C "$CURRENT_CHECKOUT" rev-parse HEAD | sudo tee "$BACKUP_DIR/checkout-sha" >/dev/null
sudo chmod 0600 "$BACKUP_DIR/checkout-sha"
sudo find "$BACKUP_DIR" -maxdepth 1 -printf '%M %u:%g %f\n'
```

## 3. Move the checkout outside managed `/opt`

Stop the existing scheduler before moving its working tree. The destination must not exist, and the source must be a real Git checkout. Moving the whole directory preserves `.git`, `.env`, the Google key, `node_modules`, and `dist` together while freeing `/opt/naver-smartstore-car-plate-tracker` for the managed release layout.

**[Oracle]**

```bash
# [Oracle]
sudo systemctl stop car-plate-tracker.service
sudo systemctl is-active car-plate-tracker.service | grep -Fx inactive
test "$(sudo -u carplate -H git -C "$CURRENT_CHECKOUT" rev-parse --show-toplevel)" = "$CURRENT_CHECKOUT"
sudo test ! -e "$BOOTSTRAP_SOURCE"
sudo install -d -m 0755 -o root -g root /srv
cd /
sudo mv "$CURRENT_CHECKOUT" "$BOOTSTRAP_SOURCE"
export CURRENT_CHECKOUT="$BOOTSTRAP_SOURCE"
export ENV_SOURCE="$CURRENT_CHECKOUT/.env"
export GOOGLE_JSON_SOURCE="$CURRENT_CHECKOUT/google-service-account.json"
test "$(sudo -u carplate -H git -C "$CURRENT_CHECKOUT" rev-parse --show-toplevel)" = "$CURRENT_CHECKOUT"
test ! -e /opt/naver-smartstore-car-plate-tracker
case "$(realpath "$CURRENT_CHECKOUT")/" in
  /opt/naver-smartstore-car-plate-tracker/*) exit 1 ;;
esac
```

If the Google key was outside the old checkout, reset `GOOGLE_JSON_SOURCE` to that protected absolute path after the move. Do not restart the old service; bootstrap installs and enables the new compiled immutable service after it has established a known-good release.

## 4. Provision persistent 2 GiB swap

The deployer refuses to build unless at least 2 GiB of active swap, 3 GiB of free disk under `/opt`, and 128 MiB of available memory are present.

Inspect existing swap first.

**[Oracle]**

```bash
# [Oracle]
sudo swapon --show --bytes
awk 'NR > 1 { total += $3 } END { print total + 0 }' /proc/swaps
grep -vE '^[[:space:]]*(#|$)' /etc/fstab
```

If `/swapfile` does not exist, create exactly 2 GiB and make it persistent. If it already exists but has unexpected size, ownership, or permissions, stop and inspect it instead of overwriting it.

**[Oracle]**

```bash
# [Oracle]
if ! sudo test -e /swapfile; then
  sudo fallocate -l 2G /swapfile
  sudo chown root:root /swapfile
  sudo chmod 0600 /swapfile
  sudo mkswap /swapfile
fi
sudo stat -c '%n %s bytes %a %U:%G' /swapfile
swapon --show=NAME --noheadings | grep -Fx /swapfile >/dev/null || sudo swapon /swapfile
grep -Fqx '/swapfile none swap sw 0 0' /etc/fstab || printf '%s\n' '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
awk 'NR > 1 { total += $3 } END { if (total < 2097152) exit 1; print total " KiB active swap" }' /proc/swaps
```

## 5. Install exact Node.js and pnpm versions

Production requires Node.js `22.23.1`. The systemd unit calls `/usr/bin/node`, and the isolated builder calls `/usr/local/bin/pnpm` version `11.10.0`.

Install the official Node.js archive after checking its published checksum. This block supports Ubuntu `amd64` and `arm64` machines.

**[Oracle]**

```bash
# [Oracle]
export NODE_VERSION="v22.23.1"
case "$(dpkg --print-architecture)" in
  amd64) export NODE_ARCH="x64" ;;
  arm64) export NODE_ARCH="arm64" ;;
  *) printf '%s\n' 'Unsupported architecture' >&2; exit 1 ;;
esac
export NODE_ARCHIVE="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
export NODE_INSTALL_ROOT="/opt/nodejs/${NODE_VERSION}"
cd /tmp
curl --fail --silent --show-error --location --remote-name "https://nodejs.org/dist/${NODE_VERSION}/${NODE_ARCHIVE}"
curl --fail --silent --show-error --location --remote-name "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"
grep " ${NODE_ARCHIVE}$" SHASUMS256.txt | sha256sum --check -
if ! sudo test -x "$NODE_INSTALL_ROOT/bin/node"; then
  sudo install -d -m 0755 -o root -g root "$NODE_INSTALL_ROOT"
  sudo tar -xJf "$NODE_ARCHIVE" -C "$NODE_INSTALL_ROOT" --strip-components=1
fi
```

On a clean VM, create the path required by the unit. If `/usr/bin/node` already exists with a different version, stop and remove or migrate that package deliberately; do not overwrite an unexplained system binary.

**[Oracle]**

```bash
# [Oracle]
if test -e /usr/bin/node || test -L /usr/bin/node; then
  test "$(/usr/bin/node --version)" = "v22.23.1"
else
  sudo ln -s "$NODE_INSTALL_ROOT/bin/node" /usr/bin/node
fi
sudo env PATH="/usr/bin:$NODE_INSTALL_ROOT/bin:/usr/local/bin" "$NODE_INSTALL_ROOT/bin/npm" install --global --prefix /usr/local pnpm@11.10.0
test "$(/usr/bin/node --version)" = "v22.23.1"
test "$(/usr/local/bin/pnpm --version)" = "11.10.0"
```

## 6. Fast-forward the PR branch and prepare the initial built checkout

Bootstrap does not run `pnpm install` or `pnpm build` for the initial release. It requires a Git checkout root outside `APP_ROOT` containing `package.json`, `node_modules`, `dist/src/scheduler/main.js`, and a lowercase 40-character `HEAD` SHA. It copies only the built runtime, dependencies, package manifest, optional lockfile, and a generated non-secret `release.env`; it does not copy `.env`, `.git`, or the Google credential into the release.

The checkout must exactly match the latest remote PR branch. A dirty checkout or a non-fast-forward update is a stop condition.

**[Oracle]**

```bash
# [Oracle]
cd "$CURRENT_CHECKOUT"
test -z "$(sudo -u carplate -H git status --porcelain)"
sudo -u carplate -H git fetch origin naver-smartstore-car-plate-tracker-mvp
sudo -u carplate -H git switch naver-smartstore-car-plate-tracker-mvp
sudo -u carplate -H git merge --ff-only origin/naver-smartstore-car-plate-tracker-mvp
test "$(sudo -u carplate -H git rev-parse HEAD)" = "$(sudo -u carplate -H git rev-parse origin/naver-smartstore-car-plate-tracker-mvp)"
export INITIAL_DEPLOYED_SHA="$(sudo -u carplate -H git rev-parse HEAD)"
printf '%s\n' "$INITIAL_DEPLOYED_SHA" | grep -Ex '[0-9a-f]{40}'
sudo -u carplate -H /usr/local/bin/pnpm install --frozen-lockfile
sudo -u carplate -H /usr/local/bin/pnpm build
/usr/bin/node --check dist/src/scheduler/main.js
test -d node_modules
test -f package.json
sudo -u carplate -H git rev-parse --verify 'HEAD^{commit}' | grep -Ex '[0-9a-f]{40}'
bash -n ops/deployment/*.sh ops/deployment/lib/*.sh
sudo -u carplate -H /usr/local/bin/pnpm test:deployment
```

Do not continue unless this checkout is already accepted as the current known-good application revision. Bootstrap validates its structure and then enables the scheduler; it does not call the live Naver API or write the production Sheet as a preflight test.

## 7. Create the dedicated deploy key

Generate a new key that is not a personal maintenance key and is not reused elsewhere. The private key remains on the MacBook until it is entered into the GitHub `production` environment.

**[MacBook]**

```bash
# [MacBook]
umask 077
test ! -e "$DEPLOY_KEY"
ssh-keygen -t ed25519 -a 100 -f "$DEPLOY_KEY" -C "github-actions-carplate-production"
chmod 0600 "$DEPLOY_KEY"
chmod 0644 "$DEPLOY_KEY.pub"
scp "$DEPLOY_KEY.pub" "${OCI_MAINTENANCE_USER}@${OCI_DEPLOY_HOST}:/tmp/carplate-deploy.pub"
```

Move only the public key into a root-owned staging path.

**[Oracle]**

```bash
# [Oracle]
sudo install -m 0600 -o root -g root /tmp/carplate-deploy.pub /root/carplate-deploy.pub
rm -f /tmp/carplate-deploy.pub
sudo ssh-keygen -lf /root/carplate-deploy.pub
```

## 8. Verify and save the SSH host key

Read the server's Ed25519 fingerprint through the already trusted maintenance session or Oracle console.

**[Oracle]**

```bash
# [Oracle]
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Fetch the public host key on the MacBook, display its fingerprint, and compare it character-for-character with the trusted Oracle result. Delete the file and investigate if they differ.

**[MacBook]**

```bash
# [MacBook]
umask 077
ssh-keyscan -T 10 -t ed25519 "$OCI_DEPLOY_HOST" > "$DEPLOY_KNOWN_HOSTS"
chmod 0600 "$DEPLOY_KNOWN_HOSTS"
ssh-keygen -lf "$DEPLOY_KNOWN_HOSTS"
```

The workflow uses this pre-verified entry with `StrictHostKeyChecking=yes`; it never learns or accepts a host key during deployment.

## 9. Run the explicit privileged bootstrap

The bootstrap creates three isolated system users:

- `carplate`: no login shell; reads production credentials and writes only runtime coordination state.
- `carplate-build`: no login shell; builds without production credentials and writes only candidate/package-store paths.
- `carplate-deploy`: locked password and `/bin/sh` only so OpenSSH can enter the forced command; no general sudo and no interactive SSH command.

It creates and owns these production paths:

- `/opt/naver-smartstore-car-plate-tracker`: root-owned bare mirror, candidates, package store, immutable releases, and `current`/`previous` links.
- `/etc/naver-smartstore-car-plate-tracker`: `app.env`, Google credential, and root-controlled deploy authorized key.
- `/var/lib/naver-smartstore-car-plate-tracker/runtime`: `root:carplate` mode `2770`; shared sync lock only.
- `/var/lib/naver-smartstore-car-plate-tracker/deployment`: `root:root` mode `0700`; deployment lock, durable marker, and activation state.
- `/usr/local/sbin` and `/usr/local/lib/naver-smartstore-car-plate-tracker`: installed root-owned deploy, recovery, build, and helper programs.

Run bootstrap from the reviewed checkout. It copies the current environment to `app.env`, removes both Google credential variables from that copy, and adds the protected file path. The destination secret files become `root:carplate` mode `0640`.

`CARPLATE_INITIAL_RELEASE_SOURCE` and `CARPLATE_REVIEWED_SCRIPT_DIR` must both resolve outside `/opt/naver-smartstore-car-plate-tracker`. Do not bypass that isolation check.

**[Oracle]**

```bash
# [Oracle]
cd "$CURRENT_CHECKOUT"
sudo env \
  CARPLATE_ENV_SOURCE="$ENV_SOURCE" \
  CARPLATE_GOOGLE_JSON_SOURCE="$GOOGLE_JSON_SOURCE" \
  CARPLATE_AUTHORIZED_KEY_SOURCE=/root/carplate-deploy.pub \
  CARPLATE_INITIAL_RELEASE_SOURCE="$CURRENT_CHECKOUT" \
  CARPLATE_REVIEWED_SCRIPT_DIR="$CURRENT_CHECKOUT/ops/deployment" \
  /usr/bin/bash "$CURRENT_CHECKOUT/ops/deployment/bootstrap.sh"
```

Bootstrap is repeat-safe only when existing markers, links, releases, accounts, and source files still satisfy the validated contract. It fails closed on disagreement. Do not delete state merely to make a rerun pass.

Verify users, ownership, installed policy, the initial release, and the compiled service without displaying secrets.

**[Oracle]**

```bash
# [Oracle]
id carplate
id carplate-build
id carplate-deploy
sudo stat -c '%A %U:%G %n' \
  /opt/naver-smartstore-car-plate-tracker \
  /etc/naver-smartstore-car-plate-tracker/app.env \
  /etc/naver-smartstore-car-plate-tracker/google-service-account.json \
  /etc/naver-smartstore-car-plate-tracker/ssh/carplate-deploy \
  /var/lib/naver-smartstore-car-plate-tracker/runtime \
  /var/lib/naver-smartstore-car-plate-tracker/deployment \
  /usr/local/sbin/car-plate-tracker-deploy-entrypoint \
  /usr/local/sbin/deploy-car-plate-tracker \
  /usr/local/sbin/recover-car-plate-tracker
sudo -u carplate test -r /etc/naver-smartstore-car-plate-tracker/app.env
sudo -u carplate-build test ! -r /etc/naver-smartstore-car-plate-tracker/app.env
sudo -u carplate-deploy test ! -r /etc/naver-smartstore-car-plate-tracker/app.env
sudo sshd -t
sudo visudo -cf /etc/sudoers.d/carplate-deploy
sudo systemctl is-enabled car-plate-tracker.service
sudo systemctl is-active car-plate-tracker.service
sudo systemctl show car-plate-tracker.service --property=ActiveState,SubState,MainPID,NRestarts,InvocationID
sudo readlink /opt/naver-smartstore-car-plate-tracker/current
sudo cat /var/lib/naver-smartstore-car-plate-tracker/deployment/deployed-sha
test "$(sudo cat /var/lib/naver-smartstore-car-plate-tracker/deployment/deployed-sha)" = "$(git -C "$CURRENT_CHECKOUT" rev-parse HEAD)"
sudo journalctl -u car-plate-tracker.service -n 30 --no-pager --output=cat
```

The current invocation must log `scheduler started` with `mode: live`, the configured cron, and the initial `APP_REVISION`. Keep detailed journal output on Oracle; it can contain operational metadata that is intentionally excluded from public Actions logs.

After the protected `/etc` copies and service have been verified, remove the working checkout's duplicate secret files. The root-only backup remains available until the migration, reboot, and live smoke test all pass.

**[Oracle]**

```bash
# [Oracle]
sudo test -r /etc/naver-smartstore-car-plate-tracker/app.env
sudo test -r /etc/naver-smartstore-car-plate-tracker/google-service-account.json
sudo rm -f -- "$ENV_SOURCE"
case "$GOOGLE_JSON_SOURCE" in
  "$CURRENT_CHECKOUT"/*) sudo rm -f -- "$GOOGLE_JSON_SOURCE" ;;
esac
test ! -e "$CURRENT_CHECKOUT/.env"
test ! -e "$CURRENT_CHECKOUT/google-service-account.json"
```

## 10. Create the GitHub production environment

Create an environment named exactly `production`, restrict deployment branches to `main`, and add exactly these four environment secrets:

| Secret                       | Value to enter                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `OCI_DEPLOY_HOST`            | The reserved Oracle host name or public IP used in `known_hosts`               |
| `OCI_DEPLOY_USER`            | Literal value `carplate-deploy`                                                |
| `OCI_DEPLOY_SSH_PRIVATE_KEY` | Complete dedicated private key from `DEPLOY_KEY`, including its boundary lines |
| `OCI_DEPLOY_KNOWN_HOSTS`     | Complete verified line from `DEPLOY_KNOWN_HOSTS`                               |

Do not add Naver credentials, Google credentials, spreadsheet IDs, `.env` content, or a personal OCI private key.

**[GitHub UI]** Open repository **Settings > Environments > New environment**, enter `production`, then choose **Selected branches and tags** and allow only `main`.

**[GitHub UI]** Under **Environment secrets**, create the four values in the table. Use required reviewers only when another trusted maintainer is available and the repository plan permits that approval flow.

Use the clipboard so the private key is not printed into terminal scrollback.

**[MacBook]**

```bash
# [MacBook]
pbcopy < "$DEPLOY_KEY"
```

After saving the private-key secret, copy the verified host-key entry.

**[MacBook]**

```bash
# [MacBook]
pbcopy < "$DEPLOY_KNOWN_HOSTS"
```

## 11. Protect `main` and require merge commits for PR #2

**[GitHub UI]** Open **Settings > Branches** or **Settings > Rules > Rulesets** and create protection for `main` with these rules:

1. Require a pull request before merging.
2. Require the status check named `Verify` to pass.
3. Require conversation resolution.
4. Block force pushes.
5. Block branch deletion.
6. Disallow bypass when repository ownership and emergency access policy permit it.
7. Require CODEOWNERS approval when a second trusted code owner is available.

**[GitHub UI]** Confirm PR #2 shows the `Verify` check. The workflow verifies pull requests but cannot deploy them; only a verified push to `main` or a `main` `workflow_dispatch` reaches the production environment.

**[GitHub UI]** Open **Settings > General > Pull Requests** and ensure **Allow merge commits** is enabled. For this migration, do not use **Squash merging** or **Rebase merging**. Disable those methods temporarily if that is the clearest way to prevent an accidental choice.

## 12. Merge PR #2 with a merge commit and run the first workflow dispatch

**[GitHub UI]** Merge PR #2 only after bootstrap, environment secrets, and branch protection are complete. Select **Create a merge commit**. Do not select **Squash and merge** or **Rebase and merge**.

The merge commit must contain the initial deployed PR-head SHA as an ancestor. This is not a style preference: the deployer allows only a forward descendant of `deployed-sha`. A squash or rebase merge makes the new `main` tip divergent from the bootstrap marker and the first automatic deployment fails closed.

Wait for the push-to-`main` workflow. That successful push normally performs the first automated deployment, so do not start a concurrent manual run.

If the push workflow was skipped or must be retried, manually deploy current `main`.

**[GitHub UI]** Open **Actions > Production Deployment > Run workflow**, select branch `main`, and choose **Run workflow**. A non-`main` manual ref is rejected.

The deploy job prints one allowlisted result containing only `outcome`, requested SHA, previous SHA, activated SHA, and a diagnostic ID. Interpret `outcome` as follows:

| Outcome                         | Meaning                                                                                                                      | Action                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `deployed`                      | New forward revision was built, activated, and stable for the health window.                                                 | Verify Oracle state, then continue.                                |
| `unchanged`                     | That revision was already deployed.                                                                                          | Successful no-op.                                                  |
| `superseded`                    | A newer descendant is already deployed.                                                                                      | Successful no-op; production did not move backward.                |
| `candidate_failed_restarted`    | Install/build/seal failed; the existing release restarted and passed health.                                                 | Inspect Oracle diagnostics and fix the candidate.                  |
| `activation_failed_rolled_back` | Candidate start/health failed; the previous release was restored and verified.                                               | Inspect the candidate and keep production on the previous release. |
| `deployment_failed`             | Deployment failed before a service recovery transition was required.                                                         | Inspect preflight, revision, layout, and lock state.               |
| `deployment_failed_recovered`   | An unexpected deployment failure occurred after stop/activation began, and emergency recovery restored the previous release. | Inspect Oracle before retrying.                                    |
| `deployment_recovery_failed`    | Deployment failed and no release could be verified as active.                                                                | Treat as an incident and use the maintenance login immediately.    |

Candidate and recovery outcomes return a failing workflow even when the previous release was restored. That is intentional.

Verify the durable marker, symlink, service, and current invocation on Oracle.

**[Oracle]**

```bash
# [Oracle]
sudo systemctl is-active car-plate-tracker.service
sudo systemctl show car-plate-tracker.service --property=ActiveState,SubState,MainPID,NRestarts,InvocationID
sudo readlink /opt/naver-smartstore-car-plate-tracker/current
sudo cat /var/lib/naver-smartstore-car-plate-tracker/deployment/deployed-sha
sudo journalctl -u car-plate-tracker.service -n 30 --no-pager --output=cat
```

The `current` target, `deployed-sha`, startup log `APP_REVISION`, and Actions `activatedSha` must agree.

## 13. Verify operation after a reboot

Reboot only after the first automated deployment is healthy and no synchronization or deployment is running.

**[Oracle]**

```bash
# [Oracle]
sudo systemctl is-active car-plate-tracker.service
sudo test ! -e /var/lib/naver-smartstore-car-plate-tracker/deployment/activation-state
sudo reboot
```

Reconnect with the personal maintenance account, then verify recovery ran before the scheduler and the service remained enabled.

**[MacBook]**

```bash
# [MacBook]
ssh "${OCI_MAINTENANCE_USER}@${OCI_DEPLOY_HOST}"
```

**[Oracle]**

```bash
# [Oracle]
sudo systemctl is-enabled car-plate-tracker.service
sudo systemctl is-active car-plate-tracker.service
sudo systemctl status car-plate-tracker-recover.service --no-pager
sudo systemctl show car-plate-tracker.service --property=ActiveState,SubState,MainPID,NRestarts,InvocationID
sudo readlink /opt/naver-smartstore-car-plate-tracker/current
sudo cat /var/lib/naver-smartstore-car-plate-tracker/deployment/deployed-sha
sudo swapon --show
sudo journalctl -b -u car-plate-tracker-recover.service -u car-plate-tracker.service --no-pager --output=cat
```

## 14. Run the rollback and crash-recovery drill

Do not create a deliberately broken production commit and do not manually relink `current` as a beginner exercise. The safe repeatable drill executes the same deployer and recovery sources against isolated temporary Git, filesystem, process, and systemd shims.

**[MacBook]**

```bash
# [MacBook]
pnpm vitest run tests/deployment/deployer.integration.test.ts -t "rolls back activation without another fetch or build and verifies the rollback invocation"
pnpm vitest run tests/deployment/recovery.test.ts
```

After at least two successful production releases, verify that both known-good links point inside `releases/`. This is readiness evidence, not a request to activate `previous`.

**[Oracle]**

```bash
# [Oracle]
sudo readlink /opt/naver-smartstore-car-plate-tracker/current
sudo readlink /opt/naver-smartstore-car-plate-tracker/previous
sudo find /opt/naver-smartstore-car-plate-tracker/releases -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort
```

Routine deployment intentionally rejects historical rollback: asking for an ancestor returns `superseded` and leaves production unchanged. A real historical rollback is privileged incident response that must preserve the deployment lock, durable marker, activation state, and invocation health contract; do not improvise it with `ln -s`.

## 15. Routine deployment and manual operations

The normal operation is to merge a verified PR into `main`. GitHub-hosted runners verify and deploy; no MacBook process is involved. PR #2 specifically requires a merge commit because its head is the bootstrap marker. Later merge policy may change only after the durable deployed SHA already belongs to `main` history and the ancestry consequences have been reviewed.

**[GitHub UI]** For a manual redeploy of current `main`, use **Actions > Production Deployment > Run workflow** on `main`. This still runs the complete verification job first.

If GitHub Actions is unavailable and an incident commander authorizes a server-side forward deploy, use only the locked root deployer with an exact SHA already present on `origin/main`.

**[Oracle]**

```bash
# [Oracle]
export REQUESTED_SHA="replace-with-40-character-lowercase-main-sha"
printf '%s\n' "$REQUESTED_SHA" | grep -Ex '[0-9a-f]{40}'
sudo /usr/local/sbin/deploy-car-plate-tracker "$REQUESTED_SHA"
```

Never stop the service and replace release files by hand for a code deployment.

For a deliberate one-time production sync, stop the scheduler so it cannot create a new cron run, then run the compiled CLI in a transient unit with the same environment and shared `SYNC_LOCK_DIR`. Always restart the scheduler even if the CLI fails.

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

The CLI and scheduler both acquire `/var/lib/naver-smartstore-car-plate-tracker/runtime/sync.lock`. A lock failure is a safety stop, not permission to delete the lock directory manually.

## 16. Rotate the deploy key or privileged installation

Routine `main` deployments never install changed files from `ops/deployment/`. Any change to deployment scripts, systemd units, SSH restrictions, sudoers, or production secrets requires a reviewed maintenance window and an explicit bootstrap rerun.

For key rotation, first generate a second dedicated key and transfer only its public half.

**[MacBook]**

```bash
# [MacBook]
export ROTATED_DEPLOY_KEY="$HOME/.ssh/carplate-github-deploy-rotated"
umask 077
test ! -e "$ROTATED_DEPLOY_KEY"
ssh-keygen -t ed25519 -a 100 -f "$ROTATED_DEPLOY_KEY" -C "github-actions-carplate-production-rotated"
scp "$ROTATED_DEPLOY_KEY.pub" "${OCI_MAINTENANCE_USER}@${OCI_DEPLOY_HOST}:/tmp/carplate-deploy-rotated.pub"
```

Stage protected copies of the current runtime configuration, then rerun reviewed bootstrap with the new public key. Freeze merges during this short window because only one deployment key is accepted.

**[Oracle]**

```bash
# [Oracle]
sudo install -d -m 0700 -o root -g root /root/carplate-bootstrap-rotation
sudo install -m 0600 -o root -g root /etc/naver-smartstore-car-plate-tracker/app.env /root/carplate-bootstrap-rotation/app.env
sudo install -m 0600 -o root -g root /etc/naver-smartstore-car-plate-tracker/google-service-account.json /root/carplate-bootstrap-rotation/google-service-account.json
sudo install -m 0600 -o root -g root /tmp/carplate-deploy-rotated.pub /root/carplate-bootstrap-rotation/deploy.pub
rm -f /tmp/carplate-deploy-rotated.pub
cd "$CURRENT_CHECKOUT"
sudo env \
  CARPLATE_ENV_SOURCE=/root/carplate-bootstrap-rotation/app.env \
  CARPLATE_GOOGLE_JSON_SOURCE=/root/carplate-bootstrap-rotation/google-service-account.json \
  CARPLATE_AUTHORIZED_KEY_SOURCE=/root/carplate-bootstrap-rotation/deploy.pub \
  CARPLATE_INITIAL_RELEASE_SOURCE="$CURRENT_CHECKOUT" \
  CARPLATE_REVIEWED_SCRIPT_DIR="$CURRENT_CHECKOUT/ops/deployment" \
  /usr/bin/bash "$CURRENT_CHECKOUT/ops/deployment/bootstrap.sh"
sudo sshd -t
sudo visudo -cf /etc/sudoers.d/carplate-deploy
sudo systemctl is-active car-plate-tracker.service
```

**[GitHub UI]** Replace only `OCI_DEPLOY_SSH_PRIVATE_KEY` with the complete rotated private key, then run `workflow_dispatch` on `main`.

After the new key succeeds, delete the old private key and rotation staging files.

**[MacBook]**

```bash
# [MacBook]
rm -f "$DEPLOY_KEY" "$DEPLOY_KEY.pub"
```

**[Oracle]**

```bash
# [Oracle]
sudo find /root/carplate-bootstrap-rotation -type f -exec shred -u -- {} +
sudo rmdir /root/carplate-bootstrap-rotation
```

Rotate `OCI_DEPLOY_KNOWN_HOSTS` only after a host-key change is independently verified through the Oracle console or another trusted path. Naver and Google credential rotation updates `/etc` through the same explicit maintenance process, followed by the fixed-IP live smoke test.

## 17. Diagnostics

Start with read-only state. Do not paste full journal output into a public issue or Action log.

**[Oracle]**

```bash
# [Oracle]
sudo systemctl status car-plate-tracker.service car-plate-tracker-recover.service --no-pager
sudo systemctl show car-plate-tracker.service --property=ActiveState,SubState,MainPID,NRestarts,InvocationID,ExecMainStatus
sudo journalctl -u car-plate-tracker.service -n 100 --no-pager --output=cat
sudo readlink /opt/naver-smartstore-car-plate-tracker/current
sudo readlink /opt/naver-smartstore-car-plate-tracker/previous 2>/dev/null || true
sudo cat /var/lib/naver-smartstore-car-plate-tracker/deployment/deployed-sha
sudo test ! -e /var/lib/naver-smartstore-car-plate-tracker/deployment/activation-state
sudo swapon --show
df -h /opt/naver-smartstore-car-plate-tracker
awk '$1 == "MemAvailable:" { print }' /proc/meminfo
sudo systemd-analyze security car-plate-tracker.service --no-pager
sudo sshd -T -C user=carplate-deploy,host=localhost,addr=127.0.0.1 | grep -E 'authorizedkeysfile|authenticationmethods|passwordauthentication|permittty|allowtcpforwarding|x11forwarding|permituserrc|gatewayports'
sudo visudo -cf /etc/sudoers.d/carplate-deploy
```

Useful distinctions:

- A missing or mismatched `deployed-sha`, `current`, or `release.env` is deployment-state corruption. Recovery fails closed instead of guessing.
- A present `activation-state` means activation was interrupted. The recovery unit should reconcile it before the scheduler starts.
- `candidate_failed_restarted` points to dependency install, build, syntax, sealing, disk, memory, swap, timeout, or isolation validation before activation.
- `activation_failed_rolled_back` points to service start or invocation health after `current` changed.
- `deployment_recovery_failed` means no release passed health and needs immediate maintenance.
- `scheduled sync failed` is an application job failure. A successful scheduler process does not prove Naver, Google, DNS, or the network is healthy.

## 18. What survives a MacBook shutdown, and what does not

After setup, the MacBook may be off. A merge or manual GitHub run executes on a GitHub-hosted runner, connects directly to Oracle with the forced key, and requests one SHA. On Oracle, `systemctl enable` starts the scheduler after VM reboot, the recovery oneshot reconciles interrupted activation first, and `Restart=on-failure` restarts a failed scheduler process.

These controls do not guarantee that the Oracle VM is powered on, GitHub can reach SSH, Naver or Google is available, credentials remain valid, the fixed IP remains allowed, disk space remains sufficient, or every scheduled sync succeeds. The 60-minute systemd stop timeout only allows an active sync to drain; after that timeout deployment fails. Continue monitoring Oracle, GitHub Actions, and the application journal, and use the separate [fixed-IP live smoke test](live-smoke-test.md) for real Naver and Google verification.
