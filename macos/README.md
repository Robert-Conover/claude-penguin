# Claude Penguin for macOS (native app)

A SwiftUI/AppKit shell (Swift 6, macOS 26+, arm64) around the shared Node controller. It shows setup and recovery screens, hosts the game and the puffle terminal in a `WKWebView`, and runs the controller as a child process. Interfaces: `.local/plans/macos-contract.md`; plan: `.local/plans/macos-app.md`. The product name is the constant `Product.name` in `Sources/ClaudePenguin/AppPaths.swift` (and `APP_NAME` in `scripts/`).

## Layout

| Path | What |
| --- | --- |
| `Package.swift`, `Sources/ClaudePenguin/` | The app (single executable target, no third-party packages). |
| `Tests/ClaudePenguinTests/` | `swift test` (Swift Testing). |
| `dev/fake-controller.mjs` | Dependency-free fake controller for UI work (protocol, scenarios, a test page). |
| `scripts/build-app.sh`, `make-dmg.sh`, `notarize.sh` | Bundle, disk image, notarization. |
| `Entitlements/` | `app.plist` (empty: no sandbox, no JIT), `node.plist` (`allow-jit`), `adhoc-test.plist` (local hardened-runtime tests only). |

## Build and run

```sh
cd macos
swift build && swift test

# UI-only bundle: fake controller + system Node, no runtimes
scripts/build-app.sh --no-runtimes
open -n "build/Claude Penguin.app"

# Full bundle (needs .local/runtimes, .local/ruffle, and network or an npm cache for `npm ci`)
scripts/build-app.sh
```

The UI-only bundle looks for `Contents/Resources/dev/fake-controller.mjs` when the real controller is absent and runs it with the first `node` it finds (`/opt/homebrew/bin`, `/usr/local/bin`, `PATH`). It does not write to the real data folder if you set `CP_APP_DEV_DATA`.

`open --env` passes variables to a LaunchServices launch: `open -n --env CP_APP_DEV_DATA=/tmp/cp-data --env FAKE_PORT_CONFLICT=1 "build/Claude Penguin.app"`.

### Dev overrides (environment)

