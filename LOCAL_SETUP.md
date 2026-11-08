# Claude Penguin — local Club Penguin baseline

This checkout runs the later AS3 generation of original Club Penguin with Houdini, Dash, Card-Jitsu Snow, and archived client/media files. The local game baseline also supports an optional host-side Claude Code experiment; see [the agent engine](local/AGENT_ENGINE.md) for its separate startup and current scope.

The original client renders and runs in Safari through Ruffle. Login, room travel, the map, catalogs, purchases, inventory, puffle adoption/walking, and the introductory tour have passed interactive checks. Cart Surfer loaded into gameplay; a completed round and reward remain unverified. See [validation](local/VALIDATION.md) for the tested scope and remaining gaps.

Cloning [claude-penguin](https://github.com/Robert-Conover/claude-penguin) creates a `claude-penguin` directory by default. Run the commands below from your checkout, regardless of its directory name.

## Play

Open **http://localhost:8080/** on the Mac running the game.

Local account: **player**

Disposable password: **PenguinLocal2026!**

This seeded account starts with 100,000 coins and membership for exploring the local game. These are public development credentials, not a personal account. The separate `localcheck` and `freshcheck` accounts are test fixtures.

## Start and stop

From this repository:

```sh
./local/start
./local/stop
```

`start` uses the dedicated `club-penguin` Colima profile, 4 CPUs, 4 GB RAM, and a 30 GB data disk. It selects the VZ backend, which requires [macOS 13 or newer](https://lima-vm.io/docs/config/vmtype/vz/). Full-stack validation has used Apple Silicon; Intel Macs and the minimum macOS version have not been validated. It restores the pinned media submodule, creates local configuration if missing, starts the services, and creates the initial accounts only if they do not exist. It does not overwrite existing player progress.

`stop` stops this project's containers and dedicated VM. PostgreSQL and Redis volumes remain intact. The VM is not configured to start at login.

The local stack uses `local/compose.yml` and ignored `.local/env`. Wand's own installer and Compose stack (`install.sh`, the root `docker-compose.yml` and `.env`, `web/Dockerfile`, `wait-for-postgres.sh`, `icons/`) were removed on November 8, 2026. The local stack never used them, and Wand's Compose file published PostgreSQL on every network interface. The removal is recorded in [the source revisions](local/sources.json).

Run `./local/doctor` to see whether this Mac has everything the island needs, or `./local/doctor --agents` to include the puffles. It only reads: it lists what is missing with the command that fixes it, reports a port another program already holds, and points out an engine lock left by a crash, without installing, starting or deleting anything.

Install `colima`, `docker`, and `docker-compose` through Homebrew (Colima also installs Lima). Git and Python 3 are required by the launcher. Host-side web checks require Node 22 or newer and npm; Node is provided by the web container for ordinary gameplay. Ruffle is downloaded into ignored `.local/ruffle` and pinned by release and SHA256.

To connect project puffles to Claude Code, run `./local/agent-start` in a separate foreground terminal. On first
run, or after the overlay source changes, it builds the in-game menu with `python3 local/client-bridge/build.py`. It
serves the opt-in agent page on `http://localhost:8081/`; Git 2.48+, Python 3.9+,
Node 22+, npm, a JDK, and Claude Code must be available on the host. The [agent instructions](local/AGENT_ENGINE.md)
cover repository registration, permissions, session resume, and stopping this
separate runtime. Starting the ordinary game does not launch coding agents.

## Native runtime without Docker (`./launch`, experimental)

`./launch` runs the same servers natively, with the controller the macOS app uses (see `macos/README.md`). It never touches the Compose stack: it has its own ports (game `http://localhost:47080/`, puffles `http://localhost:47081/`), database and data folder (`.local/launch/`). Its game accounts and progress are separate from the Compose game's.

```sh
node local/native/build-runtimes.mjs    # once: pinned Node, Python, Postgres 16, Valkey, Git into .local/runtimes (needs Xcode command line tools)
./launch setup --mode explore           # or --mode code, which also installs and verifies the pinned Claude Code
./launch start                          # foreground; Ctrl-C stops everything
./launch status
./launch stop                           # from another terminal
```

The patched in-game extensions come from `.local/client-bridge-patches/`, which `local/client-bridge/patch_generate.py` writes from the overlay builds (see `local/client-bridge/PATCHER.md`). Without it, setup reuses an existing `.local/client-bridge/` build and says so.

## Inspect and verify

```sh
./local/doctor
./local/compose ps
./local/compose logs --tail 100 web login world dash snowflake
./local/verify
```

To run host-side web checks after a fresh checkout, install their dependencies first:

```sh
npm ci --ignore-scripts --prefix local/web
npm test --prefix local/web
npm run verify:http --prefix local/web
```

`npm test` uses temporary mock services and does not need the game running. `verify:http` targets the running local stack. The Houdini compatibility regressions use the built world image:

```sh
./local/compose run --rm --no-deps -v "$PWD/local:/local:ro" --entrypoint python world /local/test_houdini_compat.py
```

`local/verify` performs real TCP login/world requests. It changes only its dedicated test account: buys a color, adopts a puffle if missing, brushes and walks it, enters its igloo, clears the fixture's layout, places a Table for Two, then checks persistence after reconnect. It does not test visual rendering or minigame gameplay.

## Sources and local files

[Source revisions](local/sources.json) record the exact upstream commits. Wand was current on October 30, 2026, with Houdini updated October 16, 2026. The preserved vanilla-media revision is from March 2024; this is the later original AS3 game generation, not proof of an exact complete final-day March 2017 snapshot.

The upstream components are below. The server sources are vendored in this repository; the media is fetched as a submodule.

- `houdini/`: community Python game server source.
- `dash/`: registration, avatar, and other web services.
- `snowflake/`: Card-Jitsu Snow server source.
- `vanilla-media/`: archived Flash client, rooms, games, graphics, audio, and web files (about 4.1 GB, approximately 86,000 files).
- `local/`: Mac launch configuration, Ruffle/WebSocket compatibility wrapper, and verification helpers.

The vendored server sources and the media submodule match their recorded upstream revisions, except that Snowflake's `.github/` folder (README screenshots and game asset patches for manual setup) is omitted. Local code renders the upstream play-page/configuration templates at request time and bridges browser WebSockets to the original game protocol. A Snowflake launch wrapper preserves the local URL's port and media path. A Houdini launch wrapper corrects the pinned server's empty-igloo save exception in memory, with regression checks against the original handler. The opt-in [game bridge experiment](local/GAME_BRIDGE.md) adds two fixture destinations and puffle controls through a separately generated client overlay; normal gameplay still uses the original assets. The separate [host agent engine](local/AGENT_ENGINE.md) provisions a separate owner for each registered project and starts Claude in its persistent worktree on request. The web service mounts game assets and the public fixture directory. Private engine state stays on the host.

`local/dependency-snapshots/` and `local/runtime-snapshot.json` capture the packages/images observed during setup. They are diagnostic records, not enforced dependency constraints; upstream Dockerfiles resolve requirements on a rebuild.

The legacy AS2 media is not included. Only the English Blizzard world is started. Other languages, minigames, parties, and every original feature have not been comprehensively verified.

## Local boundaries and persistence

The browser, login, world, and Snow ports bind only to `127.0.0.1` (8080, 6112, 9875, 7002). The optional host agent engine also binds to loopback (8081 by default). PostgreSQL, Redis, and Dash are private to the container network. The source repository is public on GitHub; the running game stays on your Mac.

A clone of `Robert-Conover/claude-penguin` uses that repository as `origin`. Development happens on `dev`, with promotion PRs from `dev` to `main`; there is no `qa` branch. See [CONTRIBUTING.md](CONTRIBUTING.md). Cloning does not copy another checkout's `upstream` remote or local `DISABLED` push URLs. Preserve an existing `upstream` remote and any disabled push URLs when present; push project work to your fork or this repository's `origin`. The inherited automatic submodule-update workflow has been removed to preserve the verified revisions. Upstream history and licenses are preserved. Credentials, Ruffle binaries, logs, and raw verification reports are ignored under `.local/`; database state lives in named Docker volumes in the dedicated VM.
