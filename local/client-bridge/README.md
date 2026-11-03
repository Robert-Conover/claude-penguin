# Game bridge client experiment

This is the small client-side part of the opt-in game bridge experiment. It does
not run Claude Code, create agent sessions, or interpret an animation as completed
work. Its five animation states are explicit simulations.

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

An upstream engine change fails the build until its shape and compatibility have
been reviewed. This tool does not update upstream revisions automatically.

## Browser contract, version 1

Callbacks registered through Flash `ExternalInterface`:

| Callback | Result / behavior |
| --- | --- |
| `cpBridgeConfigure(visitorId, projects)` | Validate a dedicated visitor and an array of `{projectId, ownerId, puffleId}` mappings. Returns `{ok:true, version:1}`. Owner IDs must differ from the visitor. |
| `cpBridgeSnapshot()` | `{ok, version, configured, playerId, roomId, ownerId, puffles:[{id,x,y}]}`. Room transitions and a different logged-in player return `ok:false` and an `error`. Non-igloo owner is `0`. Coordinates use the game's room coordinate system. |
| `cpBridgeJoinIgloo(ownerId)` | Request a mapped owner's igloo via the existing shell navigator. A successful acknowledgement is not arrival; wait for a matching snapshot. |
| `cpBridgeJoinRoom(100)` | Request Town via the existing shell navigator. Other room IDs are outside this experiment. |
| `cpBridgeAnimate(puffleId, state)` | Play an existing visible puffle animation only for the configured visitor, current mapped igloo, and matching rendered puffle. State must be `working`, `needs-you`, `ready`, `interrupted`, or `failed`. Returns `simulated:true`. |

All mutation callbacks fail closed before configuration, during loading, for a
different logged-in player, for unknown IDs, and (for travel) inside a minigame.
Normal client travel and minigame exit controls continue to work.

The client calls `window.ClaudePenguinBridge.receive(event)` with:

- `{type:"ready", version:1}` when the extension registers callbacks.
- `{type:"puffle-click", ownerId, puffleId, projectId}` when the actual mapped puffle
  is clicked. A polling hook attaches only to the mapped fixture puffle's clip and
  restores its original press handler when the mapping no longer applies.
- `{type:"animation", ownerId, puffleId, state, simulated:true}` after selecting
  an animation. This is acknowledgement of an animation request, not agent work.

The five frames reuse the engine's original puffle art: play (27), bubblegum (29),
super play (28), rest (25), and angry (33). No provider credential or filesystem
path is sent to Flash. Fixture IDs are a local experiment boundary, not a security
boundary for a future agent engine; that engine will need its own authorization.

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
  scoped hook makes a fixture visitor's mapped puffle clickable without enabling
  care controls for every other owner's puffle.

These are findings from the pinned SWFs. Interactive verification must separately
prove callback registration, navigation, puffle clicks, and rendering in Ruffle.
The Node contract harness executes the adapter's shared ES3 subset against narrow
game doubles to check identity and loading gates; it does not emulate AVM1.
