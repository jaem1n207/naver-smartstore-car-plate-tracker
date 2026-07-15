#!/usr/bin/env bash

set -Eeuo pipefail

readonly CARPLATE_RUNTIME_USER=carplate
readonly CARPLATE_BUILD_USER=carplate-build
readonly CARPLATE_DEPLOY_USER=carplate-deploy

if [[ ${CARPLATE_TEST_MODE:-} == 1 ]]; then
  [[ ${CARPLATE_TEST_COMMAND_PATH:-} == /* && -d ${CARPLATE_TEST_COMMAND_PATH} ]] || {
    printf '%s\n' 'CARPLATE_TEST_COMMAND_PATH must name an absolute shim directory' >&2
    exit 1
  }
  PATH="${CARPLATE_TEST_COMMAND_PATH}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
elif (( EUID != 0 )); then
  printf '%s\n' 'bootstrap must run as root' >&2
  exit 1
else
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
fi
export PATH

DEPLOYMENT_DIRECTORY=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly DEPLOYMENT_DIRECTORY
REPOSITORY_ROOT=$(cd -- "${DEPLOYMENT_DIRECTORY}/../.." && pwd -P)
readonly REPOSITORY_ROOT
readonly APP_ROOT=${CARPLATE_APP_ROOT:-/opt/naver-smartstore-car-plate-tracker}
readonly STATE_ROOT=${CARPLATE_STATE_ROOT:-/var/lib/naver-smartstore-car-plate-tracker}
readonly ETC_DIRECTORY=${CARPLATE_ETC_DIR:-/etc/naver-smartstore-car-plate-tracker}
readonly SCRIPT_DIRECTORY=${CARPLATE_SCRIPT_DIR:-/usr/local/lib/naver-smartstore-car-plate-tracker}
readonly PRIVILEGED_EXECUTABLE_DIRECTORY=${CARPLATE_PRIVILEGED_EXECUTABLE_DIR:-/usr/local/sbin}
readonly SYSTEMD_DIRECTORY=${CARPLATE_SYSTEMD_DIR:-/etc/systemd/system}
readonly SSHD_DROPIN=${CARPLATE_SSHD_DROPIN:-/etc/ssh/sshd_config.d/carplate-deploy.conf}
readonly SSHD_CONFIG=${CARPLATE_SSHD_CONFIG:-/etc/ssh/sshd_config}
readonly AUTHORIZED_KEYS=${CARPLATE_AUTHORIZED_KEYS:-/etc/naver-smartstore-car-plate-tracker/ssh/carplate-deploy}
readonly SUDOERS_FILE=${CARPLATE_SUDOERS_FILE:-/etc/sudoers.d/carplate-deploy}
readonly ENVIRONMENT_SOURCE=${CARPLATE_ENV_SOURCE:-"${DEPLOYMENT_DIRECTORY}/../../.env"}
readonly GOOGLE_JSON_SOURCE=${CARPLATE_GOOGLE_JSON_SOURCE:-"${DEPLOYMENT_DIRECTORY}/../../google-service-account.json"}
readonly AUTHORIZED_KEY_SOURCE=${CARPLATE_AUTHORIZED_KEY_SOURCE:-}
readonly REVIEWED_SCRIPT_DIRECTORY=${CARPLATE_REVIEWED_SCRIPT_DIR:-"${DEPLOYMENT_DIRECTORY}"}
readonly REVIEWED_SOURCE_TRUST_ROOT=${CARPLATE_TEST_SOURCE_TRUST_ROOT:-/}
readonly INITIAL_RELEASE_SOURCE=${CARPLATE_INITIAL_RELEASE_SOURCE:-"${REPOSITORY_ROOT}"}
readonly RUNTIME_DIRECTORY="${STATE_ROOT}/runtime"
readonly DEPLOYMENT_STATE_DIRECTORY="${STATE_ROOT}/deployment"
readonly REPOSITORY_DIRECTORY="${APP_ROOT}/repository.git"
readonly CANDIDATES_DIRECTORY="${APP_ROOT}/candidates"
readonly PACKAGE_STORE_DIRECTORY="${APP_ROOT}/package-store"
readonly RELEASES_DIRECTORY="${APP_ROOT}/releases"
readonly GOOGLE_JSON_DESTINATION="${ETC_DIRECTORY}/google-service-account.json"
readonly ENVIRONMENT_DESTINATION="${ETC_DIRECTORY}/app.env"
readonly DEPLOY_ENTRYPOINT="${PRIVILEGED_EXECUTABLE_DIRECTORY}/car-plate-tracker-deploy-entrypoint"
readonly DEPLOYER="${PRIVILEGED_EXECUTABLE_DIRECTORY}/deploy-car-plate-tracker"
readonly RECOVERY_COMMAND="${PRIVILEGED_EXECUTABLE_DIRECTORY}/recover-car-plate-tracker"
readonly PINNED_ORIGIN=https://github.com/jaem1n207/naver-smartstore-car-plate-tracker.git
readonly RUNTIME_SERVICE=car-plate-tracker.service
if [[ ${CARPLATE_TEST_MODE:-} == 1 ]]; then
  BOOTSTRAP_HEALTH_SECONDS=0
else
  BOOTSTRAP_HEALTH_SECONDS=15
fi
readonly BOOTSTRAP_HEALTH_SECONDS

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

require_absolute_path() {
  [[ $# -eq 1 ]] || return 1
  local path=$1
  [[ $path == /* && $path != *$'\n'* && $path != *'//' && $path != */../* && $path != */.. ]] || return 1
}

