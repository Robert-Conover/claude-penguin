# Contributing to Claude Penguin

The game baseline runs locally. Our next milestone is connecting real Claude Code sessions to puffles. The README describes the direction; it is not an implementation specification for that integration.

## Branches and promotions

```text
focused branches (optional) → dev → main
```

- `dev` is the development branch. Start new work there, or create a focused branch from it and open a PR back to `dev`.
- `main` receives promotion PRs from `dev`. There is no `qa` branch.
- Keep promotion PRs open for review unless merging was explicitly requested.
- Push to your fork or this repository's `origin`, never to the upstream game projects by accident.

For a contributor branch:

```sh
git fetch origin
git switch dev
git pull --ff-only origin dev
git switch -c feature/your-change
```

These are repository conventions. Instruction files do not configure GitHub branch protection or required checks.

## Make a focused change

Use [LOCAL_SETUP.md](LOCAL_SETUP.md) to run the game. Most owned runtime code lives in `local/`; the game/server directories are pinned upstream submodules. Preserve their revisions unless the dependency update is part of the change.

Use the [runtime check matrix](local/AGENTS.md#validation-by-change) to choose validation. Documentation changes need link and rendering checks; they do not require restarting the game. For runtime work, report the command you ran and its result. Call out unavailable environments or untested UI paths plainly.

A useful pull request explains the concrete problem, the resulting behavior, and relevant validation. For a visible change, include an actual screenshot or recording and label mockups as concepts. Preserve upstream attribution and avoid adding generated artifacts or local credentials.

## Report a bug

Include the commit, macOS/browser version, room or game involved, reproduction steps, expected versus actual behavior, and relevant redacted logs. Check [known validation gaps](local/VALIDATION.md#not-yet-verified) before describing a feature as verified. Do not attach `.local/env` or an expanded Compose configuration.

## Working with coding agents

[AGENTS.md](AGENTS.md) is the shared source of repository guidance. [local/AGENTS.md](local/AGENTS.md) adds commands and compatibility rules for runtime work. The small [CLAUDE.md](CLAUDE.md) and [local/CLAUDE.md](local/CLAUDE.md) entry points import the corresponding guidance for Claude Code without duplicating the rules.

Keep instructions concrete: useful commands, non-obvious constraints, and where to look for task-specific details. Put long explanations in ordinary docs. Revise rules when the code changes; avoid duplicate rule sets, exhaustive mandatory reading, or session logs in instruction files.

This structure follows OpenAI's guidance on [instruction discovery and scope](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [keeping agent context focused](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra), and [concise repository review rules](https://developers.openai.com/blog/custom-code-review-rules-for-codex), alongside the [AGENTS.md format](https://agents.md/) and Anthropic's [project-memory guidance](https://code.claude.com/docs/en/memory).
