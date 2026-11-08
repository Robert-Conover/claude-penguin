# Native macOS runtimes and service definitions

Runs the game servers as plain processes from pinned, relocatable runtimes, with no Docker or VM. Compose
(`./local/start`) is unchanged and remains the default development stack.

| File | Purpose |
| --- | --- |
| `runtimes.json` | Pins: version, official URL, SHA-256, configure/make flags, which environments exist. |
| `build-runtimes.mjs` | Builds `.local/runtimes/` (work in `.local/runtimes-build/`) and writes `runtimes/manifest.json`. |
| `requirements/{houdini,dash,snowflake}.in` / `.txt` | Inputs (from `local/dependency-snapshots/`) and the generated hash-locked files. |
| `relocation-test.mjs` | Copies the runtimes to a path with a space and runs everything from the copy. |
| `services.mjs` | `nativeServices`, `prepareData`, `engineEnvironment` (the contract) plus `ensureSecrets`, `readSecrets`, `postgresReady`. |
| `run-stack.mjs` | Minimal dev harness (not the product controller) against the scratch data root `.local/native-test/`. |
| `dash_launch.py` | Runs Dash's own bootstrap with the avatar directory taken from `CP_DASH_ITEMS`. |
| `services.test.mjs` | `node:test` tests that need no built runtimes. |

## Build

Needs macOS arm64, the system `cc`/`make`/`tar`, and Node 22+ (the system one is fine). No Homebrew.

```sh
node local/native/build-runtimes.mjs                 # everything; skips components whose recorded inputs match
node local/native/build-runtimes.mjs --only valkey,envs --force
node local/native/build-runtimes.mjs lock houdini    # regenerate requirements/houdini.txt from houdini.in
node local/native/relocation-test.mjs                # move-and-run test
```

A clean build takes about two minutes on a 10-core M-series Mac (Postgres 39 s, Git 10 s, Valkey 9 s, environments 3-10 s each);
run it in the background if you wrap it. Every archive is hashed on download and again immediately before extraction;
a mismatch deletes the file and stops. Native code is built with `MACOSX_DEPLOYMENT_TARGET=26.0`, `-O2 -g0`.

## What is pinned

| Component | Version | Source | Notes |
| --- | --- | --- | --- |
| Node | 24.22.2 | nodejs.org official tarball | only `bin/node` and `LICENSE` are kept; SHA-256 from the official `SHASUMS256.txt` |
| Python | 3.11.18 (python-build-standalone 20261026, `install_only`) | github.com/astral-sh/python-build-standalone | test suite, idle, tkinter, turtledemo and lib2to3 removed; bytecode regenerated as unchecked-hash with no build path |
| PostgreSQL | 16.15 | ftp.postgresql.org source (bz2) | `--without-readline --without-icu --without-zlib --without-openssl --disable-rpath --disable-nls`; install names rewritten to `@loader_path`; ad-hoc re-signed |
| Valkey | 8.1.11 | GitHub tag archive | `MALLOC=libc BUILD_TLS=no`; only `valkey-server` and `valkey-cli` kept. GitHub tag archives have no published checksum (the release has no assets), so the SHA-256 was recorded when first fetched |
| Git | 2.56.0 | kernel.org | `RUNTIME_PREFIX=1 NO_RUST=1 NO_PERL=1 NO_PYTHON=1 NO_GETTEXT=1 NO_TCLTK=1 NO_EXPAT=1`, symlinked builtins (a copied tree would otherwise carry ~170 hardlinks); links system libcurl/zlib/iconv |
| `git-only/git` | - | this repo | a `/bin/sh` script that execs `../git/bin/git`; verified with `PATH` holding only that directory |

Resulting layout (matches the contract): `node/ python/ envs/{houdini,dash,snowflake}/ postgres/{bin,lib,share} valkey/bin git/ git-only/ manifest.json`.
`supervise/` is added by another part; the builder never deletes it.

