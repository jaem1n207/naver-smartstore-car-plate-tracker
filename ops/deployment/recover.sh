#!/usr/bin/env bash

set -Eeuo pipefail
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

readonly PRODUCTION_RECOVER_APP_ROOT=/opt/naver-smartstore-car-plate-tracker
readonly PRODUCTION_RECOVER_STATE_ROOT=/var/lib/naver-smartstore-car-plate-tracker/deployment
readonly PRODUCTION_RECOVER_ATOMIC_FS=/usr/local/lib/naver-smartstore-car-plate-tracker/atomic_fs.py
readonly PRODUCTION_RECOVER_FLOCK=/usr/bin/flock
readonly PRODUCTION_RECOVER_COMMON=/usr/local/lib/naver-smartstore-car-plate-tracker/lib/common.sh

RECOVER_SCRIPT_DIRECTORY=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
readonly RECOVER_SCRIPT_DIRECTORY
if [[ ${BASH_SOURCE[0]} != "$0" ]]; then
  # shellcheck source=ops/deployment/lib/common.sh
  source "$RECOVER_SCRIPT_DIRECTORY/lib/common.sh"
else
  # shellcheck source=/dev/null
  source "$PRODUCTION_RECOVER_COMMON"
fi

_recover_is_sourced() {
  [[ ${BASH_SOURCE[0]} != "$0" ]]
}

_recover_load_configuration() {
  RECOVER_APP_ROOT=$PRODUCTION_RECOVER_APP_ROOT
  RECOVER_STATE_ROOT=$PRODUCTION_RECOVER_STATE_ROOT
  RECOVER_ATOMIC_FS=$PRODUCTION_RECOVER_ATOMIC_FS
  RECOVER_FLOCK_COMMAND=$PRODUCTION_RECOVER_FLOCK
  RECOVER_EXPECTED_UID=0
  RECOVER_TEST_MODE=0
  RECOVER_TEST_FLOCK_PATH=

  if _recover_is_sourced && [[ -n ${CARPLATE_SOURCE_TEST_CONFIG:-} ]]; then
    RECOVER_TEST_MODE=1
    # shellcheck source=/dev/null
    source "$CARPLATE_SOURCE_TEST_CONFIG"
  fi
}

