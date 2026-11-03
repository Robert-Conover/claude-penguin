# Baseline validation — November 3, 2026

**Core browser gameplay and backend verified; acceptance coverage is partial.** No agent integration has started.

## Passed

- Downloaded Wand's pinned Houdini, Dash, Snowflake, and vanilla-media revisions. All four initialized source submodules have clean tracked working trees.
- Built and launched all seven local services on macOS ARM64 in the dedicated Colima profile.
- Ran `./local/start` end to end successfully; initial accounts remained unchanged on rerun.
- Real AS3 login and world authentication, player loading, spawning, movement, and transitions between Town (100) and Pet Shop (310).
- On a fresh fixture account, bought green color (20 coins), adopted a blue puffle (400 coins), entered its igloo, brushed the puffle, walked it, and returned it to its igloo.
- Reconnected and verified identity, 9,580 remaining coins, purchased inventory, puffle name/care stats, and igloo identity.
- Stopped and removed the entire container stack without removing its data volumes, recreated it, and repeated those persistence checks successfully.
- 95 real HTTP GET checks: original page/configuration/registration, 12 scripts, 10 modern stylesheets, two Ruffle WASM files, and 65 SWFs. All 56 entries in the minigame registry have available entrypoint assets.
- Four real WebSocket checks: policy exchange and AS3 version-253 acceptance on login and world bridges.
- Browser wrapper integration tests, including required-file readiness failure and all three binary socket bridges.
- Card-Jitsu Snow server starts and registers its lobby/battle places. The local bootstrap preserves the media URL's port and path.

## Interactive Safari checks

On November 3, 2026, the original AS3 client rendered through the pinned Ruffle build at http://localhost:8080/. The `player` account completed:

- Original login screen, Blizzard server selection, and successful world entry.
- Walking and map travel across Forest, Town, Clothes Shop, Plaza, Pet Shop, Igloo, and Mine.
- The full introductory tour, including claiming its clothing, puffle-hat, and furniture rewards.
- February 2017 Penguin Style catalog browsing; Orange purchased for 20 coins, inventory displayed, and Orange equipped in the world.
- Blue puffle `Claude` adopted for 400 coins, adoption certificate/supplies displayed, puffle walking/following, and return to the igloo.
- Igloo management/editor and furniture inventory displayed.
- Cart Surfer title screen, instructions, and active game rendering with the orange player. Keyboard input changed the player's riding stance.

The Mac locked again during the Cart Surfer run. A completed round, score/reward, and browser relogin persistence have not yet been confirmed. The lock interrupted UI testing; it was not a game crash.

## Persisted browser-session data

A read-only database transaction after the world restart confirmed player 103 still has 99,580 coins (100,000 minus 20 for Orange and 400 for Claude), equipped Orange (6), The Insta-Hero (24023), blue puffle Claude (id 3), Polka Puffle Hat (142), active Basic Igloo (id 3), and Table for Two (2166) in furniture inventory. There are no placed furniture rows, matching the unresolved browser placement check.

## Compatibility fix and observed warnings

Exiting the editor with an empty furniture list exposed an upstream `len(None)` exception after the layout had already been saved/broadcast. `local/houdini_bootstrap.py` normalizes that one expression to an empty list in memory while preserving the original listener and authorization/cooldown metadata. It checks the expected upstream syntax and fails explicitly if the pinned code changes. The downloaded source remains unchanged.

`local/test_houdini_compat.py` passed four tests: reproducing the original exception, corrected empty-save behavior, nonempty furniture/stamp behavior, and rejection of another player's igloo. Twelve live protocol checks then passed for the dedicated `localcheck` fixture, including empty layout save/reload, an owned Table for Two placement/save/reload, and furniture persistence after reconnect. No world-server errors occurred during that run.

The old client also sends unimplemented `nx#bimp` map analytics, `p#bipa` adoption analytics, and `g#im` edit-management notifications. These produced warnings; room travel/adoption continued. Source inspection identifies the first two as telemetry. No missing asset responses or client-bridge errors were observed during this pass.

## Not yet verified

- Successful furniture placement/save through browser input. The editor opened, but the attempted placement did not remain in the room.
- The complete puffle-care UI interaction; care state and brushing were verified at protocol level only.
- Completed minigame rounds/rewards and all Card-Jitsu Snow gameplay.
- Browser logoff/relogin verification (protocol persistence after reconnect and stack restart passed).

Only the English Blizzard world is running. Other languages, every room/item, events, multiplayer activities, and all minigames have not been exhaustively tested. Archived asset availability is not evidence of complete gameplay compatibility.

## Evidence

- [Machine-readable summary](validation-summary.json)
- [Source revisions](sources.json)
- [Runtime snapshot](runtime-snapshot.json)
- `.local/protocol-verification.json` (includes igloo save regressions)
- `.local/fresh-protocol-verification.json`
- `.local/restart-protocol-verification.json`
- `.local/http-verification.json`
- `.local/start-verification.log`

Raw logs and reports are local ignored artifacts. The original Flash assets and server sources have not been modified; environment configuration and the browser/protocol compatibility wrapper live under `local/`.
