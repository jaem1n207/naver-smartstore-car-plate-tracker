# Automatic Production Deployment Runbook

This is the canonical, ordered migration and operations guide for the Oracle production worker. It is written for a frontend developer who is comfortable with GitHub and a terminal but does not administer Linux every day.

The currently open implementation pull request is **PR #2**. Do not use an older PR number when checking or merging this work.

For a planned workstation replacement, unexpected Mac loss, or maintainer handoff, start with the shorter [maintainer workstation recovery and handoff guide](maintainer-workstation-recovery.md). It identifies which state is authoritative on GitHub or Oracle and prevents unnecessary credential copying or deploy-key replacement.

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
export INITIAL_RELEASE_SOURCE="/srv/carplate-initial-release-source"
export INITIAL_PACKAGE_STORE="/srv/carplate-initial-package-store"
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

## 6. Prepare a secretless initial built checkout

Bootstrap does not run `pnpm install` or `pnpm build` for the initial release. It requires a Git checkout root outside `APP_ROOT` containing `package.json`, `node_modules`, `dist/src/scheduler/main.js`, and a lowercase 40-character `HEAD` SHA. It copies only the built runtime, dependencies, package manifest, optional lockfile, and a generated non-secret `release.env`; it does not copy `.env`, `.git`, or the Google credential into the release.

This is the only PR-before-merge production exception. Continue only when PR #2's `Verify` check is green, all independent code/security/operator reviews are resolved, the exact head SHA below is unchanged, and the repository owner has explicitly approved this migration. Routine pull requests never use this path.

The initial checkout must be a fresh clone containing no `.env`, Google key, exported production data, or untracked files. Create the build identity before bootstrap, clone the exact reviewed PR head as that identity, fetch packages with lifecycle scripts disabled, install from the fetched cache offline, run verification and build, then prune development dependencies. Do not build from the moved legacy checkout.

**[Oracle]**

