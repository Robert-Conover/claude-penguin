#!/usr/bin/env bash
# Builds .local/macos-build.noindex/Claude Penguin.app. The folder is Git-ignored, and its ".noindex" name keeps
# Spotlight from listing the build as a second installed copy of the app.
#
#   macos/scripts/build-app.sh                full app (needs .local/runtimes, .local/ruffle, network for npm ci)
#   macos/scripts/build-app.sh --no-runtimes  UI-only dev bundle that runs dev/fake-controller.mjs with the system node
#
# Signing: ad-hoc by default. With CP_SIGN_IDENTITY="Developer ID Application: ..." it signs with the hardened
# runtime, a secure timestamp and entitlements. Nothing here needs or asks for Apple ID credentials.
#
# Environment:
#   CP_SIGN_IDENTITY   signing identity (default "-" = ad-hoc)
#   CP_HARDENED=1      use the hardened runtime even when ad-hoc signing (for testing entitlements locally)
#   CP_VERSION         CFBundleShortVersionString (default 0.1.0)
#   CP_RUNTIMES_DIR    runtimes to bundle (default <repo>/.local/runtimes)
#   CP_RUFFLE_DIR      Ruffle to bundle (default <repo>/.local/ruffle)
#   CP_PATCHES_DIR     client-bridge patches (default <repo>/.local/client-bridge-patches, optional)
#   CP_SKIP_SWIFT=1    reuse an existing .build/release binary

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MACOS="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$MACOS/.." && pwd)"

APP_NAME="Claude Penguin"
EXECUTABLE="ClaudePenguin"
BUNDLE_ID="io.github.robert-conover.claude-penguin"
VERSION="${CP_VERSION:-0.1.0}"
BUILD_NUMBER="$(date +%Y%m%d%H%M)"
IDENTITY="${CP_SIGN_IDENTITY:--}"
RUNTIMES_SRC="${CP_RUNTIMES_DIR:-$REPO/.local/runtimes}"
RUFFLE_SRC="${CP_RUFFLE_DIR:-$REPO/.local/ruffle}"
PATCHES_SRC="${CP_PATCHES_DIR:-$REPO/.local/client-bridge-patches}"
ICON_SRC="$MACOS/artwork/ClaudePenguin-v2.icns"

BUILD="$REPO/.local/macos-build.noindex"
APP="$BUILD/$APP_NAME.app"
STAGE="$BUILD/stage"
RES="$APP/Contents/Resources"
UI_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --no-runtimes) UI_ONLY=1 ;;
    -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ -f "$ICON_SRC" ]] || die "missing app icon: $ICON_SRC"

# ---- 1. compile -------------------------------------------------------------------------
if [[ "${CP_SKIP_SWIFT:-0}" != 1 ]]; then
  log "swift build -c release (arm64)"
  (cd "$MACOS" && swift build -c release --arch arm64)
fi
BIN_DIR="$(cd "$MACOS" && swift build -c release --arch arm64 --show-bin-path)"
[[ -x "$BIN_DIR/$EXECUTABLE" ]] || die "missing $BIN_DIR/$EXECUTABLE"

# ---- 2. bundle skeleton --------------------------------------------------------------------
log "assembling $APP"
rm -rf "$APP" "$STAGE"
mkdir -p "$APP/Contents/MacOS" "$RES" "$STAGE"
cp "$BIN_DIR/$EXECUTABLE" "$APP/Contents/MacOS/$EXECUTABLE"
cp "$ICON_SRC" "$RES/ClaudePenguin.icns"

USAGE_TAIL="Claude works in your repositories there when you ask a puffle to code for you."
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>$EXECUTABLE</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleIconFile</key><string>ClaudePenguin.icns</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$BUILD_NUMBER</string>
  <key>CFBundleSupportedPlatforms</key><array><string>MacOSX</string></array>
  <key>LSMinimumSystemVersion</key><string>26.0</string>
  <key>LSArchitecturePriority</key><array><string>arm64</string></array>
  <key>LSRequiresNativeExecution</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.games</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSDocumentsFolderUsageDescription</key>
  <string>$APP_NAME needs access to your Documents folder. $USAGE_TAIL</string>
  <key>NSDesktopFolderUsageDescription</key>
  <string>$APP_NAME needs access to your Desktop folder. $USAGE_TAIL</string>
  <key>NSDownloadsFolderUsageDescription</key>
  <string>$APP_NAME needs access to your Downloads folder. $USAGE_TAIL</string>
  <key>NSRemovableVolumesUsageDescription</key>
  <string>$APP_NAME needs access to removable volumes. $USAGE_TAIL</string>
  <key>NSNetworkVolumesUsageDescription</key>
  <string>$APP_NAME needs access to network volumes. $USAGE_TAIL</string>
