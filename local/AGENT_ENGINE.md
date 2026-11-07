# Project igloos and Claude Code sessions

Each registered repository gets an igloo. You adopt its puffles at the Pet Shop:
up to 10 per igloo, each with its own persistent Git worktree, branch, and
independent Claude Code session on the host. The original client runs in Ruffle.
Game services stay in Docker. The optional agent page listens on loopback and
starts a puffle only when you choose **Start / Resume**.

## Start

Install Git 2.48+, Python 3.9+, Node 22+, npm, a JDK, and
[Claude Code](https://code.claude.com/docs/en/setup) on the host. Configure Claude
authentication through its normal host setup before asking the puffle to work.
The launcher does not log you in or request authentication.

Start the local game, build the overlay with a JDK, and launch the host engine.

```sh
./local/start
python3 local/client-bridge/build.py
./local/agent-start
```

The overlay build needs a JDK; see the [build instructions](client-bridge/README.md).
The engine provisions or verifies the marked visitor without logging in as it.
Use the visitor in one browser game tab at a time. Scripted verification uses
dedicated owners or `localcheck`.

`agent-start` checks the game configuration, generated overlay, Ruffle files, and
the baseline game's HTTP readiness. It installs locked dependencies with
`npm ci --ignore-scripts` if the engine or shared web dependencies are missing,
then runs the host server in the foreground. Keep that terminal open while
agents work. The launcher does not start a Claude session automatically.

After updating the client bridge source, rebuild with
`python3 local/client-bridge/build.py` and reload the game. The launcher checks
the overlay's source and output hashes so an older menu cannot be loaded silently.

Open [the agent page](http://localhost:8081/?bridge=1&agents=1#/login), log in as
`bridgecheck` with the disposable password `PenguinLocal2026!`, and choose
Blizzard. If fixture setup originally used a different
`CLUB_PENGUIN_TEST_PASSWORD`, use that password; rerunning setup does not reset it.
The ordinary [game page](http://localhost:8080/) and
[bridge simulation](http://localhost:8080/?bridge=1#/login) remain separate modes.

## Add and visit projects

1. Open **Igloos → Add project** and enter the repository path and project name.
   Setup prepares the project's igloo; the chooser shows its progress, retries and
   manual repair instructions. Registration supports up to 32 distinct repositories.
   Game acceptance creates permanent managed owner accounts. Project deletion is deferred.
2. Adopt puffles at the Pet Shop (Plaza). **Adopt a Puffle** first asks which
   project igloo the puffle joins, then shows the original catalog, naming and
   certificate. You pay with the visitor's own coins: 400 for the ten colors,
   800 for the Blue Dog or Orange Cat. Rainbow and Gold are not offered. **OK** on
   the certificate takes you to that igloo. Each adopted puffle gets its own
   worktree in the background; its row in **Igloos** shows that setup.
3. Travel using the original map's cluster of igloos or **Visit** in the chooser.
   Click a puffle to select it. The card's **In this igloo** list switches between
   the igloo's puffles. **Work** lists the puffles that need you, across igloos.
4. Choose **Start / Resume** and **Open Claude**. On first launch Claude asks
   whether you trust the new worktree folder; the highlighted answer is **No, exit**.
   Check the displayed path, then choose **Yes, I trust this folder**. Claude runs
   in manual permission mode. Answer tool requests in the terminal. Up to three
   puffles per igloo and six overall run at once; a further start waits in line,
   shows **Queued**, and launches when a session stops.
5. Enter a task in the native card, or use the browser task card when the game
   cannot display it. Each surface keeps drafts per worker for the current page.
   Close the card or visit Town while work runs. The Work badge counts workers
   waiting for input, failed turns and turns ready for review.
6. Open **Changes** to review agent commits and current edits from the immutable
   baseline. **Copy path** copies the worktree and **Copy branch** copies its
   current branch. The **Journal** tab shows the selected worker's task history.
   Verify task results yourself and stop the session before external Git operations.
7. A migrated project also has **View archive**, with its original folder, session
   ID, task history and copyable resume command. Choose **Create isolated Atlas**
   on its row to give it a new worktree and conversation on the existing game mapping.

The worker UUID and Claude session UUID persist. Initial launch uses
`--session-id`; once Claude confirms that session, later starts use that exact
`--resume` ID. A failed resume is reported and never creates a replacement
conversation. Do not use `/clear` or switch conversations inside this terminal:
an authenticated hook reporting a different session ID stops the owned process
and keeps the original puffle binding.

## Status and interruption

Working, permission requests, questions, API failures, and turn end come from
Claude lifecycle hooks. Output alone is not proof that the agent is working.
Startup without a session hook becomes **Needs you** so trust or setup prompts
remain visible. **Ready for review** means the turn ended; it does not establish
that the requested task succeeded or that a change is correct.

During an active turn, **Interrupt** on the native card, or **Interrupt turn**
in the terminal window, sends one Escape. It does nothing for an already idle or
ended turn. Escape is context-sensitive and may dismiss a prompt. The panel first reports an interrupt request; it reports **Interrupted**
when a subsequent terminal idle marker confirms Claude returned to input. Some
Claude versions or terminal configurations do not emit that marker. Until it
arrives, the native card stays **Needs your help** (the browser panel says
**Needs you**) and directs you to **Open Claude**.
The terminal view reports that cancellation is not confirmed; task submission
through the card remains disabled. Inspect the live terminal to retry, or stop
and resume the saved session. An unrelated idle marker
is never treated as task completion.

**Stop session** in the terminal window terminates the Claude process owned by
this engine. It preserves
the conversation identity for an explicit resume. It is distinct from closing
the panel, which leaves Claude running.

## Persistence and recovery

The default state directory is ignored `.local/agent-engine/`. It holds a private
state file, the runtime ownership lock, and observational hook settings. State
writes replace the file atomically with mode `0600`. Claude maintains its own
conversation history using its normal host configuration; the engine does not
copy provider credentials into the game, browser, or Docker containers.

Browser reconnect replays a bounded terminal screen and continues the existing
PTY. The replay buffer lives in memory. Restarting the engine cannot preserve
the old PTY or its in-memory screen; choose **Start / Resume** afterward to
continue the same saved Claude conversation. Previously unfinished task records
are marked interrupted rather than completed.

Press Ctrl+C in the foreground engine terminal for a normal shutdown. It stops
the Claude PTYs it owns and releases its runtime lock. The agent page's game
connection also runs through the engine, so after any engine restart reload
the page and log in again. `./local/stop` controls the
game containers and VM; stop the separate engine as well when shutting down the
whole experiment.

After a crash, the engine refuses to start another process if a saved engine or
worker PID may still be alive. It never kills an unowned PID, which could have
been reused by another program. Inspect the process and its command in Activity
Monitor or with `ps`, and stop the actual previous engine/Claude process if it is
still running. A stale `runtime.lock` also fails closed: after confirming the old
engine and its Claude processes have stopped, remove only that lock explicitly,
then restart. Automatic stale-lock deletion could race another startup. If a PID
has been reused, preserve a copy
of the state and resolve the stale ownership record explicitly; do not delete
the state directory as a routine restart fix. Invalid JSON or changed fixture
identity also fails closed so a saved session is not silently reassigned.

Optional host environment variables:

| Variable | Purpose |
| --- | --- |
| `CP_ENGINE_STATE_DIR` | Dedicated state directory; relative values resolve from the repository root. Changing it selects separate engine state, not an automatic migration. The multi-project engine compares canonical paths (case-insensitively on macOS) and refuses a folder inside one that is served over HTTP or mounted into the game containers: `vanilla-media/`, `templates/`, `local/`, the vendored server folders, `.local/bridge-public/`, `.local/ruffle/`, `.local/client-bridge/`, `.local/native-igloos/`, and `.local/logs/`. |
| `CP_ENGINE_PORT` | Loopback port, default `8081`. Use the URL printed by the launcher. |
| `CP_CLAUDE_PATH` | Claude executable path when `claude` is not on `PATH`. |
| `CP_ENGINE_WORKTREE_ROOT` | Absolute root for new puffle worktrees, default `~/.claude-penguin/worktrees`. |
| `CP_NATIVE_IGLOOS_DIR` | Native igloo publication directory, default `.local/native-igloos` (the directory the world service mounts). Change it only for tests. |
| `CP_ENGINE_GAME_PROVISIONING` | `off` disables game provisioning (setup then stops at `game-pending`). For engine-only development and tests. When the engine later starts with provisioning on, each `game-pending` project becomes a retryable failure, and **Retry** provisions it. |

The engine validates Host/Origin and uses separate browser and per-run hook
credentials. Game fixture IDs alone do not authorize terminal control. Logs and
raw test reports belong under ignored `.local/`; do not publish session tokens,
terminal output containing private data, or host credentials.

### Host API

The loopback [engine server](engine/server.mjs) exposes the following runtime
endpoints in addition to its UI assets. Requests must use the configured Host;
HTTP Origin, when present, must match, and cross-site fetches are rejected.

| Endpoint | Authentication and behavior |
| --- | --- |
| `GET /engine/bootstrap` | Returns the browser token and current snapshot without a bearer token. Local processes can obtain this token; it is not isolation between puffles. |
| `GET /engine/snapshot` | Browser bearer token; returns `{snapshot}`. |
| `POST /engine/action` | Browser bearer token and an explicit matching Origin; accepts a JSON object with `action` and its arguments, and returns `{result, snapshot}`. |
| `POST /engine/hooks` | Per-run hook bearer token, no Origin header; accepts `{workerId, event}`. The manager checks the worker and session binding. |
| WebSocket `/engine/ws` | Matching Origin; first JSON message must be `{type: "auth", token}` within five seconds. Streams snapshots; `attach` selects an exact project/worker terminal for replay and output. Supports `detach`, `input`, and `resize`. |

Actions are `register`, `create`, `retry`, `start`, `submit`, `input`, `resize`,
`interrupt`, `stop`, and `diff`. Worker actions require explicit `projectId` and
`workerId`. Action bodies are limited to 256 KiB; hook bodies allow 1 MiB plus
1 KiB for the wrapper. WebSocket messages are limited to 64 KiB.

The manager's `submit` action requires nonblank `text` of at most 64 KiB in
UTF-8, with no NUL (`U+0000`) or ESC (`U+001B`). It validates the worktree and
session readiness before pasting and submitting. Raw terminal `input` accepts
`data` up to 64 KiB, including control characters for interactive prompts;
WebSocket control also requires attachment to that exact worker. Browser and
Flash text fields have their own smaller limits.

## Verify and extend

```sh
sh -n local/agent-start
npm test --prefix local/engine
npm test --prefix local/web
git diff --check
```

Engine tests use temporary repositories, fake PTYs, and local HTTP/WebSocket
fixtures. They do not establish a live Claude task or interactive gameplay.
Consult the dated [validation record](VALIDATION.md) for the actual checks and
remaining gaps. A full live check should submit a real task, answer a permission
prompt, interrupt, inspect its diff, reconnect the browser, and resume the same
session after a runtime restart.

The relevant official contracts are the
[CLI flags](https://code.claude.com/docs/en/cli-reference),
[hooks](https://code.claude.com/docs/en/hooks), and
[interactive controls](https://code.claude.com/docs/en/interactive-mode).
SessionStart uses a command hook; the observer forwards JSON locally without
approving permissions or changing Claude's response. Hooks supplement the real
terminal rather than replacing its interaction model.

An explicitly started host session requires a prepared, validated worktree. Game
verification controls igloo publication and native execution controls. An unavailable
igloo does not terminate a running Claude process.

## Repository and workspace rules

- **Projects.** It registers up to 32 existing, non-bare Git repositories, each
  with at least one commit. Projects are deduplicated by canonical Git common
  directory, so a symlink or linked worktree resolves to the existing project,
  while unrelated repositories with the same folder name stay separate. The
  first registered checkout remains the display path. Names are 1–30 ASCII
  letters, digits, single spaces, `-`, `_`, or `.`, and must begin and end with
  a letter or digit. The engine rejects names such as `100%`, `A|B`, or `a:b`.
  The default name is a sanitized repository basename, or `Project`.
- **Puffles.** An igloo holds up to 10 adopted puffles, each a worker named with
  1–12 letters. Houdini's name filter and title-casing apply at adoption: `nOVA`
  becomes `Nova`, and the worker takes the server-normalized name. Every action
  takes an explicit project ID and worker ID. There is no fallback to the first
  project or worker.
- **Session limits.** At most `CP_ENGINE_SESSIONS_PER_IGLOO` (default 3) puffles
  per igloo and `CP_ENGINE_SESSIONS` (default 6) overall run at once; each accepts
  1–32. A start beyond either limit is queued in order and shown as **Queued**,
  and **Stop** withdraws it. A limit never stops a running session.
- **Worktrees.** Each puffle gets one persistent, locked worktree at
  `~/.claude-penguin/worktrees/<worker-id>/<repo-folder>`, on branch
  `claude-penguin/<project-id>/<worker-id>`. `CP_ENGINE_WORKTREE_ROOT` (absolute;
  spaces allowed) changes the root for future puffles only. The engine refuses a
  root inside any Git repository, so worktrees never inherit Claude Penguin's
  instructions, and creates new folders with mode `0700`. A root that Git cannot
  classify, for example below a stale `.git` file or a folder with dubious
  ownership, is refused too. The worktree starts at
  the source checkout's exact `HEAD`. Staged, unstaged, untracked, and ignored
  files stay in the source checkout and are not copied; setup notes when the
  source was dirty. The path, branch, and baseline are saved before Git runs.
  Setup runs in the background and records its progress, and a failure offers an
  explicit retry. A retry adopts only resources that exactly match the saved
  reservation and whose checkout finished: the index exists, no `index.lock`
  remains, and tracked files match the baseline. Anything conflicting or
  incomplete is reported with manual removal guidance and never deleted or
  adopted.
- **Offline Git.** The engine requires Git 2.48 or newer and checks the version
  at startup. All engine-owned Git calls use argument arrays, bounded output, and
  per-operation timeouts. Each runs in its own process group; a timeout sends
  SIGTERM, then SIGKILL, to the whole group, so a checkout started by
  `git worktree add` cannot keep running on its own. No `GIT_*` variable is
  inherited from the engine's environment. Calls run with an empty private
  `core.hooksPath`, no fsmonitor, no submodule recursion, every transport set to
  `never` (`protocol.allow` and each `protocol.<name>.allow`), and with
  `GIT_NO_LAZY_FETCH=1`, `GIT_LFS_SKIP_SMUDGE=1`, and `GIT_TERMINAL_PROMPT=0` set.
  Config-defined hooks (`hook.<name>.*`, which `core.hooksPath` does not
  disable) and `attr.tree` are refused in every configuration scope.
  Before checkout, every baseline path is checked with
  `git check-attr --source=<baseline> --stdin -z filter`, which also covers
  repository and user attribute files. Any custom `clean`, `smudge`, or `process`
  command is refused before it can run. Only the standard installed Git LFS
  driver is allowed, and the engine checks for it by running the `git-lfs`
  executable found on an absolute `PATH` entry, never `git lfs`, which could
  resolve to a repository alias. LFS files stay pointers; run `git lfs pull` inside the
  worktree yourself if you need their contents. Repository-local `includeIf` is
  refused. Conditional includes elsewhere that set hook, filter, or attribute
  configuration fail with an explanation. Before engine-owned status and diff
  reads, the configuration is checked again, and the current attributes are
  re-inspected whenever a custom driver is configured. Missing partial-clone
  objects fail without being fetched. The engine never fetches, installs
  dependencies, initializes submodules, copies credentials, stashes, commits, or
  removes worktrees.
- **Validation.** Before start, resume, task submission, and review, the worktree
  must still exist, have the same Git top level and common directory, appear in
  `git worktree list`, and still contain the baseline commit. Otherwise the
  puffle shows **Needs repair**, and the engine never falls back to the source
  checkout. The repair message gives the manual command to try, such as
  `git -C <source> worktree repair <worktree>`; the engine never repairs
  automatically. A different branch, detached `HEAD`, an unlocked worktree, or
  history that no longer descends from the baseline produces a warning but still
  allows work.
- **Sessions and hooks.** Each puffle runs its own PTY in its worktree, and
  puffles in different projects can run at the same time. Hooks are
  authenticated with the per-run token and saved session UUID, so one puffle's
  hook token cannot send lifecycle events for another puffle. The token is in
  the Claude process environment, so the puffle's own tool commands can read it
  and forge events for that same puffle. The browser token is not a boundary
  between puffles: any local process can request it from `/engine/bootstrap`
  and send terminal input to any puffle, so treat repository code that a puffle
  runs as able to reach the others. A startup or resume reported outside the
  recorded worktree root stops that PTY. Compaction in the same session, for
  example after `cd src`, counts as ongoing. Authenticated events from outside
  the worktree are still processed so permission prompts stay visible; they set
  an outside-workspace warning. A folder inside the worktree whose Git top level
  is a nested repository also warns (`nestedRepository: true`). That lookup runs
  in the background, so the first event from such a folder may not warn yet.
  Hook events up to 1 MiB are accepted. Worktrees isolate checkouts and indexes, not
  filesystem access, and Claude keeps manual permissions. Choosing **Yes, and don't
  ask again** in a puffle's worktree can write a rule to the source checkout's
  `.claude/settings.local.json`. We observed this with a Bash rule in Claude
  Code 2.1.317. See [Claude permissions](https://code.claude.com/docs/en/permissions)
  and the [local validation record](VALIDATION.md).
- **Review.** Review shows cumulative committed and uncommitted changes since
  the immutable baseline, previews of untracked files (symlinks, hard-linked
  files, and other non-regular files are skipped; the untracked list stops at
  1 MiB of names and reports `untrackedListTruncated`), the source
  and worktree paths, the current and expected branches, the merge base (or a
  note that histories share none), the dirty state, and any warnings. External
  Git operations do not reset the baseline. Stop the session before changing the
  branch outside Claude Penguin.

### State v3, migration, and rollback

State v3 holds up to 32 projects, their adopted puffles (one worker each, with
its own `puffle` binding, setup progress and worktree), archived workers, and
open adoptions. A project no longer has one active worker. The engine refuses
version 1 and version 2 state and never migrates implicitly. Older engine code
refuses version 3. The explicit command:

```sh
node local/engine/migrate.mjs --state-dir .local/agent-engine-demo
```

takes the runtime lock and fails closed if a saved engine or worker process may
still be alive or a stale `runtime.lock` remains. It migrates one version at a
time. Before each step it writes the current bytes to
`state.v<N>-backup-<timestamp>.json` with mode `0600`, never overwriting an
existing backup, and checks the copy; then it replaces `state.json` atomically.
Running it on version 3 changes nothing.

**From v1.** The old Atlas worker is archived with its IDs, Claude session UUID,
task history, original folder, and baseline. Execution controls are disabled, and
the archive shows `cd '<original folder>' && claude --resume <session>` for
manual use. The project UUID and Atlas game mapping are kept as a ready
`legacy-fixture` mapping. **Create isolated Atlas** on that project starts a
separate Atlas with a new worktree and conversation on the existing mapping. The
old conversation and its uncommitted files are not moved. If the source checkout
is missing, migration still succeeds: the project shows as source-unavailable,
and its history stays readable. A migrated project binds to a repository at its
old path only if that repository contains the archived worker's baseline commit,
so an unrelated repository created there later never inherits the history or the
Atlas igloo. A legacy igloo belongs to the shared Bridge Alpha fixture, so the
Pet Shop does not offer it as a destination.

**From v2.** Each project's active worker keeps its ID, session, worktree, branch
and task history, and takes over the project's managed puffle as its `puffle`
binding. The project mapping keeps only its owner and igloo. Archived workers
are unchanged.

To roll back, stop the engine, then copy the backup over `state.json` and run
the older engine. Copy, rather than rename, so the backup stays available.
Puffles adopted after the migration stay in the game but are unknown to the
older engine, whose verification then reports their igloo for repair.
Worktrees and branches created by newer engines stay in place. They are locked,
and you can remove them manually with `git worktree unlock` and
`git worktree remove`.

### Game provisioning and native igloos

The original server addresses an igloo by its owner (`ownerId + 2000`), so
layouts alone cannot isolate igloos. Each project therefore gets one dedicated,
engine-managed owner penguin, and that owner holds the project's adopted puffles. The bridge-only simulation (Bridge Alpha/Beta,
`./local/bridge-fixtures`) is separate and unchanged.

**Setup.** After a project's worktree is ready, setup provisions its game
mapping, then reaches `ready`; it never reaches `ready` with only one part done.
The project's operation lock covers each step, progress is saved after each one,
and a failure is retryable without creating a second identity:

1. **Visitor.** The engine verifies, or creates, only the marked `bridgecheck`
   visitor (`CP_ENGINE_VISITOR=adoptcheck` selects the separate test visitor, for
   checks that spend coins; use it with its own `CP_ENGINE_STATE_DIR`, because a
   state directory refuses a different visitor). It shares the username, marker email, and disposable password source
   (`CLUB_PENGUIN_TEST_PASSWORD`, default `PenguinLocal2026!`) with the fixture
   seeder through `local/game_accounts.py`, so either accepts the other's
   account. The engine sends that password in the stdin request, never as a
   command argument or container environment variable. The verified ID is saved
   as `state.visitor`; once recorded, it is only verified, never recreated. The engine never logs
   in as `bridgecheck`, so it cannot disconnect your browser session.
2. **Owner.** A UUID ownership marker and generated credentials are saved to
   `<state dir>/game-secrets.json` (mode `0600`) before anything is created. The
   username is `cp` plus 10 random lowercase letters or digits, within the
   database's 12-character limit; a username taken by any other account is
   regenerated and saved before the next attempt. The project name becomes the
   owner's nickname, approved for English so the igloo list shows it.
3. **Igloo.** The engine logs in as that owner through the ordinary login and
   world servers on loopback, loads the owner's default igloo (`g#gm`), enters
   it, and confirms the room. It adopts nothing: the igloo starts empty.
4. **Verification.** The provisioning service checks the complete mapping in the
   database: exactly one account carries the marker, its active layout is the
   recorded igloo, that igloo is still **locked**, and the owner's puffles are
   exactly the project's recorded puffles (ID, name and type, indoors, at most
   10). Only then is the mapping `ready`. Before verifying, setup checks stored
   adoption receipts, so a paid puffle whose report was lost is bound first.

A retry reconciles against the same marker, username, and recorded IDs. Several
marked accounts, a marker under another username, a different owner ID, extra
puffles without a receipt, missing or renamed puffles, a changed layout, or an unlocked igloo stop with status
`repair`. Once an owner ID is recorded, the service only verifies that owner:
if the account is gone or no longer carries the marker, setup stops with
`repair` (code `MISSING`) and no replacement is created. Nothing is remapped,
adopted twice, or deleted. Repair needs a person:
inspect the game database, then retry. Missing `game-secrets.json` entries for
an existing owner also stop with `repair` rather than creating another owner.
At startup the engine re-verifies, in the background, the visitor and then
all ready mappings. It verifies a legacy owner using the recorded fixture identity, its marker email, locked layout and blue puffle. Restore a mismatched legacy fixture manually and restart to recheck it. A mismatched owner mapping
moves that project to `repair`. A visitor that is missing or mismatched is never
remapped: snapshots report `visitor: null` with a `visitorProblem` message, the
publication is withdrawn (no visitor, no igloos) until the visitor verifies
again, and owner mappings are still checked. An unavailable stack leaves the
last verified state. Startup publishes the saved ready mappings before this
check finishes.

The snapshot adds `visitor` (`penguinId`, `username`, `verifiedAt`) and an
allowlisted `project.game` (`source`, `status`, `ownerId`, `iglooId`, `roomId`,
`verifiedAt`, plus `puffleId`, `puffleName` and `fixtureId` for a legacy fixture),
each worker's `puffle` (`puffleId`, `typeId`, `subtypeId`, `name`), and each
project's `capacity`, `adoptionBlocked` reason and open `adoptions`. Owner usernames,
passwords, and markers never appear in `state.json`, snapshots, published
files, command arguments, or engine logs. Houdini's own login and world logs
(`.local/logs/`, ignored by Git) record owner usernames when the engine's game
sessions log in; they never record passwords. A migrated legacy Atlas keeps its
`legacy-fixture` mapping (owner 105, igloo 4) and is not reprovisioned.

**Provisioning service.** Database work runs in the `provision` Compose service
(`local/game_provision.py`, tools profile). The engine runs
`./local/compose run --rm --no-deps -T provision` with fixed arguments and sends
one JSON request on stdin (`visitor`, `owner`, `verify`, or the read-only
`receipts`). The database password stays in the container environment, and only
the scripts it needs are mounted, so private engine state is not visible to it. The game stack must
already be running. With `CP_ENGINE_GAME_PROVISIONING=off`, setup stops at
`game-pending` instead.

**Native publication.** The running engine atomically rewrites
`.local/native-igloos/published.json` whenever ready mappings or the visitor
change:

```json
{ "version": 2, "visitorId": 107, "igloos": [{ "ownerId": 201, "iglooId": 9 }],
  "adoptions": [{ "adoptionId": "<uuid>", "ownerId": 201, "expiresAt": 1800000000 }] }
```

It lists only `ready` mappings from this engine's own state (never
`provisioning`, `failed`, or `repair`), including a ready legacy Atlas. A clean
shutdown empties the list. One engine owns publication across all state
directories through `.local/native-igloos/owner.lock`; a second engine refuses
to start rather than overwrite it. After a crash, the lock and the last verified
list remain. That list does **not** mean any agent is running. Recovery follows
the `runtime.lock` policy: after confirming the old engine and its Claude
processes have stopped, remove `runtime.lock` and `.local/native-igloos/owner.lock`
explicitly, then start the engine, which replaces the list. Neither lock is ever
deleted automatically.

**World adapter.** `compose.yml` mounts the publication directory read-only into
the world service (a directory, because atomic replacement changes the file's
inode), and `houdini_bootstrap.py` reads it on demand. The managed igloos stay
locked in the database. Only for the published visitor:

- `g#gr` (the igloo map's open list) returns the upstream list unchanged, then
  appends each published owner that is not already listed. Offline owners are
  read from the database without adding fake online penguins. Nicknames use the
  same approval rule as `safe_name`, likes come from the existing query and
  cache, population comes from a loaded room or is zero, and entries are
  advertised as open (`locked` 0). An owner whose active layout no longer matches
  the published igloo is skipped.
- `g#pio` (the player card's "is this igloo open?") answers open for published
  owners.
- `p#cpadopt` is a new command, not an upstream one; see
  [Adoption](#adoption-into-a-project-igloo).

Every other penguin, including `player`, gets the upstream handlers unchanged.
Only the callbacks are replaced, so authorization and cooldown metadata stay on
the original listeners; startup fails if the pinned handler source changes. A
missing, unparseable, or oversized (over 64 KiB) file adds nothing, never
affects another penguin's handlers, and is reported once per file version in
the world log.
After updating, rerun `./local/start` so the world service picks up the new
mount.

**Verification status.** Engine tests cover the setup lifecycle with a fake
provisioner, the protocol client against a fake loopback Houdini, the service
adapter's argument and stdin handling, secrets, and publication ownership. Host
unit tests cover the provisioning script's logic and the adapter against the
vendored handler source:

```sh
npm test --prefix local/engine
python3 -m unittest local/test_game_provision.py local/test_native_igloos.py local/test_project_adoption.py
```

The container regression suite (`local/test_houdini_compat.py`) and live
provisioning against the running stack are recorded in the dated validation
record. See the Stage 3 entry for Ruffle map, player-card and concurrent Claude acceptance.

### Adoption into a project igloo

The agent page (8081) loads a derived copy of the archived Pet Shop module;
the ordinary game page (8080) never receives it and keeps the original module
and upstream `p#pn`. `python3 local/client-bridge/build.py` derives it
reproducibly (see the [build notes](client-bridge/README.md#project-adoption-module)).
One purchase runs as follows:

1. **Choose.** The module's destination picker lists every registered igloo with
   its count, five per page with Previous/Next controls. A full igloo, one still
   being set up, or a legacy igloo is shown with the reason it cannot be chosen.
2. **Reserve.** **Adopt** asks the engine for a reservation: an adoption UUID for
   that igloo's owner, the catalog entry, and the name, valid for 10 minutes. The
   engine refuses while the project is busy with setup, when the igloo is full
   (counting open reservations), or while the visitor has another open adoption.
   It publishes the reservation in `published.json`.
3. **Buy.** The overlay sends `p#cpadopt` with the UUID, type, name and subtype
   through the game's own connection. Houdini's added handler
   (`local/project_adoption.py`) accepts it only from the published visitor for a
   published, unexpired reservation, checks the catalog and Houdini's name rules,
   and then, in one database transaction, locks the visitor and the owner, takes
   coins from the visitor, adds the puffle to the owner (indoors, at most 10) and
   stores a receipt keyed by the UUID. It then updates the visitor's in-memory
   coins and replies with the receipt; the module shows the new balance without
   a relog. A repeated UUID returns the stored receipt and is never charged
   again; a bound or withdrawn reservation is refused (`unknown-adoption`).
   Not enough coins (401), a rejected name (441) and a full igloo (440) are
   refused before anything is charged.
4. **Bind.** The page reports the reply. The engine reads the receipt from the
   database itself, binds the puffle to a new worker, withdraws the reservation,
   and prepares that worker's worktree in the background. The certificate names
   the destination igloo; **OK** travels there.

The receipt always wins. If the page closes, the reply is lost or the engine
restarts mid-purchase, the engine checks receipts at startup, on **Check
purchase** in the chooser (available for reserved and charged operations), and on
setup retry: a receipt binds the puffle even if its reservation expired or was
withdrawn. A timeout, failed lookup, or missing receipt does not prove that no
coins were taken. The page keeps the purchase pending, shows its recovery notice,
and checks again every 20 seconds without cancelling or sending another purchase.
Matching late replies still resolve it, including after closing the module.
"Not charged" is decided only by the game database. Once a reservation has
expired by the engine's clock and has no receipt, the engine asks the
provisioning service to **settle** it (`project_adoption.settle`). In one
transaction, settlement takes the visitor's row lock, the same lock a purchase
takes first, and holds it through commit. If a receipt exists, it returns that
purchase. If the reservation has not expired on the database clock, it writes
nothing. Otherwise it stores a row in `claude_penguin_adoption_settlement`. A
purchase that acquires the lock after that commit finds the row and is refused
(`settled`) without debiting coins or creating a puffle. A purchase also
rechecks expiry with the database's `clock_timestamp()` after its lock waits,
so one delayed on a lock past expiry is refused (`expired`). Purchase and
settlement therefore serialize: whichever commits first decides. Only a
committed settlement marks the adoption `not-charged`; the page then says
nothing was charged and allows another adoption. An empty receipt lookup,
elapsed time, a failed or timed-out request, or a database that still considers
the reservation open decides nothing, and the adoption stays pending for the
next check. A lost settlement reply is safe to repeat; it returns the same row.
A purchase the game reported as charged is never sent for settlement; a missing
receipt for it stays withdrawn as `lost` for inspection. A `settledAt` recorded
by the earlier timeout-based version is treated as unverified and settled in
the database at the next check. A
confirmed receipt shows the certificate independently of worktree setup; a
definitive pre-charge refusal allows another attempt. The visitor's own collection
never gets the puffle. The world server creates the adoption tables
(`claude_penguin_adoption_receipt`, `claude_penguin_adoption_settlement` and
`claude_penguin_schema`) when it starts, at schema version 2. A version 1
database (receipts only) is upgraded in one transaction that keeps every row;
any other recorded version stops the handler. Only the world server's own
startup records version 2, and the provisioning service refuses to settle
(`SCHEMA`) until it has, so settlement is never written while an older purchase
handler that ignores it is still running. The real lock ordering is covered by
`./local/adoption-db-check`, which runs `local/test_adoption_postgres.py`
against a throwaway PostgreSQL container on an internal Docker network; it needs
the Houdini image from `./local/start` and never touches the game database.
