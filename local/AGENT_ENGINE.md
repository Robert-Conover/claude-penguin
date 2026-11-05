# One puffle, one Claude Code session

The opt-in host engine connects Atlas in Bridge Alpha to one real Claude Code
terminal on this Mac. The original game remains in its existing containers. The
engine runs separately on loopback port 8081 and starts a Claude process only when
you choose **Start / Resume** in the puffle card. After game login, that card and
the **Work** and **Igloos** buttons are drawn inside the Flash client. The full
Claude terminal opens separately when needed.

This milestone supports one registered Git repository and one named worker. It
uses the existing `bridgecheck` visitor and `bridge-alpha` fixture destination;
Bridge Beta is not a second coding project. A registered project gets its own
UUID, separate from the fixture ID, and a canonical repository path. Registering
a symlink to the same repository returns the same project. A second distinct
repository or worker is refused rather than replacing the saved mapping.

> **In-progress branch.** On the multi-project branch, the engine itself has moved to
> [state v2 with isolated worktrees](#multi-project-engine-in-progress). Game
> provisioning and browser integration are not finished there, so `server.mjs`
> refuses to serve the agent page unless you explicitly opt into the engine
> preview. Everything below describes the released single-puffle milestone on
> `dev`.

## Start

Install Node 22 or newer, npm, and
[Claude Code](https://code.claude.com/docs/en/setup) on the host. Configure Claude
authentication through its normal host setup before asking the puffle to work.
The launcher does not log you in or request authentication.

Prepare the game and the [bridge experiment](GAME_BRIDGE.md):

```sh
./local/start
python3 local/client-bridge/build.py
./local/bridge-fixtures
./local/agent-start
```

The overlay build needs a JDK; see the [build instructions](client-bridge/README.md).
Fixture setup uses dedicated accounts and preserves the interactive `player`
account. Close any existing `bridgecheck` game session before setup or protocol
verification. Houdini allows only one session per account.

`agent-start` checks the fixture manifest, generated overlay, Ruffle files, and
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

## Work with Atlas

1. Open **Work**. The setup card connects an absolute path to an existing Git
   repository with at least one commit and lets you name the session. For
   verification, use a disposable repository with a clean working tree.
2. Once connected, click Atlas in its igloo or choose **Work** from anywhere on
   the island. The native Flash puffle card shows its current state, a task field,
   and the **Start / Resume**, **Interrupt**, **Send task**, **Open Claude**, and
   **Changes** buttons.
3. Choose **Start / Resume**, then **Open Claude** for folder trust, questions,
   authentication, or permissions. This opens the real terminal in a separate
   window styled to match the game. Claude starts in manual permission mode and
   retains applicable settings. **Session details** reveals the repository path,
   session UUID, and detailed runtime activity when needed.
4. Enter an instruction on the native card and choose **Send task**, or type
   directly in Claude's terminal. The worker edits the registered checkout
   directly; this milestone does not create an isolated branch or worktree.
5. Choose the native **Igloos** button to open the destination list, which uses
   matching browser menu styling. Select your project or **Visit Town**. Closing
   a menu or traveling leaves the host-owned PTY running. **Work** remains
   available for attention and review without returning to the igloo.
6. **Changes** opens a browser viewer for tracked changes and bounded untracked
   previews. The comparison starts at the commit recorded when the worker was
   created, including subsequent agent commits and current working-tree edits.
   Pre-existing edits are identified but are not separated from agent edits.
   Review and integration remain explicit actions outside the menu. **Back to
   puffle** returns from the terminal or Changes viewer to the native card.

Before game login, or while the native menu is unavailable, **Work** uses a
compact browser puffle card with the same game-inspired appearance. Its **Task**,
**Changes**, and **Journal** tabs retain task entry, diff review, and history.
The terminal is behind **Open Claude**, rather than the default view. Returning
from a viewer also uses this fallback if the game cannot reopen its native card.
The destination list and terminal remain browser surfaces; they are not original
Flash menus.

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
| `CP_ENGINE_STATE_DIR` | Dedicated state directory; relative values resolve from the repository root. Changing it selects separate engine state, not an automatic migration. |
| `CP_ENGINE_PORT` | Loopback port, default `8081`. Use the URL printed by the launcher. |
| `CP_CLAUDE_PATH` | Claude executable path when `claude` is not on `PATH`. |
| `CP_ENGINE_WORKTREE_ROOT` | Multi-project engine only: absolute root for new puffle worktrees, default `~/.claude-penguin/worktrees`. |
| `CP_ENGINE_PREVIEW` | Multi-project engine only: `engine-v2` opts into the engine-only preview with a dedicated `CP_ENGINE_STATE_DIR`. |

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

Multiple project igloos, neighborhood/map changes, concurrent workers with
isolated worktrees, task boards, and integration actions remain later milestones.

## Multi-project engine (in progress)

Stage 1 of the multi-project milestone changes the host engine only. It is
covered by automated tests and a migration rehearsal on a private copy. Game
provisioning, the native igloo list, and the chooser, card, and selection
surfaces come in later stages. Until then, the real agent page is disabled. For
engine-only development:

```sh
CP_ENGINE_PREVIEW=engine-v2 CP_ENGINE_STATE_DIR=.local/engine-preview node local/engine/server.mjs
```

The preview refuses the default `.local/agent-engine/` directory and never
migrates saved state implicitly.

What the engine now does:

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
  instructions, and creates new folders with mode `0700`. The worktree starts at
  the source checkout's exact `HEAD`. Staged, unstaged, untracked, and ignored
  files stay in the source checkout and are not copied; setup notes when the
  source was dirty. The path, branch, and baseline are saved before Git runs.
  Setup runs in the background and records its progress, and a failure offers an
  explicit retry. A retry adopts only resources that exactly match the saved
  reservation. Anything conflicting is reported and never deleted or adopted.
- **Offline Git.** The engine requires Git 2.48 or newer and checks the version
  at startup. All engine-owned Git calls use argument arrays, bounded output, and
  per-operation timeouts. They run with an empty private `core.hooksPath`, no
  fsmonitor, no submodule recursion, no transports, and with
  `GIT_NO_LAZY_FETCH=1`, `GIT_LFS_SKIP_SMUDGE=1`, and `GIT_TERMINAL_PROMPT=0` set.
  Before checkout, every baseline path is checked with
  `git check-attr --source=<baseline> --stdin -z filter`, which also covers
  repository and user attribute files. Any custom `clean`, `smudge`, or `process`
  command is refused before it can run. Only the standard installed Git LFS
  driver is allowed, so LFS files stay pointers; run `git lfs pull` inside the
  worktree yourself if you need their contents. Repository-local `includeIf` is
  refused. Conditional includes elsewhere that set filter or attribute
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
  checkout. A different branch, detached `HEAD`, an unlocked worktree, or
  history that no longer descends from the baseline produces a warning but still
  allows work.
- **Sessions and hooks.** Each puffle runs its own PTY in its worktree, and
  puffles in different projects can run at the same time. Hooks are
  authenticated with the per-run token and saved session UUID, so one puffle's
  token cannot drive another puffle. A startup or resume reported outside the
  recorded worktree root stops that PTY. Compaction in the same session, for
  example after `cd src`, counts as ongoing. Authenticated events from outside
  the worktree are still processed so permission prompts stay visible; they set
  an outside-workspace warning. Worktrees isolate checkouts and indexes, not
  filesystem access, and Claude keeps manual permissions. Where Claude Code
  stores persistent permission approvals (the worktree's or the source
  checkout's `.claude/settings.local.json`) has not been verified yet; live
  acceptance will check and report it.
- **Review.** Review shows cumulative committed and uncommitted changes since
  the immutable baseline, symlink-safe previews of untracked files, the source
  and worktree paths, the current and expected branches, the merge base (or a
  note that histories share none), the dirty state, and any warnings. External
  Git operations do not reset the baseline. Stop the session before changing the
  branch outside Claude Penguin.

### State v2, migration, and rollback

State v2 holds multiple projects, one active worker per project, and archived
workers. The engine refuses version 1 state and never migrates it implicitly.
Older engine code refuses version 2. The explicit command:

```sh
node local/engine/migrate.mjs --state-dir <copy> --rehearsal
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
shows as source-unavailable, and its history stays readable.

In this stage the command migrates only rehearsal copies outside the checkout.
Real Atlas state is migrated once the archive and replacement controls exist.

To roll back, stop the engine, then copy the backup over `state.json` and run
the older engine. Copy, rather than rename, so the backup stays available.
Worktrees and branches created by the v2 engine stay in place. They are locked,
and you can remove them manually with `git worktree unlock` and
`git worktree remove`.