</dict>
</plist>
PLIST
plutil -lint "$APP/Contents/Info.plist" >/dev/null
printf 'APPL????' > "$APP/Contents/PkgInfo"

# ---- 3. resources ---------------------------------------------------------------------------
# rsync with explicit excludes; tests and VCS data never ship.
COMMON_EXCLUDES=(--exclude '.git' --exclude '.gitignore' --exclude '__pycache__' --exclude '*.pyc' --exclude '.DS_Store')
copy_tree() { # src dst [extra rsync args...]
  local src="$1" dst="$2"; shift 2
  mkdir -p "$dst"
  rsync -a "${COMMON_EXCLUDES[@]}" ${1+"$@"} "$src/" "$dst/"
}

if (( UI_ONLY )); then
  log "UI-only bundle: fake controller, no runtimes"
  mkdir -p "$RES/dev"
  cp "$MACOS/dev/fake-controller.mjs" "$RES/dev/fake-controller.mjs"
else
  [[ -x "$RUNTIMES_SRC/node/bin/node" ]] || die "no runtimes at $RUNTIMES_SRC (expected node/bin/node). Build them first, or use --no-runtimes."
  [[ -f "$RUFFLE_SRC/ruffle.js" ]] || die "no Ruffle at $RUFFLE_SRC"
  APPRES="$RES/app"
  mkdir -p "$APPRES/local"

  log "copying allowlisted resources"
  NODE_TEST_EXCLUDES=(--exclude 'node_modules' --exclude '*.test.mjs' --exclude 'test_*.py' --exclude 'testing.mjs')
  for d in controller engine web native installer; do
    if [[ -d "$REPO/local/$d" ]]; then
      copy_tree "$REPO/local/$d" "$APPRES/local/$d" "${NODE_TEST_EXCLUDES[@]}" --exclude 'Dockerfile' --exclude 'verify-http.mjs' --exclude 'setup-ruffle.sh'
    else
      echo "warning: local/$d does not exist yet (another part of the build owns it)" >&2
    fi
  done
  # engine/testing.mjs is imported by production code? keep it if anything imports it.
  if grep -rqs "testing.mjs" "$APPRES/local/engine" 2>/dev/null; then cp "$REPO/local/engine/testing.mjs" "$APPRES/local/engine/"; fi

  # client-bridge: only what runs at install time (patcher), plus the patches themselves.
  mkdir -p "$APPRES/local/client-bridge"
  for f in "$REPO"/local/client-bridge/patcher*.mjs; do
    [[ -e "$f" && "$f" != *.test.mjs ]] && cp "$f" "$APPRES/local/client-bridge/"
  done
  if [[ -d "$PATCHES_SRC" ]]; then
    copy_tree "$PATCHES_SRC" "$APPRES/local/client-bridge/patches"
  else
    echo "note: no client-bridge patches at $PATCHES_SRC; bundle ships without them" >&2
  fi

  # local/*.py the native services use (not tests, not the Compose-only doctor).
  for f in "$REPO"/local/*.py; do
    case "$(basename "$f")" in test_*|doctor.py) continue ;; esac
    cp "$f" "$APPRES/local/"
  done

  for d in houdini dash snowflake; do
    copy_tree "$REPO/$d" "$APPRES/$d"
  done
  copy_tree "$REPO/templates" "$APPRES/templates"
  cp "$REPO/servers.xml" "$APPRES/servers.xml"

  # Production dependencies, installed in a staging copy so the checkout's node_modules is never touched.
  NPM_NODE_DIR="$RUNTIMES_SRC/node/bin"
  for d in engine web; do
    [[ -f "$REPO/local/$d/package-lock.json" ]] || continue
    log "npm ci --omit=dev --ignore-scripts ($d)"
    mkdir -p "$STAGE/$d"
    cp "$REPO/local/$d/package.json" "$REPO/local/$d/package-lock.json" "$STAGE/$d/"
    (cd "$STAGE/$d" && PATH="$NPM_NODE_DIR:$PATH" npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
    mkdir -p "$APPRES/local/$d"
    rsync -a "$STAGE/$d/node_modules/" "$APPRES/local/$d/node_modules/"
  done

  # node-pty must ship its darwin-arm64 prebuilt binary and spawn-helper (--ignore-scripts skips building).
  PTY_DIR="$APPRES/local/engine/node_modules/@lydell/node-pty-darwin-arm64/prebuilds/darwin-arm64"
  if [[ -d "$APPRES/local/engine" && -f "$APPRES/local/engine/package.json" ]]; then
    [[ -f "$PTY_DIR/pty.node" ]] || die "node-pty prebuilt missing: $PTY_DIR/pty.node"
    [[ -x "$PTY_DIR/spawn-helper" ]] || die "node-pty spawn-helper missing or not executable: $PTY_DIR/spawn-helper"
    echo "node-pty prebuilt OK: $(file -b "$PTY_DIR/pty.node")"
  fi

  log "Ruffle -> app/ruffle"
  copy_tree "$RUFFLE_SRC" "$APPRES/ruffle"

  log "runtimes"
  mkdir -p "$RES/runtimes"
  rsync -a --exclude '.DS_Store' "$RUNTIMES_SRC/" "$RES/runtimes/"

  # The controller must pass RUFFLE_ROOT to the web server; record where it is.
  cat > "$APPRES/bundle-layout.json" <<JSON
{
  "ruffleRoot": "ruffle",
  "clientBridgePatches": "local/client-bridge/patches",
  "note": "Paths are relative to this directory (Contents/Resources/app). The controller passes RUFFLE_ROOT=<resources>/ruffle to the web server."
}
JSON
fi

# ---- 4. sign (inside out) -----------------------------------------------------------------------
log "checking minimum macOS of every Mach-O file"
"$HERE/lib/check-min-os.sh" 26.0 "$APP"   # matches LSMinimumSystemVersion above

SIGN_FLAGS=(--force --sign "$IDENTITY")
if [[ "$IDENTITY" != "-" ]]; then
  SIGN_FLAGS+=(--options runtime --timestamp)
elif [[ "${CP_HARDENED:-0}" == 1 ]]; then
  SIGN_FLAGS+=(--options runtime)
fi
log "signing (identity: $IDENTITY)"

sign_one() {
  local f="$1" ents=()
  if [[ "$IDENTITY" == "-" && "${CP_HARDENED:-0}" == 1 ]]; then
    # Local hardened-runtime test with an ad-hoc signature: no Team ID, so library validation must be relaxed
    # for executables that load our other Mach-O files. Never used for a Developer ID build.
    case "$f" in *.node|*.dylib|*.so|*.bundle) ;; *) ents=(--entitlements "$MACOS/Entitlements/adhoc-test.plist") ;; esac
  else
    case "$f" in
      */runtimes/node/bin/node) ents=(--entitlements "$MACOS/Entitlements/node.plist") ;;
    esac
  fi
  codesign "${SIGN_FLAGS[@]}" ${ents[@]+"${ents[@]}"} "$f"
}

COUNT=0
while IFS= read -r -d '' f; do
  sign_one "$f"
  COUNT=$((COUNT + 1))
done < <(perl "$HERE/lib/find-macho.pl" "$RES")
echo "signed $COUNT nested Mach-O files"

APP_ENTS=()
if [[ "$IDENTITY" != "-" || "${CP_HARDENED:-0}" == 1 ]]; then APP_ENTS=(--entitlements "$MACOS/Entitlements/app.plist"); fi
codesign "${SIGN_FLAGS[@]}" ${APP_ENTS[@]+"${APP_ENTS[@]}"} "$APP"

log "verifying"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dv "$APP" 2>&1 | grep -E 'Identifier|Signature|flags|TeamIdentifier' || true
rm -rf "$STAGE"
echo
echo "Built: $APP"