Postgres and Git are compiled with a neutral fallback prefix `/opt/claude-penguin/<name>` that appears as a string in their binaries. It is
never used for lookup (both resolve `share/`, `libexec/` etc. relative to the executable) and is not a path on any machine. The relocation
test reports which files carry it and fails on any path under the checkout, the work directory or the system temp directory.

## Python version findings

One interpreter (3.11.18) runs all three services; the 3.11/3.13 split of the container images is not needed.

* Dash cannot use 3.13: `sanic==21.12.2` requires `multidict<6`, and `multidict==5.2.0` has no wheel and fails to compile on 3.13
  (`Py_TRASHCAN_SAFE_BEGIN` was removed). It builds on 3.11.
* Snowflake (Twisted 26.10, SQLAlchemy 2.1.6, psycopg 3.3.6, redis 8.1.0) resolves wheels-only on both 3.11 and 3.13 and was run end to
  end on 3.11 only. Houdini resolves on both and was run on 3.11 only. 3.13 was not run for either.
* So the fallback to 3.11 + 3.13 was not needed. If Snowflake must move to 3.13 later, add a second entry to `pythons` in `runtimes.json`
  and point `envs.snowflake.python` at it; `services.mjs` reads the interpreter per service from `manifest.json`.

## Per-service package sets and deviations from `local/dependency-snapshots/`

Each service has its own set installed with `pip install --target runtimes/envs/<service> --require-hashes --no-deps --only-binary=:all:`
(exceptions below), then `bin/` removed, extension modules debug-stripped, absolute rpaths deleted, ad-hoc re-signed, and bytecode
compiled relative to the environment (`compileall -s`). Services run `python3 -s` with `PYTHONPATH=envs/<service>`; the environments are
never shared (Houdini has `redis 7.4.1`, Dash and Snowflake `redis 8.1.0`).

| Service | Deviation | Reason |
| --- | --- | --- |
| houdini | `asyncio==4.0.0` not installed | It is the Python 3.3 backport; under `PYTHONPATH` it would shadow the standard library (in the image the stdlib wins by path order). |
| houdini, dash | `setuptools==80.9.0` added | The python:3.11 image shipped setuptools. SQLAlchemy 1.3 (`gino` dialect entry points) and `fast_autocomplete` import `pkg_resources`; 80.9.0 is the last line that still has it. |
| houdini, dash | `SQLAlchemy==1.3.24` built from the sdist | No arm64 macOS wheel exists (gino requires `<1.4`). Builds on 3.11 with the system `cc`. |
| dash | `multidict==5.2.0`, `websockets==10.2` built from the sdist | No macOS wheels; sanic 21.12.2 pins both. |
| dash | `Pillow 8.4.0` -> `12.3.0` | 8.4.0 has no wheel for 3.11 on arm64 and needs libjpeg to build. Dash only reads and writes PNG. `stegano 0.9.9` declares `pillow<9`; it is installed with `--no-deps` and works (account creation page and avatars verified). |
| all | hash-locked to the exact wheel pip resolved | Hashes are for macOS arm64, CPython 3.11 wheels; the three sdist-built packages are hashed as source archives. |

Limitations of the locks: for the sdist packages pip's isolated build fetches `setuptools`/`wheel` from PyPI without hashes (pip does not
hash build requirements), and the compiled output is not bit-for-bit reproducible. `*.in` files record the snapshot-derived inputs;
regenerate with `lock` after editing them.

## Adapters (container behavior unchanged by default)

* `local/dash_config.py`: `CP_DASH_ROOT` (default `/usr/src/dash`), `POSTGRES_HOST`/`POSTGRES_PORT` (default `db`; a port is appended to the
  host because Dash builds `postgresql://user:pw@HOST/name`), `REDIS_HOST`/`REDIS_PORT`, `CP_DASH_ADDRESS`/`CP_DASH_PORT` (upstream
  defaults kept when unset; Dash ignores `--address` and binds `app.config.ADDRESS`), `CP_PLAY_LINK`, `CP_CJS_HOST`/`CP_CJS_PORT`.
