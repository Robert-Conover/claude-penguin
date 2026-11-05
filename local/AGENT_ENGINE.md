# Project igloos and Claude Code sessions

Each registered repository gets an igloo, a named puffle, a persistent Git worktree,
and an independent Claude Code session on the host. The original client runs in
Ruffle. Game services stay in Docker. The optional agent page listens on loopback
and starts a puffle only when you choose **Start / Resume**.

## Start

Install Node 22 or newer, npm, and
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

1. Open **Igloos → Add project** and enter the repository path, project name and
   puffle name. The chooser shows setup progress, name corrections, retries and
   manual repair instructions. Registration supports up to 32 distinct repositories.
   Game acceptance creates permanent managed owner accounts. Project deletion is deferred.
2. Travel using the original map's cluster of igloos or **Visit** in the chooser.
   Click a mapped puffle to select its project. **Work** reopens that selection
   from anywhere on the island. Without a selection it opens the chooser.
3. Choose **Start / Resume** and **Open Claude**. On first launch Claude can ask
   whether you trust the new worktree folder. Check the displayed path before
   confirming. Claude runs in manual permission mode. Answer tool requests in
   the terminal. Several puffles can run concurrently.
4. Enter a task in the native card, or use the browser task card when the game
   cannot display it. Each surface keeps drafts per worker for the current page.
   Close the card or visit Town while work runs. The Work badge counts workers
   waiting for input, failed turns and turns ready for review.
5. Open **Changes** to review agent commits and current edits from the immutable
   baseline. **Copy path** copies the worktree and **Copy branch** copies its
   current branch. The **Journal** tab shows the selected worker's task history.
   Verify task results yourself and stop the session before external Git operations.
6. A migrated project also has **View archive**, with its original folder, session
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
arrives, the native card stays **Needs you** and directs you to Open Claude.
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
the old PTY or its in-memory screen; choose **Start / resume** afterward to
continue the same saved Claude conversation. Previously unfinished task records
are marked interrupted rather than completed.

Press Ctrl+C in the foreground engine terminal for a normal shutdown. It stops
the Claude PTYs it owns and releases its runtime lock. `./local/stop` controls the
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
| `CP_ENGINE_WORKTREE_ROOT` | absolute root for new puffle worktrees, default `~/.claude-penguin/worktrees`. |
| `CP_NATIVE_IGLOOS_DIR` | native igloo publication directory, default `.local/native-igloos` (the directory the world service mounts). Change it only for tests. |
| `CP_ENGINE_GAME_PROVISIONING` | `off` disables game provisioning (setup then stops at `game-pending`). For engine-only development and tests. When the engine later starts with provisioning on, each `game-pending` project becomes a retryable failure, and **Retry** provisions it. |

