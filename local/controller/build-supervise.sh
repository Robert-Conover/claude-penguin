#!/bin/sh
# Builds the cp-supervise shim with the system C compiler.
#   CP_SUPERVISE_OUT overrides the output path (tests build into a scratch directory).
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo=$(CDPATH= cd -- "$here/../.." && pwd)
out=${CP_SUPERVISE_OUT:-$repo/.local/runtimes/supervise/cp-supervise}
command -v cc >/dev/null 2>&1 || { echo 'build-supervise.sh: no C compiler (cc). Install the Command Line Tools: xcode-select --install' >&2; exit 1; }
mkdir -p "$(dirname -- "$out")"
tmp="$out.tmp.$$"
trap 'rm -f "$tmp"' EXIT
cc -O2 -Wall -Wextra -Werror -o "$tmp" "$here/supervise.c"
chmod 755 "$tmp"
mv -f "$tmp" "$out"
trap - EXIT
echo "$out"
