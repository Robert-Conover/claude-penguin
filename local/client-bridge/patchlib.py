"""Shared pieces of the extension patch format (see PATCH_FORMAT.md).

Python 3.9+, standard library only. The generator, the audit and the tests use
this; the shipped applier is ``patcher.mjs``. ``apply_patch`` here is a second,
independent implementation that the audit uses as a cross-check.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
import struct
import zlib

PATCH_FORMAT = 'claude-penguin/swf-patch/1'
PATCHSET_FORMAT = 'claude-penguin/swf-patchset/1'
MANIFEST_NAME = 'patchset.json'
LITERAL_AUDIT_LIMIT = 16
MAX_BODY = 256 * 1024 * 1024

NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
HEX64 = re.compile(r'^[0-9a-f]{64}$')
COMPRESSION = {'CWS': 'zlib', 'FWS': 'none'}


class PatchError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def split_swf(data, label='SWF'):
    """(signature, version, body) of a CWS or FWS file, checking the declared length."""
    if len(data) < 9:
        raise PatchError('HEADER', f'{label}: too short for a SWF')
    signature = data[:3].decode('latin-1')
    if signature not in COMPRESSION:
        raise PatchError('HEADER', f'{label}: unsupported SWF signature {signature!r}')
    version = data[3]
    declared = struct.unpack_from('<I', data, 4)[0]
    if signature == 'CWS':
        if version < 6:
            raise PatchError('HEADER', f'{label}: zlib-compressed SWF needs version 6 or later')
        if declared < 8 or declared - 8 > MAX_BODY:
            raise PatchError('LENGTH', f'{label}: implausible declared length {declared}')
        inflater = zlib.decompressobj()
        try:
            body = inflater.decompress(data[8:], declared - 8 + 1)
        except zlib.error as error:
            raise PatchError('HEADER', f'{label}: corrupt zlib stream ({error})') from None
    else:
        body = data[8:]
    if declared != len(body) + 8:
        raise PatchError('LENGTH', f'{label}: declared length {declared} does not match contents ({len(body) + 8})')
    return signature, version, body


def build_swf(signature, version, body, level=9):
    header = signature.encode('latin-1') + bytes([version]) + struct.pack('<I', len(body) + 8)
    return header + (zlib.compress(body, level) if signature == 'CWS' else body)


def _uint(value, what):
    if not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > MAX_BODY:
        raise PatchError('PATCH', f'{what} must be an integer between 0 and {MAX_BODY}')
    return value


def _hash(value, what):
    if not isinstance(value, str) or not HEX64.match(value):
        raise PatchError('PATCH', f'{what} must be a lowercase SHA-256 hex string')
    return value


def _name(value, what):
    if not isinstance(value, str) or not NAME.match(value):
        raise PatchError('PATCH', f'{what} must be a plain file name')
    return value


def _relative(value, what):
    parts = value.split('/') if isinstance(value, str) else None
    if not parts or any(part in ('', '.', '..') or '\\' in part or '\0' in part for part in parts):
        raise PatchError('PATCH', f'{what} must be a relative path without . or .. parts')
    return value


def decode_literal(text):
    if not isinstance(text, str):
        raise PatchError('PATCH', 'insert data must be a base64 string')
    try:
        data = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        raise PatchError('PATCH', 'insert data is not valid base64') from None
    if base64.b64encode(data).decode() != text:
        raise PatchError('PATCH', 'insert data is not canonical base64')
    if not data:
        raise PatchError('PATCH', 'insert data is empty')
    return data


def validate_patch(patch):
    """Check structure only. Returns the decoded ops [('copy', offset, length) | ('insert', bytes)]."""
    if not isinstance(patch, dict) or patch.get('format') != PATCH_FORMAT:
        raise PatchError('PATCH', f'not a {PATCH_FORMAT} patch')
    allowed = {'format', 'target', 'recordFile', 'original', 'result', 'record', 'ops'}
    if set(patch) - allowed or not {'target', 'recordFile', 'original', 'result', 'ops'} <= set(patch):
        raise PatchError('PATCH', 'unexpected or missing patch fields')
    _name(patch['target'], 'target')
    _name(patch['recordFile'], 'recordFile')
    original, result = patch['original'], patch['result']
    if not isinstance(original, dict) or set(original) != {'path', 'sha256', 'decompressedSha256', 'decompressedLength', 'signature', 'version'}:
        raise PatchError('PATCH', 'original has unexpected fields')
    if not isinstance(result, dict) or set(result) != {'decompressedSha256', 'decompressedLength', 'signature', 'version', 'compression'}:
        raise PatchError('PATCH', 'result has unexpected fields')
    _relative(original['path'], 'original.path')
    _hash(original['sha256'], 'original.sha256')
    _hash(original['decompressedSha256'], 'original.decompressedSha256')
    original_length = _uint(original['decompressedLength'], 'original.decompressedLength')
    _hash(result['decompressedSha256'], 'result.decompressedSha256')
    result_length = _uint(result['decompressedLength'], 'result.decompressedLength')
    for side in (original, result):
        if side['signature'] not in COMPRESSION:
            raise PatchError('PATCH', 'signature must be CWS or FWS')
        if not isinstance(side['version'], int) or isinstance(side['version'], bool) or not 1 <= side['version'] <= 255:
            raise PatchError('PATCH', 'version must be 1-255')
        if side['signature'] == 'CWS' and side['version'] < 6:
            raise PatchError('PATCH', 'CWS needs version 6 or later')
    if COMPRESSION[result['signature']] != result['compression']:
        raise PatchError('PATCH', 'result.compression does not match result.signature')
    if patch.get('record') is not None and not isinstance(patch['record'], dict):
        raise PatchError('PATCH', 'record must be an object')
    ops, total, has_literal_only = [], 0, True
    if not isinstance(patch['ops'], list):
        raise PatchError('PATCH', 'ops must be a list')
    for index, op in enumerate(patch['ops']):
        if isinstance(op, list) and len(op) == 3 and op[0] == 'copy':
            offset, length = _uint(op[1], 'copy offset'), _uint(op[2], 'copy length')
            if length == 0 or offset + length > original_length:
                raise PatchError('PATCH', f'op {index}: copy range is empty or outside the original')
            ops.append(('copy', offset, length))
            total += length
        elif isinstance(op, list) and len(op) == 2 and op[0] == 'insert':
            data = decode_literal(op[1])
            ops.append(('insert', data))
            total += len(data)
        else:
            raise PatchError('PATCH', f'op {index}: unknown operation')
        if total > MAX_BODY:
            raise PatchError('PATCH', 'result too large')
    if total != result_length:
        raise PatchError('PATCH', f'ops produce {total} bytes but result.decompressedLength is {result_length}')
    return ops


def apply_ops(original_body, ops):
    out = bytearray()
    for op in ops:
        out += original_body[op[1]:op[1] + op[2]] if op[0] == 'copy' else op[1]
    return bytes(out)


def apply_patch(original_swf, patch):
    """Verify and apply; returns (result_body, result_swf_bytes)."""
    ops = validate_patch(patch)
    original = patch['original']
    if sha256(original_swf) != original['sha256']:
        raise PatchError('ORIGINAL_HASH', 'the original file does not match the patch (wrong or modified file)')
    signature, version, body = split_swf(original_swf, 'original')
    if (signature, version) != (original['signature'], original['version']):
        raise PatchError('HEADER', 'original SWF signature or version differs from the patch')
    if len(body) != original['decompressedLength'] or sha256(body) != original['decompressedSha256']:
        raise PatchError('ORIGINAL_HASH', 'the original contents do not match the patch')
    result_body = apply_ops(body, ops)
    result = patch['result']
    if len(result_body) != result['decompressedLength'] or sha256(result_body) != result['decompressedSha256']:
        raise PatchError('RESULT_HASH', 'the patched contents do not match the expected hash')
    return result_body, build_swf(result['signature'], result['version'], result_body)


def literal_runs(ops):
    """Literals with adjacent inserts merged."""
    runs, current = [], bytearray()
    for op in ops:
        if op[0] == 'insert':
            current += op[1]
        elif current:
            runs.append(bytes(current))
            current = bytearray()
    if current:
        runs.append(bytes(current))
    return runs


def dump_patch(patch):
    """Deterministic text: one op per line, other keys sorted."""
    head = {key: patch[key] for key in sorted(patch) if key != 'ops'}
    lines = ['{']
    for key, value in head.items():
        lines.append(f'  {json.dumps(key)}: {json.dumps(value, sort_keys=True, indent=2).replace(chr(10), chr(10) + "  ")},')
    lines.append('  "ops": [')
    lines.append(',\n'.join('    ' + json.dumps(op, separators=(',', ':')) for op in patch['ops']))
    lines.append('  ]')
    lines.append('}')
    return '\n'.join(lines) + '\n'


def load_patch(path):
    try:
        return json.loads(open(path, 'rb').read().decode('utf-8'))
    except (ValueError, OSError) as error:
        raise PatchError('PATCH', f'cannot read patch {path}: {error}') from None


def manifest_id(entries):
    text = ''.join(f'{entry["file"]}\0{entry["sha256"]}\n' for entry in sorted(entries, key=lambda e: e['file']))
    return 'ps-' + sha256(text.encode())[:16]


def validate_manifest(manifest):
    if not isinstance(manifest, dict) or manifest.get('format') != PATCHSET_FORMAT or set(manifest) != {'format', 'id', 'patches'}:
        raise PatchError('PATCH', f'not a {PATCHSET_FORMAT} manifest')
    _name(manifest['id'], 'id')
    if manifest['id'] in ('current',) or not isinstance(manifest['patches'], list) or not manifest['patches']:
        raise PatchError('PATCH', 'manifest id or patches invalid')
    seen = set()
    for entry in manifest['patches']:
        if not isinstance(entry, dict) or set(entry) != {'file', 'sha256', 'target'}:
            raise PatchError('PATCH', 'manifest patch entry has unexpected fields')
        _name(entry['file'], 'file')
        _name(entry['target'], 'target')
        _hash(entry['sha256'], 'sha256')
        if entry['target'] in seen:
            raise PatchError('PATCH', 'duplicate target in manifest')
        seen.add(entry['target'])
    return manifest
