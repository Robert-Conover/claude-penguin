# Building the derived game modules without a JDK

The overlay builds (`build.py`, `adoption_build.py`) need a JDK and the pinned JPEXS. The macOS app can't assume either, and it can't ship the original game's bytes. So release CI publishes **patches** (see `PATCH_FORMAT.md`), and the app applies them to the user's own verified copy of the game media with `patcher.mjs` (Node 22+, no dependencies).

| File | Role |
| --- | --- |
| `PATCH_FORMAT.md` | The format. |
| `patchlib.py` | Shared format code and an independent Python applier (used by the audit and tests). |
| `patch_generate.py` | Release CI: reference build to patches (`.local/client-bridge-patches/`, git-ignored). |
| `patch_audit.py` | Release CI: literal audit and exact-reproduction check. |
| `patcher.mjs` | Shipped: verify, apply, install. Exports `applySwfPatch`, `installPatchSet`, `loadPatchSet`. |
| `test_patch.py`, `patcher.test.mjs` | Offline tests on synthetic SWFs. |

## Use

```sh
# Release CI, after python3 local/client-bridge/build.py (needs the JDK and vanilla-media/)
python3 local/client-bridge/patch_generate.py --media vanilla-media --reference .local/client-bridge --out .local/client-bridge-patches
python3 local/client-bridge/patch_audit.py    --media vanilla-media --reference .local/client-bridge --patches .local/client-bridge-patches --strict

# On the user's Mac
node local/client-bridge/patcher.mjs --media <dir with play/ and media/> --patches <patch dir> --out <data>/client-bridge [--patchset <id>] [--json]
```

`--json` prints `{"event":"progress","task":"extensions",...}` lines and a final `{"event":"done",...}` or `{"event":"problem","code","message"}`. Exit status: 0 installed, 1 failed, 2 usage. Failure codes: `ORIGINAL_MISSING`, `ORIGINAL_HASH` (wrong or modified file), `HEADER`, `LENGTH`, `RESULT_HASH`, `PATCH` (malformed or corrupt patch), `PATCHSET` (id mismatch, unreadable set), `INSTALL`.

`generate` refuses a reference build that was made from another original, doesn't match its record, or is stale against `bridge.as` / `ProjectAdoption.as` (`--skip-source-check` overrides for experiments).

## Install layout

```
<out>/<patchset>/engine.swf  puffle_adoption.swf  build.json  adoption-build.json  patchset.json
<out>/current -> <patchset>        (relative symlink, switched with a temp symlink and rename)
```

Everything is built in `<out>/.staging-*` first; if any step fails the staging directory is removed and `<out>/current` and earlier sets are untouched. Reinstalling an identical set is a no-op apart from re-pointing `current`; a damaged directory for the same id is replaced. Older sets are kept (for rollback); pruning is the controller's decision. `build.json` / `adoption-build.json` keep the fields `local/agent-start` and `local/doctor.py` check (`extensionSha256`, `outputSha256` of the installed file, `originalTagsUnchanged` / `deterministic`) and add `outputDecompressedSha256`, `outputDecompressedLength`, `patchset`, `derivedBy`.

## Serving

The web server serves `engine.swf` and `puffle_adoption.swf` straight out of its bridge directory (`serveFile` resolves symlinks and checks containment against the real path of the directory, so a `current` symlink works). Start it with `CLIENT_BRIDGE_ROOT=<out>/current`, not `<out>`, and note the browser sees no change until the next request (`cache-control: no-cache`). Running servers pick up a new set on the next request after the switch. A request that arrives during the rename itself can fail once on APFS (the lookup briefly returns ENOENT or EINVAL); it never sees a partly built set. The app patches only during setup, which the controller refuses while the game is running.

## Tests

```sh
python3 -m unittest discover -s local/client-bridge -p 'test_*.py'
node --test local/client-bridge/
```

## Known limits

- Output SWFs are recompressed by Node's zlib, so file hashes differ from the Python-built reference files; decompressed hashes are identical (`outputSha256` in the installed record describes the installed file).
- Only `FWS` and `CWS` originals are supported (the pinned modules are `CWS`, version 9).
- The audit checks that literals don't contain original bytes; it can't prove what a literal "means". Literal runs of 16 bytes or fewer may coincide with original bytes by chance.
