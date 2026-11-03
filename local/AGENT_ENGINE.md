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
