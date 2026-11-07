# Game bridge client experiment

This is the client-side part of the opt-in game bridge and agent engine. It
provides game navigation, puffle clicks, animation requests, and a native Flash
task menu. The host engine owns Claude processes and execution state. An animation
or menu acknowledgement never establishes that work ran or completed. The bridge
lab still offers explicitly simulated cues; agent mode uses host-reported state.

The archived AS3 application loads an AVM1 `engine.swf`. We compile only the owned
[`bridge.as`](bridge.as) file, then insert a separate `DoAction` tag immediately
before the engine's first `ShowFrame`. Every existing decompressed SWF byte stays
unchanged. The pinned media submodule is never written. The overlay is served only
for the experiment; ordinary gameplay loads the original file.

## Build and verify

```sh
python3 local/client-bridge/build.py
python3 -m unittest discover -s local/client-bridge -p 'test_*.py'
node --test local/client-bridge/bridge.test.mjs
```

The build requires Python 3.9+ and a JDK. It uses Homebrew's `openjdk` when present,
or `java`/`javac` on `PATH`; set `BRIDGE_JAVA_HOME` to select another JDK. It downloads
the official [JPEXS 26.4.0 release](https://github.com/jindrapetrik/jpexs-decompiler/releases/tag/version26.4.0)
on first use. The archive, compiler library, and original engine all have checked
SHA256 values in `build.py`. Dependencies are extracted from the verified archive
on every build. Generated tooling and output stay in ignored `.local/`:

- `.local/bridge-tools/`: compiler package, exported research material, Java state.
- `.local/client-bridge/engine.swf`: generated overlay.
- `.local/client-bridge/build.json`: input, extension, compiler, output hashes and
  the added tag's offset/size, used by the preservation regression.
- `.local/client-bridge/puffle_adoption.swf` and `adoption-build.json`: the derived
  Pet Shop module described below, with its provenance.

An upstream engine change fails the build until its shape and compatibility have
been reviewed. This tool does not update upstream revisions automatically.
`./local/agent-start` refuses to start when either output is missing or older
than its source.

## Project adoption module

The agent page's Pet Shop loads a derived copy of the archived AS3 module
`media/play/v2/client/puffle_adoption.swf` (input SHA-256 pinned in
[`adoption_build.py`](adoption_build.py)). The ordinary game page never loads
it: `bootstrap.js` rewrites the module URL only when `CP_AGENT_MODE` is set,
and the 8080 server answers 404 for it. The build makes two changes:

1. It adds `com.claudepenguin.adoption.ProjectAdoption`, compiled by the pinned
   JPEXS from the owned [`ProjectAdoption.as`](ProjectAdoption.as), as a second
   ABC tag placed before the module's own.
2. Five void methods of the module's own adoption classes gain a three-instruction
   prologue, `if (ProjectAdoption.hook("<id>", this)) return;`: the pen opening
   (destination picker), the Adopt click, the purchase, the adopted event, and the
   certificate's walk. The rest of each method is the original bytecode.

Every build checks the invariants and fails if one breaks: every other tag is
byte-identical and in place; the module keeps its method and body counts; every
unpatched method body (4,360) is byte-identical; each patched body is exactly the
prologue followed by the original bytecode; and a second clean build produces
identical bytes. The hooks live only in module classes, because the module loads
into a child application domain where host classes would shadow patched copies.

`ProjectAdoption` talks to the page through `ExternalInterface`
(`window.ClaudePenguinAdoption`, [`adoption.mjs`](../web/bridge/adoption.mjs)).
If the page glue cannot be reached, the other hooks let the original code run,
but the purchase hook still blocks: the derived module never calls upstream
`p#pn`, so the visitor never adopts a puffle of its own. An error inside a hook
also fails closed. The purchase itself is `cpBridgeAdopt` below. Rainbow and Gold posters
are hidden; a full igloo reuses the module's own capacity error.

The destination picker shows five igloos per page, with Previous/Next controls
for all 32 supported projects. Change returns to the selected project's page;
removed or reordered destinations are resolved by project identity. An uncertain
purchase stays pending and displays the page's recovery notice while receipt
checks continue. Neither a timeout nor a hook exception claims that no coins
were taken. Only a settlement committed in the game database (the engine's
`settled` record, or the server refusing the ID as `settled`) ends it as a
failure; see the [engine guide](../AGENT_ENGINE.md#adoption-into-a-project-igloo). `adoption-picker.test.mjs` executes the owned AS3 picker/status methods
with display doubles; real Ruffle rendering remains a separate browser check.

## Browser contract, version 5

Version 5 (multi-puffle igloos, November 6, 2026) maps each project to a set of
up to ten puffles. Each puffle carries a page-local numeric draft slot that the
browser assigns per worker; Flash never receives worker or session identities.
A click names its project, puffle and slot, and selects exactly that puffle's
worker. The native card gains a roster of the igloo's puffles, Work opens a
native list of the puffles that need attention, and `cpBridgeAdopt` carries the
in-game project adoption purchase.

Version 4 added read-only lifecycle cards and per-worker draft slots. Version 3
put `version` on every callback result, refusals included, and added
`cpBridgeRejectAgentAction`. Version 2 allowed an empty project list, rejected
duplicate mapping IDs, and added a configuration `generation` to configure
results, snapshots, and events. The browser checks the version of every result
before reading it and refuses a missing or different version, so an older build
must be rebuilt rather than loaded silently. Game IDs (visitor, owner, room,
puffle) are integers from 1 to 999,999,999; at most 32 projects and 10 puffles
per project are mapped. The browser applies the same bounds (`MAX_GAME_ID`,
`MAX_MAPPINGS`, and `MAX_PUFFLES` in `web/bridge/model.mjs`). It excludes an
out-of-range or ambiguous mapping on its own, and with more than 32 ready
mappings it configures none and shows an error. A mapping's `projectId` is
opaque to Flash: the bridge lab sends fixture IDs (`bridge-alpha`), and agent
mode sends the engine's project UUID.

Callbacks registered through Flash `ExternalInterface`:

| Callback | Result / behavior |
| --- | --- |
| `cpBridgeConfigure(visitorId, projects)` | Validate a dedicated visitor and an array of 0–32 `{projectId, ownerId, puffles:[{puffleId, slot}]}` mappings (0–10 puffles each), then replace every mapping and advance the generation. Returns `{ok:true, version:5, generation}`. Owner IDs must differ from the visitor; project and owner IDs, puffle IDs, and slots must be unique across the whole configuration. An empty array is a valid empty neighborhood, and a project with no puffles is a valid empty igloo. A rejected call keeps the previous mapping and generation. Every existing click hook is removed; the next tick hooks only currently mapped puffles. A native card whose project is no longer mapped closes. |
| `cpBridgeSnapshot()` | `{ok, version, configured, generation, playerId, roomId, ownerId, puffles:[{id,x,y}], nativeMenuReady}`. Room transitions and a different logged-in player return `ok:false` and an `error`. Non-igloo owner is `0`. Coordinates use the game's room coordinate system. `nativeMenuReady` reports whether the native HUD exists. |
| `cpBridgeJoinIgloo(ownerId, force)` | Request a mapped owner's igloo via the existing shell navigator. When the visitor is already in that igloo it does nothing unless `force` is true, which rejoins so a newly adopted puffle renders. A successful acknowledgement is not arrival; wait for a matching snapshot. |
| `cpBridgeJoinRoom(100)` | Request Town via the existing shell navigator. Other room IDs are outside this experiment. |
| `cpBridgeAnimate(puffleId, state)` | Play an existing visible puffle animation only for the configured visitor, current mapped igloo, and a matching rendered puffle of that igloo. State must be `working`, `needs-you`, `ready`, `interrupted`, or `failed`. Returns `simulated:true`. |
| `cpBridgeSetAgentMenu(payload)` | Cache a bounded, public display summary and enable or disable the native HUD. An editable card must name a configured project and one of its mapped slots; a read-only card may name any project, and an empty ID means nothing is selected. Roster and attention rows that do not name a mapped slot are dropped. See the payload below. |
| `cpBridgeShowAgentMenu()` | Open the native task card for the cached puffle, or emit `work` without a project ID if none is selected. Requires the verified visitor, a ready room, and no active game widget. |
| `cpBridgeHideAgentMenu()` | Close the owned card and restore its modal state. Safe to call during connection or room changes. |
| `cpBridgeRejectAgentAction(action, projectId, draftSlot)` | The browser refused a native card action, for example one prepared against an older generation or sent during travel, so nothing reached the engine. A refused `submit` for the same puffle releases the pending task so Send follows the host-reported state again, and the draft stays in the input. An open card for that puffle shows "Task not sent. Try again." (or a general notice for other actions) until the next action or until it closes. |
| `cpBridgeAdopt(adoptionId, typeId, name, subtypeId)` | Send one project adoption purchase, `p#cpadopt`, through the shell's own game connection for the configured visitor. The adoption ID is the lowercase UUID the engine reserved and published; `typeId` is 0–9 and `subtypeId` is 0, 1006 (Blue Dog) or 1007 (Orange Cat); the name is 1–12 letters. Returns `{ok:true, version:5, adoptionId}` once sent. The world server's reply arrives as an `adoption-result` event; on success the shell shows the committed coin balance. The reply is never forwarded to AS3, so nothing enters the visitor's own puffle collections. |

Navigation, animation, purchase, and menu actions fail closed before
configuration, during loading, for a different logged-in player, and for
unknown IDs. Travel and menu actions also refuse execution inside a minigame.
Caching a display summary does not authorize an action. Normal client travel
and minigame exit controls remain.

The native menu payload is:

```js
{ enabled, connected, projectId, name, projectName, status, activity,
  draftSlot, readOnly, canStart, canSubmit, running, attention, color,
  roster: [{ slot, name, color, status, task, selected }],      // up to 10, this igloo
  alerts: [{ projectId, slot, name, projectName, status }] }    // up to 20, every igloo
```

Set/show/hide/reject return `{ok:true, version:5, nativeMenu, hudReady, menuVisible}` on success.
`nativeMenu` and `hudReady` are true only after the HUD exists in a verified game
session; the browser retains setup access before that point. Disabling the menu
removes its owned clips. Names, activity, roster statuses and the current task
are plain, bounded text. `attention` counts every active worker that needs a
response, failed, or ended a turn; `alerts` lists the mapped ones. No
repository or worktree path, provider credential, worker ID, Claude session UUID,
or terminal output is sent to Flash.

The client calls `window.ClaudePenguinBridge.receive(event)` with:

- `{type:"ready", version:5}` when the extension registers callbacks.
- `{type:"puffle-click", ownerId, puffleId, projectId, slot, generation}` when a
  mapped puffle is clicked. A polling hook attaches only to mapped puffles' clips
  and restores the original press handler when the mapping no longer applies or
  the overlay is reconfigured.
- `{type:"animation", ownerId, puffleId, state, simulated:true}` after selecting
  an animation. This is acknowledgement of an animation request, not agent work.
- `{type:"agent-menu-action", projectId?, action, generation, draftSlot?, text?}` for native
  menu actions. Actions are `work`, `igloos`, `select` (a roster or attention
  row: `projectId` and `draftSlot`), `start`, `submit`, `interrupt`, `terminal`,
  or `changes`. `submit` carries at most 20,000 characters; `work` may omit the
  project ID. The browser accepts project actions only for its own explicit
  selection and current generation, then applies the engine's normal
  authentication and action rules.
- `{type:"adoption-result", ok:true, adoptionId, puffleId, typeId, subtypeId, name, coins, cost, createdAt, ownerId}`
  or `{type:"adoption-result", ok:false, adoptionId, code}` for a `p#cpadopt` reply.

The browser treats every result as stale after a mapping change: it accepts clicks,
travel, and project menu actions only against a fresh snapshot whose `generation`
matches its latest successful configuration, and only for events that carry that
generation. A reload or reset overlay reports a different generation and is
reconfigured automatically. An adoption adds a puffle to a mapping, so it also
reconfigures the overlay.

The five frames reuse the engine's original puffle art: play (27), bubblegum (29),
super play (28), rest (25), and angry (33). The retained `simulated:true` field
describes the visual request, including when real host state selected it. It is
not a lifecycle event. Project and fixture IDs do not authorize terminal control;
the [host engine](../AGENT_ENGINE.md) has its own authenticated interface.

## Native menu rendering

The Work/Igloos HUD and puffle task card use owned AVM1 MovieClips, buttons, and
TextFields inside the original game's display list. They scale with the game and
accept task input in Flash. This is a new game menu styled to match the original
client, not a relabeled stock puffle-care menu. The portrait loads the archived
icon for the puffle's color (`/media/play/v2/content/global/puffle/icons/<color>.swf`).
The Blue Dog and Orange Cat have only AS3 art in the archive, which AVM1 cannot
load, so they show the blue and orange icons. If an icon fails to load, the card
falls back to the exported blue portrait; see its
[provenance and reproducer](../web/engine/art/README.md).

In an igloo, the host's AS3 Like widget sits above every AVM1 clip and takes
clicks across the stage's top-right corner (measured at about x ≥ 600, y ≤ 165
on the 760×480 stage). The card keeps its X and the roster rows outside that
area.

The card temporarily stops game keyboard shortcuts and balances the shell's
trigger-hide count. Closing it, leaving the room, losing the verified visitor,
or entering a minigame removes the card and restores the state it owned. It
refuses to replace an already-open game widget. Connection loss disables runtime
actions while retaining access to Open Claude. A submitted task cannot be sent
again while awaiting a lifecycle change; sending alone does not mark it Working.
Unsent drafts survive closing the card or opening Claude for the current page,
remain separate per worker, and clear only when the matching submission starts.

Open Claude and Changes hand off to browser views, where terminal input and
diffs remain practical. The browser owns repository setup and runtime commands;
the native card is a presentation and input layer. The dated
[validation record](../VALIDATION.md) distinguishes live checks from contract
coverage.

## Observed client seams

The decompiled pinned client provides the following concrete seams. Generated
decompilation is kept out of Git; no upstream source is copied into this adapter.

- `shell.swf` root: `sendJoinPlayerIgloo(ownerId)` loads the igloo directly;
  `sendJoinRoom(getRoomNameById(100), 0, 0)` navigates to Town. The newer igloo
  context tracks ownership with `getIglooPlayerID()`; the legacy stored igloo
  object is not populated by this path.
- `engine.swf` root: `isRoomReady()`, `isInAnIgloo()`, and `puffleManager` identify
  a ready room and rendered puffle instances.
- `com.clubpenguin.engine.PuffleManager`: `_puffles`, `getPuffleByID(id)`, and
  `updatePuffleFrameByID(id, frame)` provide the rendered object and animation.
- Original puffle clicks are enabled only in the owner's igloo/backyard. The
  scoped hook makes the verified visitor's mapped puffle clickable without enabling
  care controls for every other owner's puffle.
- `interface.swf` root: `interface_mc` hosts the owned native clips;
  `stopQuickKeys()`, `startQuickKeys()`, and `setWidgetsActive()` coordinate input.
  The shell's `hideTriggers()`/`showTriggers()` maintain a reference count.

These are findings from the pinned SWFs. Interactive verification must separately
prove callback registration, navigation, puffle clicks, and rendering in Ruffle.
The Node contract harness executes the adapter's shared ES3 subset against narrow
game doubles to check identity and loading gates; it does not emulate AVM1. It
also drives the overlay with the browser's own mapping functions (empty
neighborhood, dynamic addition, stale-generation rejection) and rejects syntax
outside that subset, but only the JPEXS build proves the source compiles.
