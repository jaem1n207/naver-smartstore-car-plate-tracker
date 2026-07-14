#!/usr/bin/env bash

set -Eeuo pipefail
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

# Task 4 must provision the runtime parent as setgid root:carplate. The lock
# directory keeps that group and setgid inheritance while exposing 0770 permissions.
readonly SYNC_LOCK_PARENT_MODE=2770
readonly SYNC_LOCK_DIRECTORY_MODE=0770
readonly SYNC_LOCK_OWNER_MODE=0640

validate_sha() {
  [[ $# -eq 1 && $1 =~ ^[0-9a-f]{40}$ ]]
}

classify_revision() {
  [[ $# -eq 3 ]] || return 1
  local git_dir=$1
  local deployed_sha=$2
  local requested_sha=$3
  local status

  [[ -d $git_dir && ! -L $git_dir ]] || return 1
  validate_sha "$deployed_sha" || return 1
  validate_sha "$requested_sha" || return 1
  git --git-dir="$git_dir" cat-file -e "${deployed_sha}^{commit}" 2>/dev/null || return 1
  git --git-dir="$git_dir" cat-file -e "${requested_sha}^{commit}" 2>/dev/null || return 1

  if [[ $deployed_sha == "$requested_sha" ]]; then
    printf 'equal\n'
    return 0
  fi

  if git --git-dir="$git_dir" merge-base --is-ancestor "$requested_sha" "$deployed_sha"; then
    printf 'stale\n'
    return 0
  else
    status=$?
    [[ $status -eq 1 ]] || return 1
  fi

  if git --git-dir="$git_dir" merge-base --is-ancestor "$deployed_sha" "$requested_sha"; then
    printf 'forward\n'
    return 0
  else
    status=$?
    [[ $status -eq 1 ]] || return 1
  fi

  printf 'divergent\n'
}

read_lock_owner() {
  [[ $# -eq 1 ]] || return 1
  _load_lock_owner "$1" || return 1
  printf 'pid=%s\nstart_ticks=%s\ntoken=%s\n' \
    "$DEPLOY_LOCK_OWNER_PID" \
    "$DEPLOY_LOCK_OWNER_START_TICKS" \
    "$DEPLOY_LOCK_OWNER_TOKEN"
}

acquire_sync_lock() {
  [[ $# -ge 1 && $# -le 2 ]] || return 1
  local lock_dir=$1
  local wait_seconds=${2:-3600}
  local deadline

  [[ $lock_dir == /* && $wait_seconds =~ ^(0|[1-9][0-9]*)$ ]] || return 1
  _validate_sync_lock_parent "${lock_dir%/*}" || return 1
  deadline=$((SECONDS + wait_seconds))

  while true; do
    if _create_sync_lock "$lock_dir"; then
      return 0
    fi

    [[ -e $lock_dir || -L $lock_dir ]] || return 1
    [[ -d $lock_dir && ! -L $lock_dir ]] || return 1

    if _reclaim_stale_sync_lock "$lock_dir"; then
      continue
    fi

    (( SECONDS < deadline )) || return 1
    sleep 0.1
  done
}

release_sync_lock() {
  [[ $# -eq 2 ]] || return 1
  local lock_dir=$1
  local token=$2
  local snapshot

  [[ $token =~ ^[0-9a-f]{32}$ ]] || return 1
  _load_lock_owner "$lock_dir" || return 0
  [[ $DEPLOY_LOCK_OWNER_TOKEN == "$token" ]] || return 0
  _lock_contains_only_owner "$lock_dir" || return 1
  printf -v snapshot 'pid=%s\nstart_ticks=%s\ntoken=%s\n' \
    "$DEPLOY_LOCK_OWNER_PID" \
    "$DEPLOY_LOCK_OWNER_START_TICKS" \
    "$DEPLOY_LOCK_OWNER_TOKEN"
  [[ $(read_lock_owner "$lock_dir")$'\n' == "$snapshot" ]] || return 1

  rm "$lock_dir/owner" || return 1
  rmdir "$lock_dir"
}

safe_result() {
  [[ $# -ge 5 ]] || return 1
  local outcome=$1
  local requested_sha=$2
  local previous_sha=$3
  local activated_sha=$4
  local diagnostic_id=$5

  [[ $outcome =~ ^[a-z][a-z0-9_-]{0,63}$ ]] || return 1
  validate_sha "$requested_sha" || return 1
  [[ -z $previous_sha ]] || validate_sha "$previous_sha" || return 1
  [[ -z $activated_sha ]] || validate_sha "$activated_sha" || return 1
  [[ $diagnostic_id =~ ^[A-Za-z0-9_-]{1,128}$ ]] || return 1

  python3 -c \
    'import json,sys; print(json.dumps(dict(zip(("outcome","requestedSha","previousSha","activatedSha","diagnosticId"), sys.argv[1:])), separators=(",",":")))' \
    "$outcome" "$requested_sha" "$previous_sha" "$activated_sha" "$diagnostic_id"
}

validate_candidate_tree() {
  [[ $# -eq 1 ]] || return 1
  local candidate_root=$1

  [[ $candidate_root == /* && -d $candidate_root && ! -L $candidate_root ]] || return 1
  python3 -c '
import os
import re
import stat
import subprocess
import sys

root = os.path.abspath(sys.argv[1])
if os.path.realpath(root) != root:
    raise SystemExit(1)

LINUX_ACL_XATTRS = frozenset({
    "system.posix_acl_access",
    "system.posix_acl_default",
})
ALLOWED_XATTRS = {
    "darwin": frozenset({"com.apple.provenance"}),
    "linux": frozenset(),
}

def platform_xattr_policy():
    if sys.platform == "darwin":
        return ALLOWED_XATTRS["darwin"]
    if sys.platform.startswith("linux"):
        return ALLOWED_XATTRS["linux"]
    raise SystemExit(1)

def list_extended_attributes(path):
    list_xattrs = getattr(os, "listxattr", None)
    if list_xattrs is not None:
        return frozenset(list_xattrs(path, follow_symlinks=False))
    if sys.platform == "darwin" and os.path.isfile("/usr/bin/xattr"):
        result = subprocess.run(
            ["/usr/bin/xattr", "-s", path],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise SystemExit(1)
        return frozenset(line for line in result.stdout.splitlines() if line)
    raise SystemExit(1)

def validate_extended_attributes(path):
    attributes = list_extended_attributes(path)
    if sys.platform.startswith("linux") and attributes & LINUX_ACL_XATTRS:
        raise SystemExit(1)
    if attributes - platform_xattr_policy():
        raise SystemExit(1)

def validate_darwin_acl(path):
    if sys.platform != "darwin":
        return
    if not os.path.isfile("/bin/ls"):
        raise SystemExit(1)
    result = subprocess.run(
        ["/bin/ls", "-lde", path],
        check=False,
        capture_output=True,
        env={"LC_ALL": "C", "PATH": "/usr/bin:/bin"},
        text=True,
    )
    if result.returncode != 0:
        raise SystemExit(1)
    if any(re.match(r"^\s*[0-9]+:\s", line) for line in result.stdout.splitlines()[1:]):
        raise SystemExit(1)

def validate_metadata(path):
    validate_extended_attributes(path)
    validate_darwin_acl(path)

validate_metadata(root)
for current, directories, files in os.walk(root, followlinks=False):
    for name in directories + files:
        path = os.path.join(current, name)
        metadata = os.lstat(path)
        mode = metadata.st_mode
        validate_metadata(path)
        if stat.S_ISLNK(mode):
            target = os.readlink(path)
            if os.path.isabs(target):
                raise SystemExit(1)
            resolved = os.path.realpath(path)
            if os.path.commonpath((root, resolved)) != root or not os.path.exists(resolved):
                raise SystemExit(1)
            continue
        if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
            raise SystemExit(1)
        if mode & (stat.S_IWGRP | stat.S_IWOTH | stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX):
            raise SystemExit(1)
' "$candidate_root"
}

verify_invocation() {
  [[ $# -eq 7 ]] || return 1
  local previous_invocation=$1
  local current_invocation=$2
  local baseline_restarts=$3
  local current_restarts=$4
  local expected_cron=$5
  local expected_revision=$6
  local journal_file=$7

  [[ -z $previous_invocation || $previous_invocation =~ ^[0-9a-f]{32}$ ]] || return 1
  [[ $current_invocation =~ ^[0-9a-f]{32}$ ]] || return 1
  [[ $current_invocation != "$previous_invocation" ]] || return 1
  [[ $baseline_restarts =~ ^(0|[1-9][0-9]*)$ ]] || return 1
  [[ $current_restarts == "$baseline_restarts" ]] || return 1
  [[ -n $expected_cron && $expected_cron != *$'\n'* ]] || return 1
  validate_sha "$expected_revision" || return 1
  [[ -f $journal_file && ! -L $journal_file ]] || return 1

  python3 -c '
import json
import sys

cron, revision, journal_path = sys.argv[1:]
matched = False

def reject_constant(_value):
    raise ValueError("non-finite JSON constant")

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result

with open(journal_path, "r", encoding="utf-8") as journal:
    for line in journal:
        if not line.strip():
            continue
        try:
            record = json.loads(
                line,
                object_pairs_hook=unique_object,
                parse_constant=reject_constant,
            )
        except (ValueError, UnicodeDecodeError):
            raise SystemExit(1)
        if not isinstance(record, dict):
            raise SystemExit(1)
        if (
            record.get("msg") == "scheduler started"
            and record.get("mode") == "live"
            and record.get("cron") == cron
            and record.get("appRevision") == revision
        ):
            matched = True
if not matched:
    raise SystemExit(1)
' "$expected_cron" "$expected_revision" "$journal_file"
}

_load_lock_owner() {
  [[ $# -eq 1 ]] || return 1
  local lock_dir=$1
  local owner_path=$lock_dir/owner
  local pid_line
  local start_ticks_line
  local token_line
  local extra_line
  local parsed_pid

  [[ -d $lock_dir && ! -L $lock_dir ]] || return 1
  [[ -f $owner_path && ! -L $owner_path ]] || return 1

  exec 3<"$owner_path" || return 1
  if ! IFS= read -r pid_line <&3 \
    || ! IFS= read -r start_ticks_line <&3 \
    || ! IFS= read -r token_line <&3; then
    exec 3<&-
    return 1
  fi
  if IFS= read -r extra_line <&3; then
    exec 3<&-
    return 1
  fi
  exec 3<&-

  [[ $pid_line =~ ^pid=([1-9][0-9]*)$ ]] || return 1
  parsed_pid=${BASH_REMATCH[1]}
  _is_safe_lock_pid "$parsed_pid" || return 1
  DEPLOY_LOCK_OWNER_PID=$parsed_pid
  [[ $start_ticks_line =~ ^start_ticks=([1-9][0-9]*|unknown)$ ]] || return 1
  DEPLOY_LOCK_OWNER_START_TICKS=${BASH_REMATCH[1]}
  [[ $token_line =~ ^token=([0-9a-f]{32})$ ]] || return 1
  DEPLOY_LOCK_OWNER_TOKEN=${BASH_REMATCH[1]}
}

_is_safe_lock_pid() {
  [[ $# -eq 1 && $1 =~ ^[1-9][0-9]*$ ]] || return 1
  local value=$1
  local maximum=9007199254740991
  local LC_ALL=C

  if [[ ${#value} -lt ${#maximum} ]]; then
    return 0
  fi
  if [[ ${#value} -gt ${#maximum} ]]; then
    return 1
  fi
  [[ $value == "$maximum" || $value < "$maximum" ]]
}

_create_sync_lock() {
  local lock_dir=$1
  local parent_dir=${lock_dir%/*}
  local token
  local pid=$$
  local start_ticks
  local temporary_owner

  mkdir -m "$SYNC_LOCK_PARENT_MODE" "$lock_dir" 2>/dev/null || return 1
  if ! _validate_created_sync_lock_directory "$parent_dir" "$lock_dir"; then
    rmdir "$lock_dir" 2>/dev/null || true
    return 1
  fi
  token=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n') || {
    rmdir "$lock_dir" 2>/dev/null || true
    return 1
  }
  [[ $token =~ ^[0-9a-f]{32}$ ]] || {
    rmdir "$lock_dir" 2>/dev/null || true
    return 1
  }
  start_ticks=$(_read_process_start_ticks "$pid") || start_ticks=unknown
  temporary_owner=$lock_dir/.owner.$token.tmp

  if ! (
    umask 027
    set -o noclobber
    printf 'pid=%s\nstart_ticks=%s\ntoken=%s\n' "$pid" "$start_ticks" "$token" >"$temporary_owner"
    chmod "$SYNC_LOCK_OWNER_MODE" "$temporary_owner"
  ); then
    rm "$temporary_owner" 2>/dev/null || true
    rmdir "$lock_dir" 2>/dev/null || true
    return 1
  fi
  if ! mv "$temporary_owner" "$lock_dir/owner"; then
    rm "$temporary_owner" 2>/dev/null || true
    rmdir "$lock_dir" 2>/dev/null || true
    return 1
  fi
  if ! _validate_created_sync_lock_owner "$lock_dir"; then
    rm "$lock_dir/owner" 2>/dev/null || true
    rmdir "$lock_dir" 2>/dev/null || true
    return 1
  fi

  printf '%s\n' "$token"
}

_validate_sync_lock_parent() {
  [[ $# -eq 1 ]] || return 1
  python3 -c '
import os
import stat
import sys

path = sys.argv[1]
metadata = os.lstat(path)
mode = metadata.st_mode
if not stat.S_ISDIR(mode) or os.path.realpath(path) != path:
    raise SystemExit(1)
expected_mode = int(sys.argv[2], 8)
if (stat.S_IMODE(mode) & 0o777) != (expected_mode & 0o777):
    raise SystemExit(1)
if sys.platform.startswith("linux") and expected_mode & stat.S_ISGID and not mode & stat.S_ISGID:
    raise SystemExit(1)
' "$1" "$SYNC_LOCK_PARENT_MODE"
}

_validate_created_sync_lock_directory() {
  [[ $# -eq 2 ]] || return 1
  python3 -c '
import os
import stat
import sys

parent = os.lstat(sys.argv[1])
lock = os.lstat(sys.argv[2])
expected_mode = int(sys.argv[3], 8)
if not stat.S_ISDIR(lock.st_mode) or stat.S_IMODE(lock.st_mode) & 0o777 != expected_mode:
    raise SystemExit(1)
if lock.st_gid != parent.st_gid:
    raise SystemExit(1)
if sys.platform.startswith("linux") and not lock.st_mode & stat.S_ISGID:
    raise SystemExit(1)
' "$1" "$2" "$SYNC_LOCK_DIRECTORY_MODE"
}

_validate_created_sync_lock_owner() {
  [[ $# -eq 1 ]] || return 1
  python3 -c '
import os
import stat
import sys

lock = os.lstat(sys.argv[1])
owner = os.lstat(os.path.join(sys.argv[1], "owner"))
expected_mode = int(sys.argv[2], 8)
if not stat.S_ISREG(owner.st_mode) or stat.S_IMODE(owner.st_mode) != expected_mode:
    raise SystemExit(1)
if owner.st_gid != lock.st_gid:
    raise SystemExit(1)
' "$1" "$SYNC_LOCK_OWNER_MODE"
}

_reclaim_stale_sync_lock() {
  local lock_dir=$1
  local snapshot

  _load_lock_owner "$lock_dir" || return 1
  _lock_owner_is_stale || return 1
  _lock_contains_only_owner "$lock_dir" || return 1
  printf -v snapshot 'pid=%s\nstart_ticks=%s\ntoken=%s\n' \
    "$DEPLOY_LOCK_OWNER_PID" \
    "$DEPLOY_LOCK_OWNER_START_TICKS" \
    "$DEPLOY_LOCK_OWNER_TOKEN"
  [[ $(read_lock_owner "$lock_dir")$'\n' == "$snapshot" ]] || return 1

  rm "$lock_dir/owner" || return 1
  rmdir "$lock_dir"
}

_lock_owner_is_stale() {
  local current_start_ticks

  if kill -0 "$DEPLOY_LOCK_OWNER_PID" 2>/dev/null; then
    :
  elif [[ -d /proc/$DEPLOY_LOCK_OWNER_PID ]]; then
    return 1
  else
    return 0
  fi

  [[ $DEPLOY_LOCK_OWNER_START_TICKS != unknown ]] || return 1
  current_start_ticks=$(_read_process_start_ticks "$DEPLOY_LOCK_OWNER_PID") || return 1
  [[ $current_start_ticks != "$DEPLOY_LOCK_OWNER_START_TICKS" ]]
}

_read_process_start_ticks() {
  [[ $# -eq 1 && $1 =~ ^[1-9][0-9]*$ ]] || return 1
  local pid=$1
  local stat_contents
  local fields_after_command
  local fields=()

  [[ -r /proc/$pid/stat && ! -L /proc/$pid/stat ]] || return 1
  stat_contents=$(<"/proc/$pid/stat") || return 1
  [[ $stat_contents == *") "* ]] || return 1
  fields_after_command=${stat_contents##*) }
  read -r -a fields <<<"$fields_after_command"
  [[ ${#fields[@]} -gt 19 && ${fields[19]} =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s\n' "${fields[19]}"
}

_lock_contains_only_owner() (
  local lock_dir=$1
  local entry
  local count=0
  shopt -s nullglob dotglob
  for entry in "$lock_dir"/*; do
    ((count += 1))
    [[ $entry == "$lock_dir/owner" ]] || return 1
  done
  [[ $count -eq 1 ]]
)
