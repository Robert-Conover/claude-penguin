# Validation record

## Current status

**The multi-project agent loop has recorded browser and real-Claude acceptance;
coverage remains partial.** The latest live evidence is from November 6, 2026:
[database-confirmed adoption settlement](#database-confirmed-adoption-settlement--november-6-2026)
covers an expired purchase stalled on the visitor's database lock resolving as
not charged in the browser, the settled ID being refused afterwards, a fresh
adoption charging once, the live schema upgrade, and real PostgreSQL tests of
both purchase/settlement orders. Earlier the same day,
[live adoption and puffle-team acceptance](#live-adoption-and-puffle-team-acceptance--november-6-2026)
covers two real Claude tasks editing code at once in one igloo, independent
drafts, the overall session cap, exact resume after a restart, paid adoption
recovery after a lost reply and an engine crash, Retry after a failed worktree
setup, the server's own full-igloo refusal and an ordinary 8080 adoption.
[Project adoption and puffle teams](#project-adoption-and-puffle-teams--november-6-2026)
covers adopting puffles at the Pet Shop into project igloos, one charge per
purchase, a 10-puffle igloo, session limits, reconnect and the v3 state migration. Earlier evidence from November 5:
[Stage 3](#multi-project-experience-stage-3--november-5-2026) covers native map
visits, two concurrent puffles, permissions, changes review, reconnect, exact
session resume, and the real Atlas archive migration. The
[Postcards playthrough](#puffle-postcards-playthrough--november-5-2026) covers a
task submitted in-game and a fix independently checked in its worktree.

The current `dev` engine uses the normal opt-in launcher; it no longer requires
`CP_ENGINE_PREVIEW=engine-v2`. See the [engine guide](AGENT_ENGINE.md) for setup.
This overview summarizes existing evidence, not a new acceptance run. All dated
entries below describe their checkpoint only: preview gates, running processes,
state versions, test counts, and then-open gaps may have been superseded by later
entries. They do not describe the current state of any user's machine. The
[JSON summary](validation-summary.json) keeps the same historical records and a
separate `current_status` overview.

## Current validation gaps

- Minigames other than Thin Ice, and any minigame payout while a Claude task is
  live; all Card-Jitsu Snow gameplay. The
  [November 8 browser playthrough](#browser-playthrough-minigame-igloo-puffle-care-and-relogin--november-8-2026)
  completed a Thin Ice level and its payout, placed and saved furniture, fed a
  puffle and logged off and back on as `localcheck`; puffle play, cleaning, rest
  and dressing, the Puffle Care catalog and igloo purchases were not exercised.
- New accounts that have not finished the introductory tour open the map in its
  quest mode; map clicks did not travel during that playthrough.
- Automatic interrupt confirmation on the tested Claude CLI and cancellation
  during a running tool. Stage 3 checked an interrupt, terminal inspection, and
  retry; that does not establish every cancellation path.
- Individual puffle animation frames tied to real agent states, and live
  puffle-name rejection/correction. Animation routing and rejection logic have
  automated coverage; the local name-filter data did not produce a live rejection.
- Adoption edge paths: the default overall cap of six has not been filled live
  (the queue was checked at a cap of four), and the lost-reply, crash and
  setup-failure recovery purchases were driven through the page adoption
  controller, not the native catalog UI. Settling an expired purchase as not
  charged is now confirmed by the game database and was checked live; an agent
  page whose purchase stalls on a database lock loses its game connection.
- Full-stack operation on Intel Macs or other host platforms. The recorded
  game acceptance used Apple Silicon macOS; offline CI is separate coverage.

Only the English Blizzard world has been exercised. Other languages, every
room/item, events, multiplayer activities, and all minigames have not been
exhaustively tested. The dated entries retain environment-specific limits;
Stage 3's local results do not establish a GitHub-hosted CI result.

## Baseline validation — November 3, 2026

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

## Multi-project engine, Stage 1 — November 4, 2026

**Engine changes pass automated validation, and migration was rehearsed on a
private copy. Live Claude, game, and browser acceptance are not part of this
stage.** The host was macOS with Git 2.54.0 (Apple Git-157), git-lfs 3.8.1, and
Node 26.13.0. On this branch the real agent page is disabled. `server.mjs` serves
it only with `CP_ENGINE_PREVIEW=engine-v2` and a dedicated, non-default state
directory.

Automated checks:

- Engine: 57 tests passed (`npm test --prefix local/engine`): 11 Git policy, 7
  workspace, 6 state/migration, 27 manager, and 6 server tests. They use
  temporary repositories, isolated Git global configuration, real `git worktree`
  operations, and fake PTYs.
- Web/UI: 11 passed. Client contract: 9 passed. Synthetic SWF preservation: 5
  passed. Launcher syntax checks passed.
- Coverage includes multiple repositories, equal basenames, symlink and
  linked-worktree deduplication, the 32-project limit, and explicit-ID routing
  with no fallback. It includes worktree placement, sanitized leaf names, a root
  containing spaces, refusal of a root inside Git, and unchanged source files,
  index, and `HEAD` with staged, unstaged, untracked, and ignored edits present.
  Git policy cases cover refused custom `clean`, `smudge`, and `process` filters
  (a sentinel file proves none ran), a fake driver named `lfs`, user attribute
  files, local and conditional `includeIf`, inactive `post-checkout` hooks, a
  partial clone failing with "lazy fetching disabled", real Git LFS 3.8.1 leaving
  pointers, locked worktrees, and the 2.48 version floor. Recovery cases cover
  setup failure and retry with no duplicate branch or worktree, reconciliation
  after a simulated crash, and concurrent or duplicate creation. Workspace cases
  cover missing, replaced, and pruned worktrees, an unavailable baseline,
  branch/detached/unlocked/unrelated-history warnings, and review against the
  baseline. Hook cases cover cross-worker tokens, startup and resume outside the
  worktree, `cd src` followed by compaction, attention outside the workspace, and
  session mismatch. Ported PR #5 interruption regressions also pass. Migration
  cases cover byte preservation, a missing source, archived execution refusal,
  the retained mapping, and an isolated Atlas replacement.
- A preview-engine HTTP smoke test registered a disposable repository whose path
  contains a space, created a puffle, and reached a ready, locked worktree on
  its `claude-penguin/<project>/<worker>` branch. Review data came back, and the
  engine released its lock on SIGINT. It also exposed a missing local binding
  for `acquireLock` in `server.mjs`. That bug is fixed and covered by a new
  start/stop test.

Migration rehearsal (copy of `.local/agent-engine-demo/` in a private folder
outside the checkout):

- The copy kept the real stale `runtime.lock`, so migration first refused with
  the stale-lock message. PID 9967 was confirmed not running and the saved worker
  PID was `null`. The lock was then removed from the copy only.
- Migration produced v2 state. The backup is byte-identical to the original
  4,481-byte file, mode `0600`. The project UUID `e7c554c7-…` and its
  owner/igloo/room/puffle mapping 105/4/2105/4 are kept as `legacy-fixture`.
  Atlas is archived with session `c6b60407-…`, all 7 tasks, original folder
  `/private/tmp/claude-penguin-session-a_k41ydy`, baseline `dc4eefb…`, and a
  manual resume command.
- The previous engine's `readState` (from f86a615) rejects the migrated file.
  Loading the copy in the v2 engine showed the archived worker, and start,
  submit, and review returned 409.
- SHA-256 hashes of the real `.local/agent-engine-demo/` files match before and
  after, and the source repository gained no branch or worktree. The real state
  remains version 1. Its source repository lives under `/private/tmp`, which
  macOS may clean, so migration's missing-source path is likely to be needed.

Not verified in this stage: real Claude tasks in worktrees, folder-trust prompts
in a new worktree, where persistent permission approvals are written, game
provisioning, the native igloo list, browser UI, and GitHub-hosted CI on this
branch. Evidence is in the ignored `.local/stage1-engine-2026-11-04/`.

## Multi-project game mapping, Stage 2 — November 4, 2026

**Provisioning, publication, the visitor-only Houdini adapter, and the browser
mapping model pass automated checks, and one project was provisioned against the
running stack. Nothing in this stage ran in Ruffle, and the real agent page is
still disabled.** Same host as Stage 1, with Homebrew OpenJDK 27.0.1 for the
overlay build and the `club-penguin` Colima profile started with `./local/start`
(existing `localcheck` and `player` accounts reported unchanged).

Automated checks on the combined tree:

- Engine: 77 tests passed. These are the 57 Stage 1 tests plus 11 game protocol
  and provisioner, 8 setup-lifecycle, and 1 cross-boundary contract test. The
  contract test feeds a real engine snapshot (with a fake provisioner) into the
  browser's `agentMappings` and `flashConfiguration`. It confirms they and
  `published.json` list the same ready igloos, and that no path, session ID,
  owner username, password, or marker reaches the browser mapping or Flash.
- Web/UI: 21 passed. Client contract: 14 passed. Python host tests for
  provisioning and the adapter: 10 passed. Launcher syntax checks passed, as
  did `./local/compose config --quiet`.
- `python3 local/client-bridge/build.py` compiled the version-2 `bridge.as` with
  JPEXS, and all 6 SWF tests passed, including the generated-overlay byte
  preservation test (overlay SHA-256 `f1d346fc…`).
- Houdini container regressions: 11 passed (`test_houdini_compat.py`, including
  7 new adapter tests). On world startup the adapter installed, which means the
  AST check of the pinned `g#gr` and `g#pio` handlers matched the real image.
- `./local/verify` passed against the running stack.
- The migration command test failed on a checkout without `.local/` (as on CI)
  because `migrate.mjs` resolved that folder unconditionally. It now resolves it
  only when present, and the test passes in a tree without `.local/`.

Live provisioning (scratch state and worktree folders outside the checkout;
evidence script and output in `.local/stage2-game-2026-11-04/`):

- One disposable repository registered as `stage2-live` reached `ready`. The
  engine verified `bridgecheck` as game ID 107 without logging in as it, created
  managed owner 108, adopted the blue puffle "Pebble" (puffle 6) in owner igloo
  6, entered room 2108, and the provisioning service's database check passed.
  `published.json` listed exactly `{ownerId: 108, iglooId: 6}` for visitor 107
  while the engine ran, and was emptied on clean shutdown.
- A second run on the same state reused owner 108, re-verified it, and created
  nothing new.
- Logged in as the dedicated `localcheck` account (102) while the publication was
  live, `g#gr` listed no managed igloo and `g#pio` for owner 108 returned `0`,
  so non-visitors keep upstream behavior.
- The first attempt placed the worktree root inside the checkout; the engine
  refused it, as designed. That attempt's process exited while holding
  `owner.lock`; its PID was confirmed dead and the lock removed by hand,
  following the documented recovery.

The game database now permanently contains managed owner 108 (`cp…` username,
marker email under `managed.claude-penguin.invalid`) with puffle 6. It is a
disposable verification identity; `player` was not used.

Not verified in this stage: the visitor's in-game igloo map and player card
(they require a `bridgecheck` session in the browser), anything in Ruffle (the
reconfigurable overlay, UUID click routing, travel and animation with real
clips), a puffle name rejected live by Houdini (error 441 and the failed name
check are covered only by fakes), real Claude tasks in worktrees, and
GitHub-hosted CI on this branch.

## Multi-project review of Stages 1 and 2 — November 5, 2026

**Four independent reviews of `dev..multi-project-igloos` led to 28 fixes, each
with a regression test that failed on the unfixed code first. All offline suites, the Houdini container suite, `./local/verify`, the
HTTP checks, and a live provisioning rerun pass. Nothing ran in Ruffle, and the
real agent page is still disabled.** Same host and Colima profile as Stage 2;
the stack was started with `./local/start` (existing `localcheck` and `player`
accounts reported unchanged) and stopped again afterwards.

Fixed, by area:

- Git and worktrees:
  - Config-defined hooks (`hook.<name>.*`) and `attr.tree` are refused. Both
    previously let repository code run during worktree creation.
  - `git-lfs` runs directly, so a repository `alias.lfs` cannot run.
  - No inherited `GIT_*` variable is kept. `GIT_CONFIG` and `GIT_ATTR_SOURCE`
    previously bypassed the filter check.
  - Every transport is pinned to `never`.
  - Hard-linked untracked files are not previewed, and previews open with
    `O_NONBLOCK`.
  - Worktree roots that Git cannot classify are refused.
  - Git runs in its own process group, and a timeout stops the whole group.
  - A retry no longer adopts an interrupted checkout (missing index, stale
    `index.lock`, or unfilled tracked files).
  - Review truncates a very large untracked list instead of failing.
  - Repair messages give the `git worktree repair` command.
- Engine state and sessions:
  - Card submission re-checks the turn after the workspace check and after the
    paste. A terminal prompt or an unconfirmed Escape during inspection could
    previously still submit the task, a regression from PR #5's guarantee.
  - `game-pending` projects become retryable once provisioning is on. They were
    previously stuck.
  - Saved-state validation refuses shared repositories, sessions, and worktrees,
    mismatched repository records, unknown setup phases, and non-object entries.
  - A legacy project binds only to a repository that contains its archived
    baseline.
  - State folders are compared canonically, and served or container-mounted
    folders are refused. `.local/ruffle/<dir>` previously made
    `game-secrets.json` downloadable on 8080.
  - The hooks endpoint accepts 1 MiB, matching the hook client.
  - Folders inside a nested repository raise the outside-workspace warning.
- Game provisioning and the adapter:
  - A recorded owner or visitor ID is only verified, never recreated (code
    `MISSING`). A deleted owner previously led to a second account on retry.
  - The visitor password travels on stdin instead of a container environment
    variable.
  - A visitor mismatch withdraws the publication and reports `visitor: null`
    with `visitorProblem`.
  - An unparseable publication file publishes nothing and cannot break `g#gr`
    for other penguins, which a deeply nested file previously did.
- Browser bridge and overlay (contract version 3):
  - **Work** follows the panel's own selection.
  - A native action the browser refuses is reported back through the new
    `cpBridgeRejectAgentAction`, so the card no longer stays locked.
  - The browser applies the overlay's game ID range and 32-project cap.
  - Every overlay result carries `version`, and the browser checks it on each
    one.
  - The ES3/AS2 guard catches the 12 constructs that previously passed it.
  - The generated-overlay test fails on a stale build.
  - `panel.mjs` gained tests that drive the real panel, client, and overlay
    source.

Found while validating the fixes: `server.mjs` announced its address before
installing its SIGINT/SIGTERM handlers. In a source-only copy, as on CI, the
startup test then failed once in 13 full runs, because the signal arrived first
and the engine died without releasing its locks. This dated from Stage 1. The
handlers are now installed first, and 14 further runs passed.

Automated checks on the combined tree:

- Engine: 98 passed (77 before the review).
- Web/UI: 31 passed. Client contract: 18 passed. Python host tests: 14 passed.
- `python3 local/client-bridge/build.py` compiled the version-3 `bridge.as`
  (extension SHA-256 `b23ba529…`, overlay `11ef2c54…`, original tags unchanged).
  All 7 SWF tests passed, including generated-overlay preservation.
- Houdini container regressions: 12 passed, including the new unparseable
  publication test. On world startup the adapter installed.
- `./local/verify`, `npm run verify:http --prefix local/web` (95 HTTP and 4
  socket checks, no failures), `./local/compose config --quiet`, launcher syntax
  checks, and `git diff --check` passed.

Live provisioning (scratch state outside the checkout; evidence in
`.local/stage1-2-review-2026-11-05/`):

- A fresh disposable project reached `ready`. The visitor was verified as 107
  without logging in as it. The engine created managed owner 109, adopted puffle
  7 "Quartz" in igloo 7, and entered room 2109. `published.json` listed
  `{ownerId: 109, iglooId: 7}` while the engine ran, and was emptied on clean
  shutdown.
- A rerun on the same state reused owner 109, and `verifyGameMappings` returned
  1 checked, 0 repair, and no visitor problem. Logged in as `localcheck` (102),
  `g#gr` listed no managed igloo and `g#pio` returned `0`.
- Requests sent straight to the provisioning service exercised the new
  verify-only paths and created nothing; the highest penguin ID stayed 109:
  - The visitor with recorded ID 107 returned it unchanged; recorded ID 999
    returned `MISMATCH`.
  - An owner request with an unknown marker and recorded ID 109 returned
    `MISSING`, because that account no longer carries the marker; recorded ID
    99999 returned `MISSING`, because it does not exist.

The game database now also permanently contains managed owner 109 with puffle
7, a disposable verification identity like owner 108. `player` was not used.

Not fixed in this review, with the reason:

- Any local process can obtain the browser token from `/engine/bootstrap` and
  send terminal input to any puffle. This predates the branch, and puffles run
  as the same user. A fix is a design decision, so it is documented in
  `AGENT_ENGINE.md` instead.
- Hook tokens are visible to the puffle's own tool commands. This predates the
  branch; they can forge events only for that same puffle.
- The `web` and `seed` containers can still read the whole checkout. Nothing
  under `.local/` is reachable over HTTP (traversal probes returned 403 or 404).
  Narrowing the mounts is Stage 3 task 10.
- Smaller gaps, all left to Stage 3:
  - Startup publishes saved mappings before re-verifying them.
  - Legacy fixture mappings are not re-verified.
  - Migration's `--rehearsal` means "outside the checkout".
  - The browser's create-form fallback, per-project drafts, and selection
    upgrade gaps remain.
  - Atomic writes don't `fsync` the folder.

Still unverified: everything in Ruffle, a live puffle-name rejection, real
Claude tasks in worktrees, and GitHub-hosted CI on this branch.

## Multi-project experience, Stage 3 — November 5, 2026

Tested the uncommitted Stage 3 diff on `multi-project-igloos`, based on
`3596d57`, on macOS 27.2 with Node 26.13.0, Git 2.54.0, git-lfs 3.8.1,
Python 3.9.6, the dedicated Colima profile, the pinned Ruffle build and Claude
Code 2.1.317 in manual mode. The default engine state folder is still
`.local/agent-engine`. Acceptance used separate state and durable disposable
repositories under ignored `.local/stage3-evidence/`.

| Check | Result |
| --- | --- |
| `npm test --prefix local/engine` | 100 passed, including normal startup, explicit migration, mount boundaries and legacy mapping verification |
| `npm test --prefix local/web` | 37 passed, including Add, correction, archive, lifecycle, drafts, selection and late responses |
| `node --test local/client-bridge/bridge.test.mjs` | 18 passed |
| `python3 local/client-bridge/build.py` and the client-bridge Python discovery suite | Version 4 built, all original tags preserved, 7 tests passed including generated-overlay preservation |
| `python3 -m unittest local/test_game_provision.py local/test_native_igloos.py` | 16 passed |
| Houdini compatibility suite in the world image | 12 passed |
| `./local/start`, `./local/compose config --quiet`, `./local/verify`, `./local/bridge-fixtures` | Passed. Scripted game visits used fixture owners and localcheck. Only the interactive browser logged in as bridgecheck. |
| `npm run verify:http --prefix local/web` | 95 HTTP checks, 4 socket checks, zero failures |
| Launcher shell syntax, local document links and `git diff --check` | Passed |

The shell sandbox initially refused the launcher's submodule config write and
the loopback-socket test. The authorized host runs passed. An initial UI
regression lost selection invalidation on visitor mismatch; the corrected
browser suite and the updated version-4 event shape passed. Hosted CI requires
a pushed branch and is outside this handoff.

### Interactive and persistence evidence

- Added three repositories through **Igloos → Add project**. The original map
  listed all three owners and Bridge Alpha. The table gives the permanent game
  identities created by acceptance. The legacy fixture remained 105/4/2105/4.

  | Project | Puffle | Owner | Igloo | Room | Puffle ID |
  | --- | --- | ---: | ---: | ---: | ---: |
  | Snowcap | Comet | 110 | 8 | 2110 | 8 |
  | Lighthouse | Nova | 111 | 9 | 2111 | 9 |
  | Iceberg | Badword | 112 | 10 | 2112 | 10 |

- Visited Snowcap through the original map, Lighthouse through the chooser
  and Iceberg through its native player card. The player-card check briefly
  brought the disposable Iceberg owner into Town. Clicking each igloo's puffle
  opened the matching project card. A separate private copy started with
  Iceberg marked failed to rehearse interrupted setup. The real **Retry**
  reverified owner 112; Visit enabled and its puffle click worked in the same
  Ruffle page without reloading or logging the visitor out.
- Comet and Nova each showed a first-launch folder-trust prompt naming its
  own external worktree. Each received a task through Flash and a one-time
  Write approval in its own terminal. Comet wrote `comet.txt` and Nova wrote
  `nova.txt`. Checked contents and hashes on disk, absence in the opposite
  worktree and source checkouts, and the file preview in Nova's Changes tab.
  All three managed projects’ source HEADs, index bytes and tracked-file hashes
  matched the pre-registration fingerprints. No acceptance source gained a
  `.claude/settings.local.json` during these checks.
- In a follow-up on November 5, resumed Nova and ran
  `openssl dgst -sha256 nova.txt`. With explicit approval, selected **Yes, and
  don't ask again** for `openssl dgst *`. Neither Lighthouse checkout had a
  local settings file beforehand. Claude created `.claude/settings.local.json`
  in the **source checkout** with the single allow rule `Bash(openssl dgst *)`.
  The worktree had no local settings file afterward. The checksum matched
  the recorded hash of Nova's file. All acceptance source HEADs, index bytes
  and tracked-file hashes matched their values before the follow-up.
- The visitor traveled between igloos and to Town during concurrent work.
  **Work (2)** reflected both requests for attention. Interrupting Nova from
  the native card left **Needs your help** pending confirmation. Claude's
  terminal showed the interrupted response and accepted a retry, returning
  `LIGHTHOUSE RETRY OK`.
- A fresh browser connection retained both original worker/session/PID pairs.
  A clean engine restart reverified all four igloos, and starting Comet explicitly
  resumed its original conversation with its earlier Write and reply visible.
  A full browser reload reattached to the running terminal and replayed that
  conversation.
- The live web and seed containers could read their required files and could
  not see the engine state, game secrets or the private environment file at
  their former mount paths. In the rebuilt lab on 8080, a real click reported
  owner 105 and puffle 4, and a simulated cue produced **1 simulated alert**.
- Read-only database fingerprints of the normal player's progress, owned
  igloo rows, inventory and puffles matched before and after. The publication
  selected visitor 107, while player is 103. Localcheck (102) received upstream
  `gr` and `pio` results with no published owner available. The player's
  personal game session was never opened during acceptance.

### Real Atlas migration

First tested the archive and isolated replacement in the browser on a private
state copy pointing to a disposable clone of the original checkout. After
explicit confirmation, checked PID 9967 had exited, the saved worker had no
PID, and removed only that stale runtime lock. Ran:

```sh
node local/engine/migrate.mjs --state-dir .local/agent-engine-demo
```

The mode-0600 backup `state.v1-backup-2026-11-05T12-42-57-097Z.json`
matches the original v1 file byte-for-byte (SHA-256
`9d7a93683ae9f2af15952796107936dd85cbdc65530192c117b12030ff7f8a5e`).
The real archive displayed its original folder, session, resume command and
seven task records. Its active worker ID is null. The real replacement remains
available through **Create isolated Atlas**.

### Limits and raw evidence

- The local database contained zero filter words matching a valid ASCII
  puffle name. Houdini accepted the candidate `Badword`. Name rejection,
  adoption error 441 and name correction were exercised with doubles.
- Room-specific cue routing and the overlay's animation calls passed the
  contract tests. The live run verified attention, card state and travel;
  individual real-agent animation frames were not visually identified.

Private evidence is under `.local/stage3-evidence/`, including the suite
logs, `native-igloo-list.jpg`, `live-projects.jpg`, `comet-permission.jpg`,
`town-attention.jpg`, `nova-changes.jpg`, `interrupted-terminal.jpg`,
`resumed-comet.jpg`, `after-live-retry.jpg`, `real-atlas-archive.jpg`,
`worktree-files.json`, `lighthouse-rule-result.jpg`,
`lighthouse-rule-{before,after}.json`, before/after source, process, player and migration
fingerprints, and the stack shutdown log. The test engines were stopped
cleanly, the publication emptied, and `./local/stop` preserved the volumes.

## Puffle Postcards playthrough — November 5, 2026

On merged `dev` (`afe6a58`), the [first-task guide](../docs/first-task.md) was exercised with a disposable Postcards repository, the dedicated `bridgecheck` visitor on Blizzard, and a real host Claude Code session. The capture used Chrome 156 on macOS 27.2, the original client through Ruffle, and a separate engine state directory.

- **In the game:** Registered Postcards and its puffle, Pip. Submitted the bug from Pip’s native task card, visited Town, and handled the task’s permission requests in the live terminal. The Changes panel showed the edit to `postcard.cjs`.
- **On disk:** An independent `node --test` run on Node 26.13.0 failed in the original repo and passed in Pip’s worktree (one test in each). The original checkout was clean. Pip removed `.toLowerCase()` from the implementation; the test file matched its original committed contents.
- **In the public recording:** The [edited GIF](../docs/assets/pip-fixes-a-postcard.gif) and [MP4](../docs/assets/pip-fixes-a-postcard.mp4) use frames from this playthrough. Idle time and private terminal details are omitted. This run covered one puffle and travel to Town; it did not test minigame rewards or multiple puffles in a single repo.

## Project adoption and puffle teams — November 6, 2026

Environment: macOS 27.2 on Apple Silicon (arm64), Node 26.13.0, Ruffle
nightly-2026-11-03 in the Claude desktop app's built-in browser, Claude Code
2.1.318, the running local stack, and this branch's working tree. The engine
ran with `CP_ENGINE_VISITOR=adoptcheck`, a private `CP_ENGINE_STATE_DIR` and
worktree root, and two disposable repositories (`calc-app`, `notes-app`).
`player`, `bridgecheck` and the default engine state were not used or changed.
Raw notes stay under ignored `.local/`.

**Adoption through the original Pet Shop (agent page, 8081).**

- The derived module showed the destination picker over the pen ("calc-app,
  1 of 10 puffles"), then the original catalog, naming (`Rex` accepted by the
  server's name check) and certificate.
- A 400-coin green puffle (Moss) and the 800-coin Blue Border Collie (Rex) were
  adopted into `calc-app`. Adopt was clicked twice for each; each purchase stored
  one receipt and charged once (10000 → 9600 → 8800). The pen showed the new
  balance in the same session without a relog.
- The certificate read "Rex is waiting for you in calc-app." **OK** travelled to
  the igloo, where both puffles were mapped (overlay generation 2). The card's
  **In this igloo** list showed Moss and Rex; selecting a row switched the card.
- The database showed both puffles indoors on the `calc-app` owner, none on
  `adoptcheck`, and the two receipts. Both workers were bound, with ready
  worktrees, and no reservation remained in `published.json`.

**One charge under failure.**

- Replay: sending Rex's adoption ID again after binding was refused with
  `unknown-adoption`; coins were unchanged.
- Closing mid-purchase: a reservation for `notes-app` was sent twice through the
  real transport and the page was reloaded before the reply was handled. One
  receipt, one puffle (Snowy) and one 400-coin charge resulted. The engine still
  showed the reservation; **reconcile** bound it from the stored receipt and
  created its worker.

**Capacity.** Nine more adoptions filled `notes-app` to 10 puffles. The 11th was
refused by the engine ("This igloo already has 10 puffles.") before any
reservation or charge. Totals: 12 receipts, 5,200 coins charged, 10000 → 4800.
Back-to-back reservations wait while the previous puffle's worktree is set up
("busy with setup or another adoption"), as designed.

**Ordinary page (8080).** `/bridge/assets/puffle_adoption.swf` returns 404 on
8080 and 200 on 8081. Signed in as `localcheck` on 8080, the Pet Shop loaded
the archived `/media/play/v2/client/puffle_adoption.swf` and showed the original
catalog without a destination picker. No purchase was made, to keep the
verifier's fixture unchanged. `./local/verify` passed; its puffle already
existed, so it did not repeat a native adoption.

**Two real Claude sessions in one igloo.** Moss and Rex started together in
`calc-app` with distinct session IDs and both reported **Needs you** for the
first-run folder trust prompt, which **Work (2)** listed as "Puffles that need
you." The trust prompt's highlighted default is **No, exit**; the first Enter
declined it and Claude exited, as Claude intends. After restarting and choosing
**Yes, I trust this folder**, both reported ready. A no-tool task to each ran
concurrently (working → ready for review); the terminals showed "My name is
Moss." and "My name is Rex."

**Session limits and reconnect.** With the defaults (3 per igloo, 6 overall),
starting four `notes-app` puffles launched three and showed the fourth as
"Queued (1 in line). 3 of 3 sessions in this igloo and 5 of 6 overall are
running." Stopping one launched the queued puffle. A page reload kept all five
sessions with exactly one host process each. All sessions were then stopped.

**Native card fixes found live.**

- In an igloo the card's X did nothing. A hit-test probe showed no AVM1 clip
  above it; the host's AS3 Like widget takes clicks across the stage's top-right
  corner (about x ≥ 600, y ≤ 165). The X moved to the main panel's corner and
  the roster rows start below that area; the X then closed the card.
- The card always showed the blue portrait. It now loads the archived icon for
  the puffle's color (Moss showed green; the Blue Dog uses the blue icon).
- Attention rows now carry each puffle's color.
- Screenshots of the hidden browser pane were sometimes stale; card state was
  confirmed through the overlay's callbacks rather than screenshots alone.

**Migration rehearsal.** Copies of two saved v2 states
(`.local/agent-engine-demo`, `.local/readme-preview/session-state`) migrated to
v3 with `--rehearsal` outside the checkout. Sessions, puffle bindings (4, 8, 9,
10) and task histories were kept; the backup matched the original bytes; a
second run changed nothing; the originals were unchanged.

**Automated checks.** Engine 113, web 48, overlay contract 22, client-bridge
Python 16 (including the generated-module invariants: 4,360 unpatched method
bodies unchanged, 5 hooked), host Python 32, Houdini container 13, launcher
syntax and `git diff --check` all passed. After the live run, the derived
module's purchase hook was changed to fail closed when the page glue is
unreachable; that rebuild passed the module invariants but was not re-run in
the browser.

## Adoption recovery and destination paging — November 6, 2026

Follow-up fixes on `project-adoption-teams`, based on `2ea12da`. This is a new
working-tree check, not a repeat of the earlier purchases or real-Claude run.

- Unknown purchase outcomes stay pending and recheck the same receipt every
  20 seconds. Timeout, lookup failure, generic server failure, and expired or
  missing records never claim no charge or automatically resend a purchase.
  Late replies resolve the operation, including during a lookup or after closing
  the module. Confirmed payment is independent of worker setup.
- The native picker pages through all 32 projects, five per page. Previous/Next,
  selection by project identity, list changes, and bounds within the 760×480
  stage have production-source regression coverage.
- **Check purchase** is available for both reserved and charged operations.
  The real browser/overlay test harness distinguishes a verified refusal before
  sending from an exception after dispatch; only the former cancels the unused
  reservation.

**Automated verification:** web 58, bridge/picker 28, and client-bridge Python 16
passed. The first web-server test attempt could not bind localhost in the
sandbox (`listen EPERM`); the permitted rerun passed. The bridge build passed
its deterministic-output and preservation checks: all 4,360 unrelated method
bodies remain unchanged and five original methods retain their verified hooks.
`git diff --check` passed. These checks use doubles for engine/game outcomes;
they do not establish a new paid adoption or simultaneous coding tasks.

**Ruffle browser check:** the rebuilt module ran in headless Chrome against the
local stack as `adoptcheck`, with an isolated engine state and no registered
projects. Page-only fixtures supplied 32 destinations and a pending purchase;
these were not real project registrations or purchases. The picker rendered
seven pages, selected destinations 9 and 32 by their IDs, reopened on the
selected destination's page, and disabled Next on the last page. The pending
recovery notice was fully readable over the original naming/purchase screen.
Screenshots and the test script remain ignored under `.local/adoption-review/`.

With the page adoption glue removed, an attempted native Adopt click stayed on
the naming screen. A database check confirmed `adoptcheck` still had 4,800 coins
and no owned puffles. Browser WebSocket instrumentation did not capture Ruffle's
worker game sockets, so this is UI/database evidence, not packet-level proof.
No real purchases or Claude sessions were created. The temporary engine stopped
and released its runtime and publication locks.

## Live adoption and puffle-team acceptance — November 6, 2026

Tested commit: `c4e1a7c` on `dev` (PR #11 merge; `main` at `46f2896` has the
same tree), rebuilt overlay and derived Pet Shop module (`adoption-build.json`
output SHA-256 `2acafec3…`). Apple Silicon macOS 27.2, Node 26.13.0, Claude
Code 2.1.318 in manual permission mode. The engine ran as `adoptcheck` with a
dedicated `CP_ENGINE_STATE_DIR`/`CP_ENGINE_WORKTREE_ROOT` and the throwaway
`calc-app` and `notes-app` repositories from the earlier entry. Browser checks
used the Claude desktop browser pane, which was hidden for most of the run:
screenshots lagged, so state was confirmed through overlay callbacks, the engine
snapshot and the database.

Each item is labelled **real** (actual purchase, actual Claude task, actual
process failure) or **simulated** (a condition the operator induced or a fixture
written by hand).

**Two real coding tasks at once in one igloo (real).** Moss and Rex resumed
their saved `calc-app` sessions (`238b09d5…`, `a57d8a1c…`). Moss was asked to fix
`add()` (`return a - b`); Rex to add a Usage section to `README.md`. Both
reached their own edit permission prompts at the same time, each showing only
its own file. Rex was stopped at its prompt (status **interrupted**, process
gone) while Moss stayed live; one **Yes** (not the auto-accept option) let Moss
finish. Rex was then resumed on the same session ID, redid the edit and got one
**Yes**. The `diff` action returned only `calc.py` for Moss and only `README.md`
for Rex, on separate branches with base `572531f`. In Moss's worktree
`add(2, 3)` returned 5; the source checkout and Rex's worktree kept
`return a - b`. No `.claude/` settings were written to the source repository.

**Drafts (real UI).** In the `calc-app` igloo the native card showed Moss's
green portrait and the two-puffle roster. Different unsent drafts were typed for
Moss and Rex, then the roster was switched Moss → Rex → Moss → Rex quickly; each
puffle's text came back unchanged.

**Overall session cap and restart resume (real; cap lowered).** The engine was
stopped normally (both locks released, no Claude processes left) and restarted
with `CP_ENGINE_SESSIONS=4` so the overall limit binds before the per-igloo
limit. Moss and Rex resumed their exact session IDs; Snowy and Ash started in
`notes-app`; Berry queued with "2 of 3 sessions in this igloo and 4 of 4 overall
are running". Stopping Snowy started Berry. Asked without tools, Moss correctly
described its earlier `calc.py` change. The default cap of six was not filled.
The notes-app sessions were stopped at their first-run trust prompts.

**Lost reply (real purchase, simulated loss).** Through the page adoption
controller (the calls the Pet Shop module makes), Pebble (pink, 400) was bought
for `calc-app` with the overlay's `adoption-result` event dropped in the page.
The world server charged once (4,800 → 4,400, puffle 25). The page stayed
pending for 20 seconds, then resolved **done** from the stored receipt at the
first recheck. The engine bound Pebble with a ready worktree. This run did not
drive the native catalog UI for this purchase.

**Engine crash after the debit (real purchase, real SIGKILL).** Quartz (black,
400) was bought the same way with the reply dropped, and the engine was killed
with `kill -9` right after the world reply, before any report or recheck. The
database had the charge (4,400 → 4,000), puffle 26 and the receipt; the engine
state still had the adoption as `reserved` with no worker. No orphaned Claude
processes remained. Restart refused the stale `runtime.lock`, as designed; after
confirming the PID was gone, `runtime.lock` and
`.local/native-igloos/owner.lock` were removed by hand. Startup reconcile then
bound Quartz to the reserved worker ID with a ready worktree.

The kill also dropped the agent page's game connection, which runs through the
engine on 8081. A purchase attempted before relogging (Ruby) stayed pending
with "not confirmed yet"; the world log showed the disconnect and the database
showed no charge. The open reservation was cancelled by hand after that check.
The page keeps an unknown outcome pending even after the reservation expires,
when the server would refuse it anyway (see gaps).

**Setup failure after purchase, then Retry (real purchase, simulated cause).**
A config-defined hook (`hook.cpcheck.command`) was added to the throwaway
`calc-app` repository. Ruby (red, 400) was bought after relogging: charged once
(4,000 → 3,600, puffle 27) and bound, and its worktree setup failed with the Git
policy message naming the hook, marked retryable. After the hook was removed,
**Retry** (`retryWorker`) built the worktree from `572531f`. One receipt and one
charge.

**Server-side full-igloo refusal (real handler, simulated reservation).** With
the engine stopped, `published.json` was hand-written to list the full
`notes-app` igloo (owner 117, 10 indoor puffles) and a fresh reservation, which
the engine itself would refuse. A protocol client built on `verify_game.py`
logged in as `adoptcheck` and sent `p#cpadopt`. Houdini replied `error 440`;
coins (3,600), owner 117's puffles (10) and receipts (15) were unchanged. The
publication was restored afterwards.

**Ordinary adoption on 8080 (real).** A disposable fixture account,
`nativecheck` (id 118, fixture-marked email), was created through
`game_accounts.ensure_fixture_account`. Signed in on `localhost:8080`, it went
through the new-player tour, entered the Pet Shop and adopted Nimbus (blue) from
the original catalog, with no destination picker; naming showed the server's
check mark and the original certificate appeared. The database showed 10,000 →
9,600 and puffle 28 on `nativecheck` itself, with no project receipt.

**Totals and untouched accounts.** `adoptcheck` 4,800 → 3,600 (three purchases);
receipts 12 → 15; `calc-app` owner now has 5 puffles. `player` (99,580),
`localcheck` (9,580, one puffle) and `bridgecheck` (10,000) were unchanged. At
the end the engine was stopped with no locks left. The throwaway repository had
no changes and no hooks, and the game stack was stopped with `./local/stop`.

**Remaining gaps from this run.**

- The default overall cap of six was not filled; the queue was checked at four.
- The lost-reply, crash and setup-failure purchases used the page adoption
  controller, not clicks through the native catalog; the native catalog flow was
  checked in the earlier entry and on 8080 here.
- An unknown outcome stays pending after its reservation has expired, although
  the server refuses an expired reservation. A purchase sent while the game
  connection was down therefore needed a manual database check and cancel.
- Restarting the engine drops the 8081 game session; the player must reload and
  log in again.
- No code changed in this run, so no automated suites were rerun.

**Follow-up fix (automated coverage only).** After this run the engine settles
an adoption as `not-charged` when a receipt lookup that started at least two
minutes after the reservation expired finds no receipt. The world server
refuses expired reservations, so no charge can follow. The page then ends the
purchase with "nothing was charged" and allows another adoption. A purchase the
game reported as charged is never settled this way, and a receipt still wins.
Engine 114, web 59 and bridge contract 28 tests passed, including new
regressions for the margin, a lookup that starts inside it, persistence across
a restart, the reported-charge exclusion and a late receipt. This was not
rechecked live in the browser.

*Superseded later the same day.* Review showed the margin did not prove that no
charge could follow: the handler checked expiry before waiting for the visitor
lock, so a purchase delayed on that lock could still commit after an empty
lookup. This was reproduced against PostgreSQL with the handler at `215a771`.
The timeout settlement was replaced by a settlement committed in the game
database; see the
[next entry](#database-confirmed-adoption-settlement--november-6-2026).

## Database-confirmed adoption settlement — November 6, 2026

Tested revision: `cdbc734` on `live-adoption-acceptance` (PR #13), the
implementation commit before this record. Apple Silicon macOS 27.2, Node
26.13.0, PostgreSQL 16 (`postgres:16-alpine`), Houdini image with Python 3.11
and asyncpg 0.32.0. Live checks used the `adoptcheck` visitor, its dedicated
`CP_ENGINE_STATE_DIR`/`CP_ENGINE_WORKTREE_ROOT` and the throwaway `calc-app`
repository from the previous entry, in the Claude desktop browser pane (hidden
for most of the run, so state was also read from the page controller, engine
state and database).

**What changed.** "Not charged" is now decided only by a settlement committed
in the game database (`project_adoption.settle`), which takes the visitor's row
lock, the same lock a purchase takes first. A purchase that acquires the lock
after a settlement is refused (`settled`), and it rechecks expiry with
`clock_timestamp()` after its lock waits. The engine no longer infers anything
from an empty lookup or elapsed time. See the
[engine guide](AGENT_ENGINE.md#adoption-into-a-project-igloo).

**Real PostgreSQL concurrency tests (automated, real database).**
`./local/adoption-db-check` ran `local/test_adoption_postgres.py` in the
Houdini image against a throwaway PostgreSQL 16 container loaded with the
vendored `houdini.sql`, on an internal Docker network; each test cloned its own
database. Purchases and settlements ran on separate connections, ordered behind
a third connection holding the visitor lock and confirmed waiting through
`pg_stat_activity`. All 12 passed, each asserting coins, owner puffles, receipts
and settlements:

- settlement queued first, purchase sent before expiry: settlement commits,
  the waiting purchase is refused `settled`, nothing charged;
- purchase queued first: it commits, and the waiting settlement returns its
  receipt (even before expiry);
- the counterexample: a purchase sent before expiry and held on the lock until
  2 seconds after it, with an empty receipt lookup during the wait, is refused
  `expired`; the settlement queued behind it then commits;
- expiry while waiting for the owner lock: refused `expired`;
- settlement of an open reservation writes nothing; repeats return the same
  row; other identities get `conflict`, an unknown visitor `unknown-visitor`;
- a committed settlement whose response is discarded: the retry returns the
  same row and a later purchase with a fresh expiry is refused `settled`;
- a settlement whose backend is terminated while waiting writes nothing; the
  retry settles;
- a purchase that fails after its debit (foreign-key violation) rolls back
  completely and then settles as not charged;
- an uncontended purchase charges once, and its replay returns the receipt;
- fresh install records version 2 (concurrently from two connections and
  repeated); a version 1 database with a receipt and puffle upgrades in place
  with every row, account count and balance unchanged; version 3 is refused
  before any DDL.

The same counterexample script against the previous handler (`215a771`) in
the same setup charged 400 coins and created the puffle after the lock was
released, although the receipt lookup during the wait was empty.

**Live schema upgrade (real).** `./local/start` restarted the world server
with the new handler, which upgraded the persistent game database from version
1 to 2 at boot. The 15 existing receipts and every checked balance (`player`
99,580, `localcheck` 9,580, `bridgecheck` 10,000, `nativecheck` 9,600,
`adoptcheck` 3,600) were unchanged. When the engine started, it settled the two
cancelled reservations from the previous entry (Moss and the first Ruby, no
receipts) through the provisioning service.

**Expired purchase stalled on the lock, in the browser (real purchase,
simulated stall).** Through the native Pet Shop picker and catalog on 8081,
`adoptcheck` chose `calc-app` and named a blue puffle Locky. Before **Adopt**,
a separate `psql` session locked `adoptcheck`'s penguin row and slept for 720
seconds (03:32:33–03:44:33 UTC). The reservation (`15ec768f…`) expired at
03:42:43. `pg_stat_activity` showed the world server's purchase transaction
waiting on `SELECT coins … FOR UPDATE`. The page showed "Your purchase is not
confirmed yet…" and stayed pending. The lock was released at 03:44:32.981; the
engine's settlement committed at 03:44:32.991. Which of the two queued
transactions took the lock first was not captured. The database showed no
receipt, no new puffle and 3,600 coins. The engine recorded `not-charged` from
the database settlement, and the page ended the purchase with "That adoption
did not go through, and nothing was charged. You can adopt again." The game
connection had dropped by then: Houdini handles one client's packets in order,
so the client went unanswered for the whole stall (world log disconnect at
03:44:32.989).

**The settled ID cannot charge afterwards (real handler, simulated
reservation).** With the engine stopped, `published.json` was hand-written to
list `15ec768f…` for owner 116 with an expiry an hour ahead, so the handler's
publication check passed. A `verify_game.py`-based client logged in as
`adoptcheck` and sent `p#cpadopt` with that ID. Houdini replied `error
settled`; coins (3,600), receipts and owner 116's puffles (5) were unchanged.
The empty publication was restored.

**A fresh adoption succeeds once (real).** After restarting the engine and
logging in again, `adoptcheck` adopted a green puffle, Fresh, into `calc-app`
through the native picker and catalog. The certificate appeared, the page
reported `done`, and the database showed one receipt (`6545fadb…`, puffle 29),
3,600 → 3,200 coins and owner 116 with 6 puffles. The engine bound Fresh with a
ready worktree.

**Automated suites at `cdbc734`.** Engine 116, web 60, bridge contract 28,
client-bridge Python 16, Python host suites 36 (provisioning, native igloos,
adoption with an in-memory fake), Houdini container regressions 13, real
PostgreSQL 12; launcher syntax and `git diff --check` clean. CI adds a Linux job
that runs the PostgreSQL suite against a service container.

**Totals.** `adoptcheck` 3,600 → 3,200 (one purchase); receipts 15 → 16;
settlements 0 → 3 (two earlier cancelled reservations and Locky). `player`,
`localcheck`, `bridgecheck` and `nativecheck` were unchanged.

**Remaining gaps.**

- The live stall showed the database outcome and the page result, not the
  order in which the queued purchase and settlement took the lock; both orders
  are covered by the PostgreSQL tests.
- An agent page whose purchase is stalled on a database lock loses its game
  connection; the player must reload and log in again.
- The engine's settlement relies on the provisioning service, so each check
  starts a container (a few seconds). The engine's clock decides only when to
  ask; a database that still considers the reservation open leaves it pending.
- The default overall cap of six has still not been filled live, and the
  earlier recovery purchases were not repeated through native catalog clicks.
- `CREATE TABLE IF NOT EXISTS` would accept an unrelated relation already named
  `claude_penguin_adoption_settlement`; no such object exists in the vendored
  schema.

## Setup doctor, on-demand overlay build and Wand cleanup — November 8, 2026

Tested revision: `d63d37b` on branch `first-run-usability`, Apple Silicon macOS
27.2, Python 3.9.6, Node 26.13.0, Git 2.54.0, Homebrew OpenJDK 27.0.1, Claude
Code 2.1.318. No Claude session was started and no account was changed.

**Automated (fake host).** `python3 -m unittest local/test_doctor.py`: 15 passed.
They cover a ready Mac in both modes, a missing tool with its fix, puffle problems
staying optional without `--agents`, old Node and Git, the Homebrew JDK chosen over
the macOS `javac` stub, a game port held by another program, the running game
owning its ports, the first-start disk warning, a missing and a stale overlay, a
stale lock reported and left in place, a live lock, `CP_ENGINE_STATE_DIR`,
`CP_CLAUDE_PATH`, non-macOS and old/Intel macOS, and plain output without UTF-8.
The other Python host suites (provisioning, native igloos, adoption) passed
unchanged, 36 tests; launcher syntax (now including `local/doctor`) and
`git diff --check` were clean.

**On this Mac (real).**

- `./local/doctor` with the stack stopped: every island and puffle check passed;
  the VM, game and engine were reported as not running; exit 0.
- `./local/start` after removing Wand's root files: the stack built and passed its
  health waits, and the seed step left existing accounts unchanged. `./local/doctor`
  then reported the VM running and the game up.
- `./local/agent-start` with the overlay current skipped the build. With both build
  records removed it ran `build.py`, and `engine.swf` and `puffle_adoption.swf`
  came out byte-identical to the previous build (about 6 seconds with the compiler
  already cached). With `BRIDGE_JAVA_HOME=/nonexistent` it stopped after the failed
  build with a pointer to `./local/doctor --agents`. The first two runs used a
  stopped game and so ended at the expected port 8080 readiness error.
- With the game up, `agent-start` under `CP_ENGINE_VISITOR=adoptcheck` and a fresh
  temporary `CP_ENGINE_STATE_DIR` reached its ready line; `./local/doctor --agents`
  showed the runtime and publication locks held by that process. Ctrl+C released
  both locks; `./local/stop` stopped the stack and the temporary state was deleted.

**Not checked.** A first build on a Mac that has never downloaded JPEXS (the
compiler was already cached), the doctor on an Intel Mac or a Mac without
Homebrew, a real port conflict (covered only by the fake host), and the agent page
in a browser after the on-demand build. Doctor does not check Claude sign-in.

## Claude Penguin homepage — November 8, 2026

The English landing page now uses project-owned generated igloo artwork,
Claude Penguin branding, project navigation, and separate links for ordinary
play and the opt-in coding engine. The archived client scripts and callbacks
are byte-for-byte unchanged. The media submodule was not edited. Other locale
landing pages retain their archived presentation.

Validation on the local macOS checkout, with only the web container rebuilt:

- `npm test --prefix local/web`: all 60 tests passed. The first sandboxed attempt
  could not bind the test HTTP server (`listen EPERM`); the loopback-enabled run
  passed.
- `npm run verify:http --prefix local/web`: 96 HTTP checks and four socket
  checks passed, with no required or inventory HTTP failures.
- Temporary local servers confirmed that both new assets return HTTP 200 with
  the correct MIME types, ordinary play links to the engine on port 8081, and
  engine mode retains a custom configured origin. The login hash retains the
  current query string.
- In-app browser: inspected desktop, 909 × 1127, and 390 × 844 landing layouts.
  The artwork loaded and the narrow landing page had no horizontal overflow.
  Clicking **Play the island** removed the landing sections and rendered the
  original Ruffle login form. No account was signed in or modified.
- `git diff --check` passed.

This checks the homepage and login transition, not a new gameplay or Claude
acceptance run. **Code with puffles** still requires the separately started host
engine; a live engine session and non-English layouts were not exercised here.
The image generation prompt and asset provenance are in `web/home/README.md`.

## Browser playthrough: minigame, igloo, puffle care and relogin — November 8, 2026

Revision `de3509f` (the stack was started from `7cf42bf`; only the web container
was rebuilt to `de3509f` by the concurrent homepage work). Chromium-based in-app
browser at 1100 × 780, Ruffle `nightly-2026-11-03`, Apple Silicon macOS 27.2. Account:
`localcheck`, the dedicated verification account. The other accounts' coins were
compared before and after and did not change. No Claude session ran.

| Check | Browser result | Database result |
| --- | --- | --- |
| Thin Ice (Dance Lounge arcade) | Level 1 solved for 36 points; closing the game showed "Coins earned: 3", total 9,583 | coins 9,580 → 9,583 |
| Igloo furniture | Editor opened; potted plant (790) dragged from the inventory onto the floor; Table for Two (2166) dragged to a new spot; closing the editor saved | `igloo_furniture`: 790 at (310, 287), 2166 moved from (400, 280) to (513, 339) |
| Puffle care | Clicking the puffle opened its care menu, then the care screen and Rory's tutorial; the Apple was dragged onto the puffle and left the tray | Apple (79) removed; food 82 → 100, play 100 → 95, rest 82 → 77, clean 100 (the Apple's +50/−5/−5/0) |
| Log off and back on | Page **Log off**, then a fresh login; the igloo showed the plant, the moved table and the puffle; the player card showed 9,583 coins | unchanged from the rows above |

**Input notes.** Ruffle reads Thin Ice's arrow keys and the igloo/puffle-care drags
from held input. Instant synthetic key presses and the browser tool's one-step drag
were not seen by the game, so moves and drags were sent as held key events and
multi-step pointer events from the page. This is an automation limit; a person's
mouse and keyboard produce held input. The earlier note that a placement "did not
remain" (November 3) is consistent with the same limit.

**Found along the way.**

- Two disconnects ("The connection has been lost", error 10004) happened while
  another agent rebuilt the web container in the same checkout; the web service
  carries the game socket. Neither the world log nor its error log recorded a
  server fault, and a later two-and-a-half-minute idle session stayed connected.
- `localcheck` has not finished the introductory tour, so the map loads
  `intro_to_cp_quest_map.swf`, and clicks on Town did not travel. Whether that is
  the quest mode or the concurrent rebuilds was not separated.
- The client posts to `http://localhost/web-service/membership` (port 80, not 8080),
  which is refused. Its source and effect were not traced.

**Not checked.** Other minigames, Card-Jitsu Snow, puffle play/clean/rest/dress,
catalog purchases, the ordinary `player` account, and Safari.

## macOS app prototype — November 8, 2026

This records an internal build on branch `macos-app`, made on this Mac: macOS 27.2, Apple Silicon, Xcode 27.2. The build covers four parts:

- the shared controller and `./launch`;
- the native runtimes and servers;
- the verified-download installer;
- the extension patcher, engine app mode, and the SwiftUI/WKWebView app.

Nothing was signed with a Developer ID or notarized, and no clean Mac was used. Gate 0 decisions, covering media hosting, Claude Code terms, the name and updates, remain the owner's.

**Offline suites**

| Suite | Result |
| --- | --- |
| engine | 133 passed |
| web | 68 passed |
| client-bridge (Node) | 41 passed |
| client-bridge (Python) | 29 passed |
| controller | 43 passed |
| native | 10 passed |
| installer | 42 passed |
| Python host suites | 62 passed |
| `swift test` | 28 passed |

Launcher and script syntax checks and `git diff --check` passed. One controller test, "a service that dies while running", failed once under load in seven full runs and passed when rerun alone.

**Compose regression.** `./local/start` succeeded, then `./local/verify` passed. `npm run verify:http` ran 96 HTTP checks and 4 socket checks with no failures. The Houdini container regression ran 13 tests, all OK. `servers.xml` still renders the world port as 9875. The stack was stopped afterwards.

**Native runtime with `./launch`** (data in `.local/launch/`)

- `setup --mode explore` then `start`: all seven servers came up. Every listening socket, and every connection between them, was on 127.0.0.1.
- `setup --mode code`: installed and verified Claude 2.1.311, with the app's own empty `CLAUDE_CONFIG_DIR`. Claude never signed in. The engine then started in app mode:
  - it captured the login-shell environment with no warnings;
  - it found Git at `/Applications/Xcode.app/Contents/Developer/usr/bin/git` (`user`);
  - it reported the sign-in method as `login`.
- Registering a disposable repository, whose path contained a space, provisioned a managed owner (penguin 105) through the native provisioning runner, and verified the world session.
- Startup took about 4 s after setup. The resident memory of the 17 runtime processes totaled about 815 MiB. `.local/runtimes` is 462 MiB.

**Crash checks**, all on `./launch` and the real services:

| Action | Result |
| --- | --- |
| SIGKILL of the controller | All 16 managed processes exited in about 1.5 s. |
| SIGKILL of Valkey's shim, then of the controller | Valkey survived. The next launch identified it by record (PID, start time, executable) and stopped it before starting. |
| SIGKILL of the engine | Reported as `SERVICE_FAILED`. The next start removed the engine's `runtime.lock` and the publication `owner.lock` only after confirming that this app had launched that engine PID and that its process group was empty. |
| A clean stop | No ownership records left. |

Accounts, the managed owner and engine state persisted across every restart.

These checks found five defects, all fixed before this record:

- Valkey rewrites its process title, so its identity is now read with `proc_pidpath`.
- One stale record could remain after a clean stop.
- Stale engine locks blocked restart.
- `verifyClaude` was missing the app's config directory.
- The home page's puffle link was hardcoded to port 8081.

**The app bundle** (`macos/scripts/build-app.sh`, ad-hoc signed, 515 MiB)

- 155 nested Mach-O files were signed, and `codesign --verify --deep --strict` passed.
- It was launched against a scratch data folder whose path contains a space, with `CP_MEDIA_DIR` set to the checkout's media.
- **Explore:** welcome, preflight, setup, starting and the game page.
- **Code:** the puffle page loaded at `http://localhost:47081/?bridge=1&agents=1#/login`, app mode reported, and the host bridge was present.
- **Shutdown:** Quit stopped every service. Force-killing the app made the controller see stdin close and stop all 15 managed processes within about 1.5 s.

**Not verified**

- The screen was locked, so WebKit reported the page hidden. Ruffle loaded `club_penguin.swf` and then waited, with its unmute overlay showing. Whether the client renders and plays audio in the visible app window without a click, as well as login, room travel, Pet Shop adoption and the terminal, is untested.
- `takeSnapshot` cannot capture Ruffle's WebGL canvas.
- A real Claude session in app mode needs the owner's `/login`.
- Not done:
  - Developer ID signing under the hardened runtime, and notarization;
  - a clean Mac, or a downloaded, quarantined DMG;
  - sleep and wake;
  - an interrupted media download, since no media host exists;
  - an Explore-to-Code switch in the app UI, which is not implemented.

## macOS app prototype: lifecycle and packaging fixes — November 8, 2026

A later run the same day, on the same Mac and branch. A review found four defects in the prototype recorded above and three smaller ones, and each was confirmed in the code before it was fixed. That record is unchanged; this one covers the fixes.

| Defect | Fix |
| --- | --- |
| `cp-supervise` was built for the build Mac's macOS (`minos 27.2`), though the app requires macOS 26. It was the only bundled Mach-O file that needed a newer macOS than 26. | `build-supervise.sh` targets macOS 26.0. `build-app.sh` now runs `check-min-os.sh 26.0` over every Mach-O file in the bundle before signing, and a controller test checks the shim's minimum. |
| Claude's terminal has its own session (node-pty), so a killed engine's supervisor could not reach it. A Claude that ignored SIGHUP would survive. | In the app the engine starts Claude through `cp-supervise guard` (`CP_ENGINE_PTY_GUARD`). Claude is exec'd in place with the same PID and terminal. A detached watcher stops Claude's process group when the engine exits. |
| `provision-env.json`, which holds the absolute runtime path for Python, was written only during setup, so a moved app would provision through its old location. | It is rewritten before every engine start (`writeProvisionEnv`). |
| The controller removed a service's ownership record on any numeric exit code, including the shim's 70 for "process group did not exit". | A record is removed only when the shim exited on its own and the group is empty. Otherwise it is kept and `stop` reports the service as not stopped. |
| An installed Git older than the engine's minimum (2.48) was still chosen over the bundled Git, and then the engine refused to start. | `findUserGit` skips a Git older than 2.48, so the bundled Git is used. |
| The setup check for the extensions only tested that `engine.swf` existed. Reinstalling the same set also ignored a damaged `patchset.json`. | `verifyInstalledPatchSet` checks both SWFs, their records and the manifest. Setup uses it. |
| The copied resume command lacked `DISABLE_UPDATES=1`. | Added. |

**Offline suites** (Node 26.13.0; the controller, installer and engine suites also under Node 22.23.4, the version CI uses):

| Suite | Result |
| --- | --- |
| engine | 134 passed |
| web | 68 passed |
| client-bridge (Node) | 42 passed |
| client-bridge (Python) | 29 passed |
| controller | 51 passed |
| native | 10 passed |
| native adapters (Python) | 11 passed |
| installer | 42 passed |

The record above gave the native suite as 10 tests. It had 9; this run added one. Launcher and script syntax checks and `git diff --check` passed. The Swift sources did not change, and `swift test` was not rerun.

**Checks on this Mac**

- `cp-supervise guard` in real node-pty terminals, with stand-in programs:
  - the exit status and output came through, and the terminal closed 113 ms after exit;
  - typed input reached the program;
  - when the owner was SIGKILLed, a program ignoring SIGHUP and SIGTERM, and its child, were gone after 507 ms (a 500 ms grace);
  - no watcher remained afterwards.
- The real Claude 2.1.311 was started by the engine manager through `guard`:
  - it ran with fake game provisioning (no account or coins), a disposable repository and a scratch `CLAUDE_CONFIG_DIR`;
  - it was not signed in and was in manual permission mode;
  - Claude kept the PID the engine started, and stayed the terminal's foreground group;
  - after a SIGKILL of the engine, Claude and the watcher were gone within 499 ms, and Claude's group was empty.

  Without the guard, the same Claude also exited, 407 ms after the hangup. So Claude 2.1.311 at its first-run screen already exits on a terminal hangup. The guard covers a Claude that does not, and processes left in its group.
- `./launch start --mode code` on the built runtimes:
  - `verifyInstalledPatchSet` accepted the installed set `ps-ae39499484a07eb8`;
  - `provision-env.json` was rewritten;
  - the engine received `CP_ENGINE_PTY_GUARD`;
  - every listener was on 127.0.0.1.

  `./launch stop` left no ownership records and no runtime processes.
- `check-min-os.sh 26.0` over `.local/runtimes` and the app executable passed (154 Mach-O files). Over the bundle built earlier, it failed on the old `cp-supervise` alone. The bundle was not rebuilt.

**Not verified:**

- a signed-in Claude in the middle of a task when the engine dies, and processes that Claude's tools move into other sessions;
- the rebuilt app bundle, which would now include the shim built for macOS 26;
- everything listed as not verified in the record above.

## macOS app prototype: rebuilt bundle — November 8, 2026

This entry covers the bundle rebuilt after the fixes above, at `b9ec7fb`. CI passed on that commit: Regression on ubuntu-24.04 and macos-15, and Adoption concurrency.

**Build.** `CP_HARDENED=1 macos/scripts/build-app.sh` produced a 515 MiB bundle:

- The signature is still ad-hoc, now with the hardened runtime and its entitlements. This is the closest local stand-in for the Developer ID build.
- `check-min-os.sh` passed during the build, and again when run on its own: all 156 Mach-O files run on macOS 26.0.
- The packaged `cp-supervise` targets 26.0 and has `guard`.
- `codesign --verify --deep --strict` passed, and all 156 Mach-O files carry the hardened-runtime flag.
- Entitlements:
  - node has `allow-jit` and `disable-library-validation`, the local-test set;
  - the app has none.
- Gatekeeper (`spctl`) rejects the bundle, as expected for an ad-hoc signature.
- The bundle contains no media from the submodule. `templates/vanilla-media/` holds only the project's five tracked page templates.

**Running it.** The app was opened in code mode on a fresh scratch data folder (path with a space) with `CP_MEDIA_DIR`:

- Setup completed in about 20 s:
  - the database was created;
  - the extensions were built from the patches (`ps-ae39499484a07eb8`);
  - Claude 2.1.311 was installed and verified.
- All 18 processes ran from the bundle under the hardened runtime: the app, three node, four python3, postgres, valkey-server and eight cp-supervise.
- All eight ports listened on 127.0.0.1 only.
- In the web view, Ruffle 0.8.0-nightly.2026.11.3 started (wgpu-webgl) and loaded `club_penguin.swf`. The puffle page returned 200.
- Against the app's own servers, using the scratch database's disposable accounts:
  - `verify_game.py --login-port 47112 --world-port 47875` passed all 12 protocol checks: login, Town Center to Pet Shop, movement, purchase, adoption, igloo, puffle care and walking, furniture, and persistence after a fresh login;
  - `verify-http.mjs` with `PUBLIC_ORIGIN=http://localhost:47080` ran 96 HTTP checks and 4 socket checks with no failures.
- Quitting through a standard quit event stopped every service and left no ownership records or listeners.

**Not verified.** The screen was locked and the owner was away. In the visible window, rendering, audio, login, room travel, adoption and terminal input are still untested. Protocol and HTTP checks do not establish interactive gameplay. The Developer ID signing, notarization, clean-Mac and signed-in Claude gates are unchanged.

**In the app window**, later the same evening. The owner was at the Mac. The same bundle was reopened on the same scratch data, and full-screen control sent real keystrokes. Each step below was seen in the window:

- **Rendering.** Ruffle drew the game inside the puffle page: the login screen, the loading animation, the server list, then the Dock, Plaza, Puffle Park and Town rooms. The page overlay ("Your Igloos", "Work") and the extension's in-game "Work" and "Igloos" buttons from the patched `engine.swf` drew over it.
- **Login.** `localcheck` and then `bridgecheck` (the scratch database's visitor) logged in and joined Blizzard. A new account gets the intro tour, which was clicked through.
- **Room travel.** The map and the doors moved the penguin through the rooms above and into the Pet Shop.
- **Adoption.** The project was added from "Your Igloos" with a disposable repository whose path contains a space; its igloo appeared as "Ready". In the Pet Shop, the patched adoption module asked which igloo the puffle would join. A blue puffle named Waddle was adopted for 400 of the scratch account's coins. The game then showed "Waddle is waiting for you in Puffle Check" and entered the project igloo.
- **Terminal.**
  - Start / Resume launched Claude Code v2.1.311 through `cp-supervise guard`, in the app's scratch configuration.
  - "Open Claude" showed its first-run theme picker in the game's terminal.
  - A real Down key moved the selection. The panel then reported that Claude needed a response.
  - Testing stopped there, before any sign-in.
  - Stop session ended the process, and no Claude or guard process remained.
- Quitting stopped every service and left no ownership records or listeners.

Notes:

- The game's Settings showed music unmuted, and Ruffle never showed its unmute overlay. Whether sound actually played was not checked by ear.
- Keystrokes sent to the window while it was in the background lost characters, both in the HTML form and in the game. Real keystrokes with the app in front lost none. The losses are attributed to the background input method, not the app.
- The browser console showed only the archived client's known messages: a 405 for its `/datatech/serverlog` telemetry, and a missing `AS2loadingScreen` symbol.

Still open: audio by ear, Developer ID signing and notarization, a clean macOS 26 install, and a signed-in Claude task.

## macOS app: game media download and one setup path — November 8, 2026

Later the same evening, on the same Mac (macOS 27.2, Apple Silicon), branch `dev`, uncommitted at the time of these checks. Two changes:

- **Media source.** A fresh install had no way to get the game media. Launching the earlier bundle on an empty data folder, with no `CP_MEDIA_DIR`, stopped at "Before we begin" with Start Setup disabled: "No media source is configured (release.json has no media and CP_MEDIA_DIR is not set)." The owner chose the source the checkout already uses: the `vanilla-media` submodule's commit `e8666de19835faf61782358d52a3b41c9226a00a` on `git.solero.me`. `release.json` now pins it as a `source: "git"` manifest (commit, tree `0f18f38f74e02012f75330fcce148698a04bc1cb`, 86,642 files, 4,264,645,163 bytes installed), and `local/installer/media-git.mjs` fetches it with the bundled Git in resumable batches (see `local/installer/README.md`). `CP_MEDIA_DIR` still overrides it for development.
- **One setup path.** The welcome screen no longer offers Explore or Code. Get Started always sets up code mode; signing in to Claude still happens later, in a puffle's terminal. A data folder set up in explore mode by an earlier build gets the Claude step on its next launch.

Smaller fixes found on the way:

- A Cancel during an installer step (media or Claude) was reported as `SETUP_FAILED` with the message "aborted". It is now `CANCELLED`.
- The setup screen showed the installers' internal phase names (`download`, `verify`) as row titles. The controller now shows readable labels.
- Preflight reported the download size as unknown in code mode, because Claude Code's size was not in `release.json`. It is now (276,185,504 bytes).

**The host.** `git.solero.me` is a public GitLab. Its "download archive" endpoint answered `200` with no `Content-Length` and no `Accept-Ranges`, so an archive could not be resumed or pinned. Its Git endpoint advertised `fetch=shallow wait-for-done filter` over protocol v2. A shallow, blob-less fetch of the pinned commit took 1.4 s and produced the pinned tree; fetching one file (`README.md`) by its blob ID worked.

**Offline suites:**

| Suite | Result |
| --- | --- |
| installer (including 8 new `media-git` tests over `file://` repositories) | 50 passed |
| controller (3 new: the app layout downloads with the bundled Git and `CP_MEDIA_DIR` overrides it; Cancel during the media step; readable labels) | 54 passed |
| `swift build`, `swift test` | 28 passed |

`git diff --check` passed.

**Full size, from a local mirror.** The installer ran against a bare repository on this Mac that borrowed the submodule's objects (`file://`, no network): 38 batches, 86,642 files, 41 s in all (download 29 s, checkout 9 s). `diff -rq` against the checkout's `vanilla-media/` found no differences.

**Real download from `git.solero.me`.** `node local/installer/cli.mjs media --manifest <the release's media entry> --root <scratch> --git .local/runtimes/git/bin/git`, over this Mac's home connection:

- It finished in 401 s (6 min 41 s): the trees (2,430,975 bytes), then 76,129 distinct files in 39 batches, the offline checkout, the status check and the switch.
- Pack data downloaded in all: 3,879,653,694 bytes, about 9.7 MB/s on average. `release.json` `size` now records this total.
- The result held 86,642 files, 4.15 GiB on disk. `diff -rq` against the checkout's `vanilla-media/` found no differences.
- During the download the scratch root held the pack data and, at the end, the checked-out files too; the pack data was deleted before the rename.

**In the app.** The bundle was rebuilt with `CP_HARDENED=1 macos/scripts/build-app.sh` (ad-hoc signature with the hardened runtime, 517 MiB; `codesign --verify --deep --strict` passed). It was opened on a fresh scratch data folder, whose path contains a space, with no `CP_MEDIA_DIR`, and driven by `CP_APP_DEV_AUTOPILOT`:

- The welcome screen showed the single Get Started path. Preflight reported a 4.16 GB download, 8.42 GB of space needed, no problems, and Start Setup enabled.
- **Run 1, Cancel.** Cancel 45 s into setup, during the media download. Setup ended as `CANCELLED` ("Setup was cancelled; run setup again to resume."), the window went back to the welcome screen, 391 MB of fetched data stayed on disk, and no Git process remained.
- **Run 2, force-quit.** Setup resumed from 391 MB. A `kill -9` of the app 25 s into the download: the controller saw its stdin close, cancelled, and it and Git exited within a second. 656 MB were on disk.
- **Run 3, finish.** Setup resumed from 656 MB and finished: media, extensions, Claude Code 2.1.311, then the start in code mode. From launch to a serving puffle page took 5 min 41 s, 3,271,659,370 bytes of it downloaded in this run. Across the three runs about 47 MB were fetched twice: the batches in flight at the two interruptions.
- The media held 86,642 files, identical to the checkout (`diff -rq`). `setup.json` records the media step with `source: download` and version `e8666de19835`.
- All eight listeners were on 127.0.0.1. Against the app's own servers, with the scratch database's fixture accounts, `verify-http.mjs` (`PUBLIC_ORIGIN=http://localhost:47080`) ran 96 HTTP checks and 4 socket checks with no failures, and `verify_game.py --login-port 47112 --world-port 47875` passed all 12 protocol checks.
- Quitting stopped every process and left no listeners or ownership records.
- **Explore upgrade.** A scratch folder set up in explore mode by the bundle's controller (with `CP_MEDIA_DIR` set to the checkout's media) was opened in the app. It ran only the Claude step and served the puffle page in code mode after 13 s.
- **Welcome screen.** The first rebuild left a gap in the card (a `Spacer` stretched to the window's minimum height), and the button inside the card's material background rendered grey. Get Started now sits below the card and renders as the blue default button, as seen in the app's own snapshot.

**Not verified:**

- Nobody logged in or played in the app window during these runs. Protocol and HTTP checks do not establish interactive gameplay; the window checks recorded above were made on the previous bundle. The page console showed Ruffle's usual emulation warnings and the puffle panel polling `cpBridgeSnapshot` before any login.
- A slow or unreliable network. The retry path was exercised only with an unreachable `file://` source in the tests.
- A disk that fills during the download.
- A controller killed on its own while the app keeps running. Its Git fetch would be orphaned and run to the end of its batch; the next setup removes leftover temporary packs.
- Developer ID signing and notarization, a clean Mac or user account, and a signed-in Claude task, as before.
