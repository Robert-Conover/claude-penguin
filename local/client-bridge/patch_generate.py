#!/usr/bin/env python3
"""Generate copy/insert extension patches from the reference builds (see PATCH_FORMAT.md).

Run in release CI after ``build.py``:

    python3 local/client-bridge/patch_generate.py --media vanilla-media \\
        --reference .local/client-bridge --out .local/client-bridge-patches

Greedy longest match against the original's decompressed bytes through a
hash-chain index of k-byte windows (k <= 16). Any run of k or more bytes that
occurs anywhere in the original becomes a copy, so literals hold only bytes the
original does not contain (plus runs shorter than k). Output is deterministic.
"""
from __future__ import annotations

import argparse
import base64
from array import array
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import zlib

HERE = Path(__file__).resolve().parent


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault(name, module)
    spec.loader.exec_module(module)
    return module


lib = sys.modules.get('patchlib') or _load('patchlib', 'patchlib.py')

NONE = 0xFFFFFFFF
DEFAULT_K = 16
MAX_CANDIDATES = 32      # verified candidates compared per position
CLIENT_DIR = 'media/play/v2/client/'
# (target, original path under the media root, reference output, build record, extension source)
PAIRS = [
    ('engine.swf', CLIENT_DIR + 'engine.swf', 'engine.swf', 'build.json', 'bridge.as'),
    ('puffle_adoption.swf', CLIENT_DIR + 'puffle_adoption.swf', 'puffle_adoption.swf', 'adoption-build.json', 'ProjectAdoption.as'),
]
RECORD_DROP = ('outputSha256', 'outputDecompressedSha256', 'outputDecompressedLength')


class WindowIndex:
    """Hash chains over every k-byte window of ``data`` (lowest offsets first)."""

    def __init__(self, data, k=DEFAULT_K):
        if not 4 <= k <= 16:
            raise ValueError('k must be between 4 and 16')
        self.data, self.k = data, k
        count = max(len(data) - k + 1, 0)
        bits = max(16, min(24, count.bit_length() + 1))
        self.mask = (1 << bits) - 1
        self.head = array('I', [NONE]) * (self.mask + 1)
        self.prev = array('I', [NONE]) * max(count, 1)
        crc, head, prev, mask = zlib.crc32, self.head, self.prev, self.mask
        for i in range(count - 1, -1, -1):
            slot = crc(data[i:i + k]) & mask
            prev[i] = head[slot]
            head[slot] = i

    def contains_window(self, window):
        return self._first(window) != NONE

    def _first(self, window):
        i = self.head[zlib.crc32(window) & self.mask]
        while i != NONE:
            if self.data[i:i + self.k] == window:
                return i
            i = self.prev[i]
        return NONE

    def longest(self, target, p):
        """(offset, length) of the longest original run equal to target[p:], or None."""
        k, data = self.k, self.data
        window = target[p:p + k]
        if len(window) < k:
            return None
        i = self.head[zlib.crc32(window) & self.mask]
        best, offset, seen = 0, -1, 0
        while i != NONE:
            if data[i:i + k] == window:
                length = k + common_prefix(data, i + k, target, p + k)
                if length > best:
                    best, offset = length, i
                seen += 1
                if seen >= MAX_CANDIDATES:
                    break
            i = self.prev[i]
        return (offset, best) if best else None


def common_prefix(a, ai, b, bi):
    limit = min(len(a) - ai, len(b) - bi)
    done, chunk = 0, 64
    while done < limit:
        size = min(chunk, limit - done)
        if a[ai + done:ai + done + size] == b[bi + done:bi + done + size]:
            done += size
            chunk = min(chunk * 2, 1 << 20)
            continue
        low, high = 0, size - 1
        while low < high:
            mid = (low + high + 1) // 2
            if a[ai + done:ai + done + mid] == b[bi + done:bi + done + mid]:
                low = mid
            else:
                high = mid - 1
        return done + low
    return done


def diff_ops(original, result, k=DEFAULT_K, index=None):
    """Ops list for result against original body bytes."""
    index = index or WindowIndex(original, k)
    ops, literal, p, n = [], bytearray(), 0, len(result)

    def flush():
        if literal:
            ops.append(['insert', base64.b64encode(bytes(literal)).decode()])
            literal.clear()

    while p < n:
        found = index.longest(result, p)
        if found is None:
            literal.append(result[p])
            p += 1
            continue
        offset, length = found
        # Reclaim pending literal bytes that the original also has just before the match.
        while literal and offset > 0 and original[offset - 1] == literal[-1]:
            literal.pop()
            offset -= 1
            length += 1
        flush()
        if ops and ops[-1][0] == 'copy' and ops[-1][1] + ops[-1][2] == offset:
            ops[-1][2] += length
        else:
            ops.append(['copy', offset, length])
        p += length - (found[0] - offset)
    flush()
    return ops


