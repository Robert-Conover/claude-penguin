# Puffle game bridge experiment

This is milestone 1: connect the preserved game to a browser task panel. It uses
two disposable project destinations and named puffles. It does **not** register
repositories, run Claude Code, persist conversations, or create worktrees.
This document describes that bridge-only mode on port 8080. The separate
[host agent engine](AGENT_ENGINE.md) builds on the same fixture mapping for the
next milestone; its terminal and real execution states are enabled on port 8081.

## Run

Start the baseline with `./local/start`, then:

```sh
python3 local/client-bridge/build.py
./local/bridge-fixtures
./local/compose up -d --build --no-deps web
```

The extension build needs a JDK and downloads a checksum-pinned official JPEXS
compiler package on first use. See [client build details](client-bridge/README.md).
The web rebuild disconnects existing browser game sessions; it preserves game
data. Ordinary starts still work without the experimental build or fixtures.

Open [the bridge lab](http://localhost:8080/?bridge=1#/login). Log in as
`bridgecheck`, password `PenguinLocal2026!`, then choose Blizzard. These are public
disposable fixture credentials. If you supplied `CLUB_PENGUIN_TEST_PASSWORD` during
initial seeding, use that password instead; rerunning setup never resets it.

Use **Work** to open Your Igloos, select Bridge Alpha or Bridge Beta, then click
the actual puffle in the room. Its panel identifies the project and puffle instance.
Choose a simulated state to play an existing game animation. **Visit Town** leaves
the igloo. Work remains available, including a simulated attention count, and the
last chosen cue remains in the panel for the current browser page. Animations play
once and do not represent persistent execution state. Reloading resets these cues.

The standard [play page](http://localhost:8080/) loads the unmodified archived
client. The experiment adds a browser destination list; it does not yet modify the
original map or build a neighborhood scene. New fixture accounts retain the normal
game introduction; complete it with the game controls if it covers interactions.

## Identity and scope

Each project fixture has separate `projectId`, `ownerId`, active `iglooId`, wire
`roomId`, and `puffleId` values. The generated manifest lives at
`.local/bridge-fixtures.json`. IDs come from the actual database/protocol, never
from an array index or project display name. The setup refuses changed identities
instead of silently assigning a different project.

The original server addresses an igloo by penguin owner (`ownerId + 2000`) and
shares puffles across that owner's four layouts. The experiment therefore uses
two dedicated owners (`bridgealpha`, `bridgebeta`) plus the visitor `bridgecheck`.
This proves distinct destinations without redefining the server's room model.
It is a fixture strategy, not yet a production project provisioning policy.

`bridge_seed.py` creates only those marked fixtures and leaves existing accounts
alone. `verify_bridge.py` adopts one named puffle for each owner on initial setup
through normal game handlers. Subsequent verification checks identity, travel,
frame delivery, and reconnect. It never changes the interactive `player` account
or clears furniture/volumes. Close the browser fixture session before rerunning
protocol checks, because Houdini permits only one session per account.

The browser enables controls only after confirming the fixture visitor. Clicks
must match the current owner, room, project, and rendered puffle. Loading rooms
disable actions. Layout IDs displayed in the panel are fixture metadata; protocol
verification checks the active layout separately. No repository paths, provider
credentials, terminal execution, or arbitrary filesystem endpoints are exposed.

## Implementation

- [Client extension](client-bridge/bridge.as): a separate compiled AVM1 action tag
  appended to a generated copy of the pinned `engine.swf`. Existing decompressed
  SWF tags remain byte-for-byte identical. Submodule source is untouched.
- [Browser bootstrap](web/bridge/bootstrap.js): Ruffle URL rewriting applies only
  on the opt-in page. Only the generated engine is substituted.
- [Panel](web/bridge/panel.mjs) and [identity model](web/bridge/model.mjs): real
  ExternalInterface events and snapshots, with explicit simulation labels.
- [Server](web/server.mjs): a fixed allowlist of experimental assets and a
  validated public projection of the fixture manifest. It does not serve `.local/`.

Ruffle documents [ExternalInterface](https://ruffle.rs/js-docs/master/interfaces/Player.PlayerV1.html#callExternalInterface)
and [URL rewriting](https://ruffle.rs/js-docs/master/interfaces/Config.BaseLoadOptions.html#urlRewriteRules).
The game-specific callbacks are derived from the pinned client; see the
[callback contract](client-bridge/README.md#browser-contract-version-1).

## Verify

```sh
npm test --prefix local/web
node --test local/client-bridge/bridge.test.mjs
python3 -m unittest discover -s local/client-bridge -p 'test_*.py'
npm run verify:http --prefix local/web
CLUB_PENGUIN_TEST_PASSWORD='PenguinLocal2026!' python3 local/verify_bridge.py
git diff --check
```

The JavaScript and binary tests cover identity isolation, transition handling,
click callback restoration, invalid mappings, opt-in routing, and preservation of
the archived engine. HTTP/protocol checks do not prove visual interaction. See the
dated [validation record](VALIDATION.md) for browser evidence and remaining gaps.

## Agent milestone

The opt-in [agent engine](AGENT_ENGINE.md) now supplies the implementation for one
registered repository and one persistent named Claude Code session on the Mac.
It runs separately from this simulation page, binds Atlas to Bridge Alpha, and
uses the actual terminal for permissions and questions. The dated validation
record distinguishes tested live behavior from remaining checks.

The required loop is task submission, a real permission prompt, interrupt, diff
review, and reconnect with the same conversation. Turn end remains distinct from
verified task completion. More repositories, a neighborhood scene, concurrent
workers, and isolated worktrees remain later milestones.