| Variable | Overrides |
| --- | --- |
| `CP_APP_DEV_NODE` | the `node` binary (default `<runtimes>/node/bin/node`) |
| `CP_APP_DEV_CONTROLLER` | the controller script (default `<resources>/local/controller/main.mjs`) |
| `CP_APP_DEV_RESOURCES` | `--resources` (default `Contents/Resources/app`) |
| `CP_APP_DEV_RUNTIMES` | `--runtimes` (default `Contents/Resources/runtimes`) |
| `CP_APP_DEV_DATA` | `--data` (default `~/Library/Application Support/Claude Penguin`) |
| `CP_APP_DEV_FORCE_MOVE=1` | show the Move to Applications screen |
| `CP_APP_DEV_INSPECT=1` | make the web view inspectable (Safari Web Inspector) |
| `CP_APP_DEV_SNAPSHOT_DIR` | write a PNG of the window each time the screen changes (renders the app's own views; needs no Screen Recording permission) |
| `CP_APP_DEV_AUTOPILOT` | scripted UI for walkthroughs, `\|`-separated: `choose:code`, `choose:explore`, `begin`, `cancel`, `retry`, `recover`, `restart`, `close`, `reopen`, `js:<code>`, `wait:<s>`, `quit`. Each step waits for the screen it needs. |

`CP_APP_DEV_*` variables are removed from the controller's environment. Everything else is passed through.

### Fake controller

`node dev/fake-controller.mjs --data <dir> [--page-port 47180]`. It serves the "game" page on `127.0.0.1:<page-port>` (default **47180**, `FAKE_PAGE_PORT`) and the "agents" page on port+1 (different origin on purpose). The pages have an external link, `target=_blank`, `window.open`, alert/confirm/prompt, element fullscreen, autoplay audio, a paste box, and buttons that post `claudePenguinHost` messages (two allowed, four that must be rejected: symlink escape, `..`, `worktrees-evil`, `/etc`). Switches:

| Variable | Effect |
| --- | --- |
| `FAKE_SETUP_COMPLETE=1` | start set up (state `stopped`); `FAKE_MODE=explore\|code` |
| `FAKE_PORT_CONFLICT=1`, `FAKE_DISK_SHORT=1` | preflight problems |
| `FAKE_SURVIVOR=1` (or `FAKE_RECOVERY=1`) | start in `recovery` |
| `FAKE_FAIL_SETUP=1` / `FAKE_FAIL_ALWAYS=1` | setup fails at ~40% of the media step (first attempt / every attempt) |
| `FAKE_SESSIONS=n` | `sessions.running` in `status` |
| `FAKE_STEP_MS`, `FAKE_STOP_HANG=1`, `FAKE_CRASH_AFTER_MS=n` | speed, a `stop` that never finishes, an unexpected exit |
| `FAKE_LOG=<file>` | one JSON line per request and lifecycle event |

## How the app behaves

- **Launch:** installed-location check first (translocated or read-only volume gives the Move to Applications screen and starts nothing). Then it spawns `node <controller> --resources --runtimes --data`, stderr to `<data>/logs/app/controller.log`, and sends `status`. `needs-setup` shows the welcome screen; a set-up environment (`stopped`) is started automatically.
- **Setup:** mode pick, `preflight` summary (download, space needed/free, port conflicts, problems; Start Setup is disabled while any exist), `setup` with per-task progress, Cancel and Retry. After `setup` succeeds the app sends `start`.
- **Window:** `running` shows a `WKWebView` (`urls.agents` in code mode, `urls.game` in explore mode). Navigation is allowed only to the origins in `urls`; everything else, and `window.open`, goes to the default browser. `claudePenguinHost` messages are accepted only from the main frame of those origins, and only for paths whose real path is strictly inside `<data>/worktrees/` (no `..`, symlink escapes or `worktrees-evil`). `openInEditor` asks once for an editor app (`UserDefaults` key `editorApplicationPath`; Choose Editor… in the app menu changes it) and falls back to Finder.
- **Close / Dock:** closing the window loads `about:blank`, releases the web view and keeps the app and controller running; the Dock icon reopens the window at the game's login screen.
- **Quit:** `status`; confirm if `sessions.running > 0`; `stop` and wait for `stopped` (30 s, then Keep Waiting or Force Quit; a Force Quit button is on the progress panel throughout); close stdin; wait for the controller to exit (10 s, then kill). If the controller dies on its own the window offers Restart.

## Packaging

`build-app.sh` output: `build/Claude Penguin.app`. Resources are copied from an explicit allowlist (see the script): `local/{controller,engine,web,native,installer}` (no tests, no `node_modules`), the client-bridge patcher, `local/*.py` minus tests and `doctor.py`, `houdini/ dash/ snowflake/` (no `.git`), `templates/`, `servers.xml`, Ruffle, and the runtimes. `engine` and `web` production dependencies come from `npm ci --omit=dev --ignore-scripts` in a staging copy, and the script fails if node-pty's darwin-arm64 `pty.node` or `spawn-helper` is missing. Never copied: `vanilla-media/`, other `.local/` content, credentials, logs. Before signing, `scripts/lib/check-min-os.sh 26.0` reads the minimum macOS of every Mach-O file in the bundle (`vtool -show-build`) and fails the build if any needs a newer macOS than `LSMinimumSystemVersion`.

Layout facts other parts depend on (also written to `Resources/app/bundle-layout.json`):

- **Ruffle** is at `Contents/Resources/app/ruffle`. The controller must pass `RUFFLE_ROOT=<resources>/ruffle` to the web server.
- Client-bridge patches (from `.local/client-bridge-patches`, when present) go to `Contents/Resources/app/local/client-bridge/patches`, where `local/controller` reads them (`installPatchSet`).
- Python must not write bytecode inside the bundle (set `PYTHONDONTWRITEBYTECODE=1`), or the code-signature seal breaks.

Environment: `CP_SIGN_IDENTITY`, `CP_VERSION`, `CP_RUNTIMES_DIR`, `CP_RUFFLE_DIR`, `CP_PATCHES_DIR`, `CP_SKIP_SWIFT`, `CP_HARDENED`.

### Signing

Signing goes inside out: every Mach-O is found by magic bytes (`scripts/lib/find-macho.pl`, so `.node`, `.dylib`, `.so` and bare executables), deepest first, then the app, then `codesign --verify --deep --strict`.

- Default is ad-hoc (`-`), no hardened runtime.
- With `CP_SIGN_IDENTITY="Developer ID Application: Name (TEAMID)"`: `--options runtime --timestamp`, the app signed with `Entitlements/app.plist`, and the bundled Node with `Entitlements/node.plist`.
- `node.plist` holds `com.apple.security.cs.allow-jit` only. Tested locally on the official Node 22.23.4 arm64 build re-signed with the hardened runtime: without it Node is killed on its first JIT page (exit 133); with it JavaScript and WebAssembly run.
- `CP_HARDENED=1` signs ad-hoc with the hardened runtime for local testing. An ad-hoc signature has no Team ID, so library validation then blocks `pty.node` ("code signature ... not valid for use in process"); `adhoc-test.plist` adds `disable-library-validation` in that mode only. A Developer ID build signs everything with one Team ID, which satisfies library validation, so the shipped `node.plist` leaves it out. Unverified until the real certificate is used. If a Developer ID run reports that error, add the key to `node.plist` (what the official Node build does).
- No Python entitlements file: nothing yet shows one is needed. Check on a hardened Developer ID build once the runtimes exist: `ctypes` callbacks, cffi, and Postgres loading extensions.

### Disk image and notarization

```sh
export CP_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"
macos/scripts/build-app.sh
macos/scripts/make-dmg.sh                         # build/Claude-Penguin.dmg, Applications link, signed with the identity
CP_NOTARY_PROFILE=<profile> macos/scripts/notarize.sh
```

Needs from the owner: a **Developer ID Application** certificate in the keychain, and a notarytool keychain profile made once with `xcrun notarytool store-credentials <profile>` (the owner enters credentials; nothing here asks for them). `notarize.sh` submits with `--wait`, staples, validates, and runs `spctl --assess` on the image and the app. It has not been run.

## Known gaps

- No app icon or custom name artwork (waits on the naming decision); no Sparkle or other updater.
- The setup UI has no path from Explore to Code later (the controller supports it with `setup` mode `code`); `start` always uses the controller's default mode.
- English only; accessibility labels and Dynamic Type are not audited.
- Quit's confirmation, Force Quit and "taking a while" alerts were exercised only as far as seeing the windows appear, not by clicking them.
- Never run against a real runtime bundle, real services or a signed Developer ID build. Only the controller's `status` and `preflight` were run against the real `local/controller`.
- `hdiutil create` prints a deprecation notice on macOS 26 but works.
