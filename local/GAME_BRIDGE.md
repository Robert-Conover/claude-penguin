# Puffle game bridge

The bridge connects the preserved game to two opt-in modes using the same
version-4 overlay:

- **Bridge lab, port 8080:** two disposable fixture igloos and named puffles,
  with simulated cues. It does not register repositories, run Claude Code,
  persist conversations, or create worktrees.
- **Agent mode, port 8081:** the [host agent engine](AGENT_ENGINE.md) supplies
  verified project mappings, native menus, real session status, and project
  igloos in the original map. See [project igloos in agent mode](#project-igloos-in-agent-mode).

An Atlas migrated from the original demo shares the Bridge Alpha igloo with
the lab. The lab's simulated cues are independent of any Claude session.

## Run the bridge lab

Start the baseline with `./local/start`, then:

```sh
python3 local/client-bridge/build.py
./local/bridge-fixtures
```

The extension build needs a JDK and downloads a checksum-pinned official JPEXS
compiler package on first use. See [client build details](client-bridge/README.md).
The running web service reads the generated overlay and fixtures from bind
mounts; reload the bridge page after rebuilding them. No web rebuild is needed
for these generated files. If you change the web server or browser code copied
into its image, run `./local/compose up -d --build --no-deps web`; that rebuild
disconnects browser game sessions and preserves game data. Ordinary starts
still work without the overlay or fixtures.

Open [the bridge lab](http://localhost:8080/?bridge=1#/login). Log in as
`bridgecheck`, password `PenguinLocal2026!`, then choose Blizzard. These are public
disposable fixture credentials. If you supplied `CLUB_PENGUIN_TEST_PASSWORD` during
initial seeding, use that password instead; rerunning setup never resets it.

**Your Igloos** starts open. Select Bridge Alpha or Bridge Beta, then click
the actual puffle in the room. **Work · bridge lab** toggles the panel if you
close it. The panel identifies the project and puffle instance.
Choose a simulated state to play an existing game animation. **Visit Town** leaves
the igloo. Work remains available, including a simulated attention count, and the
last chosen cue remains in the panel for the current browser page. Animations play
once and do not represent persistent execution state. Reloading resets these cues.

The standard [play page](http://localhost:8080/) loads the unmodified archived
client. The lab uses a browser destination list. A running agent engine can also
publish igloos to the visitor's original map on either page, as described below.
New fixture accounts retain the normal game introduction; complete it with the
game controls if it covers interactions.

## Bridge lab identity and scope

Each project fixture has separate `projectId`, `ownerId`, active `iglooId`, wire
`roomId`, and `puffleId` values. The generated manifest lives at
`.local/bridge-public/fixtures.json`. IDs come from the actual database/protocol, never
from an array index or project display name. The setup refuses changed identities
instead of silently assigning a different project.

The original server addresses an igloo by penguin owner (`ownerId + 2000`) and
shares puffles across that owner's four layouts. The experiment therefore uses
two dedicated owners (`bridgealpha`, `bridgebeta`) plus the visitor `bridgecheck`.
This proves distinct destinations without redefining the server's room model.
Agent mode uses the separate [project provisioning flow](AGENT_ENGINE.md#game-provisioning-and-native-igloos).

`bridge_seed.py` creates only those marked fixtures and leaves existing accounts
alone. `verify_bridge.py` adopts one named puffle for each owner on initial setup
through normal game handlers. Subsequent verification checks identity, travel,
frame delivery, and reconnect. It never changes the interactive `player` account
or clears furniture/volumes. Scripted visits use `localcheck`. Only the interactive browser logs in as `bridgecheck`.

The browser enables controls only after confirming the fixture visitor. Clicks
must match the current owner, room, project, and rendered puffle. Loading rooms
disable actions. Layout IDs displayed in the panel are fixture metadata; protocol
verification checks the active layout separately. No repository paths, provider
credentials, terminal execution, or arbitrary filesystem endpoints are exposed.

## Implementation

- [Client extension](client-bridge/bridge.as): a separate compiled AVM1 action tag
  appended to a generated copy of the pinned `engine.swf`. Existing decompressed
  SWF tags remain byte-for-byte identical. The media submodule is untouched.
- [Browser bootstrap](web/bridge/bootstrap.js): Ruffle URL rewriting applies only
  on the opt-in page. Only the generated engine is substituted.
- [Panel](web/bridge/panel.mjs) and [identity model](web/bridge/model.mjs): real
  ExternalInterface events and snapshots, with explicit simulation labels.
- [Server](web/server.mjs): a fixed allowlist of experimental assets and a
  validated public projection of the fixture manifest. It does not serve `.local/`.

Ruffle documents [ExternalInterface](https://ruffle.rs/js-docs/master/interfaces/Player.PlayerV1.html#callExternalInterface)
and [URL rewriting](https://ruffle.rs/js-docs/master/interfaces/Config.BaseLoadOptions.html#urlRewriteRules).
The game-specific callbacks are derived from the pinned client; see the
[callback contract](client-bridge/README.md#browser-contract-version-4).

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

## Project igloos in agent mode

The bridge lab on port 8080 loads `/bridge/fixtures.json`,
requires Bridge Alpha and Bridge Beta, and plays explicitly simulated cues. While
a multi-project engine is publishing, though, the `bridgecheck` visitor's igloo
map and player cards list the published project igloos as open on either page,
because the world adapter keys on the visitor, not on the page.

In agent mode (`?bridge=1&agents=1`), the browser derives game mappings from the
engine snapshot with `agentMappings()` in the [identity model](web/bridge/model.mjs).
It uses only:

- the engine's verified `visitor` (`penguinId`, `username`, `verifiedAt`); without
  one, no mapping is usable and the native HUD stays off. A visitor that failed
  this engine run's verification is reported as `visitor: null` with a
  `visitorProblem` message;
- projects whose `game.status` is `ready`. Provisioning, failed, and repair
  mappings are skipped. A mapping is also rejected if its project ID is not a
  UUID, its room is not `ownerId + 2000`, its owner is the visitor, a game ID is
  outside the overlay's range (1 to 999,999,999), or another ready project claims
  the same owner, igloo, room, or puffle. Every claimant of a shared identity is
  excluded, and the panel reports how many are hidden. A project's puffles come
  from its workers' `puffle` bindings (at most 10); a puffle ID claimed twice is
  excluded the same way. With more than 32 ready
  mappings the panel configures none and shows an error rather than dropping
  some.

The project UUID is the mapping identity. Flash receives `{projectId, ownerId,
puffles: [{puffleId, slot}]}` per project, where `slot` is a page-local number
for each worker, and a bounded display card (puffle name and color, project
name, status, activity, aggregate attention, the igloo's roster, and the
puffles that need you). Paths, worker and session IDs, setup detail, adoption
IDs and tokens stay in the browser. A verified visitor with zero ready
projects configures an empty neighborhood. Town travel and the HUD work, and
**Work** opens the project list.

The panel reconfigures the overlay whenever the ready mapping set changes, for
example after setup, retry, migration, repair, or an engine reconnect, without a
page reload. Until the overlay confirms the new configuration generation, igloo
buttons, puffle clicks, project card actions, and in-flight travel are refused.
Afterwards, only snapshots and events carrying that generation are accepted.

A puffle click selects that puffle's own worker, validated against the current
owner, room, and rendered puffle. The card's **In this igloo** list selects
another puffle in the same igloo. **Work** lists the puffles that need you
(permission, an answer, recovery, review, or failed setup) across igloos; a row
opens that puffle's card. With nothing to list it opens the project list. The native and browser views share that explicit selection.
When the browser refuses a native card action (for example one prepared against
an older generation, or sent during travel), it tells the overlay through
`cpBridgeRejectAgentAction`. The card then releases a pending task, keeps the
draft, and shows "Task not sent. Try again." Attention
counts all active workers; each mapped puffle in the current room animates from
its own worker's state. Travel and closing menus never stop a
started PTY.

**Igloos** shows all registered projects with their puffles, including setup,
repair and archived records. Add projects here, retry a project's or a puffle's
setup, check a purchase, inspect the old Atlas journal or create its isolated
replacement explicitly. Flash uses contract version 5. Adoption at the Pet Shop
uses the derived module and `p#cpadopt`; see the
[engine guide](AGENT_ENGINE.md#adoption-into-a-project-igloo). The terminal, task journal and
changes viewer share the selected target. Rebuild the overlay after changing
its source. See the [engine guide](AGENT_ENGINE.md) and [validation record](VALIDATION.md).