```bash
# [Oracle]
sudo getent group carplate-build >/dev/null 2>&1 || sudo groupadd --system carplate-build
if ! id -u carplate-build >/dev/null 2>&1; then
  sudo useradd --system --gid carplate-build --home-dir /nonexistent --no-create-home \
    --shell /usr/sbin/nologin carplate-build
fi
sudo test ! -e "$INITIAL_RELEASE_SOURCE"
sudo install -d -m 0755 -o carplate-build -g carplate-build "$INITIAL_RELEASE_SOURCE"
sudo install -d -m 0700 -o carplate-build -g carplate-build "$INITIAL_PACKAGE_STORE"
sudo -u carplate-build -H git clone --branch naver-smartstore-car-plate-tracker-mvp \
  --single-branch https://github.com/jaem1n207/naver-smartstore-car-plate-tracker.git \
  "$INITIAL_RELEASE_SOURCE"
cd "$INITIAL_RELEASE_SOURCE"
test -z "$(sudo -u carplate-build -H git status --porcelain)"
sudo -u carplate-build -H git fetch origin naver-smartstore-car-plate-tracker-mvp
sudo -u carplate-build -H git merge --ff-only origin/naver-smartstore-car-plate-tracker-mvp
test "$(sudo -u carplate-build -H git rev-parse HEAD)" = \
  "$(sudo -u carplate-build -H git rev-parse origin/naver-smartstore-car-plate-tracker-mvp)"
export INITIAL_DEPLOYED_SHA="$(sudo -u carplate-build -H git rev-parse HEAD)"
printf '%s\n' "$INITIAL_DEPLOYED_SHA" | grep -Ex '[0-9a-f]{40}'
test ! -e .env
test ! -e google-service-account.json
if grep -Eiq '(https?://|git\+|tarball:)' pnpm-lock.yaml; then exit 1; fi
sudo systemd-run --wait --collect --service-type=exec \
  --uid=carplate-build --gid=carplate-build --working-directory="$INITIAL_RELEASE_SOURCE" \
  --property=MemoryMax=600M --property=MemorySwapMax=1G --property=TasksMax=64 \
  --property=LimitFSIZE=536870912 --property=ProtectSystem=strict --property=ProtectHome=true \
  --property=PrivateTmp=true --property=NoNewPrivileges=true \
  --property=IPAddressAllow=127.0.0.53/32 --property=IPAddressAllow=::1/128 \
  --property=IPAddressDeny=127.0.0.0/8 --property=IPAddressDeny=10.0.0.0/8 \
  --property=IPAddressDeny=172.16.0.0/12 --property=IPAddressDeny=192.168.0.0/16 \
  --property=IPAddressDeny=169.254.0.0/16 --property=IPAddressDeny=::1/128 \
  --property=IPAddressDeny=fc00::/7 --property=IPAddressDeny=fe80::/10 \
  --property="ReadWritePaths=$INITIAL_RELEASE_SOURCE" \
  --property="ReadWritePaths=$INITIAL_PACKAGE_STORE" \
  --setenv="HOME=$INITIAL_PACKAGE_STORE/home" \
  --setenv="PNPM_HOME=$INITIAL_PACKAGE_STORE/pnpm-home" \
  --setenv="PNPM_STORE_DIR=$INITIAL_PACKAGE_STORE/store" \
  --setenv=npm_config_registry=https://registry.npmjs.org/ --setenv=npm_config_strict_ssl=true \
  /usr/local/bin/pnpm fetch --frozen-lockfile --ignore-scripts

The fetch sandbox allows only the local DNS stub addresses needed by Ubuntu's
`systemd-resolved` (`127.0.0.53` and IPv6 loopback) and denies other loopback,
private, and link-local ranges. This keeps registry DNS resolution working
without allowing package fetches to reach Oracle metadata or private network
services.

sudo systemd-run --wait --collect --service-type=exec \
  --uid=carplate-build --gid=carplate-build --working-directory="$INITIAL_RELEASE_SOURCE" \
  --property=MemoryMax=900M --property=MemorySwapMax=2G --property=TasksMax=128 \
  --property=LimitFSIZE=536870912 --property=ProtectSystem=strict --property=ProtectHome=true \
  --property=PrivateTmp=true --property=PrivateNetwork=true --property=NoNewPrivileges=true \
  --property="ReadWritePaths=$INITIAL_RELEASE_SOURCE" \
  --property="ReadWritePaths=$INITIAL_PACKAGE_STORE" \
  --setenv="HOME=$INITIAL_PACKAGE_STORE/home" \
  --setenv="PNPM_HOME=$INITIAL_PACKAGE_STORE/pnpm-home" \
  --setenv="PNPM_STORE_DIR=$INITIAL_PACKAGE_STORE/store" \
  /usr/bin/bash -Eeuo pipefail -c \
  '/usr/local/bin/pnpm install --offline --frozen-lockfile --ignore-scripts &&
   /usr/local/bin/pnpm test:deployment &&
   /usr/local/bin/pnpm build &&
   /usr/local/bin/pnpm prune --prod'
/usr/bin/node --check dist/src/scheduler/main.js
test -d node_modules
test -f package.json
sudo -u carplate-build -H git rev-parse --verify 'HEAD^{commit}' | grep -Ex '[0-9a-f]{40}'
bash -n ops/deployment/*.sh ops/deployment/lib/*.sh
```

Do not continue unless this checkout is already accepted as the current known-good application revision. Bootstrap validates its structure and then enables the scheduler; it does not call the live Naver API or write the production Sheet as a preflight test.

The checkout remains owned by `carplate-build`. During bootstrap, the root process scopes Git's `safe.directory` exception to this exact `CARPLATE_INITIAL_RELEASE_SOURCE` for the two read-only revision checks. Do not add a global `safe.directory` entry or use the `*` wildcard to bypass Git's ownership protection.

The build account owns this secretless checkout, so root must not execute bootstrap from it. Fetch the same PR head independently into a root-only bare repository, export only `ops/deployment`, and make that reviewed source immutable. This prevents repository or dependency code from replacing a privileged script or systemd unit before bootstrap.

**[Oracle]**

