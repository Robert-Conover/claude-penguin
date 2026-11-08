#!/usr/bin/env python3
"""Build an opt-in engine overlay, preserving the original SWF tags byte for byte."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import urllib.request
import zipfile
import zlib

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUT = ROOT / '.local/client-bridge'
TOOLS = ROOT / '.local/bridge-tools'
VERSION = '26.4.0'
ARCHIVE_SHA256 = '56ce960aeafc7caf034e2052ba49f878a883f7c7ca690da6eeffca9587b5e4b9'
LIB_SHA256 = 'ed9314b24190f497a9e02236dae7caaf69062cbbe9d98157c005c3f1c25481d4'
ENGINE_SHA256 = 'c30d75048a7d3e49becef76dd81a683163df36dbabbcc1683e984cbd0ca5d23b'
URL = f'https://github.com/jindrapetrik/jpexs-decompiler/releases/download/version{VERSION}/ffdec_{VERSION}.zip'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def checked(path, expected):
    data = path.read_bytes()
    if digest(data) != expected:
        raise ValueError(f'Unexpected SHA256 for {path}; refusing to build')
    return data


def overlay(original, actions):
    if original[:3] != b'CWS':
        raise ValueError('Expected pinned zlib-compressed SWF')
    body = zlib.decompress(original[8:])
    if struct.unpack_from('<I', original, 4)[0] != len(body) + 8:
        raise ValueError('Invalid SWF length')
    position = (5 + 4 * (body[0] >> 3) + 7) // 8 + 4
    while position < len(body):
        start = position
        header, = struct.unpack_from('<H', body, position)
        position += 2
        code, length = header >> 6, header & 63
        if length == 63:
            length, = struct.unpack_from('<I', body, position)
            position += 4
        if code == 1:  # immediately before first ShowFrame, after original actions
            addition = struct.pack('<HI', (12 << 6) | 63, len(actions)) + actions
            changed = body[:start] + addition + body[start:]
            assert changed[:start] + changed[start + len(addition):] == body
            return original[:4] + struct.pack('<I', len(changed) + 8) + zlib.compress(changed), start, len(addition)
        position += length
    raise ValueError('No ShowFrame tag found')


def install_jpexs():
    """Download (once) and re-extract the checksum-verified pinned JPEXS."""
    TOOLS.mkdir(parents=True, exist_ok=True)
    archive = TOOLS / 'ffdec.zip'
    if not archive.exists():
        temporary = archive.with_suffix('.download')
        print(f'Downloading pinned JPEXS {VERSION}', flush=True)
        urllib.request.urlretrieve(URL, temporary)
        checked(temporary, ARCHIVE_SHA256)
        temporary.replace(archive)
    checked(archive, ARCHIVE_SHA256)
    # Re-extract the checksum-verified package so all compiler dependencies match.
    with zipfile.ZipFile(archive) as package:
        for member in package.infolist():
            target = (TOOLS / 'ffdec' / member.filename).resolve()
            if not target.is_relative_to((TOOLS / 'ffdec').resolve()):
                raise ValueError('Unsafe archive entry')
        package.extractall(TOOLS / 'ffdec')
    checked(TOOLS / 'ffdec/lib/ffdec_lib.jar', LIB_SHA256)


def java_tools():
    java_home = os.environ.get('BRIDGE_JAVA_HOME')
    if not java_home and Path('/opt/homebrew/opt/openjdk/bin/java').exists():
        java_home = '/opt/homebrew/opt/openjdk'
    java = str(Path(java_home) / 'bin/java') if java_home else shutil.which('java')
    javac = str(Path(java_home) / 'bin/javac') if java_home else shutil.which('javac')
    if not java or not javac:
        raise RuntimeError('A JDK is required; set BRIDGE_JAVA_HOME to its directory')
    return java, javac


def build_engine_overlay():
    OUT.mkdir(parents=True, exist_ok=True)
    engine_path = ROOT / 'vanilla-media/media/play/v2/client/engine.swf'
    original = checked(engine_path, ENGINE_SHA256)
    java, javac = java_tools()
    classpath = str(TOOLS / 'ffdec/lib/*')
    subprocess.run([javac, '-cp', classpath, '-d', str(OUT), str(HERE / 'CompileBridge.java')], check=True)
    actions_path = OUT / 'bridge.actions'
    subprocess.run([java, f'-Duser.home={TOOLS}', '-cp', str(OUT) + os.pathsep + classpath,
                    'CompileBridge', str(engine_path), str(HERE / 'bridge.as'), str(actions_path)], check=True)
    changed, offset, size = overlay(original, actions_path.read_bytes())
    destination = OUT / 'engine.swf'
    temporary = destination.with_suffix('.tmp')
    temporary.write_bytes(changed)
    temporary.replace(destination)
    decompressed = zlib.decompress(changed[8:])
    provenance = {
        'version': 1, 'kind': 'game-bridge-experiment',
        'source': 'vanilla-media/media/play/v2/client/engine.swf',
        'sourceSha256': ENGINE_SHA256,
        'compiler': {'name': 'JPEXS', 'version': VERSION, 'url': URL,
                     'archiveSha256': ARCHIVE_SHA256, 'librarySha256': LIB_SHA256},
        'extensionSha256': digest((HERE / 'bridge.as').read_bytes()),
        'outputSha256': digest(changed), 'injectedTagOffset': offset, 'injectedTagBytes': size,
        'outputDecompressedSha256': digest(decompressed), 'outputDecompressedLength': len(decompressed),
        'originalTagsUnchanged': True,
    }
    (OUT / 'build.json').write_text(json.dumps(provenance, indent=2) + '\n')
    print(f'Built {destination}; original tags preserved; SHA256 {digest(changed)}')


def main():
    install_jpexs()
    build_engine_overlay()
    # The agent page also serves a derived Pet Shop adoption module (Plan A).
    import adoption_build
    adoption_build.build()


if __name__ == '__main__':
    main()
