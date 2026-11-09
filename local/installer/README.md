# Verified-download layer (`local/installer/`)

Resumable downloads, safe archive extraction, installing and verifying the official Claude Code executable, and installing the game media archive. Node 22+, ESM, no npm dependencies, no `package.json`.

| File | Purpose |
| --- | --- |
| `download.mjs` | `download()`: `Range` + `If-Range` resume, `.partial` file, size and SHA-256 checked before the final rename |
| `extract.mjs` | `extractArchive()`: in-process tar / tar.gz reader (ustar + pax, GNU long names), staging directory then atomic rename |
| `openpgp.mjs` | Detached OpenPGP signature verifier on `node:crypto` (RSA, v4) |
| `claude.mjs` | `installClaude()`, `verifyClaude()`, manifest and code-signature checks |
| `media.mjs` | `installMedia()`, `switchCurrent()`; hands a `source: "git"` manifest to `media-git.mjs` |
| `media-git.mjs` | `installGitMedia()`: the game media from a pinned Git commit, with the app's bundled Git |
| `cli.mjs` | JSON-line CLI |
| `claude-release.json` | The pinned Claude version, its checksum and the expected signing identity |
| `keys/claude-code.asc` | Anthropic's Claude Code release signing key (public) |
| `fixtures/` | A real 2.1.311 `manifest.json` and `manifest.json.sig` used by an offline test |
| `testlib.mjs` | Test helpers (HTTP fixtures, tar writer, tiny OpenPGP signer). Not a test file. |

## Why `node:crypto` and no OpenPGP dependency

The release key is a single RSA-4096 v4 primary key and the signatures are v4 binary-document signatures with SHA-256. Verifying that needs: packet parsing, the SHA-1 fingerprint, the signature hash trailer, and one `crypto.verify` call with PKCS#1 v1.5. That is about 200 lines (`openpgp.mjs`), has no supply chain, and runs on a clean Mac without `gpg`. The verifier is deliberately narrow: v4 RSA keys and SHA-2 hashes only; anything else is rejected. It does not model key expiry, revocation, or the web of trust. Trust comes from pinning the primary-key fingerprint. It was checked against a real Anthropic manifest and signature (see tests). If the release key ever moves to Ed25519 or a newer key version, `parsePublicKey` throws `unsupported ... algorithm` and the installer fails closed; at that point either extend the module or switch to a pinned library.

## Verification chain (`installClaude`)

1. Fetch `<base>/<version>/manifest.json` and `manifest.json.sig` (the version must match `^\d+\.\d+\.\d+$` and be >= 2.1.89).
2. Check the shipped key's primary fingerprint equals the one pinned in `claude.mjs` (`31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE`), then verify the signature over the exact manifest bytes. Failure is a `VERIFY` error and the binary is never requested.
3. Check `manifest.version`, and take `platforms["darwin-arm64"]` (`checksum`, `size`, `binary: "claude"`). If the requested version is the one in `claude-release.json`, the checksum and the manifest SHA-256 must also equal the pinned values.
4. Download `<base>/<version>/darwin-arm64/claude` to `<root>/downloads/` with `download()` (size + SHA-256).
5. `chmod 755`, then `codesign --verify --strict --verbose=2`, then `codesign -dv --verbose=4` and require: first `Authority=` is `Developer ID Application: Anthropic PBC (Q6L2SF6YDW)`, `TeamIdentifier=Q6L2SF6YDW`, `Identifier=com.anthropic.claude-code`.
6. Move (not copy) the file into a staging directory with `install.json`, then rename the directory to `<root>/versions/<version>/`. The binary's bytes are never changed, so Anthropic's signature stays intact. If an intact install is already present, `installClaude` returns it (`reused: true`) without network access.

`verifyClaude` rechecks the hash recorded in `install.json`, repeats the codesign checks, and runs `<path> --version` with a minimal environment (`PATH`, `HOME`, `TMPDIR`, `LANG`) plus `DISABLE_UPDATES=1` and `CLAUDE_CONFIG_DIR=<configDir>`. `configDir` is required; nothing defaults to `~/.claude`. The output must be the installed version.

Not done: notarization is not checked. `spctl -a -t exec` rejects a bare command-line binary ("the code is valid but does not seem to be an app"), so it cannot serve as a check. Hardened-runtime flags (`flags=0x10000(runtime)`) are observed but not asserted.

## Exported API

