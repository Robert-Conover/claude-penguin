#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/../.." && pwd)"
version=nightly-2026-11-03
archive=ruffle-nightly-2026_11_03-web-selfhosted.zip
checksum=b3762367e4cdc1313adbd756eba99c0660af63bb0d1e187dc3cd92644428a100
ruffle_tmp="$(mktemp -d "${TMPDIR:-/tmp}/club-penguin-ruffle.XXXXXX")"
trap 'rm -rf "$ruffle_tmp"' EXIT
curl --fail --location --retry 2 "https://github.com/ruffle-rs/ruffle/releases/download/$version/$archive" -o "$ruffle_tmp/$archive"
actual="$(shasum -a 256 "$ruffle_tmp/$archive" | cut -d ' ' -f 1)"
if [ "$actual" != "$checksum" ]; then
  echo "Ruffle archive checksum mismatch" >&2
  exit 1
fi
unzip -q "$ruffle_tmp/$archive" -d "$ruffle_tmp/runtime"
test -f "$ruffle_tmp/runtime/ruffle.js"
mkdir -p "$project_root/.local/ruffle"
cp -R "$ruffle_tmp/runtime/." "$project_root/.local/ruffle/"
printf '%s\n%s  %s\n' "$version" "$checksum" "$archive" > "$project_root/.local/ruffle/VERSION"
printf 'Ruffle %s installed at %s\n' "$version" "$project_root/.local/ruffle"