```bash
# [Oracle]
export REVIEWED_REPOSITORY="/root/carplate-reviewed-${INITIAL_DEPLOYED_SHA}.git"
export REVIEWED_SOURCE="/root/carplate-reviewed-${INITIAL_DEPLOYED_SHA}"
sudo test ! -e "$REVIEWED_REPOSITORY"
sudo test ! -e "$REVIEWED_SOURCE"
sudo git init --bare --quiet "$REVIEWED_REPOSITORY"
sudo git --git-dir="$REVIEWED_REPOSITORY" remote add origin \
  https://github.com/jaem1n207/naver-smartstore-car-plate-tracker.git
sudo git --git-dir="$REVIEWED_REPOSITORY" fetch --depth=1 origin \
  refs/heads/naver-smartstore-car-plate-tracker-mvp:refs/heads/reviewed
test "$(sudo git --git-dir="$REVIEWED_REPOSITORY" rev-parse refs/heads/reviewed)" = "$INITIAL_DEPLOYED_SHA"
sudo install -d -m 0555 -o root -g root "$REVIEWED_SOURCE"
sudo git --git-dir="$REVIEWED_REPOSITORY" archive "$INITIAL_DEPLOYED_SHA" ops/deployment |
  sudo tar --extract --directory="$REVIEWED_SOURCE" --no-same-owner
sudo chown -R root:root "$REVIEWED_SOURCE"
sudo find "$REVIEWED_SOURCE" -type d -exec chmod 0555 -- {} +
sudo find "$REVIEWED_SOURCE" -type f -exec chmod 0444 -- {} +
test -z "$(sudo find "$REVIEWED_SOURCE" \( ! -user root -o -perm /022 -o -type l \) -print -quit)"
sudo find "$REVIEWED_SOURCE/ops/deployment" -type f -name '*.sh' -exec bash -n -- {} +
sudo test -f "$REVIEWED_SOURCE/ops/deployment/bootstrap.sh"
sudo test -f "$REVIEWED_SOURCE/ops/deployment/lib/common.sh"
```

## 7. Create the dedicated deploy key

Generate a new key that is not a personal maintenance key and is not reused elsewhere. The private key remains on the MacBook until it is entered into the GitHub `production` environment. GitHub Actions cannot answer a passphrase prompt, so this dedicated non-interactive key intentionally has an empty passphrase and is protected by the environment secret plus the server-side forced command.

**[MacBook]**

```bash
# [MacBook]
umask 077
test ! -e "$DEPLOY_KEY"
ssh-keygen -t ed25519 -a 100 -N '' -f "$DEPLOY_KEY" -C "github-actions-carplate-production"
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
- `/var/lib/naver-smartstore-car-plate-tracker/deployment`: `root:root` mode `0700`; deployment lock, durable release marker, reviewed `privileged-sha`, and activation state.
- `/usr/local/sbin` and `/usr/local/lib/naver-smartstore-car-plate-tracker`: installed root-owned deploy, recovery, build, and helper programs.

Run bootstrap only from the root-owned immutable reviewed source. It copies the current environment to `app.env`, removes both Google credential variables from that copy, and adds the protected file path. The destination secret files become `root:carplate` mode `0640`.

`CARPLATE_INITIAL_RELEASE_SOURCE` and `CARPLATE_REVIEWED_SCRIPT_DIR` must both resolve outside `/opt/naver-smartstore-car-plate-tracker`. Do not bypass that isolation check.

**[Oracle]**

```bash
# [Oracle]
cd /
sudo env \
  CARPLATE_ENV_SOURCE="$ENV_SOURCE" \
  CARPLATE_GOOGLE_JSON_SOURCE="$GOOGLE_JSON_SOURCE" \
  CARPLATE_AUTHORIZED_KEY_SOURCE=/root/carplate-deploy.pub \
  CARPLATE_INITIAL_RELEASE_SOURCE="$INITIAL_RELEASE_SOURCE" \
  CARPLATE_REVIEWED_SCRIPT_DIR="$REVIEWED_SOURCE/ops/deployment" \
  /usr/bin/bash "$REVIEWED_SOURCE/ops/deployment/bootstrap.sh"
