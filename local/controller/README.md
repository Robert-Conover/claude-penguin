# Controller

The shared Node controller behind `./launch` (checkout) and the macOS app (packaged). It sets the environment up, starts and health-checks the native game services in dependency order, supervises them, and stops them in reverse order. Interfaces are fixed by `.local/plans/macos-contract.md`; this file records what is implemented here.

Status: implemented and tested with fake services. Not yet run against the real native services, installer, patcher or engine (those modules are written elsewhere; see "Integration").

## Files

| File | Role |
| --- | --- |
| `supervise.c`, `build-supervise.sh` | The `cp-supervise` shim. Output: `<runtimes>/supervise/cp-supervise` (`CP_SUPERVISE_OUT` overrides). |
| `main.mjs` | Controller entry: `node main.mjs --resources <dir> --runtimes <dir> --data <dir> [--layout app\|launch] [--ports <json>] [--deps-module <file>]`. |
| `controller.mjs` | State machine and commands. |
| `protocol.mjs` | JSON-lines server. |
| `orchestrator.mjs`, `health.mjs`, `logs.mjs` | Ordered start/stop, health checks, log files with a size cap. |
| `owners.mjs`, `lock.mjs`, `procinfo.mjs` | Ownership records, survivor recovery, controller lock and `controller.json`. |
| `setup.mjs`, `deps.mjs`, `release.json` | Resumable setup steps, lazy imports of the other parts, release pins. |
| `engine-service.mjs` | Engine service definition (code mode), Git selection, minimal base environment. |
| `preflight.mjs`, `config.mjs` | Port/disk checks; roots, ports, data layout, the product-name constant (`PRODUCT_NAME`). |
| `launch-cli.mjs`, `../../launch` | `./launch` (POSIX sh wrapper plus CLI). |
| `fake-*.mjs`, `fixtures.mjs`, `*.test.mjs` | Test doubles and tests. |

## Protocol

Exactly the contract's: requests `status`, `preflight`, `setup`, `start`, `stop`, `cancel`, `recover` as JSON lines on stdin; responses and `state` / `progress` / `service` / `problem` events on stdout; logs on stderr. Closing stdin (or SIGTERM/SIGINT/SIGHUP) stops everything gracefully and exits.

Behavior beyond the bare contract:

- Requests run concurrently, so `status` and `cancel` answer during setup. Conflicting operations get `BUSY`.
- Error codes: `BAD_REQUEST` (bad JSON/id/action), `UNKNOWN_COMMAND`, `INVALID_MODE`, `BUSY`, `LOCKED`, `NEEDS_SETUP`, `RECOVERY_REQUIRED`, `NOT_IN_RECOVERY`, `PORT_IN_USE`, `SERVICE_FAILED`, `VERIFY`, `DOWNLOAD`, `DISK_SPACE`, `CANCELLED`, `RUNTIMES_MISSING`, `MODULE_MISSING`, `SETUP_FAILED`, `INTERNAL`.
- `start` takes an optional `mode`; default is the highest mode set up. `stop` during `starting` or `setting-up` aborts the operation first.
- A second controller on the same data directory answers every request with `LOCKED` and exits 75.
- `status` adds `message` and, in `recovery`, `recovery: {ambiguous, failed}`. `urls.agents` is present in code mode only. The engine control token never appears in any output.
- `preflight` port conflicts for a port held by an unresolved survivor carry `"ours": true`. Problems are also emitted as `problem` events.
- Setup states: `needs-setup` (a step is missing), `stopped` (set up, not running). A failed start leaves `error` (nothing running); a service dying later leaves `error` with the others still up. `start` from `error` cleans up first.

### Setup steps

`runtimes` (manifest and supervisor present; in the launch layout a missing supervisor is built with `build-supervise.sh`) then `database` (`prepareData`), `media`, `extensions`, and for `code` only `claude` (`installClaude` then `verifyClaude`, version from `release.json`). Each step has a cheap `check`, so setup skips finished steps; progress is recorded in `data/setup.json` after each step. Explore to code runs only `claude`. `verifyClaude` also runs before every start in code mode.

