#!/usr/bin/env bash

set -Eeuo pipefail
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

readonly PRODUCTION_APP_ROOT=/opt/naver-smartstore-car-plate-tracker
readonly PRODUCTION_STATE_ROOT=/var/lib/naver-smartstore-car-plate-tracker/deployment
readonly PRODUCTION_RUNTIME_ROOT=/var/lib/naver-smartstore-car-plate-tracker/runtime
readonly PRODUCTION_REPOSITORY=/opt/naver-smartstore-car-plate-tracker/repository.git
readonly PRODUCTION_APP_ENV=/etc/naver-smartstore-car-plate-tracker/app.env
readonly PRODUCTION_ORIGIN=https://github.com/jaem1n207/naver-smartstore-car-plate-tracker.git
readonly PRODUCTION_ATOMIC_FS=/usr/local/lib/naver-smartstore-car-plate-tracker/atomic_fs.py
readonly PRODUCTION_BUILD_SCRIPT=/usr/local/lib/naver-smartstore-car-plate-tracker/build-candidate.sh
readonly PRODUCTION_SYSTEMCTL=/usr/bin/systemctl
readonly PRODUCTION_SYSTEMD_RUN=/usr/bin/systemd-run
readonly PRODUCTION_JOURNALCTL=/usr/bin/journalctl
readonly PRODUCTION_DF=/usr/bin/df
readonly PRODUCTION_FLOCK=/usr/bin/flock
readonly PRODUCTION_COMMON=/usr/local/lib/naver-smartstore-car-plate-tracker/lib/common.sh
readonly PRODUCTION_SERVICE=car-plate-tracker.service
readonly PRODUCTION_BUILD_USER=carplate-build
readonly PRODUCTION_RELEASE_USER=root
readonly PRODUCTION_RELEASE_GROUP=carplate
readonly MINIMUM_SWAP_KIB=2097152
readonly MINIMUM_DISK_KIB=3145728
readonly MINIMUM_MEMORY_KIB=131072

DEPLOY_SCRIPT_DIRECTORY=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
readonly DEPLOY_SCRIPT_DIRECTORY
if [[ ${BASH_SOURCE[0]} != "$0" ]]; then
  # shellcheck source=ops/deployment/lib/common.sh
  source "$DEPLOY_SCRIPT_DIRECTORY/lib/common.sh"
else
  # shellcheck source=/dev/null
  source "$PRODUCTION_COMMON"
fi

_deploy_is_sourced() {
  [[ ${BASH_SOURCE[0]} != "$0" ]]
}

_deploy_load_configuration() {
  DEPLOY_APP_ROOT=$PRODUCTION_APP_ROOT
  DEPLOY_STATE_ROOT=$PRODUCTION_STATE_ROOT
  DEPLOY_RUNTIME_ROOT=$PRODUCTION_RUNTIME_ROOT
  DEPLOY_REPOSITORY=$PRODUCTION_REPOSITORY
  DEPLOY_APP_ENV=$PRODUCTION_APP_ENV
  DEPLOY_ORIGIN=$PRODUCTION_ORIGIN
  DEPLOY_ATOMIC_FS=$PRODUCTION_ATOMIC_FS
  DEPLOY_BUILD_SCRIPT=$PRODUCTION_BUILD_SCRIPT
  DEPLOY_SYSTEMCTL_COMMAND=$PRODUCTION_SYSTEMCTL
  DEPLOY_SYSTEMD_RUN_COMMAND=$PRODUCTION_SYSTEMD_RUN
  DEPLOY_JOURNALCTL_COMMAND=$PRODUCTION_JOURNALCTL
  DEPLOY_DF_COMMAND=$PRODUCTION_DF
  DEPLOY_FLOCK_COMMAND=$PRODUCTION_FLOCK
  DEPLOY_SERVICE=$PRODUCTION_SERVICE
  DEPLOY_BUILD_USER=$PRODUCTION_BUILD_USER
  DEPLOY_RELEASE_USER=$PRODUCTION_RELEASE_USER
  DEPLOY_RELEASE_GROUP=$PRODUCTION_RELEASE_GROUP
  DEPLOY_EXPECTED_UID=0
  DEPLOY_HEALTH_SECONDS=15
  DEPLOY_SYNCHRONIZATION_WAIT_SECONDS=3600
  DEPLOY_SWAP_FILE=/proc/swaps
  DEPLOY_MEMORY_FILE=/proc/meminfo
  DEPLOY_PROC_ROOT=/proc
  DEPLOY_CGROUP_ROOT=/sys/fs/cgroup/system.slice
  DEPLOY_BUILD_CGROUP_NAME=
  DEPLOY_TEST_CRASH_AFTER=
  DEPLOY_TEST_MODE=0

  if _deploy_is_sourced && [[ -n ${CARPLATE_SOURCE_TEST_CONFIG:-} ]]; then
    DEPLOY_TEST_MODE=1
    # This file is reachable only by a source-based test harness. Executed
    # production entrypoints always reset to the constants above.
    # shellcheck source=/dev/null
    source "$CARPLATE_SOURCE_TEST_CONFIG"
  fi
}

_deploy_reset_runtime_state() {
  DEPLOY_DIAGNOSTIC_ID=
  DEPLOY_REQUESTED_SHA=
  DEPLOY_PREVIOUS_SHA=
  DEPLOY_PRIOR_PREVIOUS_SHA=
  DEPLOY_SYNC_TOKEN=
  DEPLOY_SYNC_TOKEN_FILE=
  DEPLOY_SERVICE_STOPPED=0
  DEPLOY_ACTIVATION_PENDING=0
  DEPLOY_RECOVERY_HANDLED=0
  DEPLOY_RECOVERING=0
  DEPLOY_CRASHED=0
  DEPLOY_TEST_FLOCK_PATH=
  DEPLOY_RESULT_EMITTED=0
  DEPLOY_BUILD_CANDIDATE=
  DEPLOY_BUILD_PACKAGE_STORE=
  DEPLOY_BUILD_ARCHIVE=
  DEPLOY_TEMPORARY_RELEASE=
}

