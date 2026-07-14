#!/usr/bin/env bash

set -Eeuo pipefail
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

readonly PRODUCTION_CANDIDATES_ROOT=/opt/naver-smartstore-car-plate-tracker/candidates
readonly PRODUCTION_PACKAGE_STORE_ROOT=/opt/naver-smartstore-car-plate-tracker/package-store
readonly PRODUCTION_PNPM_COMMAND=/usr/local/bin/pnpm
readonly PRODUCTION_NODE_COMMAND=/usr/bin/node

_build_candidate_is_sourced() {
  [[ ${BASH_SOURCE[0]} != "$0" ]]
}

_build_candidate_load_configuration() {
  BUILD_TEST_ALLOWED_ROOT=
  BUILD_PNPM_COMMAND=$PRODUCTION_PNPM_COMMAND
  BUILD_NODE_COMMAND=$PRODUCTION_NODE_COMMAND
  BUILD_CANDIDATES_ROOT=$PRODUCTION_CANDIDATES_ROOT
  BUILD_PACKAGE_STORE_ROOT=$PRODUCTION_PACKAGE_STORE_ROOT

  if _build_candidate_is_sourced && [[ -n ${CARPLATE_SOURCE_TEST_CONFIG:-} ]]; then
    # shellcheck source=/dev/null
    source "$CARPLATE_SOURCE_TEST_CONFIG"
  fi
}

_build_path_is_direct_child() {
  [[ $# -eq 2 && $1 == "$2"/* && ${1#"$2"/} != */* && -n ${1#"$2"/} ]]
}

_build_path_is_under_test_root() {
  [[ -n $BUILD_TEST_ALLOWED_ROOT && $1 == "$BUILD_TEST_ALLOWED_ROOT"/* ]]
}

_validate_build_paths() {
  local candidate=$1
  local package_store=$2

  [[ $candidate == /* && $package_store == /* ]] || return 1
  [[ -d $candidate && ! -L $candidate && -d $package_store && ! -L $package_store ]] || return 1
  [[ $(realpath "$candidate") == "$candidate" ]] || return 1
  [[ $(realpath "$package_store") == "$package_store" ]] || return 1

  if [[ -n $BUILD_TEST_ALLOWED_ROOT ]]; then
    _build_path_is_under_test_root "$candidate" || return 1
    _build_path_is_under_test_root "$package_store" || return 1
  else
    _build_path_is_direct_child "$candidate" "$BUILD_CANDIDATES_ROOT" || return 1
    _build_path_is_direct_child "$package_store" "$BUILD_PACKAGE_STORE_ROOT" || return 1
  fi
}

_close_inherited_descriptors() {
  local descriptor_path
  local descriptor
  local flags

  [[ -d /proc/$$/fd ]] || return 0
  for descriptor_path in /proc/$$/fd/*; do
    descriptor=${descriptor_path##*/}
    [[ $descriptor =~ ^[0-9]+$ && $descriptor -gt 2 ]] || continue
    flags=$(awk '$1 == "flags:" { print $2 }' "/proc/$$/fdinfo/$descriptor" 2>/dev/null) || continue
    [[ $flags =~ ^[0-7]+$ ]] || continue
    (( (8#$flags & 3) != 0 )) || continue
    eval "exec ${descriptor}>&-" 2>/dev/null || true
  done
}

build_candidate_main() {
  [[ $# -eq 2 ]] || return 1
  _build_candidate_load_configuration
  local candidate=$1
  local package_store=$2

  _validate_build_paths "$candidate" "$package_store" || return 1
  _close_inherited_descriptors

  unset SSH_AUTH_SOCK SSH_CONNECTION SSH_ORIGINAL_COMMAND SSH_TTY
  unset NAVER_CLIENT_ID NAVER_CLIENT_SECRET GOOGLE_APPLICATION_CREDENTIALS GOOGLE_SERVICE_ACCOUNT_JSON_BASE64
  export HOME=$package_store/home
  export PNPM_HOME=$package_store/pnpm-home
  export PNPM_STORE_DIR=$package_store/store
  export CI=1
  umask 022
  mkdir -p "$HOME" "$PNPM_HOME" "$PNPM_STORE_DIR"
  cd "$candidate"

  "$BUILD_PNPM_COMMAND" install --frozen-lockfile
  "$BUILD_PNPM_COMMAND" build
  "$BUILD_NODE_COMMAND" --check dist/src/scheduler/main.js
  "$BUILD_PNPM_COMMAND" prune --prod
}

if ! _build_candidate_is_sourced; then
  unset CARPLATE_SOURCE_TEST_CONFIG
  build_candidate_main "$@"
fi