```

Bootstrap is repeat-safe only when existing markers, links, releases, accounts, and source files still satisfy the validated contract. It requires every allowlisted file in the immutable reviewed `ops/deployment/` tree to match the same path at `CARPLATE_INITIAL_RELEASE_SOURCE` Git `HEAD`. It fails closed on disagreement. Do not delete state merely to make a rerun pass.

On a maintenance rerun, bootstrap records the active scheduler `InvocationID`, installs the reviewed privileged files, explicitly restarts the service, and refuses success unless a different invocation remains active with the same restart count for the bounded 15-second bootstrap health window. Only after that check succeeds does it atomically write `privileged-sha` for the exact reviewed Git revision. The window allows a cold Node.js process on the free-tier VM to publish its structured startup record without weakening the invocation or restart checks. `enable --now` alone is not treated as proof that an already-running process loaded the new installation.

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

The merge commit must contain the initial deployed PR-head SHA as an ancestor. This is not a style preference: the deployer activates only the exact current `main` tip when it is a forward descendant of `deployed-sha`. A squash or rebase merge makes the new `main` tip divergent from the bootstrap marker and the first automatic deployment fails closed.

Wait for the push-to-`main` workflow. That successful push normally performs the first automated deployment, so do not start a concurrent manual run.

If the push workflow was skipped or must be retried, manually deploy current `main`.

**[GitHub UI]** Open **Actions > Production Deployment > Run workflow**, select branch `main`, and choose **Run workflow**. A non-`main` manual ref is rejected.

The deploy job prints one allowlisted result containing only `outcome`, requested SHA, previous SHA, activated SHA, and a diagnostic ID. Interpret `outcome` as follows:

| Outcome                           | Meaning                                                                                                                                           | Action                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `deployed`                        | New forward revision was built, activated, and stable for the health window.                                                                      | Verify Oracle state, then continue.                                                     |
| `unchanged`                       | That revision was already deployed.                                                                                                               | Successful no-op.                                                                       |
| `superseded`                      | A newer descendant is already deployed.                                                                                                           | Successful no-op; production did not move backward.                                     |
| `privileged_maintenance_required` | The server's reviewed root-owned deployment assets do not match the requested revision. The scheduler was not stopped and no candidate was built. | Freeze merges, run exact-SHA privileged bootstrap, then retry with `workflow_dispatch`. |
| `candidate_failed_restarted`      | Install/build/seal failed; the existing release restarted and passed health.                                                                      | Inspect Oracle diagnostics and fix the candidate.                                       |
| `activation_failed_rolled_back`   | Candidate start/health failed; the previous release was restored and verified.                                                                    | Inspect the candidate and keep production on the previous release.                      |
| `deployment_failed`               | Deployment failed before a service recovery transition was required.                                                                              | Inspect preflight, revision, layout, and lock state.                                    |
| `deployment_failed_recovered`     | An unexpected deployment failure occurred after stop/activation began, and emergency recovery restored the previous release.                      | Inspect Oracle before retrying.                                                         |
| `deployment_recovery_failed`      | Deployment failed and no release could be verified as active.                                                                                     | Treat as an incident and use the maintenance login immediately.                         |

Candidate and recovery outcomes return a failing workflow even when the previous release was restored. That is intentional.

For `candidate_failed_restarted`, copy the 24-character `diagnosticId` from the allowlisted result and inspect only that candidate's fixed stage records and secretless fetch/build journal on Oracle. Keep the journal on Oracle rather than pasting it into a public issue or Actions log.

```bash
# [Oracle]
DIAGNOSTIC_ID=replace-with-24-character-id; sudo journalctl -t "carplate-candidate-${DIAGNOSTIC_ID}" -n 200 --no-pager --output=cat
```

The last fixed stage identifies the boundary without logging paths or credentials. Failure stages are `archive_export_failed`, `dependency_fetch_failed`, `candidate_build_failed`, `build_quiescence_failed`, `candidate_tree_validation_failed`, `required_artifacts_validation_failed`, `release_seal_failed`, and `candidate_quiescence_failed`. A successful candidate ends with `stage=candidate_quiescent`.

Deployers installed before diagnostic correlation was added used the requested SHA in the transient unit names. For one of those older failures, use the `requestedSha` instead.

```bash
# [Oracle]
REQUESTED_SHA=replace-with-40-character-sha; sudo journalctl -u "carplate-fetch-${REQUESTED_SHA}.service" -u "carplate-build-${REQUESTED_SHA}.service" -n 200 --no-pager --output=cat
```

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

Complete the [fixed-IP live smoke test](live-smoke-test.md). Only after the automated deployment, reboot verification, and live Naver/Google synchronization all pass, destroy the duplicate credential backup. Replace the path below with the exact `BACKUP_DIR` created in Step 2.

**[Oracle]**

```bash
# [Oracle]
export BACKUP_DIR="/var/backups/carplate-pre-bootstrap-YYYYMMDDTHHMMSSZ"
sudo test -f "$BACKUP_DIR/app.env"
sudo test -f "$BACKUP_DIR/google-service-account.json"
sudo shred -u -- "$BACKUP_DIR/app.env" "$BACKUP_DIR/google-service-account.json"
sudo rm -f -- "$BACKUP_DIR/car-plate-tracker.service" "$BACKUP_DIR/checkout-sha"
sudo rmdir "$BACKUP_DIR"
```

The dedicated private key is now stored only in the protected GitHub environment and its public half is installed on Oracle. After the automated deployment, reboot verification, and live smoke test have all passed, remove the MacBook copy instead of keeping an undocumented break-glass credential.

**[MacBook]**

```bash
# [MacBook]
test -f "$DEPLOY_KEY"
rm -P -- "$DEPLOY_KEY"
rm -f -- "$DEPLOY_KEY.pub"
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

