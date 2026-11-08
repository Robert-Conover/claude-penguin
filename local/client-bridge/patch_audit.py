#!/usr/bin/env python3
"""CI audit of extension patches (see PATCH_FORMAT.md).

    python3 local/client-bridge/patch_audit.py --media vanilla-media \\
        --reference .local/client-bridge --patches .local/client-bridge-patches --strict

Fails (exit 1) when
  * a patch or the patch set manifest is malformed or does not match its recorded hash;
  * a literal run longer than 16 bytes also occurs in the original's decompressed contents;
  * with --strict, any 16-byte window of any literal occurs in the original;
  * applying the patch to the original does not reproduce the reference result exactly.
Reports literal bytes per patch and for the set.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault(name, module)
    spec.loader.exec_module(module)
    return module


lib = sys.modules.get('patchlib') or _load('patchlib', 'patchlib.py')
generator = sys.modules.get('patch_generate') or _load('patch_generate', 'patch_generate.py')


def audit_patch(patch, original_swf, reference_swf=None, strict=False, limit=lib.LITERAL_AUDIT_LIMIT):
    """Returns (problems, stats) for one decoded patch."""
    problems = []
    try:
        ops = lib.validate_patch(patch)
        result_body, _ = lib.apply_patch(original_swf, patch)
    except lib.PatchError as error:
        return [f'{error.code}: {error}'], {'literalBytes': 0, 'ops': 0}
    _, _, original_body = lib.split_swf(original_swf, 'original')
    runs = lib.literal_runs(ops)
    for number, run in enumerate(runs):
        if len(run) > limit and run in original_body:
            problems.append(f'literal run {number} ({len(run)} bytes) also occurs in the original')
    if strict and not problems:
        index = generator.WindowIndex(original_body, limit)
        for number, run in enumerate(runs):
            for i in range(len(run) - limit + 1):
                if index.contains_window(run[i:i + limit]):
                    problems.append(f'literal run {number} contains an original {limit}-byte window at +{i}')
                    break
    if reference_swf is not None:
        _, _, expected = lib.split_swf(reference_swf, 'reference')
        if result_body != expected:
            problems.append('patched result differs from the reference build')
    stats = {'literalBytes': sum(len(run) for run in runs), 'literalRuns': len(runs), 'ops': len(ops),
             'copyBytes': sum(op[2] for op in ops if op[0] == 'copy'), 'resultBytes': len(result_body)}
    return problems, stats


def audit_set(media, reference, patches, strict=False, log=print):
    media, reference, patches = Path(media), Path(reference), Path(patches)
    problems, report = [], {'patches': {}, 'totalLiteralBytes': 0, 'totalPatchBytes': 0}
    try:
        manifest = lib.validate_manifest(json.loads((patches / lib.MANIFEST_NAME).read_text()))
    except (OSError, ValueError, lib.PatchError) as error:
        return [f'manifest: {error}'], report
    report['id'] = manifest['id']
    for entry in manifest['patches']:
        name = entry['target']
        raw = (patches / entry['file']).read_bytes()
        if lib.sha256(raw) != entry['sha256']:
            problems.append(f'{name}: patch file does not match the manifest hash')
            continue
        patch = json.loads(raw)
        if patch.get('target') != name:
            problems.append(f'{name}: patch target differs from the manifest')
            continue
        original = (media / patch['original']['path']).read_bytes()
        pair = next((p for p in generator.PAIRS if p[0] == name), None)
        ref = (reference / pair[2]).read_bytes() if pair else None
        if ref is None:
            problems.append(f'{name}: no reference build is known for this target')
        found, stats = audit_patch(patch, original, ref, strict)
        stats.update(patchBytes=len(raw))
        report['patches'][name] = stats
        report['totalLiteralBytes'] += stats['literalBytes']
        report['totalPatchBytes'] += len(raw)
        problems += [f'{name}: {text}' for text in found]
        log(f'{name}: {stats["literalBytes"]} literal bytes in {stats.get("literalRuns", 0)} runs, '
            f'{stats["ops"]} ops, {len(raw)} bytes of patch: {"FAIL" if found else "ok"}')
    log(f'patch set {manifest["id"]}: {report["totalLiteralBytes"]} literal bytes, {report["totalPatchBytes"]} bytes of patches')
    return problems, report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--media', default='vanilla-media')
    parser.add_argument('--reference', default='.local/client-bridge')
    parser.add_argument('--patches', default='.local/client-bridge-patches')
    parser.add_argument('--strict', action='store_true', help='also reject any original 16-byte window inside a literal')
    parser.add_argument('--max-literal-bytes', type=int, help='fail if the set holds more literal bytes than this')
    args = parser.parse_args(argv)
    problems, report = audit_set(args.media, args.reference, args.patches, args.strict)
    if args.max_literal_bytes is not None and report['totalLiteralBytes'] > args.max_literal_bytes:
        problems.append(f'literal budget exceeded: {report["totalLiteralBytes"]} > {args.max_literal_bytes}')
    for problem in problems:
        print(f'AUDIT FAILURE: {problem}', file=sys.stderr)
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