* `local/snowflake_bootstrap.py`: `CP_SNOWFLAKE_ROOT`, `CP_SNOWFLAKE_BIND` (every `reactor.listenTCP` gets the interface; upstream passes
  none), `CP_SNOWFLAKE_POLICY_PORT` (moves the hard-coded 843; the policy server itself stays off), `CP_SNOWFLAKE_NO_DOTENV` (upstream
  `load_dotenv(override=True)` would let a `.env` found in a parent directory of the resources beat the environment).
  `MEDIA_LOCATION`, `PORT`, `POSTGRES_*`, `REDIS_*` were already environment variables.
* `local/houdini_bootstrap.py`: `CP_HOUDINI_ROOT`. Houdini has `--address` and `--redis-port` but no database port flag; the database
  address is `127.0.0.1:47432` because Houdini interpolates it into `postgresql://user:pw@ADDRESS/name`.
* `native/dash_launch.py`: sets `dash.routes.avatar.avatar_item_directory` (upstream uses `./items`, which Compose mounts) and runs Dash's
  own `bootstrap.py`. Dash's working directory is its source directory (`dash/templates` and `locale` are relative to it).
* `local/web/server.mjs`: `MEDIA_ROOT`, `CLIENT_BRIDGE_ROOT`, `BRIDGE_PUBLIC_ROOT` (also `createServer` options `mediaRoot`,
  `clientBridgeRoot`, `bridgePublicRoot`); `servers.xml` now uses `{{ .Env.GAME_WORLD_PORT }}` for the world and redemption port, rendered
  from `WORLD_PORT` (default 9875, so Compose output is identical).

Checks: `python3 -m unittest local/test_native_adapters.py`, `npm test --prefix local/web`, `node --test local/native/services.test.mjs`.

## Service definitions

`services.mjs` follows the contract. Details beyond it:

* Data: `prepareData` creates `secrets/db.json` once (mode 0600, directory 0700; 24 random bytes as hex, user `penguin`, database `houdini`),
  initializes Postgres only when `postgres/PG_VERSION` is absent (into `postgres.initdb-tmp`, then renamed; a non-empty directory that is not a
  cluster is refused), and writes `secrets/provision-env.json` (0600) for `CP_PROVISION_ENV_FILE`.
* Postgres: `initdb --auth-host=scram-sha-256 --auth-local=reject --locale=en_US.UTF-8 --encoding=UTF8`; started with
  `-c listen_addresses=127.0.0.1 -c port=N -c unix_socket_directories=` (no Unix socket). Health: `pg_isready`. Stop: SIGINT (fast).
* The `ready` hook creates the database if missing, loads `houdini/houdini.sql` only when the `public` schema has no tables (the file begins
  with `DROP TABLE IF EXISTS`), then runs `local/verify_seed.py` with the Houdini environment (it only inserts the fixture accounts
  `localcheck` and `player` when absent).
* Valkey: `--bind 127.0.0.1 --protected-mode yes --appendonly yes --dir <data>/valkey`; health `valkey-cli -e ping`.
* Houdini receives the database password as a command-line argument (the only way it accepts it, as in Compose); it is visible to the same
  user in `ps`. Dash and Snowflake take it through their environment. Python services set `PYTHONDONTWRITEBYTECODE=1` and
  `PYTHONPYCACHEPREFIX=<data>/cache/pycache` so a read-only app bundle is never written.
* Dash's health check is `http` with the extension field `anyStatus: true` (Dash has no health route and answers `/` with 404).
* Extra keys in `engineEnvironment`: `CP_ENGINE_PORT`, `CP_BUNDLED_GIT_DIR`, `CP_ENGINE_GIT`, `BRIDGE_PUBLIC_ROOT`.
* Optional config keys: `secrets` (inject credentials instead of reading `db.json`) and `bridgePublicRoot` (default `<data>/bridge-public`).
  `clientBridgeRoot` defaults to `<data>/client-bridge/current`, `mediaRoot` to `<resources>/vanilla-media`.