For a deliberate one-time production sync, stop the scheduler so it cannot create a new cron run, then run the compiled CLI in a transient unit with the same environment and shared `SYNC_LOCK_DIR`. The EXIT trap below restarts the scheduler and verifies a new invocation even when the CLI fails.

**[Oracle]**

```bash
# [Oracle]
sudo /usr/bin/bash -Eeuo pipefail <<'BASH'
service=car-plate-tracker.service
before=$(systemctl show "$service" --property=InvocationID --value)
restart_scheduler() {
  status=$?
  trap - EXIT
  systemctl start "$service" || exit 1
  after=$(systemctl show "$service" --property=InvocationID --value) || exit 1
  [[ $after =~ ^[0-9a-f]{32}$ && $after != "$before" ]] || exit 1
  baseline_restarts=$(systemctl show "$service" --property=NRestarts --value) || exit 1
  expected_pid=$(systemctl show "$service" --property=MainPID --value) || exit 1
  expected_revision=$(sed -n 's/^APP_REVISION=//p' \
    /opt/naver-smartstore-car-plate-tracker/current/release.env)
  expected_cron=$(sed -n 's/^SYNC_CRON=//p' \
    /etc/naver-smartstore-car-plate-tracker/app.env)
  [[ -n $expected_cron ]] || expected_cron='*/5 * * * *'
  [[ $baseline_restarts =~ ^[0-9]+$ && $expected_pid =~ ^[1-9][0-9]*$ ]] || exit 1
  [[ $expected_revision =~ ^[0-9a-f]{40}$ ]] || exit 1
  for _ in $(seq 0 15); do
    systemctl is-active --quiet "$service" || exit 1
    [[ $(systemctl show "$service" --property=SubState --value) == running ]] || exit 1
    [[ $(systemctl show "$service" --property=InvocationID --value) == "$after" ]] || exit 1
    [[ $(systemctl show "$service" --property=NRestarts --value) == "$baseline_restarts" ]] || exit 1
    [[ $(systemctl show "$service" --property=MainPID --value) == "$expected_pid" ]] || exit 1
    sleep 1
  done
  journalctl --no-pager --output=cat "_SYSTEMD_INVOCATION_ID=$after" | python3 -c '
import json
import sys

revision, cron = sys.argv[1:]
found = False
for line in sys.stdin:
    try:
        record = json.loads(line)
    except (json.JSONDecodeError, TypeError):
        continue
    if (
        isinstance(record, dict)
        and record.get("msg") == "scheduler started"
        and record.get("mode") == "live"
        and record.get("cron") == cron
        and record.get("appRevision") == revision
    ):
        found = True
raise SystemExit(0 if found else 1)
' "$expected_revision" "$expected_cron" || exit 1
  exit "$status"
}
trap restart_scheduler EXIT
systemctl stop "$service"
systemd-run --wait --collect --service-type=exec \
  --uid=carplate \
  --gid=carplate \
  --working-directory=/opt/naver-smartstore-car-plate-tracker/current \
  --property=EnvironmentFile=/etc/naver-smartstore-car-plate-tracker/app.env \
  --property=EnvironmentFile=-/opt/naver-smartstore-car-plate-tracker/current/release.env \
  /usr/bin/node /opt/naver-smartstore-car-plate-tracker/current/dist/src/cli/sync-once.js
BASH
```

