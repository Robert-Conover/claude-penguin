#!/usr/bin/env bash
# Submits the disk image to Apple's notary service, staples the ticket, and runs Gatekeeper assessments.
#
#   CP_NOTARY_PROFILE=<keychain profile> macos/scripts/notarize.sh [path/to/Claude-Penguin.dmg]
#
# The profile is created once by the owner with `xcrun notarytool store-credentials`, which keeps the
# credentials in the login keychain. This script never reads, prints or accepts Apple ID passwords.
# Requires a Developer ID-signed app and DMG (CP_SIGN_IDENTITY for build-app.sh and make-dmg.sh).
#
# NOT RUN during development: no Developer ID certificate or notary profile exists on the build machine.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MACOS="$(cd "$HERE/.." && pwd)"
DMG="${1:-$(cd "$MACOS/.." && pwd)/.local/macos-build.noindex/Claude-Penguin.dmg}"

: "${CP_NOTARY_PROFILE:?set CP_NOTARY_PROFILE to a notarytool keychain profile name}"
[[ -f "$DMG" ]] || { echo "error: $DMG not found; run make-dmg.sh first" >&2; exit 1; }

echo "==> submitting $DMG (waits for the result)"
xcrun notarytool submit "$DMG" --keychain-profile "$CP_NOTARY_PROFILE" --wait

echo "==> stapling"
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"

echo "==> Gatekeeper assessment of the disk image"
spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG"

echo "==> Gatekeeper assessment of the app inside"
MNT="$(mktemp -d "${TMPDIR:-/tmp}/cp-notarize.XXXXXX")"
trap 'hdiutil detach "$MNT" -quiet >/dev/null 2>&1 || true; rmdir "$MNT" 2>/dev/null || true' EXIT
hdiutil attach "$DMG" -mountpoint "$MNT" -nobrowse -readonly -quiet
spctl --assess --type execute --verbose=4 "$MNT/Claude Penguin.app"
echo "Notarized and stapled: $DMG"