```js
// download.mjs
download({ url, dest, sha256, size, onProgress, signal, fetchImpl, retries = 4, backoffMs = 500, sleep, headers })
  // -> { path, sha256, size, resumedBytes, restarts, attempts, cached? }; onProgress({ done, total })
  // throws DownloadError { code: ABORTED | HTTP | NETWORK | VERIFY | SIZE }
sha256File(file, signal)

// extract.mjs
extractArchive({ archive, destDir, format /* tar | tar.gz | sniffed */, maxTotalBytes, maxEntries, replace, onProgress, signal })
  // -> { destDir, files, directories, bytes }; ExtractError { code: UNSAFE_PATH | UNSAFE_ENTRY | TOO_LARGE | BAD_ARCHIVE | ABORTED | EXISTS }
safeRelativePath(name)

// claude.mjs
installClaude({ version, root, onProgress, signal, fetchImpl, runner })  // -> { path, version, sha256, reused }
verifyClaude({ path, version, configDir, runner })  // -> { path, version, sha256, authority, teamId, versionOutput }
fetchChannelVersion('stable' | 'latest', { fetchImpl })   // beyond the contract
fetchVerifiedManifest({ version, ... }), checkCodeSignature(file, runner), parseCodesignDetails(text)
defaultRunner(cmd, args, { env, timeoutMs }) -> { code, stdout, stderr }   // execFile, no shell
loadReleasePin(), claudePaths(root, version), InstallerError { code: DOWNLOAD | VERIFY | DISK_SPACE | ABORTED | BAD_INPUT }
constants: RELEASE_BASE, SIGNING_KEY_FINGERPRINT, SIGNING_KEY_FILE, CODESIGN_AUTHORITY, CODESIGN_TEAM_ID, CODESIGN_IDENTIFIER, MIN_SIGNED_VERSION

// media.mjs
installMedia({ manifest, root, onProgress, signal, git })  // -> { dir, current, version, previous, pruned, reused }
switchCurrent(mediaDir, version), validateMediaManifest(manifest)

// media-git.mjs (installMedia calls it for source: "git")
installGitMedia({ manifest, root, git, onProgress, signal })  // -> { ..., downloadedBytes }
validateGitMediaManifest(manifest), gitEnvironment(env), gitVersion(git, env), MIN_GIT_VERSION

// openpgp.mjs
verifyDetached({ data, signature, publicKey, expectedFingerprint }), parsePublicKey, parseSignature, dearmor
```

`installClaude` also accepts test seams (`baseUrl`, `publicKey`, `fingerprint`, `platform`, `teamId`, `pin`). `installMedia` accepts `fetchImpl`, `statfs`, `keepPrevious`, `downloadOptions`; `installGitMedia` accepts `statfs`, `env`, `keepPrevious`, `batchSize`, `retries`, `backoffMs`, `sleep`, `pollMs` and `allowFileUrl` (tests only). Progress callbacks receive `{ label, done, total }`; the CLI adds `event` and `task`, and the controller turns the short labels into the text the setup screen shows.

Runner contract: `runner(cmd, args, { env, timeoutMs }) -> Promise<{ code, stdout, stderr }>`. It must resolve (not reject) on a non-zero exit. `codesign -dv` prints to stderr, and the parser reads both streams.

## Media

The release names the media in `local/controller/release.json`. Two manifest kinds are accepted.

### From a pinned Git commit (`source: "git"`, what the release uses)

