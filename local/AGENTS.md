# Local runtime guidance

These instructions supplement the root `AGENTS.md` for changes under `local/`.

## Runtime map

- `start`, `stop`, and `compose`: dedicated Colima profile/context and Compose lifecycle.
- `compose.yml`: local services, loopback bindings, mounts, health checks, and persistent volumes.
- `web/server.mjs`: serves the preserved client, renders local addresses, proxies Dash, and bridges WebSocket traffic to TCP game servers. Node ESM; host development requires Node 22 or newer.
- `agent-start`, `engine/`, and `web/engine/`: optional host Claude PTY runtime, explicit project/session state, and browser terminal. See `AGENT_ENGINE.md` for supported scope and recovery.
- `houdini_bootstrap.py` and `snowflake_bootstrap.py`: narrow launch-time compatibility adapters around pinned upstream code.
- `verify_seed.py`: idempotent local account creation. `verify_game.py`: mutating checks against dedicated fixture accounts.
- `client-bridge/`: JPEXS-built `engine.swf` overlay (output in ignored `.local/client-bridge/`) and its browser contract. `bridge-fixtures`, `bridge_seed.py`, and `verify_bridge.py` create the disposable `bridgecheck` visitor and project-igloo fixtures.

Use `./local/compose` for this stack. It selects `colima-club-penguin` explicitly. The root `docker-compose.yml` and `.env` belong to the inherited Wand setup and are not the local launch configuration. Avoid changing the user's global Docker context or unrelated VMs.

## Validation by change

Run commands from the repository root. On a fresh checkout, host web checks need:

```sh
npm ci --ignore-scripts --prefix local/web
```

| Change | Relevant checks |
| --- | --- |
| Browser wrapper, routing, templates, socket bridge | `npm test --prefix local/web` |
| Agent engine, persistence, hooks, terminal control | `npm ci --ignore-scripts --prefix local/engine` when needed; `npm test --prefix local/engine`; web tests for browser changes; a disposable repository for real-Claude checks |
| Launcher or Compose configuration | Shell syntax checks below; validate Compose and exercise the affected startup/stop path when the local runtime is available |
| Flash overlay or bridge contract (`client-bridge/`) | `node --test local/client-bridge/bridge.test.mjs`; `python3 -m unittest discover -s local/client-bridge -p 'test_*.py'` (the generated-overlay test skips until `python3 local/client-bridge/build.py` has run) |
| Houdini compatibility adapter | Container regression command below; `./local/verify` when the stack is running |
| Client/config serving, Ruffle version, game socket endpoints | `npm run verify:http --prefix local/web` against the running stack; browser checks for affected rendering/interaction |
| Database seeding, game protocol, persistence | `./local/verify`; confirm existing player progress survives the affected lifecycle operation |
| Documentation or SVG only | Link/claim review, render preview, and `git diff --check` |

Check each launcher script with its matching shell:

```sh
for file in local/start local/stop local/compose local/verify local/agent-start local/bridge-fixtures; do
  sh -n "$file" || exit
done
bash -n local/web/setup-ruffle.sh
```

Houdini regressions use the built world image and initialized upstream source:

```sh
./local/compose run --rm --no-deps -v "$PWD/local:/local:ro" \
  --entrypoint python world /local/test_houdini_compat.py
```

`npm test` runs temporary mock HTTP/TCP/WebSocket fixtures without the full game stack. Live HTTP and protocol checks require `./local/start` first. `./local/verify` buys items, adopts/cares for a puffle, and replaces the test account's furniture layout; retain its dedicated fixture identity.

For Compose validation, use `./local/compose config --quiet` after local configuration exists. Avoid dumping expanded Compose output because it contains the generated database password.

## Compatibility and data invariants

- Preserve original play-page callbacks, game packet behavior, byte framing, and the login/world/Snow bridges when changing the web wrapper. Reuse the existing fixture tests for regressions.
- Keep launch-time patches narrow and fail explicitly if the pinned upstream shape changes. The Houdini empty-furniture fix must preserve the original listener's authorization and cooldown metadata. Snowflake media URLs must retain their configured port and path.
- Serve archived source/media through adapters; do not rewrite thousands of downloaded files as a configuration shortcut.
- `start` must preserve existing accounts and progress. `stop` keeps named data volumes. Do not add destructive reset behavior to either command.
- Bind published game ports to `127.0.0.1`; keep database, Redis, and Dash inside the container network.
- Keep agent/provider credentials on the host, preserve exact project and session identities, and keep Stop/turn end distinct from successful completion. Browser reconnect must not spawn a second PTY. Do not bypass manual permissions or edit the interactive checkout merely to obtain a passing agent demo.
- Keep Ruffle's release and checksum consistent with `sources.json`, `web/setup-ruffle.sh`, and the version guard in `start`. Runtime/dependency snapshots are observations, not lockfiles; do not claim they make container builds fully reproducible.

## Evidence

Protocol success establishes backend behavior; HTTP success establishes serving/transport behavior. Neither proves interactive gameplay. Verify affected UI paths in the browser before claiming they work. Update the dated validation record with the command/environment and remaining gaps when adding evidence. Keep raw reports and logs under ignored `.local/`.
