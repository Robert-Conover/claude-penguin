"""Minimal reader for the AS3 bytecode (ABC) in a SWF's DoABC2 tag.

It reads only what the adoption-module build needs: the constant pool names,
method and method-body tables, and class traits, so each patched method's body
index and bytecode can be located and every other body compared byte for byte.
Format: Adobe "ActionScript Virtual Machine 2 Overview", section 4.
"""
from __future__ import annotations

import hashlib
import struct
import zlib

DO_ABC2 = 82
TRAIT_KINDS = {1: 'method', 2: 'getter', 3: 'setter'}


class Reader:
    def __init__(self, data, position=0):
        self.data, self.position = data, position

    def u8(self):
        value = self.data[self.position]
        self.position += 1
        return value

    def u16(self):
        value, = struct.unpack_from('<H', self.data, self.position)
        self.position += 2
        return value

    def u30(self):
        result = shift = 0
        for _ in range(5):
            byte = self.u8()
            result |= (byte & 0x7F) << shift
            if not byte & 0x80:
                return result
            shift += 7
        raise ValueError('Invalid variable-length integer in ABC')

    def skip(self, count):
        self.position += count
        if self.position > len(self.data):
            raise ValueError('Truncated ABC data')

    def take(self, count):
        start = self.position
        self.skip(count)
        return self.data[start:self.position]


def swf_tags(swf):
    """(header bytes, [(code, header+payload bytes, payload offset, payload length)]) of a CWS/FWS SWF."""
    if swf[:3] == b'CWS':
        body = zlib.decompress(swf[8:])
    elif swf[:3] == b'FWS':
        body = swf[8:]
    else:
        raise ValueError('Expected an uncompressed or zlib-compressed SWF')
    if struct.unpack_from('<I', swf, 4)[0] != len(body) + 8:
        raise ValueError('Invalid SWF length')
    position = (5 + 4 * (body[0] >> 3) + 7) // 8 + 4
    header, tags = body[:position], []
    while position < len(body):
        start = position
        code_length, = struct.unpack_from('<H', body, position)
        position += 2
        code, length = code_length >> 6, code_length & 63
        if length == 63:
            length, = struct.unpack_from('<I', body, position)
            position += 4
        tags.append((code, body[start:position + length], position - start, length))
        position += length
    return header, tags


def abc_of(swf):
    """The ABC bytes of the one DoABC2 tag, after its flags and name."""
    _, tags = swf_tags(swf)
    blocks = [tag for tag in tags if tag[0] == DO_ABC2]
    if len(blocks) != 1:
        raise ValueError(f'Expected exactly one DoABC2 tag, found {len(blocks)}')
    _, raw, offset, _ = blocks[0]
    payload = raw[offset:]
    name_end = payload.index(b'\0', 4)
    return payload[name_end + 1:]


def parse(abc):
    """Map (class, trait kind, name) -> {method, body, code sha256}, plus every body's code hash."""
    read = Reader(abc)
    read.u16(), read.u16()
    for _ in range(max(0, read.u30() - 1)):
        read.u30()  # int (s32 uses the same encoding)
    for _ in range(max(0, read.u30() - 1)):
        read.u30()
    read.skip(8 * max(0, read.u30() - 1))
    strings = ['']
    for _ in range(max(0, read.u30() - 1)):
        strings.append(read.take(read.u30()).decode('utf-8'))
    namespaces = [None]
    for _ in range(max(0, read.u30() - 1)):
        read.u8()
        namespaces.append(strings[read.u30()])
    for _ in range(max(0, read.u30() - 1)):
        for _ in range(read.u30()):
            read.u30()
    names = [None]
    for _ in range(max(0, read.u30() - 1)):
        kind = read.u8()
        if kind in (0x07, 0x0D):
            namespace, name = read.u30(), read.u30()
            names.append((namespaces[namespace], strings[name]))
        elif kind in (0x0F, 0x10):
            names.append((None, strings[read.u30()]))
        elif kind in (0x11, 0x12):
            names.append(None)
        elif kind in (0x09, 0x0E):
            name = read.u30()
            read.u30()
            names.append((None, strings[name]))
        elif kind in (0x1B, 0x1C):
            read.u30()
            names.append(None)
        elif kind == 0x1D:
            read.u30()
            for _ in range(read.u30()):
                read.u30()
            names.append(None)
        else:
            raise ValueError(f'Unknown multiname kind {kind:#x}')
    method_count = read.u30()
    for _ in range(method_count):
        params = read.u30()
        read.u30()
        for _ in range(params):
            read.u30()
        read.u30()
        flags = read.u8()
        if flags & 0x08:
            for _ in range(read.u30()):
                read.u30(), read.u8()
        if flags & 0x80:
            for _ in range(params):
                read.u30()
    for _ in range(read.u30()):
        read.u30()
        items = read.u30()
        for _ in range(2 * items):
            read.u30()

    def traits():
        found = []
        for _ in range(read.u30()):
            name, kind = read.u30(), read.u8()
            base = kind & 0x0F
            if base in (0, 6):
                read.u30(), read.u30()
                if read.u30():
                    read.u8()
            elif base in (4, 5):
                read.u30(), read.u30()
            elif base in TRAIT_KINDS:
                read.u30()
                found.append((TRAIT_KINDS[base], names[name][1] if names[name] else None, read.u30()))
            else:
                raise ValueError(f'Unknown trait kind {kind:#x}')
            if kind & 0x40:
                for _ in range(read.u30()):
                    read.u30()
        return found

    class_count = read.u30()
    classes = []
    for _ in range(class_count):
        name = names[read.u30()]
        read.u30()
        flags = read.u8()
        if flags & 0x08:
            read.u30()
        for _ in range(read.u30()):
            read.u30()
        read.u30()  # iinit
        qualified = f'{name[0]}.{name[1]}' if name[0] else name[1]
        classes.append((qualified, traits()))
    for index in range(class_count):
        read.u30()  # cinit
        classes[index] = (classes[index][0], classes[index][1] + traits())
    for _ in range(read.u30()):
        read.u30()
        traits()
    bodies = {}
    codes = []
    for index in range(read.u30()):
        method = read.u30()
        read.u30(), read.u30(), read.u30(), read.u30()
        code = read.take(read.u30())
        exceptions = [tuple(read.u30() for _ in range(5)) for _ in range(read.u30())]
        traits()
        bodies[method] = {'body': index, 'code': code, 'exceptions': exceptions}
        codes.append(code)
    if read.position != len(abc):
        raise ValueError('Unexpected data after the ABC method bodies')
    methods = {}
    for qualified, found in classes:
        for kind, name, method in found:
            body = bodies.get(method)
            if body is None:
                continue
            key = (qualified, kind, name)
            if key in methods:
                raise ValueError(f'Duplicate trait {qualified} {kind} {name}')
            methods[key] = {'method': method, 'body': body['body'],
                            'sha256': hashlib.sha256(body['code']).hexdigest()}
    return {'methods': methods, 'bodyCount': len(codes), 'methodCount': method_count, 'codes': codes}


def parse_bodies(abc):
    """Code bytes of every method body, by body index."""
    return parse(abc)['codes']