require_regular_source() {
  [[ $# -eq 1 ]] || return 1
  [[ -f $1 && ! -L $1 && -r $1 ]] || return 1
}

validate_bootstrap_source_boundaries() {
  local source

  for source in \
    "$ENVIRONMENT_SOURCE" \
    "$GOOGLE_JSON_SOURCE" \
    "$AUTHORIZED_KEY_SOURCE" \
    "$REVIEWED_SCRIPT_DIRECTORY" \
    "$INITIAL_RELEASE_SOURCE"; do
    [[ -n $source ]] || continue
    require_absolute_path "$source" || die 'bootstrap source paths must be absolute and normalized'
    [[ $source != "$APP_ROOT" && $source != "$APP_ROOT/"* ]] ||
      die 'bootstrap sources must remain outside the managed application root'
  done
}

validate_reviewed_source_boundary() {
  [[ -d $REVIEWED_SCRIPT_DIRECTORY && ! -L $REVIEWED_SCRIPT_DIRECTORY ]] ||
    die 'reviewed bootstrap source must be a real directory'
  if [[ ${CARPLATE_TEST_MODE:-} != 1 ]]; then
    [[ $REVIEWED_SCRIPT_DIRECTORY == "$DEPLOYMENT_DIRECTORY" ]] ||
      die 'bootstrap must execute from the reviewed deployment source'
  fi

  python3 -c '
import os
import stat
import sys

root = os.path.abspath(sys.argv[1])
expected_uid = int(sys.argv[2])
trust_root = os.path.abspath(sys.argv[3])
if os.path.realpath(trust_root) != trust_root or os.path.commonpath((trust_root, root)) != trust_root:
    raise SystemExit(1)

ancestor = root
while True:
    metadata = os.lstat(ancestor)
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or metadata.st_uid != expected_uid or stat.S_IMODE(metadata.st_mode) & 0o022:
        raise SystemExit(1)
    if ancestor == trust_root:
        break
    parent = os.path.dirname(ancestor)
    if parent == ancestor:
        raise SystemExit(1)
    ancestor = parent

for current, directories, files in os.walk(root, followlinks=False):
    for path in [current, *(os.path.join(current, name) for name in directories + files)]:
        metadata = os.lstat(path)
        if stat.S_ISLNK(metadata.st_mode) or metadata.st_uid != expected_uid or stat.S_IMODE(metadata.st_mode) & 0o022:
            raise SystemExit(1)
' "$REVIEWED_SCRIPT_DIRECTORY" "$EUID" "$REVIEWED_SOURCE_TRUST_ROOT" ||
    die 'reviewed bootstrap source must be owner-controlled and immutable'

  validate_reviewed_sources
}

verify_bootstrap_startup_record() {
  [[ $# -eq 1 ]] || return 1
  local invocation=$1
  local revision
  revision=$(read_current_sha) || return 1

  journalctl --no-pager --output=cat "_SYSTEMD_INVOCATION_ID=$invocation" 2>/dev/null | python3 -c '
import json
import shlex
import sys

environment_path, expected_revision = sys.argv[1:]
expected = {"NAVER_API_MODE": "live", "SYNC_CRON": "*/5 * * * *"}
with open(environment_path, encoding="utf-8") as environment:
    for raw_line in environment:
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, separator, raw_value = line.partition("=")
        if not separator or key not in expected:
            continue
        value = raw_value.strip()
        if value[:1] in (chr(34), chr(39)):
            values = shlex.split(value, comments=True, posix=True)
            value = values[0] if values else ""
        expected[key] = value

found = False
for raw_line in sys.stdin:
    try:
        record = json.loads(raw_line)
    except (json.JSONDecodeError, TypeError):
        continue
    if (
        isinstance(record, dict)
        and record.get("msg") == "scheduler started"
        and record.get("mode") == expected["NAVER_API_MODE"]
        and record.get("cron") == expected["SYNC_CRON"]
        and record.get("appRevision") == expected_revision
    ):
        found = True
raise SystemExit(0 if found else 1)
' "$ENVIRONMENT_DESTINATION" "$revision"
}

ensure_group() {
  [[ $# -eq 1 ]] || return 1
  getent group "$1" >/dev/null 2>&1 || groupadd --system "$1"
}

ensure_user() {
  [[ $# -eq 3 ]] || return 1
  local user=$1
  local group=$2
  local shell=$3

  if ! getent passwd "$user" >/dev/null 2>&1; then
    useradd --system --gid "$group" --home-dir /nonexistent --no-create-home --shell "$shell" "$user"
  fi
  usermod --gid "$group" --groups '' --home /nonexistent --shell "$shell" "$user"
}

isolated_user_uid() {
  [[ $# -eq 2 ]] || return 1
  local user=$1
  local expected_group=$2
  local uid
  local primary_group
  local all_groups

  uid=$(id -u "$user") || die "cannot resolve UID for ${user}"
  [[ $uid =~ ^[1-9][0-9]*$ ]] || die "deployment account UIDs must be distinct nonzero values"
  primary_group=$(id -gn "$user") || die "cannot resolve primary group for ${user}"
  all_groups=$(id -Gn "$user") || die "cannot resolve group memberships for ${user}"
  [[ $primary_group == "$expected_group" ]] || die "unexpected primary group for ${user}"
  [[ $all_groups == "$expected_group" ]] || die "dangerous supplementary groups remain for ${user}"
  printf '%s\n' "$uid"
}

verify_account_isolation() {
  local runtime_uid
  local build_uid
  local deploy_uid

  runtime_uid=$(isolated_user_uid "$CARPLATE_RUNTIME_USER" "$CARPLATE_RUNTIME_USER")
  build_uid=$(isolated_user_uid "$CARPLATE_BUILD_USER" "$CARPLATE_BUILD_USER")
  deploy_uid=$(isolated_user_uid "$CARPLATE_DEPLOY_USER" "$CARPLATE_DEPLOY_USER")
  [[ $runtime_uid != "$build_uid" && $runtime_uid != "$deploy_uid" && $build_uid != "$deploy_uid" ]] ||
    die 'deployment account UIDs must be distinct nonzero values'
}

install_file() {
  [[ $# -eq 4 ]] || return 1
  local source=$1
  local destination=$2
  local mode=$3
  local group=$4
  require_regular_source "$source" || die "refusing non-regular source: $source"
  install -m "$mode" -o root -g "$group" "$source" "$destination"
}

write_managed_file() {
  [[ $# -eq 4 ]] || return 1
  local destination=$1
  local mode=$2
  local group=$3
  local content=$4
  local temporary

  temporary=$(mktemp "${TMPDIR:-/tmp}/carplate-bootstrap.XXXXXXXX")
  trap 'rm -f -- "$temporary"' RETURN
  printf '%s' "$content" > "$temporary"
  install -m "$mode" -o root -g "$group" "$temporary" "$destination"
  rm -f -- "$temporary"
  trap - RETURN
}

validate_reviewed_sources() {
  local relative
  for relative in deploy-entrypoint.sh deploy.sh recover.sh build-candidate.sh lib/common.sh atomic_fs.py; do
    require_regular_source "${REVIEWED_SCRIPT_DIRECTORY}/${relative}" ||
      die "missing reviewed deployment source: ${relative}"
  done

  for relative in deploy-entrypoint.sh deploy.sh recover.sh build-candidate.sh lib/common.sh; do
    bash -n "${REVIEWED_SCRIPT_DIRECTORY}/${relative}"
  done
  python3 -c 'import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))' \
    "${REVIEWED_SCRIPT_DIRECTORY}/atomic_fs.py"
}

install_reviewed_scripts() {
  validate_reviewed_sources
  install -d -m 0755 -o root -g root "$PRIVILEGED_EXECUTABLE_DIRECTORY"
  install -d -m 0755 -o root -g root "$SCRIPT_DIRECTORY"
  install -d -m 0755 -o root -g root "${SCRIPT_DIRECTORY}/lib"
  install_file "${REVIEWED_SCRIPT_DIRECTORY}/deploy-entrypoint.sh" "$DEPLOY_ENTRYPOINT" 0755 root
  install_file "${REVIEWED_SCRIPT_DIRECTORY}/deploy.sh" "$DEPLOYER" 0700 root
  install_file "${REVIEWED_SCRIPT_DIRECTORY}/recover.sh" "$RECOVERY_COMMAND" 0700 root
  install_file "${REVIEWED_SCRIPT_DIRECTORY}/build-candidate.sh" "${SCRIPT_DIRECTORY}/build-candidate.sh" 0750 "$CARPLATE_BUILD_USER"
  install_file "${REVIEWED_SCRIPT_DIRECTORY}/lib/common.sh" "${SCRIPT_DIRECTORY}/lib/common.sh" 0644 root
  install_file "${REVIEWED_SCRIPT_DIRECTORY}/atomic_fs.py" "${SCRIPT_DIRECTORY}/atomic_fs.py" 0700 root
}

install_runtime_configuration() {
  require_regular_source "$ENVIRONMENT_SOURCE" || die "missing environment source"
  require_regular_source "$GOOGLE_JSON_SOURCE" || die "missing Google service-account JSON source"
  [[ -n $AUTHORIZED_KEY_SOURCE ]] || die "CARPLATE_AUTHORIZED_KEY_SOURCE is required"
  require_regular_source "$AUTHORIZED_KEY_SOURCE" || die "missing deploy authorized-key source"

  install -d -m 0755 -o root -g root "$ETC_DIRECTORY"
  install_file "$GOOGLE_JSON_SOURCE" "$GOOGLE_JSON_DESTINATION" 0640 "$CARPLATE_RUNTIME_USER"

  local environment_temporary
  environment_temporary=$(mktemp "${TMPDIR:-/tmp}/carplate-environment.XXXXXXXX")
  trap 'rm -f -- "$environment_temporary"' RETURN
  sed -E '/^(export )?GOOGLE_(APPLICATION_CREDENTIALS|SERVICE_ACCOUNT_JSON_BASE64)=/d' "$ENVIRONMENT_SOURCE" > "$environment_temporary"
  printf 'GOOGLE_APPLICATION_CREDENTIALS=%s\n' "$GOOGLE_JSON_DESTINATION" >> "$environment_temporary"
  install -m 0640 -o root -g "$CARPLATE_RUNTIME_USER" "$environment_temporary" "$ENVIRONMENT_DESTINATION"
  rm -f -- "$environment_temporary"
  trap - RETURN
}

install_ssh_restrictions() {
  local effective_policy
  local key_line
  local key_type
  local key_blob
  local _key_comment
  local key_lines

  key_lines=$(wc -l < "$AUTHORIZED_KEY_SOURCE")
  key_lines=${key_lines//[[:space:]]/}
  [[ $key_lines == 1 ]] || die 'deploy key must contain exactly one line'
  key_line=$(<"$AUTHORIZED_KEY_SOURCE")
  read -r key_type key_blob _key_comment <<< "$key_line"
  [[ $key_type =~ ^(ssh-ed25519|sk-ssh-ed25519@openssh\.com|ecdsa-sha2-nistp256|ssh-rsa)$ ]] ||
    die 'deploy key type is not permitted'
  [[ $key_blob =~ ^[A-Za-z0-9+/=]+$ ]] || die 'deploy key payload is malformed'
  [[ $DEPLOY_ENTRYPOINT != *' '* && $DEPLOY_ENTRYPOINT != *$'\t'* && $DEPLOY_ENTRYPOINT != *'"'* && $DEPLOY_ENTRYPOINT != *\\* ]] ||
    die 'deploy entrypoint cannot be represented safely in forced-command syntax'

  install -d -m 0755 -o root -g root "$(dirname -- "$SSHD_DROPIN")"
  install -d -m 0750 -o root -g "$CARPLATE_DEPLOY_USER" "$(dirname -- "$AUTHORIZED_KEYS")"
  write_managed_file "$AUTHORIZED_KEYS" 0640 "$CARPLATE_DEPLOY_USER" \
    "command=\"${DEPLOY_ENTRYPOINT}\",no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding ${key_line}"$'\n'
  write_managed_file "$SSHD_DROPIN" 0644 root "Match User ${CARPLATE_DEPLOY_USER}
    AuthorizedKeysFile ${AUTHORIZED_KEYS}
    AuthorizedKeysCommand none
    TrustedUserCAKeys none
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    ForceCommand ${DEPLOY_ENTRYPOINT}
    DisableForwarding yes
    PermitTTY no
    AllowTcpForwarding no
    X11Forwarding no
    PermitUserRC no
    GatewayPorts no
Match all
"
  sshd -t -f "$SSHD_CONFIG"
  effective_policy=$(sshd -T -C "user=${CARPLATE_DEPLOY_USER},host=localhost,addr=127.0.0.1" -f "$SSHD_CONFIG")
  for expected in \
    "authorizedkeysfile ${AUTHORIZED_KEYS}" \
    'authorizedkeyscommand none' \
    'trustedusercakeys none' \
    'authenticationmethods publickey' \
    'passwordauthentication no' \
    'kbdinteractiveauthentication no' \
    "forcecommand ${DEPLOY_ENTRYPOINT}" \
    'disableforwarding yes' \
    'permittty no' \
    'allowtcpforwarding no' \
    'x11forwarding no' \
    'permituserrc no' \
    'gatewayports no'; do
    grep -Fqx -- "$expected" <<< "$effective_policy" ||
      die "effective SSH policy mismatch: ${expected}"
  done
  systemctl reload ssh.service
}

install_sudoers_policy() {
  install -d -m 0750 -o root -g root "$(dirname -- "$SUDOERS_FILE")"
  write_managed_file "$SUDOERS_FILE" 0440 root "Defaults:${CARPLATE_DEPLOY_USER} !setenv
${CARPLATE_DEPLOY_USER} ALL=(root) NOPASSWD: NOSETENV: ${DEPLOYER} ^[0-9a-f]{40}$
"
  visudo -cf "$SUDOERS_FILE"
}

install_systemd_units() {
  install -d -m 0755 -o root -g root "$SYSTEMD_DIRECTORY"
  install_file "${DEPLOYMENT_DIRECTORY}/systemd/car-plate-tracker.service" \
    "${SYSTEMD_DIRECTORY}/car-plate-tracker.service" 0644 root
  install_file "${DEPLOYMENT_DIRECTORY}/systemd/car-plate-tracker-recover.service" \
    "${SYSTEMD_DIRECTORY}/car-plate-tracker-recover.service" 0644 root
  systemctl daemon-reload
}

install_application_layout() {
  install -d -m 0755 -o root -g root "$APP_ROOT"
  install -d -m 0710 -o root -g "$CARPLATE_BUILD_USER" "$CANDIDATES_DIRECTORY"
  install -d -m 0710 -o root -g "$CARPLATE_BUILD_USER" "$PACKAGE_STORE_DIRECTORY"
  install -d -m 0755 -o root -g root "$RELEASES_DIRECTORY"

  if [[ ! -d $REPOSITORY_DIRECTORY ]]; then
    (umask 077 && git init --bare --quiet "$REPOSITORY_DIRECTORY")
  fi
  [[ -d $REPOSITORY_DIRECTORY && ! -L $REPOSITORY_DIRECTORY ]] ||
    die 'deployment repository must be a real directory'
  chmod -R go-rwx "$REPOSITORY_DIRECTORY"
  if git --git-dir="$REPOSITORY_DIRECTORY" remote get-url origin >/dev/null 2>&1; then
    git --git-dir="$REPOSITORY_DIRECTORY" remote set-url origin "$PINNED_ORIGIN"
  else
    git --git-dir="$REPOSITORY_DIRECTORY" remote add origin "$PINNED_ORIGIN"
  fi
}

validate_initial_source() {
  local git_root

  require_absolute_path "$INITIAL_RELEASE_SOURCE" || die 'CARPLATE_INITIAL_RELEASE_SOURCE must be an absolute normalized path'
  [[ -d $INITIAL_RELEASE_SOURCE && ! -L $INITIAL_RELEASE_SOURCE ]] ||
    die 'initial release source must be a real directory'
  require_regular_source "${INITIAL_RELEASE_SOURCE}/package.json" ||
    die 'initial release source must contain a regular package.json'
  [[ -d ${INITIAL_RELEASE_SOURCE}/dist && ! -L ${INITIAL_RELEASE_SOURCE}/dist ]] ||
    die 'initial release source must contain a real dist directory'
  require_regular_source "${INITIAL_RELEASE_SOURCE}/dist/src/scheduler/main.js" ||
    die 'initial release source must contain the built scheduler entrypoint'
  [[ -d ${INITIAL_RELEASE_SOURCE}/node_modules && ! -L ${INITIAL_RELEASE_SOURCE}/node_modules ]] ||
    die 'initial release source must contain real node_modules'
  if [[ -e ${INITIAL_RELEASE_SOURCE}/pnpm-lock.yaml || -L ${INITIAL_RELEASE_SOURCE}/pnpm-lock.yaml ]]; then
    require_regular_source "${INITIAL_RELEASE_SOURCE}/pnpm-lock.yaml" ||
      die 'initial release lockfile must be a regular file'
  fi

  git_root=$(git -c "safe.directory=$INITIAL_RELEASE_SOURCE" -C "$INITIAL_RELEASE_SOURCE" \
    rev-parse --show-toplevel 2>/dev/null) ||
    die 'initial release source must be a Git checkout'
  git_root=$(cd -- "$git_root" && pwd -P) || die 'cannot resolve initial release Git root'
  [[ $git_root == "$INITIAL_RELEASE_SOURCE" ]] ||
    die 'initial release source must be the Git checkout root'
}

initial_source_sha() {
  local sha
  sha=$(git -c "safe.directory=$INITIAL_RELEASE_SOURCE" -C "$INITIAL_RELEASE_SOURCE" \
    rev-parse --verify 'HEAD^{commit}' 2>/dev/null) ||
    return 1
  [[ $sha =~ ^[0-9a-f]{40}$ ]] || return 1
  printf '%s\n' "$sha"
}

validate_with_reviewed_common() {
  local candidate=$1
  (
    # shellcheck source=ops/deployment/lib/common.sh
    source "${SCRIPT_DIRECTORY}/lib/common.sh"
    validate_candidate_tree "$candidate"
  )
}

validate_sealed_release_at() {
  local sha=$1
  local release=$2
  local revision
  local unexpected_owner

  [[ $sha =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ -d $release && ! -L $release ]] || return 1
  require_regular_source "$release/package.json" || return 1
  require_regular_source "$release/dist/src/scheduler/main.js" || return 1
  [[ -d $release/node_modules && ! -L $release/node_modules ]] || return 1
  require_regular_source "$release/release.env" || return 1
  IFS= read -r revision <"$release/release.env" || return 1
  [[ $revision == "APP_REVISION=$sha" ]] || return 1
  [[ $(wc -c <"$release/release.env") -eq $((${#revision} + 1)) ]] || return 1
  validate_with_reviewed_common "$release" || return 1
  python3 -c '
import os
import stat
import sys

root = sys.argv[1]
for current, directories, files in os.walk(root, followlinks=False):
    for path in [current, *(os.path.join(current, name) for name in directories + files)]:
        metadata = os.lstat(path)
        if stat.S_ISLNK(metadata.st_mode):
            continue
        expected = 0o550 if stat.S_ISDIR(metadata.st_mode) else 0o440
        if stat.S_IMODE(metadata.st_mode) != expected:
            raise SystemExit(1)
' "$release" || return 1
  if [[ ${CARPLATE_TEST_MODE:-} != 1 ]]; then
    unexpected_owner=$(find "$release" -xdev \( ! -user root -o ! -group "$CARPLATE_RUNTIME_USER" \) -print -quit) ||
      return 1
    [[ -z $unexpected_owner ]] || return 1
  fi
}

validate_sealed_release() {
  local sha=$1
  validate_sealed_release_at "$sha" "${RELEASES_DIRECTORY}/${sha}"
}

read_deployed_sha() {
  local marker="${DEPLOYMENT_STATE_DIRECTORY}/deployed-sha"
  local sha

  [[ -f $marker && ! -L $marker ]] || return 1
  IFS= read -r sha <"$marker" || return 1
  [[ $sha =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ $(wc -c <"$marker") -eq 41 ]] || return 1
  python3 -c '
import os
import stat
import sys

metadata = os.lstat(sys.argv[1])
if stat.S_IMODE(metadata.st_mode) != 0o600:
    raise SystemExit(1)
if sys.argv[2] != "1" and (metadata.st_uid != 0 or metadata.st_gid != 0):
    raise SystemExit(1)
' "$marker" "${CARPLATE_TEST_MODE:-0}" || return 1
  printf '%s\n' "$sha"
}

read_current_sha() {
  local target
  [[ -L ${APP_ROOT}/current ]] || return 1
  target=$(readlink "${APP_ROOT}/current") || return 1
  [[ $target =~ ^releases/([0-9a-f]{40})$ ]] || return 1
  printf '%s\n' "${BASH_REMATCH[1]}"
}

remove_initial_temporary_release() {
  local sha=$1
  local temporary_release="${RELEASES_DIRECTORY}/.${sha}.bootstrap.tmp"

  [[ $sha =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ $temporary_release == "$RELEASES_DIRECTORY"/* && ${temporary_release#"$RELEASES_DIRECTORY"/} != */* ]] ||
    return 1
  if [[ ! -e $temporary_release && ! -L $temporary_release ]]; then
    return 0
  fi
  [[ -d $temporary_release && ! -L $temporary_release ]] || return 1
  find "$temporary_release" -type d -exec chmod u+rwx {} + || return 1
  rm -rf -- "$temporary_release" || return 1
  [[ ! -e $temporary_release && ! -L $temporary_release ]]
}

fsync_directory() {
  python3 -c 'import os,sys; descriptor=os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY); os.fsync(descriptor); os.close(descriptor)' "$1"
}

populate_initial_temporary_release() {
  local sha=$1
  local temporary_release=$2

  mkdir -m 0700 "$temporary_release" || return 1
  COPYFILE_DISABLE=1 cp -R "${INITIAL_RELEASE_SOURCE}/dist" "$temporary_release/dist" || return 1
  COPYFILE_DISABLE=1 cp -R "${INITIAL_RELEASE_SOURCE}/node_modules" "$temporary_release/node_modules" ||
    return 1
  COPYFILE_DISABLE=1 cp "${INITIAL_RELEASE_SOURCE}/package.json" "$temporary_release/package.json" ||
    return 1
  if [[ -f ${INITIAL_RELEASE_SOURCE}/pnpm-lock.yaml && ! -L ${INITIAL_RELEASE_SOURCE}/pnpm-lock.yaml ]]; then
    COPYFILE_DISABLE=1 cp "${INITIAL_RELEASE_SOURCE}/pnpm-lock.yaml" "$temporary_release/pnpm-lock.yaml" ||
      return 1
  fi
  validate_with_reviewed_common "$temporary_release" || return 1
  (
    umask 077
    set -o noclobber
    printf 'APP_REVISION=%s\n' "$sha" >"$temporary_release/release.env"
  ) || return 1
  find "$temporary_release" -type d -exec chmod 0550 {} + || return 1
  find "$temporary_release" -type f -exec chmod 0440 {} + || return 1
  chown -hR "root:${CARPLATE_RUNTIME_USER}" "$temporary_release" || return 1
  validate_sealed_release_at "$sha" "$temporary_release"
}

create_or_validate_initial_release() {
  local sha=$1
  local release="${RELEASES_DIRECTORY}/${sha}"
  local temporary_release="${RELEASES_DIRECTORY}/.${sha}.bootstrap.tmp"

  remove_initial_temporary_release "$sha" || return 1
  if [[ -e $release || -L $release ]]; then
    validate_sealed_release "$sha"
    return
  fi
  if ! populate_initial_temporary_release "$sha" "$temporary_release"; then
    remove_initial_temporary_release "$sha" >/dev/null 2>&1 || true
    return 1
  fi
  mv "$temporary_release" "$release" || return 1
  fsync_directory "$RELEASES_DIRECTORY" || return 1
  validate_sealed_release "$sha"
}

replace_current_atomically() {
  local sha=$1
  python3 "${SCRIPT_DIRECTORY}/atomic_fs.py" --allowed-root "$APP_ROOT" \
    replace-symlink "${APP_ROOT}/current" "releases/${sha}"
}

write_deployed_sha_atomically() {
  local sha=$1
  printf '%s\n' "$sha" | python3 "${SCRIPT_DIRECTORY}/atomic_fs.py" \
    --allowed-root "$STATE_ROOT" write-file "${DEPLOYMENT_STATE_DIRECTORY}/deployed-sha" 0600
}

verify_known_good_baseline() {
  local sha=$1
  local current_sha

  validate_sealed_release "$sha" || return 1
  current_sha=$(read_current_sha) || return 1
  [[ $current_sha == "$sha" ]] || return 1
  [[ $(read_deployed_sha) == "$sha" ]]
}

establish_initial_known_good_release() {
  local marker="${DEPLOYMENT_STATE_DIRECTORY}/deployed-sha"
  local sha
  local current_sha

  if [[ -e $marker || -L $marker ]]; then
    sha=$(read_deployed_sha) || die 'existing deployed-sha marker is invalid'
    remove_initial_temporary_release "$sha" || die 'cannot clean partial initial release'
    validate_sealed_release "$sha" || die 'existing deployed release is invalid'
    if [[ -e ${APP_ROOT}/current || -L ${APP_ROOT}/current ]]; then
      current_sha=$(read_current_sha) || die 'existing current link is invalid'
      [[ $current_sha == "$sha" ]] || die 'existing current link disagrees with deployed-sha'
    else
      replace_current_atomically "$sha" || die 'cannot establish current release link'
    fi
    verify_known_good_baseline "$sha" || die 'known-good deployment baseline verification failed'
    return
  fi

  if [[ -e ${APP_ROOT}/current || -L ${APP_ROOT}/current ]]; then
    sha=$(read_current_sha) || die 'existing current link is invalid'
    remove_initial_temporary_release "$sha" || die 'cannot clean partial initial release'
    validate_sealed_release "$sha" || die 'existing current release is invalid'
    write_deployed_sha_atomically "$sha" || die 'cannot establish deployed-sha marker'
    verify_known_good_baseline "$sha" || die 'known-good deployment baseline verification failed'
    return
  fi

  validate_initial_source
  sha=$(initial_source_sha) || die 'initial release Git HEAD must be a 40-character lowercase SHA'
  create_or_validate_initial_release "$sha" || die 'cannot seal initial release'
  replace_current_atomically "$sha" || die 'cannot establish current release link'
  write_deployed_sha_atomically "$sha" || die 'cannot establish deployed-sha marker'
  verify_known_good_baseline "$sha" || die 'known-good deployment baseline verification failed'
}

main() {
  local previous_invocation=
  local current_invocation
  local service_was_active=0

  require_absolute_path "$APP_ROOT" || die 'CARPLATE_APP_ROOT must be an absolute normalized path'
  require_absolute_path "$STATE_ROOT" || die 'CARPLATE_STATE_ROOT must be an absolute normalized path'
  require_absolute_path "$ETC_DIRECTORY" || die 'CARPLATE_ETC_DIR must be an absolute normalized path'
  require_absolute_path "$SCRIPT_DIRECTORY" || die 'CARPLATE_SCRIPT_DIR must be an absolute normalized path'
  require_absolute_path "$PRIVILEGED_EXECUTABLE_DIRECTORY" ||
    die 'CARPLATE_PRIVILEGED_EXECUTABLE_DIR must be an absolute normalized path'
  require_absolute_path "$SYSTEMD_DIRECTORY" || die 'CARPLATE_SYSTEMD_DIR must be an absolute normalized path'
  require_absolute_path "$SSHD_DROPIN" || die 'CARPLATE_SSHD_DROPIN must be an absolute normalized path'
  require_absolute_path "$SSHD_CONFIG" || die 'CARPLATE_SSHD_CONFIG must be an absolute normalized path'
  require_absolute_path "$AUTHORIZED_KEYS" || die 'CARPLATE_AUTHORIZED_KEYS must be an absolute normalized path'
  require_absolute_path "$SUDOERS_FILE" || die 'CARPLATE_SUDOERS_FILE must be an absolute normalized path'
  validate_bootstrap_source_boundaries
  validate_reviewed_source_boundary

  if systemctl is-active --quiet "$RUNTIME_SERVICE"; then
    service_was_active=1
    previous_invocation=$(systemctl show "$RUNTIME_SERVICE" --property=InvocationID --value) ||
      die 'cannot read the active scheduler invocation before bootstrap'
    [[ $previous_invocation =~ ^[0-9a-f]{32}$ ]] ||
      die 'active scheduler has an invalid invocation identifier'
  fi

  ensure_group "$CARPLATE_RUNTIME_USER"
  ensure_group "$CARPLATE_BUILD_USER"
  ensure_group "$CARPLATE_DEPLOY_USER"
  ensure_user "$CARPLATE_RUNTIME_USER" "$CARPLATE_RUNTIME_USER" /usr/sbin/nologin
  ensure_user "$CARPLATE_BUILD_USER" "$CARPLATE_BUILD_USER" /usr/sbin/nologin
  ensure_user "$CARPLATE_DEPLOY_USER" "$CARPLATE_DEPLOY_USER" /bin/sh
  passwd --lock "$CARPLATE_DEPLOY_USER"
  verify_account_isolation

  install -d -m 0755 -o root -g root "$STATE_ROOT"
  install -d -m 2770 -o root -g "$CARPLATE_RUNTIME_USER" "$RUNTIME_DIRECTORY"
  install -d -m 0700 -o root -g root "$DEPLOYMENT_STATE_DIRECTORY"
  install_application_layout

  install_runtime_configuration
  install_reviewed_scripts
  install_ssh_restrictions
  install_sudoers_policy
  install_systemd_units
  establish_initial_known_good_release

  systemctl enable "$RUNTIME_SERVICE"
  if [[ $service_was_active -eq 1 ]]; then
    systemctl restart "$RUNTIME_SERVICE"
  else
    systemctl start "$RUNTIME_SERVICE"
  fi
  systemctl is-active --quiet "$RUNTIME_SERVICE" || die 'scheduler did not become active after bootstrap'
  current_invocation=$(systemctl show "$RUNTIME_SERVICE" --property=InvocationID --value) ||
    die 'cannot read the scheduler invocation after bootstrap'
  [[ $current_invocation =~ ^[0-9a-f]{32}$ ]] ||
    die 'scheduler has an invalid invocation identifier after bootstrap'
  [[ -z $previous_invocation || $current_invocation != "$previous_invocation" ]] ||
    die 'bootstrap did not create a new scheduler invocation'

  local baseline_restarts
  local observed_invocation
  local observed_restarts
  local elapsed=0
  local startup_record_seen=0
  baseline_restarts=$(systemctl show "$RUNTIME_SERVICE" --property=NRestarts --value) ||
    die 'cannot read the scheduler restart count after bootstrap'
  [[ $baseline_restarts =~ ^[0-9]+$ ]] ||
    die 'scheduler has an invalid restart count after bootstrap'
  while (( elapsed <= BOOTSTRAP_HEALTH_SECONDS )); do
    systemctl is-active --quiet "$RUNTIME_SERVICE" ||
      die 'scheduler did not remain active after bootstrap'
    observed_invocation=$(systemctl show "$RUNTIME_SERVICE" --property=InvocationID --value) ||
      die 'cannot verify the scheduler invocation after bootstrap'
    observed_restarts=$(systemctl show "$RUNTIME_SERVICE" --property=NRestarts --value) ||
      die 'cannot verify the scheduler restart count after bootstrap'
    [[ $observed_invocation == "$current_invocation" && $observed_restarts == "$baseline_restarts" ]] ||
      die 'scheduler restarted during bootstrap health verification'
    if verify_bootstrap_startup_record "$current_invocation"; then
      startup_record_seen=1
    fi
    (( elapsed == BOOTSTRAP_HEALTH_SECONDS )) && break
    sleep 1
    ((elapsed += 1))
  done
  [[ $startup_record_seen -eq 1 ]] || die 'scheduler startup readiness record was not observed'
}

main "$@"
