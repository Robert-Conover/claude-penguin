#!/bin/sh
# Builds the cp-supervise shim with the system C compiler.
#   CP_SUPERVISE_OUT overrides the output path (tests build into a scratch directory).
#   MACOSX_DEPLOYMENT_TARGET is the oldest macOS it must run on (default 26.0, the app's minimum;
#   local/native/runtimes.json uses the same value). Without it, cc targets the build Mac's version.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo=$(CDPATH= cd -- "$here/../.." && pwd)
out=${CP_SUPERVISE_OUT:-$repo/.local/runtimes/supervise/cp-supervise}
command -v cc >/dev/null 2>&1 || { echo 'build-supervise.sh: no C compiler (cc). Install the Command Line Tools: xcode-select --install' >&2; exit 1; }
mkdir -p "$(dirname -- "$out")"
tmp="$out.tmp.$$"
trap 'rm -f "$tmp"' EXIT
target=${MACOSX_DEPLOYMENT_TARGET:-26.0}
cc -O2 -Wall -Wextra -Werror -mmacosx-version-min="$target" -o "$tmp" "$here/supervise.c"
chmod 755 "$tmp"
mv -f "$tmp" "$out"
trap - EXIT
echo "$out"
