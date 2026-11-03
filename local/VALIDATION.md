# Baseline validation — November 3, 2026

**Backend verified; visual gameplay pending.** No agent integration has started.

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

## Not yet verified

The Mac was locked and computer-use tools could not unlock it. An unlock was requested. No successful browser rendering or interactive gameplay is claimed.

The remaining acceptance pass is to open http://localhost:8080/, log in as `player`, walk around several rooms, use the map and catalogs, inspect inventory, adopt/care for a puffle, edit an igloo, play a representative minigame, log out, and confirm the saved state after logging in again. Card-Jitsu Snow needs its own visual gameplay test.

Only the English Blizzard world is running. Other languages, every room, every item, events, multiplayer activities, and all minigames have not been exhaustively tested. Archived asset availability is not evidence of complete gameplay compatibility.

## Evidence

- [Machine-readable summary](validation-summary.json)
- [Source revisions](sources.json)
- [Runtime snapshot](runtime-snapshot.json)
- `.local/fresh-protocol-verification.json`
- `.local/restart-protocol-verification.json`
- `.local/http-verification.json`
- `.local/start-verification.log`

Raw logs and reports are local ignored artifacts. The original Flash assets and server sources have not been modified; environment configuration and the browser/protocol compatibility wrapper live under `local/`.