_deploy_validate_layout() {
  [[ $EUID -eq $DEPLOY_EXPECTED_UID ]] || return 1
  [[ $DEPLOY_ORIGIN == "$PRODUCTION_ORIGIN" || $DEPLOY_TEST_MODE -eq 1 ]] || return 1
  [[ $DEPLOY_APP_ROOT == /* && $DEPLOY_STATE_ROOT == /* && $DEPLOY_RUNTIME_ROOT == /* ]] || return 1
  [[ $DEPLOY_REPOSITORY == "$DEPLOY_APP_ROOT/repository.git" ]] || return 1
  [[ -d $DEPLOY_APP_ROOT && ! -L $DEPLOY_APP_ROOT ]] || return 1
  [[ -d $DEPLOY_APP_ROOT/candidates && ! -L $DEPLOY_APP_ROOT/candidates ]] || return 1
  [[ -d $DEPLOY_APP_ROOT/releases && ! -L $DEPLOY_APP_ROOT/releases ]] || return 1
  [[ -d $DEPLOY_STATE_ROOT && ! -L $DEPLOY_STATE_ROOT ]] || return 1
  [[ -d $DEPLOY_RUNTIME_ROOT && ! -L $DEPLOY_RUNTIME_ROOT ]] || return 1
  [[ -d $DEPLOY_REPOSITORY && ! -L $DEPLOY_REPOSITORY ]] || return 1
  [[ -f $DEPLOY_APP_ENV && ! -L $DEPLOY_APP_ENV ]] || return 1
  [[ -f $DEPLOY_ATOMIC_FS && ! -L $DEPLOY_ATOMIC_FS ]] || return 1
  [[ -f $DEPLOY_BUILD_SCRIPT && ! -L $DEPLOY_BUILD_SCRIPT ]] || return 1

  python3 -c '
import os
import stat
import sys

app_root, state_root, runtime_root, repository, expected_uid, test_mode = sys.argv[1:]
protected = (app_root, os.path.join(app_root, "candidates"), os.path.join(app_root, "releases"), repository)
for path in (app_root, state_root, runtime_root, *protected):
    metadata = os.lstat(path)
    if not stat.S_ISDIR(metadata.st_mode) or os.path.realpath(path) != path:
        raise SystemExit(1)
state = os.lstat(state_root)
if state.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
    raise SystemExit(1)
if test_mode == "0":
    if state.st_uid != int(expected_uid) or stat.S_IMODE(state.st_mode) != 0o700:
        raise SystemExit(1)
    for path in protected:
        metadata = os.lstat(path)
        if metadata.st_uid != int(expected_uid) or metadata.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
            raise SystemExit(1)
' "$DEPLOY_APP_ROOT" "$DEPLOY_STATE_ROOT" "$DEPLOY_RUNTIME_ROOT" "$DEPLOY_REPOSITORY" "$DEPLOY_EXPECTED_UID" "$DEPLOY_TEST_MODE"
}

_deploy_acquire_flock() {
  local lock_path=$DEPLOY_STATE_ROOT/deploy.lock
  [[ ! -L $lock_path ]] || return 1

  if [[ $DEPLOY_TEST_MODE -eq 1 ]]; then
    DEPLOY_TEST_FLOCK_PATH=$lock_path.test-flock
    mkdir "$DEPLOY_TEST_FLOCK_PATH" 2>/dev/null || return 1
    return 0
  fi

  umask 077
  exec {DEPLOY_FLOCK_FD}>"$lock_path"
  chmod 0600 "$lock_path"
  "$DEPLOY_FLOCK_COMMAND" -n "$DEPLOY_FLOCK_FD"
}

_deploy_release_flock() {
  if [[ -n ${DEPLOY_TEST_FLOCK_PATH:-} ]]; then
    rmdir "$DEPLOY_TEST_FLOCK_PATH" 2>/dev/null || true
    DEPLOY_TEST_FLOCK_PATH=
  fi
}

_deploy_read_sha_file() {
  [[ $# -eq 1 ]] || return 1
  local path=$1
  local value
  [[ -f $path && ! -L $path ]] || return 1
  IFS= read -r value <"$path" || return 1
  validate_sha "$value" || return 1
  [[ $(wc -l <"$path") -eq 1 ]] || return 1
  printf '%s\n' "$value"
}

_deploy_current_sha() {
  local target
  [[ -L $DEPLOY_APP_ROOT/current ]] || return 1
  target=$(readlink "$DEPLOY_APP_ROOT/current") || return 1
  [[ $target =~ ^releases/([0-9a-f]{40})$ ]] || return 1
  [[ -d $DEPLOY_APP_ROOT/$target && ! -L $DEPLOY_APP_ROOT/$target ]] || return 1
  printf '%s\n' "${BASH_REMATCH[1]}"
}

_deploy_fetch_and_classify() {
  local requested_sha=$1
  local deployed_sha=$2
  local origin_head
  local classification

  git --git-dir="$DEPLOY_REPOSITORY" fetch --force --no-tags "$DEPLOY_ORIGIN" \
    '+refs/heads/main:refs/remotes/origin/main' >/dev/null 2>&1 || return 1
  git --git-dir="$DEPLOY_REPOSITORY" cat-file -e "${requested_sha}^{commit}" 2>/dev/null || return 1
  origin_head=$(git --git-dir="$DEPLOY_REPOSITORY" rev-parse refs/remotes/origin/main 2>/dev/null) || return 1
  git --git-dir="$DEPLOY_REPOSITORY" merge-base --is-ancestor \
    "$requested_sha" "$origin_head" 2>/dev/null || return 1
  if [[ $origin_head != "$requested_sha" ]]; then
    [[ -n $deployed_sha ]] || return 1
    printf 'stale\n'
    return 0
  fi

  if [[ -z $deployed_sha ]]; then
    printf 'initial\n'
    return 0
  fi

  classification=$(classify_revision "$DEPLOY_REPOSITORY" "$deployed_sha" "$requested_sha") || return 1
  printf '%s\n' "$classification"
}

_deploy_request_is_current_main() {
  local requested_sha=$1
  local origin_head

  git --git-dir="$DEPLOY_REPOSITORY" fetch --force --no-tags "$DEPLOY_ORIGIN" \
    '+refs/heads/main:refs/remotes/origin/main' >/dev/null 2>&1 || return 1
  origin_head=$(git --git-dir="$DEPLOY_REPOSITORY" rev-parse refs/remotes/origin/main 2>/dev/null) || return 1
  [[ $origin_head == "$requested_sha" ]]
}

_deploy_preflight() {
  local swap_kib
  local disk_kib
  local memory_kib

  [[ -f $DEPLOY_SWAP_FILE && ! -L $DEPLOY_SWAP_FILE ]] || return 1
  [[ -f $DEPLOY_MEMORY_FILE && ! -L $DEPLOY_MEMORY_FILE ]] || return 1
  swap_kib=$(awk 'NR > 1 { total += $3 } END { print total + 0 }' "$DEPLOY_SWAP_FILE") || return 1
  memory_kib=$(awk '$1 == "MemAvailable:" { print $2; found=1 } END { if (!found) exit 1 }' "$DEPLOY_MEMORY_FILE") || return 1
  disk_kib=$("$DEPLOY_DF_COMMAND" -Pk "$DEPLOY_APP_ROOT" | awk 'NR == 2 { print $4; found=1 } END { if (!found) exit 1 }') || return 1
  [[ $swap_kib =~ ^[0-9]+$ && $swap_kib -ge $MINIMUM_SWAP_KIB ]] || return 1
  [[ $disk_kib =~ ^[0-9]+$ && $disk_kib -ge $MINIMUM_DISK_KIB ]] || return 1
  [[ $memory_kib =~ ^[0-9]+$ && $memory_kib -ge $MINIMUM_MEMORY_KIB ]] || return 1
}

_deploy_acquire_sync_lock() {
  DEPLOY_SYNC_TOKEN_FILE=$DEPLOY_STATE_ROOT/.sync-token.$DEPLOY_DIAGNOSTIC_ID
  umask 077
  : >"$DEPLOY_SYNC_TOKEN_FILE"
  if ! acquire_sync_lock "$DEPLOY_RUNTIME_ROOT/sync.lock" \
    "$DEPLOY_SYNCHRONIZATION_WAIT_SECONDS" >"$DEPLOY_SYNC_TOKEN_FILE"; then
    rm -f "$DEPLOY_SYNC_TOKEN_FILE"
    DEPLOY_SYNC_TOKEN_FILE=
    return 1
  fi
  IFS= read -r DEPLOY_SYNC_TOKEN <"$DEPLOY_SYNC_TOKEN_FILE" || return 1
  rm -f "$DEPLOY_SYNC_TOKEN_FILE"
  DEPLOY_SYNC_TOKEN_FILE=
  [[ $DEPLOY_SYNC_TOKEN =~ ^[0-9a-f]{32}$ ]]
}

_deploy_release_sync_lock() {
  if [[ -n ${DEPLOY_SYNC_TOKEN:-} ]]; then
    release_sync_lock "$DEPLOY_RUNTIME_ROOT/sync.lock" "$DEPLOY_SYNC_TOKEN" >/dev/null 2>&1 || true
    DEPLOY_SYNC_TOKEN=
  fi
  if [[ -n ${DEPLOY_SYNC_TOKEN_FILE:-} ]]; then
    rm -f "$DEPLOY_SYNC_TOKEN_FILE" 2>/dev/null || true
    DEPLOY_SYNC_TOKEN_FILE=
  fi
}

_deploy_remove_direct_child() {
  [[ $# -eq 2 ]] || return 1
  local parent=$1
  local child=$2
  [[ $child == "$parent"/* && ${child#"$parent"/} != */* && -n ${child#"$parent"/} ]] || return 1
  [[ ! -L $child ]] || return 1
  rm -rf -- "$child" >/dev/null 2>&1
}

_deploy_export_candidate() {
  local sha=$1
  local candidate=$DEPLOY_APP_ROOT/candidates/$sha
  local package_store=$DEPLOY_APP_ROOT/package-store/$sha
  local archive=$DEPLOY_STATE_ROOT/.candidate.$DEPLOY_DIAGNOSTIC_ID.tar

  mkdir -p "$DEPLOY_APP_ROOT/package-store"
  [[ -d $DEPLOY_APP_ROOT/package-store && ! -L $DEPLOY_APP_ROOT/package-store ]] || return 1
  _deploy_remove_direct_child "$DEPLOY_APP_ROOT/candidates" "$candidate" || return 1
  _deploy_remove_direct_child "$DEPLOY_APP_ROOT/package-store" "$package_store" || return 1
  mkdir -m 0755 "$candidate" "$package_store"
  DEPLOY_BUILD_ARCHIVE=$archive
  git --git-dir="$DEPLOY_REPOSITORY" archive --format=tar "$sha" >"$archive" 2>/dev/null || return 1
  tar -xf "$archive" -C "$candidate" >/dev/null 2>&1 || return 1
  rm -f "$archive"
  DEPLOY_BUILD_ARCHIVE=

  if [[ -n $DEPLOY_RELEASE_USER ]]; then
    chown -R "$DEPLOY_BUILD_USER:$DEPLOY_BUILD_USER" "$candidate" "$package_store" || return 1
  fi
}

_deploy_run_isolated_build() {
  local sha=$1
  local candidate=$2
  local package_store=$3
  local unit_name=carplate-build-${sha}

  if [[ -n $DEPLOY_BUILD_CGROUP_NAME ]]; then
    unit_name=${DEPLOY_BUILD_CGROUP_NAME%.service}
  fi
  "$DEPLOY_SYSTEMD_RUN_COMMAND" \
    --quiet \
    --wait \
    --collect \
    --unit="$unit_name" \
    --uid="$DEPLOY_BUILD_USER" \
    --gid="$DEPLOY_BUILD_USER" \
    --working-directory="$candidate" \
    --property=Type=exec \
    --property=KillMode=control-group \
    --property=RuntimeMaxSec=30min \
    --property=MemoryMax=900M \
    --property=MemorySwapMax=2G \
    --property=TasksMax=128 \
    --property=LimitFSIZE=536870912 \
    --property=ProtectSystem=strict \
    --property=ProtectHome=true \
    --property=PrivateTmp=true \
    --property=PrivateNetwork=true \
    --property=TemporaryFileSystem=/tmp:size=256M,nr_inodes=65536,mode=1777 \
    --property=NoNewPrivileges=true \
    --property=IPAddressDeny=127.0.0.0/8 \
    --property=IPAddressDeny=10.0.0.0/8 \
    --property=IPAddressDeny=172.16.0.0/12 \
    --property=IPAddressDeny=192.168.0.0/16 \
    --property=IPAddressDeny=169.254.0.0/16 \
    --property=IPAddressDeny=::1/128 \
    --property=IPAddressDeny=fc00::/7 \
    --property=IPAddressDeny=fe80::/10 \
    --property="ReadWritePaths=$candidate" \
    --property="ReadWritePaths=$package_store" \
    --setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    --setenv=CI=1 \
    --setenv=npm_config_registry=https://registry.npmjs.org/ \
    --setenv=npm_config_strict_ssl=true \
    -- "$DEPLOY_BUILD_SCRIPT" build "$candidate" "$package_store" >/dev/null 2>&1
}

_deploy_fetch_dependencies() {
  local sha=$1
  local candidate=$2
  local package_store=$3

  "$DEPLOY_SYSTEMD_RUN_COMMAND" \
    --quiet \
    --wait \
    --collect \
    --unit="carplate-fetch-${sha}" \
    --uid="$DEPLOY_BUILD_USER" \
    --gid="$DEPLOY_BUILD_USER" \
    --working-directory="$candidate" \
    --property=Type=exec \
    --property=KillMode=control-group \
    --property=RuntimeMaxSec=15min \
    --property=MemoryMax=600M \
    --property=MemorySwapMax=1G \
    --property=TasksMax=64 \
    --property=LimitFSIZE=536870912 \
    --property=ProtectSystem=strict \
    --property=ProtectHome=true \
    --property=PrivateTmp=true \
    --property=TemporaryFileSystem=/tmp:size=256M,nr_inodes=65536,mode=1777 \
    --property=NoNewPrivileges=true \
    --property=IPAddressAllow=127.0.0.53/32 \
    --property=IPAddressAllow=::1/128 \
    --property=IPAddressDeny=127.0.0.0/8 \
    --property=IPAddressDeny=10.0.0.0/8 \
    --property=IPAddressDeny=172.16.0.0/12 \
    --property=IPAddressDeny=192.168.0.0/16 \
    --property=IPAddressDeny=169.254.0.0/16 \
    --property=IPAddressDeny=::1/128 \
    --property=IPAddressDeny=fc00::/7 \
    --property=IPAddressDeny=fe80::/10 \
    --property="ReadWritePaths=$candidate" \
    --property="ReadWritePaths=$package_store" \
    --setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    --setenv=CI=1 \
    -- "$DEPLOY_BUILD_SCRIPT" fetch "$candidate" "$package_store" >/dev/null 2>&1
}

_deploy_validate_quiescence() {
  local candidate=$1
  local cgroup_name=$2
  local cgroup_file=$DEPLOY_CGROUP_ROOT/$cgroup_name/cgroup.procs

  if [[ -e $cgroup_file || -L $cgroup_file ]]; then
    [[ -f $cgroup_file && ! -L $cgroup_file ]] || return 1
    [[ ! -s $cgroup_file || -z $(tr -d '[:space:]' <"$cgroup_file") ]] || return 1
  fi

  python3 -c '
import glob
import os
import sys

proc_root, candidate = sys.argv[1:]
candidate = os.path.realpath(candidate)
for process in glob.glob(os.path.join(proc_root, "[0-9]*")):
    links = [os.path.join(process, name) for name in ("cwd", "root", "exe")]
    links.extend(glob.glob(os.path.join(process, "fd", "*")))
    for link in links:
        try:
            target = os.path.realpath(link)
        except OSError:
            continue
        if target == candidate or target.startswith(candidate + os.sep):
            raise SystemExit(1)
' "$DEPLOY_PROC_ROOT" "$candidate"
}

_deploy_fsync_directory() {
  python3 -c 'import os,sys; fd=os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY); os.fsync(fd); os.close(fd)' "$1"
}

_deploy_validate_existing_release() {
  local sha=$1
  local release=$DEPLOY_APP_ROOT/releases/$sha
  local revision
  [[ -d $release && ! -L $release ]] || return 1
  validate_candidate_tree "$release" || return 1
  [[ -f $release/package.json && ! -L $release/package.json ]] || return 1
  [[ -f $release/dist/src/scheduler/main.js && ! -L $release/dist/src/scheduler/main.js ]] || return 1
  [[ -d $release/node_modules && ! -L $release/node_modules ]] || return 1
  [[ -f $release/release.env && ! -L $release/release.env ]] || return 1
  IFS= read -r revision <"$release/release.env" || return 1
  [[ $revision == "APP_REVISION=$sha" ]] || return 1
  [[ $(wc -l <"$release/release.env") -eq 1 ]] || return 1
}

_deploy_seal_release() {
  local sha=$1
  local candidate=$2
  local final_release=$DEPLOY_APP_ROOT/releases/$sha
  local temporary_release=$DEPLOY_APP_ROOT/releases/.${sha}.${DEPLOY_DIAGNOSTIC_ID}.tmp

  if [[ -e $final_release || -L $final_release ]]; then
    _deploy_validate_existing_release "$sha"
    return
  fi

  [[ ! -e $temporary_release && ! -L $temporary_release ]] || return 1
  DEPLOY_TEMPORARY_RELEASE=$temporary_release
  mkdir -m 0700 "$temporary_release"
  COPYFILE_DISABLE=1 cp -R "$candidate/." "$temporary_release/" || return 1
  validate_candidate_tree "$temporary_release" || return 1
  (
    umask 077
    set -o noclobber
    printf 'APP_REVISION=%s\n' "$sha" >"$temporary_release/release.env"
  ) || return 1
  find "$temporary_release" -type d -exec chmod 0550 {} + || return 1
  find "$temporary_release" -type f -exec chmod 0440 {} + || return 1
  if [[ -n $DEPLOY_RELEASE_USER ]]; then
    chown -hR "$DEPLOY_RELEASE_USER:$DEPLOY_RELEASE_GROUP" "$temporary_release" || return 1
  fi
  mv "$temporary_release" "$final_release" || return 1
  DEPLOY_TEMPORARY_RELEASE=
  _deploy_fsync_directory "$DEPLOY_APP_ROOT/releases"
}

_deploy_prepare_release() {
  local sha=$1
  local candidate
  local package_store
  local cgroup_name

  if [[ -e $DEPLOY_APP_ROOT/releases/$sha || -L $DEPLOY_APP_ROOT/releases/$sha ]]; then
    _deploy_validate_existing_release "$sha"
    return
  fi

  candidate=$DEPLOY_APP_ROOT/candidates/$sha
  package_store=$DEPLOY_APP_ROOT/package-store/$sha
  cgroup_name=${DEPLOY_BUILD_CGROUP_NAME:-carplate-build-${sha}.service}
  DEPLOY_BUILD_CANDIDATE=$candidate
  DEPLOY_BUILD_PACKAGE_STORE=$package_store
  if ! _deploy_export_candidate "$sha"; then
    _deploy_remove_build_workspace
    return 1
  fi

  local build_status=0
  _deploy_fetch_dependencies "$sha" "$candidate" "$package_store" || build_status=$?
  if (( build_status == 0 )); then
    _deploy_run_isolated_build "$sha" "$candidate" "$package_store" || build_status=$?
  fi
  _deploy_validate_quiescence "$candidate" "$cgroup_name" || return 1
  if [[ $build_status -ne 0 ]] \
    || ! validate_candidate_tree "$candidate" \
    || [[ ! -f $candidate/dist/src/scheduler/main.js || -L $candidate/dist/src/scheduler/main.js ]] \
    || [[ ! -d $candidate/node_modules || -L $candidate/node_modules ]] \
    || ! _deploy_seal_release "$sha" "$candidate"; then
    _deploy_remove_build_workspace
    return 1
  fi
  _deploy_validate_quiescence "$candidate" "$cgroup_name" || return 1
  _deploy_remove_build_workspace
}

_deploy_remove_build_workspace() {
  [[ -n $DEPLOY_BUILD_CANDIDATE && -n $DEPLOY_BUILD_PACKAGE_STORE ]] || return 0
  _deploy_remove_direct_child "$DEPLOY_APP_ROOT/candidates" "$DEPLOY_BUILD_CANDIDATE" || return 1
  _deploy_remove_direct_child "$DEPLOY_APP_ROOT/package-store" "$DEPLOY_BUILD_PACKAGE_STORE" || return 1
  DEPLOY_BUILD_CANDIDATE=
  DEPLOY_BUILD_PACKAGE_STORE=
}

_deploy_build_cgroup_name() {
  local sha=$1
  if [[ -n $DEPLOY_BUILD_CGROUP_NAME ]]; then
    printf '%s\n' "$DEPLOY_BUILD_CGROUP_NAME"
  else
    printf 'carplate-build-%s.service\n' "$sha"
  fi
}

_deploy_remove_candidate_archive() {
  local archive=$1
  local name=${archive##*/}
  [[ $archive == "$DEPLOY_STATE_ROOT"/* \
    && ${archive#"$DEPLOY_STATE_ROOT"/} != */* \
    && $name =~ ^\.candidate\.[0-9a-f]{24}\.tar$ \
    && -f $archive \
    && ! -L $archive ]] || return 1
  rm -f -- "$archive"
}

_deploy_remove_temporary_release() {
  local release=$1
  local name=${release##*/}
  [[ $release == "$DEPLOY_APP_ROOT/releases"/* \
    && ${release#"$DEPLOY_APP_ROOT/releases"/} != */* \
    && $name =~ ^\.[0-9a-f]{40}\.[0-9a-f]{24}\.tmp$ \
    && -d $release \
    && ! -L $release ]] || return 1
  find "$release" -type d -exec chmod u+w {} + >/dev/null 2>&1 || return 1
  _deploy_remove_direct_child "$DEPLOY_APP_ROOT/releases" "$release"
}

_deploy_remove_controlled_temporary_paths() {
  if [[ -n ${DEPLOY_BUILD_ARCHIVE:-} && ( -e $DEPLOY_BUILD_ARCHIVE || -L $DEPLOY_BUILD_ARCHIVE ) ]]; then
    _deploy_remove_candidate_archive "$DEPLOY_BUILD_ARCHIVE" || return 1
  fi
  DEPLOY_BUILD_ARCHIVE=
  if [[ -n ${DEPLOY_TEMPORARY_RELEASE:-} \
    && ( -e $DEPLOY_TEMPORARY_RELEASE || -L $DEPLOY_TEMPORARY_RELEASE ) ]]; then
    _deploy_remove_temporary_release "$DEPLOY_TEMPORARY_RELEASE" || return 1
  fi
  DEPLOY_TEMPORARY_RELEASE=
}

_deploy_cleanup_abandoned_paths() {
  local path
  local sha
  local cgroup_name
  local matching_store

  shopt -s nullglob
  for path in "$DEPLOY_APP_ROOT/candidates"/*; do
    sha=${path##*/}
    [[ $sha =~ ^[0-9a-f]{40}$ && -d $path && ! -L $path ]] || continue
    cgroup_name=$(_deploy_build_cgroup_name "$sha") || return 1
    _deploy_validate_quiescence "$path" "$cgroup_name" || return 1
    matching_store=$DEPLOY_APP_ROOT/package-store/$sha
    if [[ -e $matching_store || -L $matching_store ]]; then
      [[ -d $matching_store && ! -L $matching_store ]] || return 1
      _deploy_validate_quiescence "$matching_store" "$cgroup_name" || return 1
      _deploy_remove_direct_child "$DEPLOY_APP_ROOT/package-store" "$matching_store" || return 1
    fi
    _deploy_remove_direct_child "$DEPLOY_APP_ROOT/candidates" "$path" || return 1
  done

  if [[ -e $DEPLOY_APP_ROOT/package-store || -L $DEPLOY_APP_ROOT/package-store ]]; then
    [[ -d $DEPLOY_APP_ROOT/package-store && ! -L $DEPLOY_APP_ROOT/package-store ]] || return 1
    for path in "$DEPLOY_APP_ROOT/package-store"/*; do
      sha=${path##*/}
      [[ $sha =~ ^[0-9a-f]{40}$ && -d $path && ! -L $path ]] || continue
      cgroup_name=$(_deploy_build_cgroup_name "$sha") || return 1
      _deploy_validate_quiescence "$path" "$cgroup_name" || return 1
      _deploy_remove_direct_child "$DEPLOY_APP_ROOT/package-store" "$path" || return 1
    done
  fi

  for path in "$DEPLOY_STATE_ROOT"/.candidate.*.tar; do
    [[ ${path##*/} =~ ^\.candidate\.[0-9a-f]{24}\.tar$ \
      && -f $path \
      && ! -L $path ]] || continue
    _deploy_validate_quiescence "$path" __no_build_cgroup__.service || return 1
    _deploy_remove_candidate_archive "$path" || return 1
  done
  for path in "$DEPLOY_APP_ROOT/releases"/.*.tmp; do
    [[ ${path##*/} =~ ^\.[0-9a-f]{40}\.[0-9a-f]{24}\.tmp$ \
      && -d $path \
      && ! -L $path ]] || continue
    _deploy_validate_quiescence "$path" __no_build_cgroup__.service || return 1
    _deploy_remove_temporary_release "$path" || return 1
  done
  shopt -u nullglob
}

_deploy_write_atomic_file() {
  local destination=$1
  local mode=$2
  python3 "$DEPLOY_ATOMIC_FS" --allowed-root "$DEPLOY_STATE_ROOT" \
    write-file "$destination" "$mode"
}

_deploy_replace_link() {
  local name=$1
  local sha=$2
  python3 "$DEPLOY_ATOMIC_FS" --allowed-root "$DEPLOY_APP_ROOT" \
    replace-symlink "$DEPLOY_APP_ROOT/$name" "releases/$sha"
}

_deploy_write_journal() {
  local previous_sha=$1
  local prior_previous_sha=$2
  local candidate_sha=$3
  python3 -c '
import json
import sys
print(json.dumps({"state":"pending","previousSha":sys.argv[1],"priorPreviousSha":sys.argv[2],"candidateSha":sys.argv[3]}, separators=(",",":")))
' "$previous_sha" "$prior_previous_sha" "$candidate_sha" | _deploy_write_atomic_file "$DEPLOY_STATE_ROOT/activation-state" 0600
}

_deploy_write_marker() {
  printf '%s\n' "$1" | _deploy_write_atomic_file "$DEPLOY_STATE_ROOT/deployed-sha" 0600
}

_deploy_clear_journal() {
  python3 "$DEPLOY_ATOMIC_FS" --allowed-root "$DEPLOY_STATE_ROOT" \
    clear-file "$DEPLOY_STATE_ROOT/activation-state"
}

_deploy_read_pending() {
  local pending=$DEPLOY_STATE_ROOT/activation-state
  [[ -f $pending && ! -L $pending ]] || return 1
  python3 -c '
import json
import sys

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result

with open(sys.argv[1], "r", encoding="utf-8") as source:
    value = json.load(source, object_pairs_hook=unique_object, parse_constant=lambda _value: (_ for _ in ()).throw(ValueError()))
if not isinstance(value, dict) or set(value) != {"state", "previousSha", "priorPreviousSha", "candidateSha"}:
    raise SystemExit(1)
if value["state"] != "pending":
    raise SystemExit(1)
for key in ("previousSha", "candidateSha"):
    candidate = value[key]
    if not isinstance(candidate, str) or len(candidate) != 40 or any(character not in "0123456789abcdef" for character in candidate):
        raise SystemExit(1)
prior_previous = value["priorPreviousSha"]
if not isinstance(prior_previous, str) or (prior_previous and (len(prior_previous) != 40 or any(character not in "0123456789abcdef" for character in prior_previous))):
    raise SystemExit(1)
print("|".join((value["previousSha"], prior_previous, value["candidateSha"])))
' "$pending"
}

_deploy_link_sha() {
  local name=$1
  local target
  [[ -L $DEPLOY_APP_ROOT/$name ]] || return 1
  target=$(readlink "$DEPLOY_APP_ROOT/$name") || return 1
  [[ $target =~ ^releases/([0-9a-f]{40})$ ]] || return 1
  _deploy_validate_existing_release "${BASH_REMATCH[1]}" || return 1
  printf '%s\n' "${BASH_REMATCH[1]}"
}

_deploy_remove_sealed_release() {
  local release=$1
  [[ $release == "$DEPLOY_APP_ROOT/releases"/* \
    && ${release#"$DEPLOY_APP_ROOT/releases"/} != */* \
    && ${release##*/} =~ ^[0-9a-f]{40}$ \
    && -d $release \
    && ! -L $release ]] || return 1
  find "$release" -type d -exec chmod u+w {} + >/dev/null 2>&1 || return 1
  if _deploy_remove_direct_child "$DEPLOY_APP_ROOT/releases" "$release"; then
    return 0
  fi
  find "$release" -type d -exec chmod 0550 {} + >/dev/null 2>&1 || true
  return 1
}

_deploy_prune_releases() {
  local current_sha
  local previous_sha=
  local release
  local release_sha
  current_sha=$(_deploy_link_sha current) || return 1
  if [[ -e $DEPLOY_APP_ROOT/previous || -L $DEPLOY_APP_ROOT/previous ]]; then
    previous_sha=$(_deploy_link_sha previous) || return 1
  fi

  shopt -s nullglob
  for release in "$DEPLOY_APP_ROOT/releases"/*; do
    release_sha=${release##*/}
    [[ $release_sha =~ ^[0-9a-f]{40}$ ]] || continue
    [[ $release_sha == "$current_sha" || $release_sha == "$previous_sha" ]] && continue
    _deploy_remove_sealed_release "$release" || return 1
  done
  shopt -u nullglob
  _deploy_fsync_directory "$DEPLOY_APP_ROOT/releases"
}

_deploy_expected_cron() {
  python3 -c '
import sys

value = "*/5 * * * *"
with open(sys.argv[1], "r", encoding="utf-8") as source:
    for raw_line in source:
        line = raw_line.rstrip("\r\n")
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, candidate = line.split("=", 1)
        if key.strip() == "SYNC_CRON":
            value = candidate.strip()
if not value or "\n" in value or "\r" in value:
    raise SystemExit(1)
print(value)
' "$DEPLOY_APP_ENV"
}

_deploy_systemctl_property() {
  "$DEPLOY_SYSTEMCTL_COMMAND" show "$DEPLOY_SERVICE" --property="$1" --value 2>/dev/null
}

_deploy_service_running() {
  local active_state
  local sub_state
  local main_pid
  active_state=$(_deploy_systemctl_property ActiveState) || return 1
  sub_state=$(_deploy_systemctl_property SubState) || return 1
  main_pid=$(_deploy_systemctl_property MainPID) || return 1
  [[ $active_state == active && $sub_state == running && $main_pid =~ ^[1-9][0-9]*$ ]]
}

_deploy_service_stopped() {
  local active_state
  local sub_state
  local main_pid
  active_state=$(_deploy_systemctl_property ActiveState) || return 1
  sub_state=$(_deploy_systemctl_property SubState) || return 1
  main_pid=$(_deploy_systemctl_property MainPID) || return 1
  [[ $active_state == inactive && $sub_state == dead && $main_pid == 0 ]]
}

_deploy_start_service() {
  "$DEPLOY_SYSTEMCTL_COMMAND" start --job-mode=ignore-dependencies "$DEPLOY_SERVICE" >/dev/null 2>&1
}

_deploy_stop_for_deployment() {
  DEPLOY_SERVICE_STOPPED=1
  if "$DEPLOY_SYSTEMCTL_COMMAND" stop "$DEPLOY_SERVICE" >/dev/null 2>&1; then
    return 0
  fi
  if _deploy_service_running; then
    DEPLOY_SERVICE_STOPPED=0
  fi
  return 1
}

_deploy_stop_for_recovery() {
  DEPLOY_SERVICE_STOPPED=1
  if "$DEPLOY_SYSTEMCTL_COMMAND" stop "$DEPLOY_SERVICE" >/dev/null 2>&1; then
    return 0
  fi
  _deploy_service_stopped
}

_deploy_verify_health() {
  local expected_sha=$1
  local previous_invocation=$2
  local baseline_restarts=$3
  local current_invocation
  local current_restarts
  local expected_cron
  local journal_file=$DEPLOY_STATE_ROOT/.journal.$DEPLOY_DIAGNOSTIC_ID
  local elapsed=0
  local active_state
  local sub_state
  local main_pid
  local expected_pid=
  local startup_record_seen=0

  current_invocation=$(_deploy_systemctl_property InvocationID) || return 1
  expected_cron=$(_deploy_expected_cron) || return 1

  while (( elapsed <= DEPLOY_HEALTH_SECONDS )); do
    active_state=$(_deploy_systemctl_property ActiveState) || return 1
    sub_state=$(_deploy_systemctl_property SubState) || return 1
    main_pid=$(_deploy_systemctl_property MainPID) || return 1
    current_restarts=$(_deploy_systemctl_property NRestarts) || return 1
    [[ $active_state == active && $sub_state == running ]] || return 1
    [[ $main_pid =~ ^[1-9][0-9]*$ ]] || return 1
    if [[ -z $expected_pid ]]; then
      expected_pid=$main_pid
    fi
    [[ $main_pid == "$expected_pid" ]] || return 1
    [[ $current_restarts == "$baseline_restarts" ]] || return 1
    [[ $(_deploy_systemctl_property InvocationID) == "$current_invocation" ]] || return 1

    "$DEPLOY_JOURNALCTL_COMMAND" --no-pager --output=cat \
      "_SYSTEMD_INVOCATION_ID=$current_invocation" >"$journal_file" 2>/dev/null || return 1
    if verify_invocation "$previous_invocation" "$current_invocation" \
      "$baseline_restarts" "$current_restarts" "$expected_cron" "$expected_sha" "$journal_file"; then
      startup_record_seen=1
    fi
    [[ $(_deploy_systemctl_property MainPID) == "$expected_pid" ]] || return 1
    [[ $(_deploy_systemctl_property NRestarts) == "$baseline_restarts" ]] || return 1
    [[ $(_deploy_systemctl_property InvocationID) == "$current_invocation" ]] || return 1
    (( elapsed == DEPLOY_HEALTH_SECONDS )) && break
    sleep 1
    ((elapsed += 1))
  done
  rm -f "$journal_file"
  [[ $startup_record_seen -eq 1 ]]
}

_deploy_start_and_verify() {
  local sha=$1
  local previous_invocation
  local baseline_restarts
  previous_invocation=$(_deploy_systemctl_property InvocationID) || return 1
  baseline_restarts=$(_deploy_systemctl_property NRestarts) || return 1
  _deploy_start_service || return 1
  DEPLOY_SERVICE_STOPPED=0
  _deploy_verify_health "$sha" "$previous_invocation" "$baseline_restarts"
}

_deploy_emit_result() {
  safe_result "$@" || return 1
  DEPLOY_RESULT_EMITTED=1
}

_deploy_crash_point() {
  local point=$1
  if [[ $DEPLOY_TEST_MODE -eq 1 && $DEPLOY_TEST_CRASH_AFTER == "$point" ]]; then
    DEPLOY_CRASHED=1
    return 97
  fi
}

_deploy_cleanup() {
  if [[ -n ${DEPLOY_DIAGNOSTIC_ID:-} ]]; then
    rm -f "$DEPLOY_STATE_ROOT/.journal.$DEPLOY_DIAGNOSTIC_ID" 2>/dev/null || true
  fi
  _deploy_remove_build_workspace >/dev/null 2>&1 || true
  _deploy_remove_controlled_temporary_paths >/dev/null 2>&1 || true
  _deploy_release_sync_lock
  _deploy_release_flock
}

_deploy_emergency_recovery() {
  [[ $DEPLOY_RECOVERING -eq 0 && $DEPLOY_CRASHED -eq 0 ]] || return 0
  [[ $DEPLOY_RECOVERY_HANDLED -eq 0 ]] || return 0
  [[ $DEPLOY_SERVICE_STOPPED -eq 1 || $DEPLOY_ACTIVATION_PENDING -eq 1 ]] || return 0
  [[ -n $DEPLOY_PREVIOUS_SHA ]] || return 0
  DEPLOY_RECOVERING=1
  if _deploy_service_running; then
    _deploy_stop_for_recovery || return 0
  elif ! _deploy_service_stopped; then
    return 0
  fi
  if _deploy_replace_link current "$DEPLOY_PREVIOUS_SHA" >/dev/null 2>&1 \
    && { [[ -z $DEPLOY_PRIOR_PREVIOUS_SHA ]] \
      || _deploy_replace_link previous "$DEPLOY_PRIOR_PREVIOUS_SHA" >/dev/null 2>&1; } \
    && _deploy_start_and_verify "$DEPLOY_PREVIOUS_SHA" \
    && _deploy_write_marker "$DEPLOY_PREVIOUS_SHA" \
    && _deploy_clear_journal \
    && _deploy_prune_releases; then
    DEPLOY_ACTIVATION_PENDING=0
    DEPLOY_RECOVERY_HANDLED=1
  fi
}

_deploy_exit_trap() {
  local status=$?
  local recovery_required=0
  local outcome
  local activated_sha
  if [[ $status -ne 0 ]]; then
    if [[ $DEPLOY_SERVICE_STOPPED -eq 1 || $DEPLOY_ACTIVATION_PENDING -eq 1 ]]; then
      recovery_required=1
    fi
    _deploy_emergency_recovery || true
    if [[ $DEPLOY_CRASHED -eq 0 && $DEPLOY_RESULT_EMITTED -eq 0 \
      && -n $DEPLOY_REQUESTED_SHA && -n $DEPLOY_DIAGNOSTIC_ID ]]; then
      outcome=deployment_failed
      activated_sha=$DEPLOY_PREVIOUS_SHA
      if [[ $recovery_required -eq 1 && $DEPLOY_RECOVERY_HANDLED -eq 1 ]]; then
        outcome=deployment_failed_recovered
      elif [[ $recovery_required -eq 1 ]]; then
        outcome=deployment_recovery_failed
        activated_sha=
      fi
      _deploy_emit_result "$outcome" "$DEPLOY_REQUESTED_SHA" "$DEPLOY_PREVIOUS_SHA" \
        "$activated_sha" "$DEPLOY_DIAGNOSTIC_ID" || true
    fi
  fi
  _deploy_cleanup
  return "$status"
}

_deploy_restart_after_candidate_failure() {
  local requested_sha=$1
  if [[ -n $DEPLOY_PREVIOUS_SHA ]] \
    && _deploy_start_and_verify "$DEPLOY_PREVIOUS_SHA" \
    && _deploy_prune_releases; then
    DEPLOY_RECOVERY_HANDLED=1
    _deploy_emit_result candidate_failed_restarted "$requested_sha" "$DEPLOY_PREVIOUS_SHA" \
      "$DEPLOY_PREVIOUS_SHA" "$DEPLOY_DIAGNOSTIC_ID"
  else
    DEPLOY_RECOVERY_HANDLED=1
    _deploy_emit_result deployment_recovery_failed "$requested_sha" "$DEPLOY_PREVIOUS_SHA" \
      "" "$DEPLOY_DIAGNOSTIC_ID"
  fi
  return 1
}

_deploy_restart_after_superseded_build() {
  local requested_sha=$1
  if [[ -n $DEPLOY_PREVIOUS_SHA ]] \
    && _deploy_start_and_verify "$DEPLOY_PREVIOUS_SHA" \
    && _deploy_prune_releases; then
    DEPLOY_RECOVERY_HANDLED=1
    DEPLOY_SERVICE_STOPPED=0
    _deploy_emit_result superseded "$requested_sha" "$DEPLOY_PREVIOUS_SHA" \
      "$DEPLOY_PREVIOUS_SHA" "$DEPLOY_DIAGNOSTIC_ID"
    return 0
  fi
  DEPLOY_RECOVERY_HANDLED=1
  _deploy_emit_result deployment_recovery_failed "$requested_sha" "$DEPLOY_PREVIOUS_SHA" \
    "" "$DEPLOY_DIAGNOSTIC_ID"
  return 1
}

_deploy_rollback_activation() {
  local requested_sha=$1
  if _deploy_stop_for_recovery \
    && [[ -n $DEPLOY_PREVIOUS_SHA ]] \
    && _deploy_replace_link current "$DEPLOY_PREVIOUS_SHA" \
    && { [[ -z $DEPLOY_PRIOR_PREVIOUS_SHA ]] || _deploy_replace_link previous "$DEPLOY_PRIOR_PREVIOUS_SHA"; } \
    && _deploy_start_and_verify "$DEPLOY_PREVIOUS_SHA" \
    && _deploy_write_marker "$DEPLOY_PREVIOUS_SHA" \
    && _deploy_clear_journal \
    && _deploy_prune_releases; then
    DEPLOY_ACTIVATION_PENDING=0
    DEPLOY_RECOVERY_HANDLED=1
    _deploy_emit_result activation_failed_rolled_back "$requested_sha" "$DEPLOY_PREVIOUS_SHA" \
      "$DEPLOY_PREVIOUS_SHA" "$DEPLOY_DIAGNOSTIC_ID"
  else
    DEPLOY_RECOVERY_HANDLED=1
    _deploy_emit_result deployment_recovery_failed "$requested_sha" "$DEPLOY_PREVIOUS_SHA" \
      "" "$DEPLOY_DIAGNOSTIC_ID"
  fi
  return 1
}

_deploy_reconcile_pending() {
  local pending_values
  local recovery_sha
  local prior_previous_sha
  local candidate_sha
  pending_values=$(_deploy_read_pending) || return 1
  IFS='|' read -r recovery_sha prior_previous_sha candidate_sha <<<"$pending_values"
  _deploy_validate_existing_release "$recovery_sha" || return 1
  [[ -z $prior_previous_sha ]] || _deploy_validate_existing_release "$prior_previous_sha" || return 1
  validate_sha "$candidate_sha" || return 1
  DEPLOY_PREVIOUS_SHA=$recovery_sha
  DEPLOY_PRIOR_PREVIOUS_SHA=$prior_previous_sha
  DEPLOY_ACTIVATION_PENDING=1
  if _deploy_stop_for_recovery \
    && _deploy_replace_link current "$recovery_sha" \
    && { [[ -z $prior_previous_sha ]] || _deploy_replace_link previous "$prior_previous_sha"; } \
    && _deploy_start_and_verify "$recovery_sha" \
    && _deploy_write_marker "$recovery_sha" \
    && _deploy_clear_journal \
    && _deploy_prune_releases; then
    DEPLOY_ACTIVATION_PENDING=0
    DEPLOY_RECOVERY_HANDLED=0
    return 0
  fi
  return 1
}

deploy_main() {
  _deploy_load_configuration
  _deploy_reset_runtime_state
  [[ $# -eq 1 ]] || return 1
  validate_sha "$1" || return 1
  DEPLOY_REQUESTED_SHA=$1
  _deploy_validate_layout || return 1
  _deploy_acquire_flock || return 1
  trap _deploy_exit_trap EXIT

  DEPLOY_DIAGNOSTIC_ID=$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n') || return 1
  [[ $DEPLOY_DIAGNOSTIC_ID =~ ^[0-9a-f]{24}$ ]] || return 1
  _deploy_cleanup_abandoned_paths || return 1

  if [[ -e $DEPLOY_STATE_ROOT/activation-state || -L $DEPLOY_STATE_ROOT/activation-state ]]; then
    _deploy_reconcile_pending || return 1
  elif [[ -e $DEPLOY_STATE_ROOT/deployed-sha || -L $DEPLOY_STATE_ROOT/deployed-sha ]]; then
    DEPLOY_PREVIOUS_SHA=$(_deploy_read_sha_file "$DEPLOY_STATE_ROOT/deployed-sha") || return 1
  elif [[ -e $DEPLOY_APP_ROOT/current || -L $DEPLOY_APP_ROOT/current ]]; then
    return 1
  fi
  if [[ -n $DEPLOY_PREVIOUS_SHA ]]; then
    [[ $(_deploy_current_sha) == "$DEPLOY_PREVIOUS_SHA" ]] || return 1
  fi

  local classification
  classification=$(_deploy_fetch_and_classify "$DEPLOY_REQUESTED_SHA" "$DEPLOY_PREVIOUS_SHA") || return 1
  case $classification in
    equal)
      _deploy_prune_releases || return 1
      DEPLOY_RECOVERY_HANDLED=1
      _deploy_emit_result unchanged "$DEPLOY_REQUESTED_SHA" "$DEPLOY_PREVIOUS_SHA" \
        "$DEPLOY_PREVIOUS_SHA" "$DEPLOY_DIAGNOSTIC_ID"
      return 0
      ;;
    stale)
      _deploy_prune_releases || return 1
      DEPLOY_RECOVERY_HANDLED=1
      _deploy_emit_result superseded "$DEPLOY_REQUESTED_SHA" "$DEPLOY_PREVIOUS_SHA" \
        "$DEPLOY_PREVIOUS_SHA" "$DEPLOY_DIAGNOSTIC_ID"
      return 0
      ;;
    forward|initial) ;;
    *) return 1 ;;
  esac

  _deploy_preflight || return 1
  _deploy_stop_for_deployment || return 1
  _deploy_acquire_sync_lock || return 1

  if ! _deploy_prepare_release "$DEPLOY_REQUESTED_SHA"; then
    _deploy_restart_after_candidate_failure "$DEPLOY_REQUESTED_SHA"
    return 1
  fi

  if [[ -e $DEPLOY_APP_ROOT/previous || -L $DEPLOY_APP_ROOT/previous ]]; then
    DEPLOY_PRIOR_PREVIOUS_SHA=$(_deploy_link_sha previous) || return 1
  fi
  if ! _deploy_request_is_current_main "$DEPLOY_REQUESTED_SHA"; then
    _deploy_restart_after_superseded_build "$DEPLOY_REQUESTED_SHA"
    return $?
  fi
  _deploy_write_journal "$DEPLOY_PREVIOUS_SHA" "$DEPLOY_PRIOR_PREVIOUS_SHA" \
    "$DEPLOY_REQUESTED_SHA" || return 1
  DEPLOY_ACTIVATION_PENDING=1
  _deploy_crash_point pending-journal
  if [[ -n $DEPLOY_PREVIOUS_SHA ]]; then
    _deploy_replace_link previous "$DEPLOY_PREVIOUS_SHA" || return 1
  fi
  _deploy_crash_point previous-link
  _deploy_replace_link current "$DEPLOY_REQUESTED_SHA" || return 1
  _deploy_crash_point current-link

  local previous_invocation
  local baseline_restarts
  previous_invocation=$(_deploy_systemctl_property InvocationID) || return 1
  baseline_restarts=$(_deploy_systemctl_property NRestarts) || return 1
  if ! _deploy_start_service; then
    _deploy_rollback_activation "$DEPLOY_REQUESTED_SHA"
    return 1
  fi
  DEPLOY_SERVICE_STOPPED=0
  _deploy_crash_point service-start
  if ! _deploy_verify_health "$DEPLOY_REQUESTED_SHA" "$previous_invocation" "$baseline_restarts"; then
    _deploy_rollback_activation "$DEPLOY_REQUESTED_SHA"
    return 1
  fi
  _deploy_crash_point health-success

  _deploy_write_marker "$DEPLOY_REQUESTED_SHA" || return 1
  _deploy_crash_point marker-write
  _deploy_clear_journal || return 1
  DEPLOY_ACTIVATION_PENDING=0
  _deploy_crash_point pending-clear
  _deploy_prune_releases || return 1
  DEPLOY_RECOVERY_HANDLED=1
  DEPLOY_SERVICE_STOPPED=0
  _deploy_emit_result deployed "$DEPLOY_REQUESTED_SHA" "$DEPLOY_PREVIOUS_SHA" \
    "$DEPLOY_REQUESTED_SHA" "$DEPLOY_DIAGNOSTIC_ID"
}

if ! _deploy_is_sourced; then
  unset CARPLATE_SOURCE_TEST_CONFIG
  deploy_main "$@"
fi
