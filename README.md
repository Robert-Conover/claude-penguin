# Claude Penguin

An experiment in bringing Claude Code agents into Club Penguin, with puffles representing agents in the game world.

The current baseline runs the original AS3 client locally through Ruffle, backed by community game servers. Login, room travel, catalogs, purchases, and puffle adoption/walking have been verified. Claude Code integration is planned; it has not been implemented yet.

## Run locally on macOS

Install Git, Python 3, and the Homebrew packages `colima`, `docker`, and `docker-compose`, then:

```sh
git clone https://github.com/Robert-Conover/claude-penguin.git
cd claude-penguin
./local/start
```

The launcher downloads the pinned game submodules and Ruffle runtime on first use. The archived media alone is about 4.1 GB.

Open **http://localhost:8080/** and sign in with the disposable development account **player / PenguinLocal2026!**.

Stop the local stack with `./local/stop`. Player progress is preserved between runs.

See [local setup](LOCAL_SETUP.md), [validation results and remaining gaps](local/VALIDATION.md), and [pinned source revisions](local/sources.json).

## Credits and source layout

Built on [Solero Wand](https://github.com/solero/wand), [Houdini](https://github.com/solero/houdini), [Dash](https://github.com/solero/dash), [Snowflake](https://github.com/Lekuruu/snowflake), and the archived vanilla-media client. Game components remain pinned upstream submodules; the Mac launcher, compatibility wrappers, and checks live in `local/`.

Upstream history and the [Wand license](LICENSE.md) are preserved. Referenced components retain their own licensing; the Wand license does not license Club Penguin artwork or other game assets. This is an unofficial experiment.

<details>
<summary>Original Wand setup instructions (upstream reference)</summary>

## Wand

Wand makes it easy to configure dash, houdini and a media server utilizing docker & docker-compose.

> [!NOTE]
> This can also be ran on Windows using WSL.

## Installation script
**Step 1** run the script
```bash
bash <(curl -s https://raw.githubusercontent.com/solero/wand/master/install.sh)
```
**Step 2** Answer Questions which are:
* Database password (Leave blank for random password)
* Hostname (example: `clubpenguin.com`) (Leave empty for localhost)
* External IP Address (Leave empty for localhost)
**Step 3** Run and enjoy.
Run this command:
```bash
$ cd wand && sudo docker-compose up
```
## Manual setup

> [!IMPORTANT]
> This is not recommended for beginners. If you're not sure what you're doing, use the install script.

**Step 1** Choose your Linux Distribution

<details>
  <summary>Debian/Ubuntu</summary>

```bash
$ sudo apt update
$ sudo apt install git curl
$ curl -fsSL https://get.docker.com -o get-docker.sh
$ sh get-docker.sh
$ sudo curl -L "https://github.com/docker/compose/releases/download/v2.20.3/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
$ sudo chmod +x /usr/local/bin/docker-compose
```
</details>

<details>
  <summary>Fedora/RHEL</summary>
  
```bash
$ sudo dnf update
$ sudo dnf install git curl
$ curl -fsSL https://get.docker.com -o get-docker.sh
$ sh get-docker.sh
$ sudo curl -L "https://github.com/docker/compose/releases/download/v2.20.3/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
$ sudo chmod +x /usr/local/bin/docker-compose
```
</details>

<details>
  <summary>Arch based distros</summary>
  
```bash
$ sudo pacman -Syu
$ sudo pacman -S docker docker-compose git curl
$ systemctl start docker.service
$ systemctl enable docker.service
```
</details>


**Step 2** Clone the repository & submodules
```bash
$ git clone --recurse-submodules https://github.com/solero/wand && cd wand
```

**Step 3** Edit the config file (optional, default values are fine for a local setup)
```bash
$ nano .env
```

**Step 4** Start the services
```bash
$ sudo docker-compose up
```

**Step 5** You're done!

</details>
