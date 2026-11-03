# Baseline validation — November 3, 2026

**Core browser gameplay and backend verified; acceptance coverage is partial.** At this baseline checkpoint, no agent integration had started. The later game-bridge experiment is recorded separately below.

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

## Game bridge experiment — November 3, 2026, later pass

The opt-in [bridge lab](GAME_BRIDGE.md) was exercised in Codex's in-app browser on
macOS against the same running local stack and pinned Ruffle. This is game/client
integration only; no Claude Code session or coding task ran.

Passed interactively with the dedicated `bridgecheck` visitor:

- Original login and Blizzard world entry, including the initial tour dialogs.
- Browser-to-Flash callbacks register from the generated AVM1 engine overlay.
- Bridge Alpha and Bridge Beta load as distinct rooms (2105 and 2106), with
  owners 105 and 106. Their active layout mappings are 4 and 5, checked separately
  through the game protocol.
- Clicking actual Atlas and Comet puffles opens the panel with the corresponding
  project, owner, and puffle IDs (4 and 5); no screen-coordinate proxy is used.
- Working visibly makes Atlas play with a ball. Needs you produces its existing
  gum animation; Interrupted visibly changes Comet to the resting frame. These
  are simulated cues, not reported execution states.
- Travel to Town succeeds and Work retains an explicitly simulated attention
  count. The selected puffle remains inspectable there, with animation controls
  disabled outside its mapped igloo.
- A fresh browser reload/login reconnects, clears page-local simulated cues, and
  retains the saved Bridge Beta/Comet mapping. Clicking Comet again identifies
  owner 106 and puffle 5 correctly.

Verification commands passed: four wrapper/model tests, four client contract
tests, five binary-preservation tests, 95 live HTTP checks, four real socket
handshakes, and the two-project protocol verification (including reconnect and
frame delivery). Repeated fixture seeding reported all existing fixture accounts
unchanged. A read-only query confirmed the interactive `player` still has 99,580
coins and equipped Orange (6). No test logged into or mutated that account.

The browser pass caught and corrected the modern igloo owner getter mismatch
(`getIglooPlayerID()` is required) and a UI wait that treated a room-loading
snapshot as failure. Both are covered by regressions. A header Work button keeps
game controls unobstructed. Ordinary play pages retain their original client;
submodule revisions and tracked content remain unchanged. The generated overlay
preserves every original decompressed SWF tag.

Remaining scope: a custom map neighborhood, real repository/session registration,
terminal and permission handling, durable agent state, diff review, and worktree
isolation. Ready/Failed frame commands have contract coverage but their complete
animations were not separately accepted in this browser pass. No minigame was
retested for this bridge change. The remembered cue is page-local and does not
reapply an animation after travel or survive a reload.

Raw evidence: `.local/bridge-verification.json`,
`.local/client-bridge/build.json`, and `.local/bridge-evidence/` screenshots.


## Host Claude session engine — November 3, 2026, subsequent pass

The [single-puffle engine](AGENT_ENGINE.md) was exercised through the Codex in-app
browser on macOS at port 8081, using Claude Code 2.1.304 and the existing game
containers. This pass used a disposable Git repository under `/private/tmp/` and
separate ignored `.local/agent-engine-demo/` state. No user project was given to
Claude and no interactive `player` account was changed.

Passed with real Claude and browser interaction:

- Repository registration, named Atlas session creation, real PTY startup, folder
  trust input, and authenticated SessionStart lifecycle reporting.
- Submission of a small coding instruction through the task form; the real
  UserPromptSubmit hook reported Working. Claude then returned **Login expired**,
  and StopFailure reported `authentication_failed`; the panel and Work button
  showed Failed/attention. Initial host authentication had reported logged in,
  but a subsequent check reported logged out. The user chose to sign in later.
- Game login and Blizzard entry through the host wrapper, travel to the registered
  fixture igloo, and clicking actual Atlas to open the correct live session.
  After resume, Town travel kept the PTY running and Work opened its terminal
  without returning to the igloo.
- Tracked diff and untracked text preview rendering, including HTML displayed as
  plain text. These changes were explicitly created by Codex as viewer fixtures;
  they are **not Claude-generated work**. The coding source stayed unchanged.