- media: launch layout uses the checkout's `vanilla-media/`. App layout uses `CP_MEDIA_DIR` in place when it is set (a developer override; nothing is downloaded and preflight counts no media bytes), otherwise `release.media` through `installMedia` with `git: <runtimes>/git/bin/git`. The release pins a `source: "git"` manifest: the submodule's commit on `git.solero.me`, fetched and checked as described in `local/installer/README.md`. With neither, preflight and setup report `DOWNLOAD`.
- Progress: the installers report short phase names (`download`, `checkout`, `verify`, ...); `makeContext().forward` turns the media and Claude ones into the labels the setup screen shows (`PHASE_LABELS` in `setup.mjs`).
- `release.json` also records Claude Code's `size` and `installedSize` (from `local/installer/claude-release.json`), so preflight reports a total for code mode instead of an unknown.
- extensions: `installPatchSet` from `<resources>/local/client-bridge/patches`. Its check runs `verifyInstalledPatchSet`, which compares every installed file (both SWFs, their records and `patchset.json`) with the patches, so a damaged or missing one sends setup back to rebuild it. In the launch layout, when that directory or the patcher module is missing, an existing `.local/client-bridge/engine.swf` build is used and a progress label says so.

## Supervision

Every service starts as `cp-supervise --owner-pid <controller> --record <data>/owners/<name>.json --stop-signal ... --grace-ms ... -- <program>`, spawned detached so a terminal Ctrl-C does not reach it. The shim:

- puts the program in its own process group and forwards SIGTERM/SIGINT/SIGHUP to that group;
- watches the controller with kqueue `NOTE_EXIT`; when it dies, sends the stop signal to the program, waits the grace period, SIGKILLs the whole group and confirms it is gone; an owner already dead at startup means the program is never started (exit 71);
- when the program leader exits for any reason, SIGKILLs whatever it left in the group;
- writes `<record>.child` (`{pid,pgid,shimPid,startSec}`) right after forking;
- exits with the program's status (128+signal if signalled, 127 if exec failed);
- extensions beyond the contract: SIGUSR1 means "stop now using the configured stop signal and grace" (the controller uses it for graceful stops, so one code path serves both), and the `.child` sidecar.

`build-supervise.sh` compiles it for macOS 26 (`-mmacosx-version-min`, override with `MACOSX_DEPLOYMENT_TARGET`), whatever macOS builds it; `supervise.test.mjs` checks the recorded minimum.

`cp-supervise guard --owner-pid <engine> --grace-ms 1500 -- <claude> ...` is how the engine starts Claude in the app (`CP_ENGINE_PTY_GUARD`). node-pty gives each terminal its own session, outside the engine's process group, so the engine's own shim cannot reach Claude when the engine is killed. `guard` starts a detached watcher (its own session, no terminal descriptors), waits until it watches both the engine and this PID, then execs Claude in place: same PID, terminal and foreground group, so typing, resizing and the engine's own SIGTERM/SIGKILL stop work as before. If the engine exits first, the watcher sends SIGTERM, waits the grace period, SIGKILLs Claude's process group and confirms it is empty; if Claude exits first, it sweeps what is left of the group. A program that does not lead its process group is refused (70).

