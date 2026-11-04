# Working in Claude Penguin

## Project and scope

Claude Penguin runs the original Club Penguin AS3 client locally and connects one puffle to a persistent Claude Code session through an opt-in host engine. Multiple projects and concurrent puffles remain planned. Keep implemented behavior, proposed behavior, and validation gaps distinct in code, docs, and demos.

Most project-owned runtime code is in `local/`. `houdini/`, `dash/`, and `snowflake/` are vendored upstream server sources (MIT; revisions in `local/sources.json`). `vanilla-media/` is a pinned Git submodule of archived game media; never commit its contents to this public repository.

## Git workflow

- Use `dev` for ongoing work. Optional focused branches start from and target `dev`.
- Promote releases with a PR from `dev` to `main`. There is no `qa` branch. Do not commit directly to `main` for routine development.
- Push this project's work to `origin` (`Robert-Conover/claude-penguin`). Preserve the original `upstream` remote when present; never redirect a push there or enable disabled submodule push URLs as a side effect.
- Opening a PR does not authorize merging it. Follow the requested stopping point, and report the PR link and validation performed.

## Find the relevant context

Read only what the task needs:

| Task | Reference |
| --- | --- |
| Running or troubleshooting the local game | `LOCAL_SETUP.md` |
| Editing anything under `local/` | `local/AGENTS.md`, then the affected code |
| Agent engine (host Claude PTY, project/session state) | `local/AGENT_ENGINE.md` |
| In-game bridge, Flash overlay, bridge fixtures | `local/GAME_BRIDGE.md` and `local/client-bridge/README.md` |
| Checking gameplay claims or known gaps | `local/VALIDATION.md` and `local/validation-summary.json` |
| Changing an upstream revision or runtime dependency | `local/sources.json`, `.gitmodules`, and the affected manifest |
| Contributor workflow and instruction-file maintenance | `CONTRIBUTING.md` |

Search owned code first. Avoid recursively searching the multi-gigabyte media archive or dumping minified/binary assets into context unless the task requires a specific asset.

## Change boundaries

- Preserve pinned upstream revisions for unrelated work. Prefer project-owned adapters over incidental edits to vendored sources or the media submodule. When a task requires an upstream change, make the change reproducible, update provenance, and include it explicitly in the diff.
- Keep the game on loopback by default. The public GitHub repository does not make the running game a public service.
- Preserve player progress. Use the dedicated verification accounts for mutating checks; do not clear Docker volumes or overwrite the interactive `player` account to make tests pass.
- Keep real credentials, logs, Ruffle binaries, and raw local reports out of Git. `.local/` is ignored; the published player password is a disposable fixture, not an API credential.
- When implementing agent integration, use current official Claude Code documentation for the chosen interface. Keep project/session identity explicit and report real execution state; an animation or mock is not proof that a coding agent ran.

## Validation and handoff

- For documentation or artwork changes, check links, claims, rendering, and `git diff --check`; do not boot the game solely for a prose edit.
- For runtime changes, select the relevant checks in `local/AGENTS.md`. Run affected checks after fixes, and distinguish environment failures from test failures.
- Update documentation when a supported command, behavior, or verification status changes. Preserve dated historical results rather than silently recasting them as a new test run.
- Before committing, review the staged diff for unexpected submodule pointers, generated output, credentials, and unrelated edits. When asked to push, verify local/remote commit equality and report the working-tree state.

## Code Review Rules

- Flag changes that expose local services or real agent credentials to the browser/network unintentionally. Preserve loopback bindings and keep provider credentials in the trusted execution layer.
- Flag changes that erase player data or make verification mutate a person's normal account. Use dedicated fixtures and preserve existing accounts on startup.
- Flag unrecorded edits to vendored server sources or silent media-submodule drift that make a checkout unreproducible. Prefer an owned adapter or an explicit, documented dependency update.

Keep this file short and durable. Put specialized runtime guidance in `local/AGENTS.md`; do not turn instructions into a session log or a list of speculative features.