The engine validates Host/Origin and uses separate browser and per-run hook
credentials. Game fixture IDs alone do not authorize terminal control. Logs and
raw test reports belong under ignored `.local/`; do not publish session tokens,
terminal output containing private data, or host credentials.

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
- **Puffles.** Each project has one active puffle named with 1–12 letters. The
  first defaults to Atlas, and later defaults avoid names already in use. Every
  action takes an explicit project ID and worker ID. There is no fallback to the
  first project or worker.
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
  filesystem access, and Claude keeps manual permissions. Claude documents that permanent
  repository approvals resolve through worktrees to the main checkout's
  `.claude/settings.local.json`. See [Claude permissions](https://code.claude.com/docs/en/permissions)
  and the dated [local observations](VALIDATION.md).
- **Review.** Review shows cumulative committed and uncommitted changes since
  the immutable baseline, previews of untracked files (symlinks, hard-linked
  files, and other non-regular files are skipped; the untracked list stops at
  1 MiB of names and reports `untrackedListTruncated`), the source
  and worktree paths, the current and expected branches, the merge base (or a
  note that histories share none), the dirty state, and any warnings. External
  Git operations do not reset the baseline. Stop the session before changing the
  branch outside Claude Penguin.

### State v2, migration, and rollback

State v2 holds multiple projects, one active worker per project, and archived
workers. The engine refuses version 1 state and never migrates it implicitly.
Older engine code refuses version 2. The explicit command:

```sh
node local/engine/migrate.mjs --state-dir .local/agent-engine-demo
```

takes the runtime lock and fails closed if a saved engine or worker process may
still be alive or a stale `runtime.lock` remains. It writes the original bytes
to `state.v1-backup-<timestamp>.json` with mode `0600`, never overwriting an
existing backup, and then replaces `state.json` atomically. The old Atlas
worker is archived with its IDs, Claude session UUID, task history, original
folder, and baseline. Execution controls are disabled, and the archive shows
`cd '<original folder>' && claude --resume <session>` for manual use. The
project UUID and Atlas game mapping are kept as a ready `legacy-fixture`
mapping. Creating a new puffle on that project starts a separate isolated Atlas
with a new conversation. The old conversation and its uncommitted files are not
moved. If the source checkout is missing, migration still succeeds: the project
shows as source-unavailable, and its history stays readable. A migrated project
binds to a repository at its old path only if that repository contains the
archived worker's baseline commit, so an unrelated repository created there
later never inherits the history or the Atlas igloo.

To roll back, stop the engine, then copy the backup over `state.json` and run
the older engine. Copy, rather than rename, so the backup stays available.
Worktrees and branches created by the v2 engine stay in place. They are locked,
and you can remove them manually with `git worktree unlock` and
`git worktree remove`.

### Game provisioning and native igloos

The original server addresses an igloo by its owner (`ownerId + 2000`), so
layouts alone cannot isolate puffles. Each project therefore gets one dedicated,
engine-managed owner penguin. The bridge-only simulation (Bridge Alpha/Beta,
`./local/bridge-fixtures`) is separate and unchanged.

**Setup.** After a project's worktree is ready, setup provisions its game
mapping, then reaches `ready`; it never reaches `ready` with only one part done.
The project's operation lock covers each step, progress is saved after each one,
and a failure is retryable without creating a second identity:

1. **Visitor.** The engine verifies, or creates, only the marked `bridgecheck`
   visitor. It shares the username, marker email, and disposable password source
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
3. **Igloo and puffle.** The engine logs in as that owner through the ordinary
   login and world servers on loopback. It checks the requested name with
   `p#checkpufflename`, adopts one blue puffle (`p#pn`), loads the owner's
   default igloo (`g#gm`), enters it, and confirms the puffle is there. Houdini's
   name filter and title-casing apply: `nOVA` becomes `Nova`, and the puffle
   records that server-normalized name. If the game rejects the name (a failed
   check or error 441), setup fails with `correction: "puffleName"`; retry with
   a new `puffleName` (1–12 letters).
4. **Verification.** The provisioning service checks the complete mapping in the
   database: exactly one account carries the marker, its active layout is the
   recorded igloo, that igloo is still **locked**, and the owner has exactly the
   recorded puffle. Only then is the mapping `ready`.

A retry reconciles against the same marker, username, and recorded IDs. Several
marked accounts, a marker under another username, a different owner ID, extra
or renamed puffles, a changed layout, or an unlocked igloo stop with status
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
`puffleId`, `puffleName`, `fixtureId`, `verifiedAt`). Owner usernames,
passwords, and markers never appear in `state.json`, snapshots, published
files, command arguments, or engine logs. Houdini's own login and world logs
(`.local/logs/`, ignored by Git) record owner usernames when the engine's game
sessions log in; they never record passwords. A migrated legacy Atlas keeps its
`legacy-fixture` mapping (owner 105, igloo 4) and is not reprovisioned.

**Provisioning service.** Database work runs in the `provision` Compose service
(`local/game_provision.py`, tools profile). The engine runs
`./local/compose run --rm --no-deps -T provision` with fixed arguments and sends
one JSON request on stdin (`visitor`, `owner`, or `verify`). The database
password stays in the container environment, and only the three scripts it needs
are mounted, so private engine state is not visible to it. The game stack must
already be running. With `CP_ENGINE_GAME_PROVISIONING=off`, setup stops at
`game-pending` instead.

**Native publication.** The running engine atomically rewrites
`.local/native-igloos/published.json` whenever ready mappings or the visitor
change:

```json
{ "version": 1, "visitorId": 107, "igloos": [{ "ownerId": 201, "iglooId": 9 }] }
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
python3 -m unittest local/test_game_provision.py local/test_native_igloos.py
```

The container regression suite (`local/test_houdini_compat.py`) and live
provisioning against the running stack are recorded in the dated validation
record. See the Stage 3 entry for Ruffle map, player-card and concurrent Claude acceptance.
