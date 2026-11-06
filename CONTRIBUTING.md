# Contributing to Claude Penguin

The game runs locally. With the host engine enabled, each registered repository has its own igloo and one puffle with a persistent Claude Code session. Sessions in different repositories can run concurrently. See the [agent engine guide](local/AGENT_ENGINE.md) for the supported scope and the dated [validation record](local/VALIDATION.md) for live acceptance evidence and remaining gaps.

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

Use [LOCAL_SETUP.md](LOCAL_SETUP.md) to run the game. Most owned runtime code lives in `local/`; `houdini/`, `dash/`, and `snowflake/` are vendored upstream server sources, and `vanilla-media/` is a pinned media submodule. Preserve their recorded revisions unless the dependency update is part of the change.

Use the [runtime check matrix](local/AGENTS.md#validation-by-change) to choose validation. Documentation changes need link and rendering checks; they do not require restarting the game. For runtime work, report the command you ran and its result. Call out unavailable environments or untested UI paths plainly.

A useful pull request explains the concrete problem, the resulting behavior, and relevant validation. For a visible change, include an actual screenshot or recording and label mockups as concepts. Preserve upstream attribution and avoid adding generated artifacts or local credentials.

## Automated regression checks

The [Regression checks workflow](.github/workflows/regression.yml) runs on pull requests targeting `dev` or `main`, pushes to those branches, and manual dispatch. It uses Node 22 and Python 3.12 on Ubuntu and macOS, installs locked dependencies with scripts disabled, checks launcher syntax, and runs the engine, web/UI, game-bridge contract, and synthetic SWF preservation suites, plus host tests for igloo provisioning and the native map adapter.

CI checks out only owned source. It does not download the media submodule or start the game or Claude. The generated-overlay preservation test explicitly skips without a built overlay; run the [overlay build and preservation checks](local/client-bridge/README.md#build-and-verify) locally for client changes. Houdini container regressions, real game transport, browser interactions, and live Claude permissions/interruption also remain separate acceptance checks. A green workflow does not establish those behaviors.

The workflow grants read-only repository permissions and needs no provider credentials. These checks do not configure branch protection or make themselves required for merging.

## Report a bug

Include the commit, macOS/browser version, room or game involved, reproduction steps, expected versus actual behavior, and relevant redacted logs. Check [known validation gaps](local/VALIDATION.md#not-yet-verified) before describing a feature as verified. Do not attach `.local/env` or an expanded Compose configuration.

## Working with coding agents

[AGENTS.md](AGENTS.md) is the shared source of repository guidance. [local/AGENTS.md](local/AGENTS.md) adds commands and compatibility rules for runtime work. The small [CLAUDE.md](CLAUDE.md) and [local/CLAUDE.md](local/CLAUDE.md) entry points import the corresponding guidance for Claude Code without duplicating the rules.

Keep instructions concrete: useful commands, non-obvious constraints, and where to look for task-specific details. Put long explanations in ordinary docs. Revise rules when the code changes; avoid duplicate rule sets, exhaustive mandatory reading, or session logs in instruction files.

This structure follows OpenAI's guidance on [instruction discovery and scope](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [keeping agent context focused](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra), and [concise repository review rules](https://developers.openai.com/blog/custom-code-review-rules-for-codex), alongside the [AGENTS.md format](https://agents.md/) and Anthropic's [project-memory guidance](https://code.claude.com/docs/en/memory).