- Task history retained the submitted prompt with failed status. Browser reload
  retained the same worker ID, Claude UUID, live PID, and replayed terminal screen.
- Stop session terminated the owned process while retaining its conversation.
  Engine shutdown disabled controls; foreground launcher restart reconnected to
  saved state. Resume used the exact UUID, confirmed in process arguments and the
  real SessionStart hook, and restored the prior prompt. No new session fallback
  was used. This proves conversation restoration, not a successful model response.

Verification passed: 14 engine/HTTP/WebSocket tests, nine wrapper/bridge/UI-model
checks, four client contract tests, five binary-preservation tests, shell syntax,
and `git diff --check`. The engine/HTTP tests needed host execution because the
sandbox denies loopback listeners; those were environment restrictions rather
than assertion failures. The host page passed 95 HTTP asset checks and four real
socket handshakes. Review caught a stale ownership-lock race and mismatched
terminal dimensions. Live checking caught double translation of a Dash URL when
proxying through port 8080; the corrected route has a focused regression.

Still pending: a successful real coding task, a real tool permission/approval,
active-turn interruption, and full visual acceptance of runtime-driven animations.
Hook/state regressions cover those paths but do not replace a live acceptance
pass. No minigame was retested. One repository/worker edits its registered checkout
directly; multiple project provisioning, the map neighborhood, and worktree
isolation remain later milestones. All upstream submodule revisions are unchanged.

Raw evidence remains ignored under `.local/engine-evidence/`, with session state
in `.local/agent-engine-demo/`. Default `.local/agent-engine/` state was not used.
The demo engine remains on port 8081; its test Claude process was explicitly
stopped after verification, retaining the saved conversation for later sign-in.


## Native puffle menus — November 3, 2026, interface revision

The agent page now uses owned AVM1 MovieClips and TextFields inside the original
Flash interface for its Work/Igloos HUD and puffle task card. These are new native
menus, styled against the original player card; they do not replace the stock
puffle-care menu. The blue puffle portrait is exported from the pinned original
sprite with [documented provenance](web/engine/art/README.md). All original engine
tags and upstream submodules remain unchanged.

Verified in the Codex in-app browser with `bridgecheck`:

- Native HUD renders within the game and replaces the external toolbar after
  entry. Work opens the native card, and clicking actual Atlas opens that same
  card with its explicit project mapping.
- Native Start/Resume starts the actual saved Claude session. Lifecycle events
  update the card from Waking up to Ready for a task. A draft was typed in the
  native text field but was not sent. Opening Claude and returning preserved
  that draft in the native card; no additional model prompts were submitted.
- Open Claude opens the secondary browser terminal, and its Stop action retains
  the session identity. The native Changes button opens the read-only viewer;
  Back returns to the Flash card. The final terminal layout has no unintended
  horizontal overflow, and the expanded diff viewer uses the available width.
- Igloos opens the game-styled destination chooser and successfully navigates to
  the registered igloo. Closing the native card restores penguin movement.
- The compact browser fallback card renders with the original puffle art before
  game entry. Session paths/UUIDs remain in optional terminal details rather than
  the main menu. Flash receives display status and fixture identity only.

Passed: 14 engine tests, 11 wrapper/UI tests, nine client contract tests, five
original-SWF preservation tests, 95 live HTTP checks and four game socket checks.
The menu contracts cover visitor/project gates, modal cleanup, disconnected
controls, duplicate-submit suppression until a real lifecycle event, and draft
preservation without crossing project identities. The
artwork reproducer was run twice with matching hashes. Shell syntax, launcher
artifact freshness, JavaScript syntax, documentation links and whitespace were
checked. The launcher refuses a stale source/output overlay instead of silently
loading the previous menu after an update.

Successful model execution still awaits Claude sign-in. Native submission with a
successful response, real tool permission approval, active-turn interruption,
minigame coexistence, and other viewport/device acceptance remain unverified.
The demo Claude process is stopped; its saved session and host engine remain.
Screenshots are ignored under `.local/menu-evidence/`.

## Authenticated agent acceptance and CI — November 3, 2026, later host pass