_recover_validate_layout() {
  [[ $EUID -eq $RECOVER_EXPECTED_UID ]] || return 1
  [[ $RECOVER_APP_ROOT == /* && $RECOVER_STATE_ROOT == /* ]] || return 1
  [[ -d $RECOVER_APP_ROOT && ! -L $RECOVER_APP_ROOT ]] || return 1
  [[ -d $RECOVER_APP_ROOT/releases && ! -L $RECOVER_APP_ROOT/releases ]] || return 1
  [[ -d $RECOVER_STATE_ROOT && ! -L $RECOVER_STATE_ROOT ]] || return 1
  [[ -f $RECOVER_ATOMIC_FS && ! -L $RECOVER_ATOMIC_FS ]] || return 1

  python3 -c '
import os
import stat
import sys

app_root, state_root, expected_uid, test_mode = sys.argv[1:]
for path in (app_root, state_root):
    metadata = os.lstat(path)
    if not stat.S_ISDIR(metadata.st_mode) or os.path.realpath(path) != path:
        raise SystemExit(1)
state = os.lstat(state_root)
if state.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
    raise SystemExit(1)
if test_mode == "0" and (state.st_uid != int(expected_uid) or stat.S_IMODE(state.st_mode) != 0o700):
    raise SystemExit(1)
' "$RECOVER_APP_ROOT" "$RECOVER_STATE_ROOT" "$RECOVER_EXPECTED_UID" "$RECOVER_TEST_MODE"
}

_recover_acquire_flock() {
  local lock_path=$RECOVER_STATE_ROOT/deploy.lock
  [[ ! -L $lock_path ]] || return 1
  if [[ $RECOVER_TEST_MODE -eq 1 ]]; then
    RECOVER_TEST_FLOCK_PATH=$lock_path.test-flock
    mkdir "$RECOVER_TEST_FLOCK_PATH" 2>/dev/null || return 1
    return 0
  fi
  umask 077
  exec {RECOVER_FLOCK_FD}>"$lock_path"
  chmod 0600 "$lock_path"
  "$RECOVER_FLOCK_COMMAND" -n "$RECOVER_FLOCK_FD"
}

_recover_release_flock() {
  if [[ -n ${RECOVER_TEST_FLOCK_PATH:-} ]]; then
    rmdir "$RECOVER_TEST_FLOCK_PATH" 2>/dev/null || true
    RECOVER_TEST_FLOCK_PATH=
  fi
}

_recover_read_marker() {
  local marker=$RECOVER_STATE_ROOT/deployed-sha
  local sha
  [[ -f $marker && ! -L $marker ]] || return 1
  IFS= read -r sha <"$marker" || return 1
  validate_sha "$sha" || return 1
  [[ $(wc -l <"$marker") -eq 1 ]] || return 1
  printf '%s\n' "$sha"
}

_recover_read_pending() {
  local pending=$RECOVER_STATE_ROOT/activation-state
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
if not isinstance(value, dict) or set(value) != {"state", "previousSha", "candidateSha"}:
    raise SystemExit(1)
if value["state"] != "pending":
    raise SystemExit(1)
for key in ("previousSha", "candidateSha"):
    candidate = value[key]
    if not isinstance(candidate, str) or len(candidate) != 40 or any(character not in "0123456789abcdef" for character in candidate):
        raise SystemExit(1)
print(value["previousSha"])
print(value["candidateSha"])
' "$pending"
}

_recover_validate_release() {
  local sha=$1
  local release=$RECOVER_APP_ROOT/releases/$sha
  local revision
  validate_sha "$sha" || return 1
  [[ -d $release && ! -L $release ]] || return 1
  [[ -f $release/release.env && ! -L $release/release.env ]] || return 1
  IFS= read -r revision <"$release/release.env" || return 1
  [[ $revision == "APP_REVISION=$sha" ]] || return 1
  [[ $(wc -l <"$release/release.env") -eq 1 ]] || return 1
}

_recover_current_sha() {
  local target
  [[ -L $RECOVER_APP_ROOT/current ]] || return 1
  target=$(readlink "$RECOVER_APP_ROOT/current") || return 1
  [[ $target =~ ^releases/([0-9a-f]{40})$ ]] || return 1
  printf '%s\n' "${BASH_REMATCH[1]}"
}

_recover_replace_current() {
  local sha=$1
  python3 "$RECOVER_ATOMIC_FS" --allowed-root "$RECOVER_APP_ROOT" \
    replace-symlink "$RECOVER_APP_ROOT/current" "releases/$sha"
}

_recover_write_marker() {
  printf '%s\n' "$1" | python3 "$RECOVER_ATOMIC_FS" --allowed-root "$RECOVER_STATE_ROOT" \
    write-file "$RECOVER_STATE_ROOT/deployed-sha" 0600
}

_recover_clear_pending() {
  python3 "$RECOVER_ATOMIC_FS" --allowed-root "$RECOVER_STATE_ROOT" \
    clear-file "$RECOVER_STATE_ROOT/activation-state"
}

recover_main() {
  _recover_load_configuration
  [[ $# -eq 0 ]] || return 1
  _recover_validate_layout || return 1
  _recover_acquire_flock || return 1
  trap _recover_release_flock EXIT

  local marker_sha
  local current_sha=
  local pending_values
  local recovery_sha
  marker_sha=$(_recover_read_marker) || return 1

  if [[ -e $RECOVER_STATE_ROOT/activation-state || -L $RECOVER_STATE_ROOT/activation-state ]]; then
    pending_values=$(_recover_read_pending) || return 1
    recovery_sha=${pending_values%%$'\n'*}
    _recover_validate_release "$recovery_sha" || return 1
    _recover_replace_current "$recovery_sha" || return 1
    _recover_write_marker "$recovery_sha" || return 1
    _recover_clear_pending || return 1
    return 0
  fi

  _recover_validate_release "$marker_sha" || return 1
  current_sha=$(_recover_current_sha) || true
  if [[ $current_sha != "$marker_sha" ]]; then
    _recover_replace_current "$marker_sha" || return 1
  fi
}

if ! _recover_is_sourced; then
  unset CARPLATE_SOURCE_TEST_CONFIG
  recover_main "$@"
fi