## Dev harness

```sh
node local/native/run-stack.mjs [--data .local/native-test] [--runtimes .local/runtimes] [--once]
```

Starts the seven services in order with health checks, logs to `<data>/logs/<service>/process.log`, stops in reverse order on
SIGINT/SIGTERM/SIGHUP (stop signal, then SIGKILL of the process group after `graceMs`). It has no supervisor shim, ownership records,
lock or recovery: a `kill -9` of the harness leaves services running.

## Licenses

Ship notices for everything below with the app.

* Node: MIT (the tarball's `LICENSE` lists bundled third-party notices; it is kept at `node/LICENSE`).
* Python: PSF-2.0; python-build-standalone packaging is MPL-2.0; its bundled libraries (OpenSSL, SQLite, zlib, xz, ...) carry their own licenses. The `install_only` archive does not include their texts (no `PYTHON.json`), so the notices file must take them from the python-build-standalone release.
* Python packages: per-package licenses in each `*.dist-info`. `psycopg-binary` bundles libpq (PostgreSQL License) and OpenSSL; `cryptography` wheels bundle OpenSSL (Apache-2.0).
* PostgreSQL 16: PostgreSQL License.
* Valkey 8.1: BSD-3-Clause (`valkey/COPYING`). (Redis 7.4+ would be RSALv2/SSPLv1, and 8.x also AGPLv3.)
* Git 2.56: GPL-2.0-only. The exact corresponding source is the pinned tarball `https://www.kernel.org/pub/software/scm/git/git-2.56.0.tar.xz`
  (SHA-256 in `runtimes.json`) and the build flags recorded in `manifest.json`; the app must offer that source (a link in the notices file is
  not sufficient on its own for physical distribution; include a written offer or host the tarball). `git/COPYING` is shipped.
  The build links only system libraries and frameworks (libcurl, zlib, libiconv, CoreServices/CoreFoundation).

## Measured sizes (2026-11-08, macOS 27.2 SDK 27.2, M-series arm64, APFS `du`)

| Item | Size |
| --- | --- |
| `.local/runtimes` total | 462 MiB |
| node | 117 MiB |
| python | 90 MiB |
| envs/dash / houdini / snowflake | 81 / 37 / 98 MiB (216 MiB; includes the packages' own `tests` directories) |
| postgres | 16 MiB |
| git (+ `git-only`) | 21 MiB |
| valkey | 2.4 MiB |
| downloads (`.local/runtimes-build/downloads`) | 136 MiB |
| whole build directory | 740 MiB |
| scratch data root after one run (`.local/native-test`) | 65 MiB |

## Verification record (2026-11-08)

See the lead report; the commands are:

```sh
node local/native/build-runtimes.mjs && node local/native/relocation-test.mjs
node --test local/native/services.test.mjs && npm test --prefix local/web && python3 -m unittest local/test_native_adapters.py
node local/native/run-stack.mjs            # then, in another shell:
CLUB_PENGUIN_TEST_PASSWORD='PenguinLocal2026!' python3 local/verify_game.py --login-port 47112 --world-port 47875
lsof -nP -iTCP -sTCP:LISTEN | grep ':47'
```

## Known gaps

* Snowflake's game protocol (a real card-jitsu match) was not driven; its listener, Postgres and Redis access and startup were. Houdini's
  empty-igloo fix and project-adoption adapters were not re-run in the container regression (`test_houdini_compat.py`, Docker not touched).
* The ruffle page was fetched but not rendered in a browser in this part.
* Runtimes are ad-hoc signed only; Developer ID signing, hardened runtime, entitlements (Node `allow-jit`) and notarization belong to packaging.
* `lib/pgxs` and Postgres headers are removed, so extensions cannot be compiled against this build.