**Real coding, manual approvals, terminal retry, and exact-session runtime resume
passed. Full in-game acceptance remains pending.** This pass used Claude Code
2.1.317 on macOS, the existing disposable repository, the saved Atlas conversation,
and `.local/agent-engine-demo/` state. Commands used the engine's authenticated
HTTP/WebSocket interfaces and actual Claude PTY, not simulated hooks. No normal
player account was used or modified.

The Mac was locked. Computer Use reported that automatic unlock could not unlock
it; the Codex in-app browser also returned `Local browser use is disabled in Work
settings` on repeated attempts. Consequently this pass does not establish native
card submission, browser reload, Town travel during successful execution, visual
attention/animation behavior, or rendered review of these new changes. Earlier
browser observations above remain dated historical evidence.

Passed through the host engine:

- Confirmed host authentication and resumed the original saved Claude session.
- Submitted a greeting fix: missing/undefined names default to `penguin`, while
  named greetings remain intact. Claude changed `greeting.mjs`, created
  `greeting.test.mjs`, and ran both Node tests successfully. An independent rerun
  also passed both tests. These two files are actual Claude-authored work.
- Observed real Bash and Write permission requests, corresponding `needs-you`
  lifecycle state, and continued work after one-time terminal approvals. Manual
  permissions remained enabled; no persistent allow rules were created.
- Verified the changes endpoint includes the tracked code diff and the untracked
  test. SHA256 comparisons confirmed the earlier Codex-authored README and preview
  fixtures, and package manifest, were unchanged. Those older viewer fixtures
  remain separate evidence and are still included in the cumulative diff.
- Reattached fresh WebSocket clients to the same PTY and obtained terminal replay.
  A normal host shutdown/restart preserved project, worker, and conversation IDs;
  the new worker process used that exact `--resume` UUID. Claude recalled both
  verification words and the code/test result after restart.
- Interrupted a real active response through the engine's Escape action. The real
  terminal returned to input and later displayed its interruption message. A
  separate attempted `sleep 45` check was refused by Claude before execution and
  is not evidence of tool-process cancellation.

The interruption pass exposed a real compatibility gap: this CLI/terminal did not
emit the OSC idle marker expected by the adapter, leaving the old UI state at
`working` after cancellation. The corrected adapter reports `needs-you` with an
explicit unconfirmed-cancellation message. It retains the unfinished task until
an authenticated lifecycle event or supported marker resolves it. The native
card uses generic attention text and keeps terminal access available. It does
not infer completion from restored prompt text or from sending Escape. A live
retest confirmed attention, terminal retry, and transition back to working/review;
the previous task became interrupted when the retry's actual prompt hook arrived.
Interrupt is now a no-op for already idle or ended turns, including a late click
racing completion; a live idle-interrupt check preserved the ready state and
revision. The [official hook contract](https://code.claude.com/docs/en/hooks#stop)
does not send Stop for user interruption.

Regression validation: 17 engine, 11 web/UI, nine client contract, and five SWF
preservation tests passed with local artifacts present. The added regressions
cover missing confirmation, late tool/lifecycle events, stale idle markers, and
idle/completed-turn interruption. The workflow was checked with actionlint and
its commands were exercised in source-only copies on macOS and Linux with Node
22.23.4. Linux's final source-only run passed 41 checks and explicitly skipped the
one real-overlay test. Local Python versions were 3.9.6/macOS and 3.11.2/Linux;
the workflow selects Python 3.12. GitHub-hosted execution has not run yet.

The new `.github/workflows/regression.yml` runs on PRs to and pushes on `dev` and
`main`, plus manual dispatch, with Ubuntu/macOS jobs and read-only permissions.
It installs locked npm dependencies without scripts and downloads no media or
provider credentials. Its expected generated-overlay skip, and separate live
acceptance responsibilities, are documented in CONTRIBUTING.md. It does not
configure required branch checks.

Raw lifecycle events, restart identity evidence, baseline hashes, and terminal
capture stay ignored under `.local/acceptance-2026-11-03/`. The game services and
host engine remain available; the test Claude process is stopped with its saved
session and actual changes preserved. Remaining acceptance: the native browser
loop after browser access is enabled, automatic interrupt confirmation on this
CLI, running-tool cancellation, animation coverage, and minigame coexistence.
