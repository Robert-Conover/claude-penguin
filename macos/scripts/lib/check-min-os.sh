#!/bin/bash
# check-min-os.sh <max-version> <root>...
# Fails when any Mach-O file under the roots needs a newer macOS than <max-version> (for example 26.0).
# Reads LC_BUILD_VERSION minos (and the older LC_VERSION_MIN_MACOSX) of every architecture with vtool.
# A file with no macOS load command is reported too, since its minimum cannot be checked.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
max=$1; shift
command -v vtool >/dev/null || { echo "check-min-os: vtool not found (Xcode Command Line Tools)" >&2; exit 1; }

newer() { # newer A B: true when version A > version B
  local IFS=.
  local -a a=($1) b=($2)
  for i in 0 1 2; do
    local x=${a[i]:-0} y=${b[i]:-0}
    (( x > y )) && return 0
    (( x < y )) && return 1
  done
  return 1
}

bad=0 count=0
while IFS= read -r -d '' f; do
  count=$((count + 1))
  versions=$(vtool -show-build "$f" 2>/dev/null | awk '/^ *minos /{print $2} /LC_VERSION_MIN_MACOSX/{v=1} v && /^ *version /{print $2; v=0}' | sort -u)
  if [[ -z "$versions" ]]; then echo "check-min-os: no macOS minimum recorded: $f" >&2; bad=1; continue; fi
  for v in $versions; do
    if newer "$v" "$max"; then echo "check-min-os: needs macOS $v (> $max): $f" >&2; bad=1; fi
  done
done < <(perl "$here/find-macho.pl" "$@")
(( bad == 0 )) || exit 1
echo "check-min-os: $count Mach-O files run on macOS $max"