The CLI and scheduler both acquire `/var/lib/naver-smartstore-car-plate-tracker/runtime/sync.lock`. A lock failure is a safety stop, not permission to delete the lock directory manually.

## 16. Rotate the deploy key or privileged installation

Routine `main` deployments never install changed files from `ops/deployment/`. Any change to deployment scripts, systemd units, SSH restrictions, sudoers, or production secrets requires a reviewed maintenance window and an explicit bootstrap rerun.

The production workflow classifies every `main` push before opening an SSH connection. It uses read-only GitHub Actions metadata to compare the last successful `main` production workflow revision with the requested revision, so a later application-only push cannot hide an earlier uninstalled `ops/deployment/` change. If the workflow cannot establish that trusted revision, it fails closed. When the accumulated range changes `ops/deployment/`, `Verify` still validates the repository, but `Deploy production` stops at **Require reviewed privileged maintenance** with a deliberate failure. This workflow check is early operator feedback, not the authoritative security boundary.

Oracle persists the exact reviewed privileged revision in root-only `/var/lib/naver-smartstore-car-plate-tracker/deployment/privileged-sha`. Bootstrap verifies every installed deployment script and systemd unit against the corresponding Git blob and writes this marker only after the restarted scheduler passes readiness. Before any forward deployment, the root deployer requires the marker to be an ancestor of the request with no `ops/deployment/` difference. Therefore a later application-only push and `workflow_dispatch` both remain blocked until reviewed maintenance succeeds.

Use this order for a privileged-only change:

1. Confirm that `Verify` passed for the merged `main` SHA and that the deployment gate reports `Privileged maintenance required`.
2. Freeze additional merges and record the exact 40-character `main` SHA.
3. Preserve the current protected environment, Google credential, deployment public key, and installed privileged assets in a root-only backup.
4. Prepare a new secretless built checkout at that exact SHA outside managed `/opt`. Repeat the build sandbox from section 6 with `main`, new maintenance-specific source/package-store paths, and require its `HEAD` to equal the recorded SHA. Do not reuse an older checkout or infer equivalence from file contents.
5. Fetch the same exact SHA into a new root-only bare repository, export only `ops/deployment/`, and make the exported tree root-owned and non-writable as shown below.
6. Run `bootstrap.sh` from that immutable reviewed source with the exact built checkout as `CARPLATE_INITIAL_RELEASE_SOURCE`. A maintenance rerun validates the existing known-good release, verifies both source trees describe the same Git revision, installs the reviewed privileged files, requires a new healthy scheduler invocation, and only then records `privileged-sha`.
7. Verify `privileged-sha` equals the maintenance SHA. In GitHub Actions, run **Production Deployment** with `workflow_dispatch` on `main`. Manual dispatch bypasses only the push-history classifier; the server-side marker/tree check still applies. A successful dispatch becomes the next trusted production workflow baseline.
8. Verify `outcome: deployed`, then confirm `deployed-sha`, `current`, the scheduler startup revision, zero unexpected restarts, and an absent `activation-state` file.

