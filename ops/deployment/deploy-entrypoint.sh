#!/bin/sh

set -eu
set -f
umask 077

original_command=${SSH_ORIGINAL_COMMAND-}
unset SSH_ORIGINAL_COMMAND BASH_ENV CDPATH ENV

readonly SAFE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
readonly DEPLOY_ACCOUNT=carplate-deploy
readonly ID=/usr/bin/id
readonly ENV=/usr/bin/env
readonly SUDO=/usr/bin/sudo
readonly DEPLOYER=/usr/local/sbin/deploy-car-plate-tracker
readonly MKTEMP=/usr/bin/mktemp
readonly RM=/bin/rm
readonly PYTHON=/usr/bin/python3

PATH=$SAFE_PATH
export PATH
IFS=' 
	'

case "$original_command" in
  "deploy "*) requested_sha=${original_command#deploy } ;;
  *) exit 1 ;;
esac

[ "${#requested_sha}" -eq 40 ] || exit 1
case "$requested_sha" in
  *[!0123456789abcdef]* | "") exit 1 ;;
esac

current_uid=$("$ID" -u) || exit 1
deploy_uid=$("$ID" -u "$DEPLOY_ACCOUNT") || exit 1
case "$current_uid" in
  0 | *[!0123456789]* | "") exit 1 ;;
esac
case "$deploy_uid" in
  0 | *[!0123456789]* | "") exit 1 ;;
esac
[ "$current_uid" = "$deploy_uid" ] || exit 1

result_file=$("$MKTEMP" /tmp/carplate-deploy-result.XXXXXX) || exit 1
trap '"$RM" -f "$result_file"' 0 HUP INT TERM

if "$ENV" -i \
  "PATH=$SAFE_PATH" \
  LC_ALL=C \
  LANG=C \
  HOME=/nonexistent \
  "$SUDO" -n -- "$DEPLOYER" "$requested_sha" >"$result_file" 2>/dev/null; then
  deploy_status=0
else
  deploy_status=$?
fi

"$ENV" -i \
  "PATH=$SAFE_PATH" \
  LC_ALL=C \
  LANG=C \
  HOME=/nonexistent \
  "$PYTHON" -c '
import json
import re
import sys

expected_sha = sys.argv[1]
raw = sys.stdin.buffer.read(1025)
if not raw or len(raw) > 1024:
    raise SystemExit(1)

try:
    text = raw.decode("ascii")
except UnicodeDecodeError:
    raise SystemExit(1)

if not text.endswith("\n") or text.count("\n") != 1:
    raise SystemExit(1)

def reject_constant(_value):
    raise ValueError("non-finite JSON constant")

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result

try:
    result = json.loads(
        text,
        object_pairs_hook=unique_object,
        parse_constant=reject_constant,
    )
except ValueError:
    raise SystemExit(1)

expected_keys = {
    "outcome",
    "requestedSha",
    "previousSha",
    "activatedSha",
    "diagnosticId",
}
sha_pattern = re.compile(r"^[0-9a-f]{40}$")
diagnostic_pattern = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
outcome_pattern = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")

if not isinstance(result, dict) or set(result) != expected_keys:
    raise SystemExit(1)
if not all(isinstance(value, str) for value in result.values()):
    raise SystemExit(1)
if result["requestedSha"] != expected_sha:
    raise SystemExit(1)
if not outcome_pattern.fullmatch(result["outcome"]):
    raise SystemExit(1)
if not diagnostic_pattern.fullmatch(result["diagnosticId"]):
    raise SystemExit(1)
if not sha_pattern.fullmatch(result["requestedSha"]):
    raise SystemExit(1)
if result["previousSha"] and not sha_pattern.fullmatch(result["previousSha"]):
    raise SystemExit(1)
if result["activatedSha"] and not sha_pattern.fullmatch(result["activatedSha"]):
    raise SystemExit(1)

print(json.dumps({
    "outcome": result["outcome"],
    "requestedSha": result["requestedSha"],
    "previousSha": result["previousSha"],
    "activatedSha": result["activatedSha"],
    "diagnosticId": result["diagnosticId"],
}, separators=(",", ":")))
' "$requested_sha" <"$result_file" 2>/dev/null

exit "$deploy_status"