The media's public source is the Git repository behind the checkout's `vanilla-media` submodule, `https://git.solero.me/solero/vanilla-media.git` (Solero's public GitLab). The release pins:

```json
{ "source": "git", "version": "e8666de19835", "url": "https://git.solero.me/solero/vanilla-media.git",
  "commit": "e8666de19835faf61782358d52a3b41c9226a00a", "tree": "0f18f38f74e02012f75330fcce148698a04bc1cb",
  "files": 86642, "size": <bytes downloaded>, "installedSize": 4264645163 }
```

`commit` is the submodule's pinned revision (the same files the checkout uses), `tree` its root tree, `files` the number of files in it, `installedSize` their total size, and `size` the pack data downloaded on a real install (see `local/VALIDATION.md`). The project hosts nothing: every install downloads from that server, as `git submodule update` does for a checkout.

The host's "download archive" link has no size and no `Range` support, so a dropped 4 GB download would restart and nothing could be pinned against it. `installGitMedia` uses Git itself, always the app's bundled Git (2.45 or newer is required; the app ships 2.56), never the user's:

1. `statfs` on `<root>/media`; need `installedSize` plus what is left of `size`, else `DISK_SPACE` with no network call.
2. In `<root>/media/<version>.partial/`: a shallow, blob-less fetch of the pinned commit (its trees only, about 2.5 MB), then `rev-parse <commit>^{tree}` must equal `tree`. A mismatch is `VERIFY` and the directory is removed.
3. `ls-tree -r`: every entry must be a regular file (`100644` or `100755`; symlinks and submodules are `VERIFY`), and the count must equal `files`.
4. The file contents (blobs) still missing are fetched by ID in batches of 2000 (`fetch --filter=blob:none --stdin`, as Git's own partial-clone fetch does). Each finished batch stays on disk; a failed batch is retried (four retries, backoff from 1 s), and a later run, after a quit, crash or cancel, fetches only what is still missing. Git checks every object it receives against its ID. Progress is the size of the fetched pack data, polled every 500 ms, against `size`.
5. An offline checkout (`GIT_NO_LAZY_FETCH=1`, so nothing missing is fetched silently), then `HEAD` must be the commit and `git status` must show no difference.
6. `.git` is deleted, `<version>.install.json` written, and the directory renamed to `<root>/media/<version>/` (the commit point), then `current` is switched as below.

Every Git command runs without a shell, with `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_TERMINAL_PROMPT=0`, no automatic `gc` or maintenance, and a stalled connection (under 1 KiB/s for 60 s) fails so the retry takes over. `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` and `ALL_PROXY` pass through; nothing else from the environment does. Peak disk use is the pack data plus the files (3.88 GB + 4.26 GB, about 8.1 GB); afterwards only the files remain (4.26 GB, 4.15 GiB on disk).

Integrity rests on Git's object IDs (SHA-1, with Git's collision detection) and the pinned commit and tree, fetched over HTTPS. Nothing is signed by the media's publisher.

### From an archive (`format: "tar"` or `"tar.gz"`)

`installMedia` takes `{ version, url, sha256, size, installedSize, format: "tar"|"tar.gz" }`. It is kept for a host that publishes a pinned archive; the release does not use it. `url` must be https (http only for loopback). Order of operations:

1. `fs.statfs` on `<root>/media`; need `size - existing partial bytes + installedSize` free, else `DISK_SPACE` with `{freeBytes, requiredBytes}` and no network call. The check does not include the previous media version, which is still on disk while the new one is extracted, so callers who care about that peak should add `installedSize` of the old version to their own preflight.
2. Resumable download to `<root>/downloads/media-<version>.<format>`.
3. Extract into a staging directory, cap `max(1.1 x installedSize, installedSize + 16 MiB)`, rename to `<root>/media/<version>/`. An existing `<version>` directory is treated as complete (the rename is the commit point).

### Switching versions (both kinds)

1. Create a temporary relative symlink and `rename` it over `<root>/media/current` (atomic: a reader sees the old or the new target, though on APFS a lookup that races the rename can fail briefly with ENOENT or EINVAL; a real directory named `current` is refused). The controller installs media only during setup, which it refuses while the game is running.
2. Only after the switch, delete the previous version (`keepPrevious: true` to keep it), the downloaded archive, and any unfinished `.partial` download of another version.

## Extraction rules

Only regular files (`0`/NUL) and directories (`5`) are accepted. Symlinks, hardlinks, character/block devices, FIFOs and contiguous files reject the whole archive, as do absolute paths, drive-letter paths, NUL, and any `..` segment, including paths introduced by pax `path` records or GNU long names. Declared file sizes are summed against `maxTotalBytes` before a file is written. Nothing is written outside the staging directory, which is deleted on any error or abort. Modes are normalised to 0755/0644 (no setuid, no sticky bits); ownership and mtime are not restored.

## CLI

```
node local/installer/cli.mjs claude --version 2.1.311 --root DIR [--config-dir DIR]
node local/installer/cli.mjs media  --manifest FILE --root DIR [--git PATH]
```

`--git` is required for a `source: "git"` manifest (the app passes `<runtimes>/git/bin/git`).

stdout is JSON lines: `{"event":"progress","task":"claude"|"media","label","done","total"}` (throttled to about 4 per second per label), `{"event":"problem","code","message","detail"}`, and a final `{"event":"done","task",...}` with `ok: true|false`. Exit status 0 or 1. Problem codes: `DOWNLOAD`, `VERIFY`, `DISK_SPACE`, `ABORTED`. `--version` defaults to the pin; `--config-dir` also runs `verifyClaude`. SIGINT and SIGTERM abort cleanly, leaving the `.partial` file for resume.

## Tests

`node --test local/installer/*.test.mjs` (50 tests, about 2 s, loopback servers on ephemeral ports, no network, no `gpg`). `media-git.test.mjs` builds small source repositories and fetches from them over `file://`; it uses `CP_TEST_GIT`, else the bundled `.local/runtimes/git/bin/git`, else `git` on `PATH`, and skips when none is 2.45 or newer. Test OpenPGP keys are generated at test time by `testlib.mjs`. One test uses the real Anthropic key with a committed real signed manifest for 2.1.311.

## Sources (all fetched 2026-11-08)

- Claude Code advanced setup, "Binary integrity and code signing", "Verify the manifest signature", "Platform code signatures", "Install a specific version", "Configure release channel", "Disable auto-updates": https://code.claude.com/docs/en/setup
- Docs index: https://code.claude.com/docs/llms.txt
- Release signing key: https://downloads.claude.ai/keys/claude-code.asc (copied to `keys/claude-code.asc`)
- Release bucket: https://downloads.claude.ai/claude-code-releases (`$REPO/$VERSION/manifest.json`, `$REPO/$VERSION/manifest.json.sig`)
- Linux package repository signing (same key, same fingerprint): https://downloads.claude.ai/claude-code/apt/stable and the key URL above
- Environment variables (`DISABLE_UPDATES`): https://code.claude.com/docs/en/env-vars
- Install script (not used or executed; only its URL is cited because the docs show it): https://claude.ai/install.sh

## What the docs say, and what was observed instead

Stated in the docs:
- The bucket `https://downloads.claude.ai/claude-code-releases`, `manifest.json` and `manifest.json.sig` under `<version>/`.
- `platforms.<platform>.checksum` is the binary's SHA-256.
- The signing key URL, user ID `Anthropic Claude Code Release Signing <security@anthropic.com>`, and fingerprint `31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE`.
- Signatures exist from 2.1.89 onward; earlier manifests have no detached signature.
- macOS binaries are "signed by Anthropic PBC and notarized by Apple".
- `DISABLE_UPDATES` blocks all update paths; `DISABLE_AUTOUPDATER` does not stop `claude update`.

Not stated in the docs; observed on 2026-11-08 with plain `curl` / Node requests:
- Channel pointers: `GET <base>/stable` returned `2.1.311` and `GET <base>/latest` returned `2.1.319`, each as a bare version string. The docs describe the channels but not these endpoints.
- Binary location: `<base>/<version>/<platform>/<manifest binary name>`, e.g. `.../2.1.311/darwin-arm64/claude` (HTTP 200, Content-Length equal to the manifest `size`, strong ETag, supports `Range`). Not in the docs; confirmed by download and by the checksum matching.
- Manifest fields beyond the documented `checksum`: top-level `version`, `commit`, `buildDate`, `manifestSignatureEnforcement` ("flag"), `sdkCompat`; per platform `binary`, `checksum`, `size`. Platform keys: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `linux-arm64-musl`, `linux-x64-musl`, `win32-x64`, `win32-arm64`. The installer reads only `version` and `platforms`.
- Key: RSA-4096 v4 primary key, created from packet timestamp 0x69caef70, a single user ID, no subkeys. The manifest signature is made by the primary key (issuer fingerprint subpacket present), a v4 SHA-256 binary-document signature.
- Code signature, from `codesign -dv --verbose=4` on the real 2.1.311 binary: `Identifier=com.anthropic.claude-code`, `Format=Mach-O thin (arm64)`, `flags=0x10000(runtime)`, `Authority=Developer ID Application: Anthropic PBC (Q6L2SF6YDW)`, `Authority=Developer ID Certification Authority`, `Authority=Apple Root CA`, `TeamIdentifier=Q6L2SF6YDW`. The docs give no team ID; `Q6L2SF6YDW` is pinned from this observation. Designated requirement: `identifier "com.anthropic.claude-code" and anchor apple generic and ... certificate leaf[subject.OU] = Q6L2SF6YDW`.
- `spctl -a -vv -t exec` reports `rejected (the code is valid but does not seem to be an app)` with `origin=Developer ID Application: Anthropic PBC (Q6L2SF6YDW)`.

Pin: `claude-release.json` records 2.1.311, the `stable` channel on 2026-11-08 (`latest` was 2.1.319). Update it by re-reading the manifest, verifying the signature with this module, and editing the pin together with a re-run of the real check.