Do not repeatedly rerun a gated push before step 5. The same old root-owned deployer will continue to run, so a source-only fix to `ops/deployment/` cannot repair its own production installation.

For key rotation, first generate a second dedicated key and transfer only its public half.

**[MacBook]**

```bash
# [MacBook]
export ROTATED_DEPLOY_KEY="$HOME/.ssh/carplate-github-deploy-rotated"
umask 077
test ! -e "$ROTATED_DEPLOY_KEY"
ssh-keygen -t ed25519 -a 100 -N '' -f "$ROTATED_DEPLOY_KEY" -C "github-actions-carplate-production-rotated"
scp "$ROTATED_DEPLOY_KEY.pub" "${OCI_MAINTENANCE_USER}@${OCI_DEPLOY_HOST}:/tmp/carplate-deploy-rotated.pub"
```

Stage protected copies of the current runtime configuration. Prepare a fresh secretless built checkout at the exact reviewed current `main` SHA by repeating section 6 with `main` and maintenance-specific paths. Then fetch that same SHA into a fresh root-only repository and export an immutable copy of `ops/deployment`. Never rerun root bootstrap from the old writable checkout or from a previously reviewed source. Freeze merges during this short window because only one deployment key is accepted.

**[Oracle]**

```bash
# [Oracle]
sudo install -d -m 0700 -o root -g root /root/carplate-bootstrap-rotation
sudo install -m 0600 -o root -g root /etc/naver-smartstore-car-plate-tracker/app.env /root/carplate-bootstrap-rotation/app.env
sudo install -m 0600 -o root -g root /etc/naver-smartstore-car-plate-tracker/google-service-account.json /root/carplate-bootstrap-rotation/google-service-account.json
sudo install -m 0600 -o root -g root /tmp/carplate-deploy-rotated.pub /root/carplate-bootstrap-rotation/deploy.pub
rm -f /tmp/carplate-deploy-rotated.pub
export MAINTENANCE_SHA="replace-with-reviewed-current-main-sha"
printf '%s\n' "$MAINTENANCE_SHA" | grep -Ex '[0-9a-f]{40}'
export MAINTENANCE_SOURCE="/srv/carplate-maintenance-source-${MAINTENANCE_SHA}"
test "$(sudo -u carplate-build -H git -C "$MAINTENANCE_SOURCE" rev-parse HEAD)" = "$MAINTENANCE_SHA"
sudo test -f "$MAINTENANCE_SOURCE/dist/src/scheduler/main.js"
sudo test -d "$MAINTENANCE_SOURCE/node_modules"
export ROTATION_REPOSITORY="/root/carplate-reviewed-${MAINTENANCE_SHA}.git"
export ROTATION_REVIEWED_SOURCE="/root/carplate-reviewed-${MAINTENANCE_SHA}"
sudo test ! -e "$ROTATION_REPOSITORY"
sudo test ! -e "$ROTATION_REVIEWED_SOURCE"
sudo git init --bare --quiet "$ROTATION_REPOSITORY"
sudo git --git-dir="$ROTATION_REPOSITORY" remote add origin \
  https://github.com/jaem1n207/naver-smartstore-car-plate-tracker.git
sudo git --git-dir="$ROTATION_REPOSITORY" fetch --depth=1 origin \
  refs/heads/main:refs/heads/reviewed
test "$(sudo git --git-dir="$ROTATION_REPOSITORY" rev-parse refs/heads/reviewed)" = "$MAINTENANCE_SHA"
sudo install -d -m 0555 -o root -g root "$ROTATION_REVIEWED_SOURCE"
sudo git --git-dir="$ROTATION_REPOSITORY" archive "$MAINTENANCE_SHA" ops/deployment |
  sudo tar --extract --directory="$ROTATION_REVIEWED_SOURCE" --no-same-owner
sudo chown -R root:root "$ROTATION_REVIEWED_SOURCE"
sudo find "$ROTATION_REVIEWED_SOURCE" -type d -exec chmod 0555 -- {} +
sudo find "$ROTATION_REVIEWED_SOURCE" -type f -exec chmod 0444 -- {} +
test -z "$(sudo find "$ROTATION_REVIEWED_SOURCE" \( ! -user root -o -perm /022 -o -type l \) -print -quit)"
before_invocation=$(sudo systemctl show car-plate-tracker.service --property=InvocationID --value)
cd /
sudo env \
  CARPLATE_ENV_SOURCE=/root/carplate-bootstrap-rotation/app.env \
  CARPLATE_GOOGLE_JSON_SOURCE=/root/carplate-bootstrap-rotation/google-service-account.json \
  CARPLATE_AUTHORIZED_KEY_SOURCE=/root/carplate-bootstrap-rotation/deploy.pub \
  CARPLATE_INITIAL_RELEASE_SOURCE="$MAINTENANCE_SOURCE" \
  CARPLATE_REVIEWED_SCRIPT_DIR="$ROTATION_REVIEWED_SOURCE/ops/deployment" \
  /usr/bin/bash "$ROTATION_REVIEWED_SOURCE/ops/deployment/bootstrap.sh"
test "$(sudo cat /var/lib/naver-smartstore-car-plate-tracker/deployment/privileged-sha)" = "$MAINTENANCE_SHA"
sudo sshd -t
sudo visudo -cf /etc/sudoers.d/carplate-deploy
sudo systemctl is-active car-plate-tracker.service
after_invocation=$(sudo systemctl show car-plate-tracker.service --property=InvocationID --value)
test "$after_invocation" != "$before_invocation"
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

The root-owned reviewed repository and source contain no credentials. Keep them as the maintenance audit record; remove them only under a separate reviewed retention policy.

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
- `candidate_failed_restarted` points to dependency install, build, syntax, sealing, disk, memory, swap, timeout, or isolation validation before activation. Query `carplate-candidate-<diagnosticId>` as shown above; do not rely on a broad text grep because the opaque ID was not previously present in journal messages.
- If the last stage is `candidate_tree_validation_failed`, inspect candidate metadata on Oracle. One known host-dependent cause was GNU tar preserving `0775` directory modes when root extracted `git archive`; the deployer now strips group/other write and special bits immediately after extraction and enforces `UMask=0022` for fetch/build units.
- `activation_failed_rolled_back` points to service start or invocation health after `current` changed.
- `privileged_maintenance_required` means the request was rejected before scheduler stop or candidate build. Check `privileged-sha`, freeze merges, and follow section 16; repeated dispatches cannot bypass this state.
- `deployment_recovery_failed` means no release passed health and needs immediate maintenance.
- `scheduled sync failed` is an application job failure. A successful scheduler process does not prove Naver, Google, DNS, or the network is healthy.

## 18. What survives a MacBook shutdown, and what does not

After setup, the MacBook may be off. A merge or manual GitHub run executes on a GitHub-hosted runner, connects directly to Oracle with the forced key, and requests one SHA. On Oracle, `systemctl enable` starts the scheduler after VM reboot, the recovery oneshot reconciles interrupted activation first, and `Restart=on-failure` restarts a failed scheduler process.

A replacement Mac does not need the GitHub Actions deployment private key, the Oracle runtime `.env`, or the Google service-account JSON. GitHub retains the environment secret for workflow use, while Oracle retains runtime credentials. The replacement workstation needs only personal GitHub access and a separately managed personal Oracle maintenance identity. Follow [Maintainer Workstation Recovery And Handoff](maintainer-workstation-recovery.md) before transferring, revoking, or rotating any key.

These controls do not guarantee that the Oracle VM is powered on, GitHub can reach SSH, Naver or Google is available, credentials remain valid, the fixed IP remains allowed, disk space remains sufficient, or every scheduled sync succeeds. The 60-minute systemd stop timeout only allows an active sync to drain; after that timeout deployment fails. Continue monitoring Oracle, GitHub Actions, and the application journal, and use the separate [fixed-IP live smoke test](live-smoke-test.md) for real Naver and Google verification.
