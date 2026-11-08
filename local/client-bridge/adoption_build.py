#!/usr/bin/env python3
"""Build the agent page's derived Pet Shop adoption module (Plan A2).

Input: the pinned AS3 ``puffle_adoption.swf`` (one DoABC2 tag). Output:
``.local/client-bridge/puffle_adoption.swf``, served only on the ``?agents=1``
page. Two changes, both reproducible from this repository:

1. A second DoABC2 tag, placed immediately before the module's own, holds
   ``com.claudepenguin.adoption.ProjectAdoption`` compiled by pinned JPEXS from
   ``ProjectAdoption.as`` (project-owned source). It is created from a small
   hand-assembled stub ABC that JPEXS then recompiles.
2. Five module methods (``HOOKS``) gain the same three-instruction prologue,
   applied as JPEXS P-code method replacement:
   ``if (ProjectAdoption.hook("<id>", this)) return;``. The rest of each body is
   the original bytecode, unchanged. No decompiled module source is stored here.

Invariants checked on every build (failing any of them fails the build):
the input module SHA-256 is pinned; every tag other than the module's DoABC2
is byte-identical and in place; the module ABC has the same method and body
counts; every unpatched body is byte-identical; each patched body is exactly
the prologue followed by the original bytecode; and a second clean build
produces identical bytes.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import zlib

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bridge_build = _load('bridge_build', 'build.py')
abcfile = _load('abcfile', 'abcfile.py')

MODULE = 'vanilla-media/media/play/v2/client/puffle_adoption.swf'
MODULE_SHA256 = '8b93c984367cbc547abe40c65d9d0635e95b2bb4f83e0d200e4990df83b09e39'
SOURCE = HERE / 'ProjectAdoption.as'
OUT = ROOT / '.local/client-bridge'
WORK = OUT / 'adoption-work'
PACKAGE = 'com.claudepenguin.adoption'
CLASS = 'ProjectAdoption'
STUB_TAG_NAME = b'claude-penguin/project-adoption'
PKG = 'com.clubpenguin.puffles.adoption.'

# (hook id, class, method). Each method is void; a true hook result returns early.
HOOKS = [
    ('penReady', 'mediators.PufflePenMediator', 'onViewComplete'),
    ('adoptClick', 'mediators.PufflePenMediator', 'onAdoptClick'),
    ('penAdopted', 'mediators.PufflePenMediator', 'onPuffleAdopted'),
    ('purchase', 'model.AdoptionModel', 'adoptSelectedPuffle'),
    ('walk', 'mediators.PuffleCongratsMediator', 'walkPuffle'),
]
PROLOGUE_STACK = 3


# ------------------------------------------------------------------ stub ABC

def u30(value):
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def stub_abc():
    """A valid minimal ABC defining an empty public class ``PACKAGE.CLASS``."""
    strings = [PACKAGE, CLASS, '', 'Object']
    pool = bytearray()
    pool += u30(0) + u30(0) + u30(0)  # ints, uints, doubles
    pool += u30(len(strings) + 1)
    for text in strings:
        data = text.encode()
        pool += u30(len(data)) + data
    # Namespaces: 1 = package, 2 = public "".
    pool += u30(3) + bytes([0x16]) + u30(1) + bytes([0x16]) + u30(3)
    pool += u30(0)  # namespace sets
    # Multinames: 1 = QName(package, CLASS), 2 = QName("", Object).
    pool += u30(3) + bytes([0x07]) + u30(1) + u30(2) + bytes([0x07]) + u30(2) + u30(4)
    methods = u30(3) + (u30(0) + u30(0) + u30(0) + bytes([0])) * 3  # iinit, cinit, script init
    metadata = u30(0)
    instance = u30(1) + u30(1) + u30(2) + bytes([0x01]) + u30(0) + u30(0) + u30(0)
    klass = u30(1) + u30(0)
    script = u30(1) + u30(2) + u30(1) + u30(1) + bytes([0x04]) + u30(1) + u30(0)
    iinit = bytes([0xD0, 0x30, 0xD0, 0x49, 0x00, 0x47])
    cinit = bytes([0xD0, 0x30, 0x47])
    init = bytes([0xD0, 0x30, 0x65, 0x00, 0x60, 0x02, 0x30, 0x60, 0x02, 0x58, 0x00, 0x1D, 0x68, 0x01, 0x47])
    bodies = u30(3)
    for method, (stack, scope, maxscope, code) in enumerate([(1, 3, 4, iinit), (1, 3, 4, cinit), (2, 1, 3, init)]):
        bodies += u30(method) + u30(stack) + u30(1) + u30(scope) + u30(maxscope) + u30(len(code)) + code + u30(0) + u30(0)
    return struct.pack('<HH', 16, 46) + bytes(pool) + methods + metadata + instance + klass + script + bodies


def do_abc2(abc, name):
    payload = struct.pack('<I', 1) + name + b'\0' + abc  # 1 = lazy initialize
    return struct.pack('<HI', (abcfile.DO_ABC2 << 6) | 63, len(payload)) + payload


def compress(header, tags, version):
    body = header + b''.join(tags)
    return b'CWS' + bytes([version]) + struct.pack('<I', len(body) + 8) + zlib.compress(body, 9)


# ------------------------------------------------------------------ P-code

TRAIT = re.compile(r'^\s*trait method QName\((?:\w+)\("[^"]*"\),"([^"]+)"\)\s*$')


def method_block(text, name):
    """The ``method ... end ; method`` block of trait method ``name`` (dedented)."""
    lines = text.replace('\r\n', '\n').split('\n')
    starts = [index for index, line in enumerate(lines) if (match := TRAIT.match(line)) and match.group(1) == name]
    if len(starts) != 1:
        raise ValueError(f'Expected one trait method {name}, found {len(starts)}')
    index = starts[0] + 1
    while lines[index].strip() != 'method':
        index += 1
    indent = lines[index][:len(lines[index]) - len(lines[index].lstrip())]
    block = []
    while True:
        line = lines[index]
        block.append(line[len(indent):] if line.startswith(indent) else line.lstrip())
        if line == indent + 'end ; method':
            return block
        index += 1


def with_prologue(block, hook_id):
    """Insert the hook call right after ``code`` and raise maxstack if needed."""
    out, inserted = [], False
    for line in block:
        stripped = line.strip()
        if stripped.startswith('maxstack '):
            line = line.replace(stripped, f'maxstack {max(int(stripped.split()[1]), PROLOGUE_STACK)}')
        out.append(line)
        if stripped == 'code' and not inserted:
            pad = line[:len(line) - len(line.lstrip())] + '   '
            out += [f'{pad}getlex QName(PackageNamespace("{PACKAGE}"),"{CLASS}")',
                    f'{pad}pushstring "{hook_id}"',
                    f'{pad}getlocal0',
                    f'{pad}callproperty QName(PackageNamespace(""),"hook"), 2',
                    f'{pad}iffalse cpcontinue',
                    f'{pad}returnvoid',
                    'cpcontinue:']
            inserted = True
    if not inserted:
        raise ValueError(f'No code section found for hook {hook_id}')
    return out


# Bytes of the prologue as AVM2 encodes it, given the multiname/string indices
# JPEXS assigns; recovered from the output and compared structurally below.
def prologue_parts(code, original):
    """Split a patched body into (prologue, rest) and require rest == original."""
    if not code.endswith(original):
        raise ValueError('patched body does not end with the original bytecode')
    prologue = code[:len(code) - len(original)]
    reader = abcfile.Reader(prologue)
    ops = []
    while reader.position < len(prologue):
        op = reader.u8()
        if op == 0x60:  # getlex
            ops.append(('getlex', reader.u30()))
        elif op == 0x2C:  # pushstring
            ops.append(('pushstring', reader.u30()))
        elif op == 0xD0:
            ops.append(('getlocal0',))
        elif op == 0x46:  # callproperty
            ops.append(('callproperty', reader.u30(), reader.u30()))
        elif op == 0x12:  # iffalse
            offset = int.from_bytes(prologue[reader.position:reader.position + 3], 'little', signed=True)
            reader.skip(3)
            ops.append(('iffalse', offset))
        elif op == 0x47:
            ops.append(('returnvoid',))
        else:
            raise ValueError(f'unexpected prologue opcode {op:#x}')
    shape = [item[0] for item in ops]
    if shape != ['getlex', 'pushstring', 'getlocal0', 'callproperty', 'iffalse', 'returnvoid'] \
            or ops[3][2] != 2 or ops[4][1] != 1:
        raise ValueError(f'unexpected prologue {ops}')
    return ops


# ------------------------------------------------------------------ build

def jpexs(*args):
    java, _ = bridge_build.java_tools()
    jar = bridge_build.TOOLS / 'ffdec/ffdec.jar'
    result = subprocess.run([java, f'-Duser.home={bridge_build.TOOLS}', '-jar', str(jar), *map(str, args)],
                            capture_output=True, text=True)
    if result.returncode != 0 or 'error' in result.stdout.lower() or 'exception' in result.stderr.lower():
        raise RuntimeError(f'JPEXS failed ({" ".join(map(str, args[:2]))}): {(result.stdout + result.stderr)[-1500:]}')
    return result.stdout


def build_once(work, original):
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    header, tags = abcfile.swf_tags(original)
    module_index = next(index for index, tag in enumerate(tags) if tag[0] == abcfile.DO_ABC2)
    raw_tags = [tag[1] for tag in tags]
    staged_input = compress(header, raw_tags[:module_index] + [do_abc2(stub_abc(), STUB_TAG_NAME)] + raw_tags[module_index:],
                            original[3])
    (work / 'input.swf').write_bytes(staged_input)

    classes = sorted({PKG + cls for _, cls, _ in HOOKS})
    jpexs('-onerror', 'abort', '-format', 'script:pcode', '-selectclass', ','.join(classes),
          '-export', 'script', work / 'pcode', work / 'input.swf')
    parsed = abcfile.parse(abcfile.abc_of(original))
    replace = []
    for hook_id, cls, method in HOOKS:
        source = (work / 'pcode/scripts' / (PKG + cls).replace('.', '/')).with_suffix('.pcode').read_text(encoding='utf-8')
        patched = work / f'{hook_id}.pcode'
        patched.write_text('\n'.join(with_prologue(method_block(source, method), hook_id)) + '\n', encoding='utf-8')
        body = parsed['methods'][(PKG + cls, 'method', method)]['body']
        replace += [PKG + cls, patched, body]
    jpexs('-replace', work / 'input.swf', work / 'staged.swf', f'{PACKAGE}.{CLASS}', SOURCE, *replace)

    staged_header, staged_tags = abcfile.swf_tags((work / 'staged.swf').read_bytes())
    abc_tags = [tag[1] for tag in staged_tags if tag[0] == abcfile.DO_ABC2]
    if len(abc_tags) != 2 or STUB_TAG_NAME not in abc_tags[0][:64]:
        raise ValueError('JPEXS output does not have the expected two ABC tags')
    if [tag[1] for tag in staged_tags if tag[0] != abcfile.DO_ABC2] != [raw for raw, tag in zip(raw_tags, tags) if tag[0] != abcfile.DO_ABC2]:
        raise ValueError('JPEXS changed a tag outside the ABC blocks')
    final = compress(header, raw_tags[:module_index] + abc_tags + raw_tags[module_index + 1:], original[3])
    return final


def verify(original, final):
    """Re-check every invariant on the final bytes; returns a provenance summary."""
    header, tags = abcfile.swf_tags(original)
    final_header, final_tags = abcfile.swf_tags(final)
    module_index = next(index for index, tag in enumerate(tags) if tag[0] == abcfile.DO_ABC2)
    if final_header != header or len(final_tags) != len(tags) + 1:
        raise ValueError('header or tag count changed')
    others = [tag[1] for index, tag in enumerate(tags) if index != module_index]
    final_others = [tag[1] for index, tag in enumerate(final_tags) if index not in (module_index, module_index + 1)]
    if final_others != others:
        raise ValueError('a tag outside the module ABC changed or moved')
    ours, module = final_tags[module_index], final_tags[module_index + 1]
    if ours[0] != abcfile.DO_ABC2 or module[0] != abcfile.DO_ABC2 or STUB_TAG_NAME not in ours[1][:64]:
        raise ValueError('the project ABC tag is not immediately before the module ABC')

    def abc(raw, offset):
        payload = raw[offset:]
        return payload[payload.index(b'\0', 4) + 1:]
    before = abcfile.parse(abcfile.abc_of(original))
    after = abcfile.parse(abc(module[1], module[2]))
    if (before['bodyCount'], before['methodCount']) != (after['bodyCount'], after['methodCount']):
        raise ValueError('method or body count changed')
    before_codes = body_codes(abcfile.abc_of(original))
    after_codes = body_codes(abc(module[1], module[2]))
    patched_bodies = {before['methods'][(PKG + cls, 'method', method)]['body'] for _, cls, method in HOOKS}
    for index, code in before_codes.items():
        if index in patched_bodies:
            prologue_parts(after_codes[index], code)
        elif after_codes[index] != code:
            raise ValueError(f'unpatched method body {index} changed')
    project = abcfile.parse(abc(ours[1], ours[2]))
    if not any(key[0] == f'{PACKAGE}.{CLASS}' and key[2] == 'hook' for key in project['methods']):
        raise ValueError('ProjectAdoption.hook is missing from the project ABC')
    return {'unpatchedBodiesUnchanged': len(before_codes) - len(patched_bodies), 'patchedBodies': len(patched_bodies),
            'moduleAbcSha256': hashlib.sha256(module[1]).hexdigest(), 'projectAbcSha256': hashlib.sha256(ours[1]).hexdigest()}


def body_codes(abc):
    """body index -> code bytes for every method body."""
    reader_result = {}
    parsed = abcfile.parse_bodies(abc)
    for index, code in enumerate(parsed):
        reader_result[index] = code
    return reader_result


def build():
    original = bridge_build.checked(ROOT / MODULE, MODULE_SHA256)
    first = build_once(WORK, original)
    second = build_once(WORK.with_name('adoption-work-repeat'), original)
    if first != second:
        raise ValueError('two clean builds produced different bytes')
    shutil.rmtree(WORK.with_name('adoption-work-repeat'))
    summary = verify(original, first)
    destination = OUT / 'puffle_adoption.swf'
    temporary = destination.with_suffix('.tmp')
    temporary.write_bytes(first)
    temporary.replace(destination)
    decompressed = zlib.decompress(first[8:])
    provenance = {
        'version': 1, 'kind': 'project-adoption-module',
        'source': MODULE, 'sourceSha256': MODULE_SHA256,
        'compiler': {'name': 'JPEXS', 'version': bridge_build.VERSION, 'librarySha256': bridge_build.LIB_SHA256},
        'extensionSha256': bridge_build.digest(SOURCE.read_bytes()),
        'hooks': [{'id': hook_id, 'class': PKG + cls, 'method': method} for hook_id, cls, method in HOOKS],
        'outputSha256': bridge_build.digest(first), 'deterministic': True, **summary,
        'outputDecompressedSha256': bridge_build.digest(decompressed), 'outputDecompressedLength': len(decompressed),
    }
    (OUT / 'adoption-build.json').write_text(json.dumps(provenance, indent=2) + '\n')
    print(f'Built {destination}; {summary["unpatchedBodiesUnchanged"]} method bodies unchanged, '
          f'{summary["patchedBodies"]} hooked; SHA256 {provenance["outputSha256"]}')
    return provenance


if __name__ == '__main__':
    bridge_build.install_jpexs()
    build()
    sys.exit(0)
