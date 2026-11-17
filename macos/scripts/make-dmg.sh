#!/usr/bin/env bash
# Builds Claude-Penguin.dmg from Claude Penguin.app, both in .local/macos-build.noindex/, with an Applications link.
# With CP_SIGN_IDENTITY set, the disk image itself is signed too (the app must already be signed by build-app.sh).
#
#   macos/scripts/make-dmg.sh [path/to/Claude Penguin.app] [output.dmg]

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MACOS="$(cd "$HERE/.." && pwd)"
BUILD="$(cd "$MACOS/.." && pwd)/.local/macos-build.noindex"
APP_NAME="Claude Penguin"
APP="${1:-$BUILD/$APP_NAME.app}"
DMG="${2:-$BUILD/Claude-Penguin.dmg}"
IDENTITY="${CP_SIGN_IDENTITY:-}"

[[ -d "$APP" ]] || { echo "error: $APP not found; run build-app.sh first" >&2; exit 1; }
codesign --verify --deep --strict "$APP" || { echo "error: app signature does not verify" >&2; exit 1; }

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/cp-dmg.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
# ditto preserves signatures, symlinks and extended attributes.
ditto "$APP" "$STAGE/$APP_NAME.app"
ln -s /Applications "$STAGE/Applications"

rm -f "$DMG"
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGE" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov "$DMG" >/dev/null

if [[ -n "$IDENTITY" && "$IDENTITY" != "-" ]]; then
  codesign --force --sign "$IDENTITY" --timestamp "$DMG"
fi
hdiutil verify "$DMG" >/dev/null
echo "Built: $DMG ($(du -h "$DMG" | cut -f1))"