Ownership records are written before spawn, then updated with the program PID, start time (`ps -o lstart=`) and executable (`cp-supervise pidpath`, the kernel's `proc_pidpath`, which a program that rewrites its process title cannot change; `ps -o comm=` only if that fails). A record is removed only when cleanup is confirmed: the shim exited on its own and the program's process group is empty. A shim killed by a signal, or one that exits 70 because the group did not exit, keeps the record, and `stop` reports that service as not stopped (`SURVIVOR`, then `recovery`). After taking the lock, the next controller classifies each record:

- PID, start time and executable all match: a survivor. Stop the group (stop signal, bounded wait, SIGKILL), re-checking identity first.
- Live PID with another start time or executable: not ours. Left alone, record dropped, `SURVIVOR` problem with outcome `not-ours`.
- Dead: record dropped.
- Anything else (unreadable record, leader dead but group alive, `ps` failed, a survivor that will not die): `recovery` state. `recover stop-survivors` signals the recorded process groups after the user confirms; `recover ignore` drops the records and leaves the processes.

`data/controller.lock` is flock'ed through `cp-supervise lock 3` on a descriptor the controller keeps open and never gives to children; death releases it. `data/controller.json` (pid, start time, executable) lets `./launch stop` find the controller, and it verifies all three before signalling.

### Limits: what can still survive

- A program that leaves its process group (`setsid`, daemonizing) survives its shim. Claude's terminals do exactly that and are covered by `guard` instead; processes Claude's own tools move into other sessions or groups are not.
- A force-killed shim leaves its program running until the next controller starts. If the program's leader then exits first, its remaining group members are only found as `recovery` (ambiguous), not killed automatically.
- Stopping can be confirmed only for processes this controller started; a recycled PID with the same start second and executable would be taken for ours (start time has one-second resolution).
- Log capping is best effort: services write straight to an append-only file (a pipe would break them when the controller dies); the controller copies it to `<name>.log.1` and truncates when it passes 8 MiB, which can lose bytes written during the copy.
- A power loss or kernel panic leaves records behind; they are evaluated at the next start like any other crash.

## Failure policy

No restart loop. A service that exits after becoming healthy produces a `service` `exited` event and one `SERVICE_FAILED` problem; state becomes `error`; the other services keep running until `stop`. A service that fails or times out during startup (default 60 s per service, 45 s for the engine) aborts the start and stops what had started.

## Engine in code mode

`<runtimes>/node/bin/node <resources>/local/engine/server.mjs` through the shim. Its environment: `HOME USER LOGNAME SHELL TMPDIR LANG` from the controller, `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, `engineEnvironment(config)`, and `CP_ENGINE_PORT CP_ENGINE_STATE_DIR CP_ENGINE_WORKTREE_ROOT CP_CLAUDE_PATH CP_CLAUDE_CONFIG_DIR CP_CLAUDE_DISABLE_UPDATES=1 CP_LOGIN_SHELL_ENV=1 CP_BUNDLED_GIT_DIR CP_ENGINE_GIT CP_ENGINE_CONTROL_TOKEN` (fresh random token per start). `CP_ENGINE_GIT` is the user's git found on the controller's `PATH` plus `/opt/homebrew/bin` and `/usr/local/bin` (and the `xcode-select -p` directory), never by running `/usr/bin/git`; `/usr/bin/git` counts only when the developer directory has its own `usr/bin/git`; a git older than the engine's minimum (2.48, `engine/git-policy.mjs`) is skipped; otherwise the bundled git. `CP_ENGINE_PTY_GUARD` is the supervisor (see `guard` above). Before every engine start the controller rewrites `secrets/provision-env.json` (`writeProvisionEnv`), so its runtime paths follow an app that was moved or renamed after setup. Health: `GET /engine/control/status` with the bearer token; `status` merges that response.

Every service gets only the `env` its definition lists; the controller adds nothing and inherits nothing.

## Tests

```sh
node --test local/controller/*.test.mjs
```

Takes about 20 seconds. Tests build the shim into a scratch directory, use ephemeral ports and fake services (`fake-service.mjs`, `fake-deps.mjs`), and kill anything they started. `./launch` test hooks (used by `launch.test.mjs`): `CP_RESOURCES`, `CP_RUNTIMES`, `CP_PORTS_JSON`, `CP_CONTROLLER_DEPS` (a `--deps-module` for the controller). `--deps-module` is a test hook; production never sets it.

## Integration

The controller imports, lazily and by these exact names: `local/native/services.mjs` (`nativeServices`, `prepareData`, `engineEnvironment`, `writeProvisionEnv`), `local/installer/claude.mjs` (`installClaude`, `verifyClaude`), `local/installer/media.mjs` (`installMedia`), `local/client-bridge/patcher.mjs` (`installPatchSet`, `verifyInstalledPatchSet`). Assumed call shapes where the contract is silent are listed in the hand-off report; adjust `setup.mjs` if the real modules differ.
