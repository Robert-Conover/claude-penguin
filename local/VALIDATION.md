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
