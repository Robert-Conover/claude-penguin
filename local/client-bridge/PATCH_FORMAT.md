# Extension patch format

Format id: `claude-penguin/swf-patch/1`. A patch rebuilds one derived SWF module (`engine.swf`, `puffle_adoption.swf`) from the user's own copy of the original, without carrying the original's bytes. It is a list of two kinds of operation: copy a range of the original, or insert a literal. Literals hold only project-authored content (the project code tags, the hook prologues and the length, count and constant-pool fields they touch). `patch_audit.py` enforces that in release CI.

"Decompressed contents" below means the SWF body: the bytes after the 8-byte header, after zlib inflation for `CWS`. The patcher and the audit compare hashes of decompressed contents, so the recompression level never matters.

## Patch file (`<target>.patch.json`, UTF-8 JSON)

```json
{
  "format": "claude-penguin/swf-patch/1",
  "target": "engine.swf",
  "recordFile": "build.json",
  "original": {
    "path": "media/play/v2/client/engine.swf",
    "sha256": "<file SHA-256>",
    "decompressedSha256": "<SHA-256 of the body>",
    "decompressedLength": 0,
    "signature": "CWS",
    "version": 9
  },
  "result": {
    "decompressedSha256": "<SHA-256 of the built body>",
    "decompressedLength": 0,
    "signature": "CWS",
    "version": 9,
    "compression": "zlib"
  },
  "record": { "...": "build record fields, see below" },
  "ops": [
    ["copy", 0, 1000],
    ["insert", "<base64>"]
  ]
}
```

- `target`: output file name (plain name: `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`). `recordFile`: name of the build record written next to it (`build.json`, `adoption-build.json`; the files `local/agent-start`, `local/doctor.py` and the web server read).
- `original.path`: relative to the media root (the directory holding `play/` and `media/`); no `.`/`..` parts, no absolute paths.
- `signature`: `CWS` (zlib) or `FWS` (uncompressed); other signatures (`ZWS`) are refused. `CWS` needs version 6 or later. `result.compression` is `zlib` for `CWS` and `none` for `FWS`.
- Hashes are lowercase hex SHA-256. `decompressedLength` is the body length; the SWF header's declared length is always `decompressedLength + 8`.
- `ops` are applied in order and concatenated to form the result body:
  - `["copy", offset, length]`: `length > 0` bytes of the original body starting at `offset`; the range must lie inside the body.
  - `["insert", base64]`: non-empty, canonical standard base64 (no whitespace, correct padding).
  - Nothing else is allowed. The lengths must add up to `result.decompressedLength`.
- `record` is optional: the reference build record without `outputSha256`, `outputDecompressedSha256` and `outputDecompressedLength`. The patcher writes it as `recordFile` after adding the hash and length of the file it produced, the patch set id and `"derivedBy": "patcher.mjs"`. It contains no original bytes (hashes, compiler pins, hook list).
- Unknown fields are refused, so a patch cannot smuggle extra data.

## Patch set (`patchset.json`, next to the patch files)

```json
{
  "format": "claude-penguin/swf-patchset/1",
  "id": "ps-ae39499484a07eb8",
  "patches": [{ "file": "engine.swf.patch.json", "sha256": "<file SHA-256>", "target": "engine.swf" }]
}
```

`id` names the install directory and the value the release pins (`--id`, or by default `ps-` plus 16 hex digits of the hash over the patch file hashes). The id is `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` and not `current`. Each patch file's hash is checked before it is parsed.

## Processing order (patcher)

1. Check the patch set manifest and each patch file hash; check patch structure.
2. Verify the original file SHA-256; parse its header: signature and version equal the patch; declared length equals the inflated length (inflation is bounded by the declared length); decompressed length and hash equal the patch.
3. Apply the ops; check the result length and decompressed SHA-256.
4. Write the SWF with the result's signature and version (CWS: zlib level 9 through `node:zlib`; byte equality with Python's zlib output is not promised), re-parse the output header, install atomically.

## Generator and audit rules

- `patch_generate.py`: greedy longest match against the original body through hash chains over every k-byte window (k = 16 by default, 4-16 allowed). Any run of at least k bytes that occurs anywhere in the original becomes a copy; matches are extended backwards over pending literal bytes; adjacent contiguous copies merge. Output is deterministic (no Python hash randomization involved).
- `patch_audit.py`: fails if a literal run (adjacent inserts merged) longer than 16 bytes occurs in the original body; with `--strict`, if any 16-byte window of any literal does; if applying the patch to the original does not give the reference build's decompressed contents; or if any patch or manifest hash does not match. Reports literal bytes per patch and per set.