def make_patch(original_swf, result_swf, *, target, original_path, record_file, record=None, k=DEFAULT_K):
    o_sig, o_ver, o_body = lib.split_swf(original_swf, 'original')
    r_sig, r_ver, r_body = lib.split_swf(result_swf, 'result')
    patch = {
        'format': lib.PATCH_FORMAT,
        'target': target,
        'recordFile': record_file,
        'original': {'path': original_path, 'sha256': lib.sha256(original_swf),
                     'decompressedSha256': lib.sha256(o_body), 'decompressedLength': len(o_body),
                     'signature': o_sig, 'version': o_ver},
        'result': {'decompressedSha256': lib.sha256(r_body), 'decompressedLength': len(r_body),
                   'signature': r_sig, 'version': r_ver, 'compression': lib.COMPRESSION[r_sig]},
        'ops': diff_ops(o_body, r_body, k),
    }
    if record is not None:
        patch['record'] = {key: value for key, value in record.items() if key not in RECORD_DROP}
    # The generator never trusts itself: re-apply with the independent reference applier.
    rebuilt, _ = lib.apply_patch(original_swf, json.loads(lib.dump_patch(patch)))
    if rebuilt != r_body:
        raise lib.PatchError('RESULT_HASH', 'generated patch does not reproduce the result')
    return patch


def check_reference(media, reference, sources, pair, strict_sources=True):
    target, original_path, ref_name, record_name, extension = pair
    original = (media / original_path).read_bytes()
    result = (reference / ref_name).read_bytes()
    record = json.loads((reference / record_name).read_text())
    if record.get('sourceSha256') != lib.sha256(original):
        raise lib.PatchError('REFERENCE', f'{target}: the reference build was made from a different original')
    if record.get('outputSha256') != lib.sha256(result):
        raise lib.PatchError('REFERENCE', f'{target}: {record_name} does not describe {ref_name}')
    _, _, body = lib.split_swf(result, target)
    if 'outputDecompressedSha256' in record and (record['outputDecompressedSha256'] != lib.sha256(body)
                                                 or record['outputDecompressedLength'] != len(body)):
        raise lib.PatchError('REFERENCE', f'{target}: decompressed hash in {record_name} is wrong')
    if strict_sources and record.get('extensionSha256') != lib.sha256((sources / extension).read_bytes()):
        raise lib.PatchError('REFERENCE', f'{target}: the reference build is stale ({extension} changed); rebuild it')
    return original, result, record


def generate(media, reference, out, sources=HERE, patchset_id=None, k=DEFAULT_K, strict_sources=True, log=print):
    media, reference, out = Path(media), Path(reference), Path(out)
    out.mkdir(parents=True, exist_ok=True)
    entries = []
    for pair in PAIRS:
        started = time.time()
        original, result, record = check_reference(media, reference, Path(sources), pair, strict_sources)
        patch = make_patch(original, result, target=pair[0], original_path=pair[1], record_file=pair[3], record=record, k=k)
        text = lib.dump_patch(patch)
        file = f'{pair[0]}.patch.json'
        write_atomic(out / file, text.encode())
        entries.append({'file': file, 'sha256': lib.sha256(text.encode()), 'target': pair[0]})
        literal = sum(len(run) for run in lib.literal_runs(lib.validate_patch(patch)))
        log(f'{pair[0]}: {len(patch["ops"])} ops, {literal} literal bytes, {len(text)} bytes of patch, {time.time() - started:.1f}s')
    manifest = {'format': lib.PATCHSET_FORMAT, 'id': patchset_id or lib.manifest_id(entries), 'patches': entries}
    lib.validate_manifest(manifest)
    write_atomic(out / lib.MANIFEST_NAME, (json.dumps(manifest, indent=2, sort_keys=True) + '\n').encode())
    return manifest


def write_atomic(path, data):
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_bytes(data)
    os.replace(temporary, path)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--media', default='vanilla-media', help='directory holding play/ and media/ (read only)')
    parser.add_argument('--reference', default='.local/client-bridge', help='reference build output directory')
    parser.add_argument('--out', default='.local/client-bridge-patches')
    parser.add_argument('--sources', default=str(HERE), help='directory holding bridge.as and ProjectAdoption.as')
    parser.add_argument('--id', help='patch set id (default: derived from the patch contents)')
    parser.add_argument('--min-match', type=int, default=DEFAULT_K, help='k, the shortest run copied (4-16)')
    parser.add_argument('--skip-source-check', action='store_true', help='do not require the reference build to match the current sources')
    args = parser.parse_args(argv)
    try:
        manifest = generate(args.media, args.reference, args.out, args.sources, args.id, args.min_match, not args.skip_source_check)
    except (lib.PatchError, OSError, ValueError) as error:
        print(f'patch_generate: {error}', file=sys.stderr)
        return 1
    print(f'Patch set {manifest["id"]} written to {args.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
