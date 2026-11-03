<p align="center">
  <img src="docs/assets/claude-penguin-banner.svg" alt="Claude Penguin — a snowy island for your coding agents. Concept illustration; agent integration is planned." width="100%">
</p>

<h1 align="center">Claude Penguin</h1>

<p align="center">
  <strong>Your coding agents. Their own little world.</strong><br>
  Bringing Claude Code to Club Penguin, one puffle at a time.
</p>

<p align="center">
  <a href="#the-idea">The idea</a> ·
  <a href="#where-things-stand">Current status</a> ·
  <a href="#play-locally">Play locally</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

> **Early development:** the original game runs locally. Connecting puffles to real Claude Code agents is the next step. The banner is concept art, not a screenshot of an implemented integration.

## The idea

What if your coding agents lived in Club Penguin?

Give a puffle a task. Let Claude Code do the work. See that little creature become the face of a real coding session, with progress you can follow inside the world.

That's the idea behind Claude Penguin: the original game's rooms, penguins, and puffles, with a new reason to hang out on the island. The starting point is the full game client, including town, shops, rooms, and minigames. The coding-agent layer comes next.

## Where things stand

| | Today |
| :--- | :--- |
| 🐧 **Explore the island** | The AS3 client runs through Ruffle in the browser. Login, walking, room travel, and the introductory tour have passed interactive checks. |
| 🛍️ **Make it yours** | Catalog browsing, purchases, equipped color, and puffle adoption and walking have been checked in Safari. |
| 💾 **Keep your progress** | Local accounts and game state persist. Backend reconnect and stack-restart checks passed. |
| 🎮 **Keep testing** | Cart Surfer reaches active gameplay. Completed rounds, rewards, browser furniture placement, and some other interactions still need verification. |
| ✨ **Puffles as agents** | Planned. No Claude Code connection, task execution, or agent-status UI is implemented yet. |

See the [validation record](local/VALIDATION.md) for the exact tested scope. Available game assets do not imply that every original feature works.

## Play locally

The current launcher targets **macOS with Colima**. The baseline was verified on Apple Silicon using Safari.

You need Git, Python 3, Homebrew, and the standard macOS `curl` and `unzip` tools. Install the container tools:

```sh
brew install colima docker docker-compose
```

Then get the project and start the island:

```sh
git clone https://github.com/Robert-Conover/claude-penguin.git
cd claude-penguin
./local/start
```

Open **[localhost:8080](http://localhost:8080/)**.

| Local account | Password |
| :--- | :--- |
| `player` | `PenguinLocal2026!` |

This disposable development account starts with membership and 100,000 coins. No Claude Code account or API key is needed to try the current game baseline.

The first launch downloads pinned submodules, about **4.1 GB of archived media**, and Ruffle, then builds the services. The dedicated VM is configured with 4 CPUs, 4 GB RAM, and a 30 GB disk. Published service ports bind to localhost.

```sh
./local/stop    # Stop the containers and dedicated VM; keep player progress.
```

For logs, troubleshooting, and verification commands, see [LOCAL_SETUP.md](LOCAL_SETUP.md).

## What comes next

- [x] Get the original game running locally.
- [x] Verify core gameplay and persistent state.
- [ ] Connect a real Claude Code session to a puffle.
- [ ] Reflect the agent's actual task progress in the game.
- [ ] Build out the experience for multiple agents.

## Under the snow

The browser runs the original Flash client through **Ruffle**. A small Node.js wrapper serves the game and bridges its sockets to **Houdini**, with **Dash**, **Snowflake**, PostgreSQL, and Redis supporting the local world.

| Path | What's there |
| :--- | :--- |
| [`local/`](local/) | Mac launcher, browser bridge, compatibility wrappers, and verification helpers |
| [`local/sources.json`](local/sources.json) | Exact upstream revisions and the Ruffle release/checksum |
| `houdini/`, `dash/`, `snowflake/` | Pinned community server submodules |
| `vanilla-media/` | Pinned archived client and game media |

The client archive is the later AS3 generation of original Club Penguin. It is not a claim of an exact, complete final-day snapshot. The legacy AS2 media is not downloaded by the local launcher.

## Build with us

Development happens on **`dev`**. Promotions go **`dev` → `main`** through pull requests; there is no `qa` branch.

Start with [CONTRIBUTING.md](CONTRIBUTING.md). Coding agents use [AGENTS.md](AGENTS.md); Claude Code has a [shared-guidance entry point](CLAUDE.md). Reproducible bug reports and focused contributions are welcome, especially around the remaining gameplay checks.

## Credits

This project builds on the preservation and server work of [Solero Wand](https://github.com/solero/wand), [Houdini](https://github.com/solero/houdini), [Dash](https://github.com/solero/dash), [Snowflake](https://github.com/Lekuruu/snowflake), the archived vanilla-media client, and [Ruffle](https://ruffle.rs/).

Upstream history and the [Wand MIT license](LICENSE.md) are preserved. Referenced components retain their own licensing; the Wand license does not grant rights to Club Penguin artwork or other game assets.

Claude Penguin is an unofficial experiment, unaffiliated with Disney or Anthropic.
