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

readonly DEPLOYMENT_DIRECTORY=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
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
  local key_comment
  local key_lines

  key_lines=$(wc -l < "$AUTHORIZED_KEY_SOURCE")
  key_lines=${key_lines//[[:space:]]/}
  [[ $key_lines == 1 ]] || die 'deploy key must contain exactly one line'
  key_line=$(<"$AUTHORIZED_KEY_SOURCE")
  read -r key_type key_blob key_comment <<< "$key_line"
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
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    PermitTTY no
    AllowTcpForwarding no
    X11Forwarding no
    PermitUserRC no
    GatewayPorts no
"
  sshd -t -f "$SSHD_CONFIG"
  effective_policy=$(sshd -T -C "user=${CARPLATE_DEPLOY_USER},host=localhost,addr=127.0.0.1" -f "$SSHD_CONFIG")
  for expected in \
    "authorizedkeysfile ${AUTHORIZED_KEYS}" \
    'authenticationmethods publickey' \
    'passwordauthentication no' \
    'kbdinteractiveauthentication no' \
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

has_known_good_marker() {
  local marker="${DEPLOYMENT_STATE_DIRECTORY}/deployed-sha"
  [[ -f $marker && ! -L $marker ]] && grep -qxE '[0-9a-f]{40}' "$marker"
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

main() {
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

  if has_known_good_marker; then
    systemctl enable --now car-plate-tracker.service
  fi
}

main "$@"
