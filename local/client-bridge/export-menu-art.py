#!/usr/bin/env python3
"""Reproduce the puffle menu artwork from one pinned archived SWF sprite."""
import hashlib
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

import build as bridge_build

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'vanilla-media/media/play/v2/content/global/puffle/icons/blue.swf'
SOURCE_SHA256 = '5071c7a73abdecff0d331d508f34394688260f58dd8e4b6ad2fbddc2fb33e1bc'
DESTINATION = ROOT / 'local/web/engine/art'
WORK = ROOT / '.local/menu-art-build'
SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink'


def validate_svg(data):
    root = ET.fromstring(data)
    if root.tag != f'{{{SVG_NAMESPACE}}}svg':
        raise ValueError('Expected an SVG document')
    for element in root.iter():
        if element.tag.split('}')[-1] in ('script', 'foreignObject', 'image'):
            raise ValueError('Expected vector-only puffle artwork')
        for key, value in element.attrib.items():
            if key.lower().startswith('on'):
                raise ValueError('Unexpected SVG event handler')
            if key in ('href', f'{{{XLINK_NAMESPACE}}}href') and not value.startswith('#'):
                raise ValueError('Unexpected external SVG reference')
            if 'url(' in value and 'url(#' not in value:
                raise ValueError('Unexpected external SVG resource')


def main():
    bridge_build.checked(SOURCE, SOURCE_SHA256)
    if bridge_build.VERSION != '26.4.0':
        raise ValueError('Review menu artwork before changing the pinned exporter')
    WORK.mkdir(parents=True, exist_ok=True)
    archive = ROOT / '.local/bridge-tools/ffdec.zip'
    if not archive.exists():
        archive.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=archive.parent, suffix='.download', delete=False) as file:
            temporary = Path(file.name)
        try:
            urllib.request.urlretrieve(bridge_build.URL, temporary)
            bridge_build.checked(temporary, bridge_build.ARCHIVE_SHA256)
            temporary.replace(archive)
        finally:
            temporary.unlink(missing_ok=True)
    bridge_build.checked(archive, bridge_build.ARCHIVE_SHA256)
    java_home = os.environ.get('BRIDGE_JAVA_HOME')
    if not java_home and Path('/opt/homebrew/opt/openjdk/bin/java').exists():
        java_home = '/opt/homebrew/opt/openjdk'
    java = str(Path(java_home) / 'bin/java') if java_home else shutil.which('java')
    if not java:
        raise RuntimeError('A Java runtime is required; set BRIDGE_JAVA_HOME')

    # A private fresh export directory avoids racing the game-overlay compiler.
    with tempfile.TemporaryDirectory(prefix='export-', dir=WORK) as directory:
        directory = Path(directory)
        tools = directory / 'ffdec'
        with zipfile.ZipFile(archive) as package:
            for member in package.infolist():
                if not (tools / member.filename).resolve().is_relative_to(tools.resolve()):
                    raise ValueError('Unsafe exporter archive entry')
            package.extractall(tools)
        bridge_build.checked(tools / 'lib/ffdec_lib.jar', bridge_build.LIB_SHA256)
        command = [java, '-Djava.awt.headless=true', f'-Duser.home={directory}',
                   '-jar', str(tools / 'ffdec.jar')]
        for kind in ('svg', 'png'):
            subprocess.run(command + ['-format', f'sprite:{kind}', '-selectid', '13',
                           '-select', '13:1', '-zoom', '4' if kind == 'png' else '1',
                           '-ignorebackground', '-export', 'sprite', str(directory / kind),
                           str(SOURCE)], check=True)
        svg = (directory / 'svg/DefineSprite_13/1.svg').read_text()
        # Preserve the exported vectors; a viewBox makes the SVG scale in HTML.
        svg = svg.replace('<svg ', '<svg viewBox="0 0 91.45 79.6" ', 1).encode('utf8')
        validate_svg(svg)
        png = (directory / 'png/DefineSprite_13/1.png').read_bytes()
        if png[:8] != b'\x89PNG\r\n\x1a\n':
            raise ValueError('Expected PNG artwork')
        width, height, depth, color = struct.unpack('>IIBB', png[16:26])
        if (width, height, depth, color) != (366, 319, 8, 6):
            raise ValueError(f'Unexpected PNG dimensions or alpha format: {width, height, depth, color}')
        DESTINATION.mkdir(parents=True, exist_ok=True)
        for name, data in [('puffle-blue.svg', svg), ('puffle-blue.png', png)]:
            (DESTINATION / name).write_bytes(data)
            print(f'{name}: {hashlib.sha256(data).hexdigest()}')
        print(f'PNG: {width} x {height}, RGBA; SVG: 91.45 x 79.6')


if __name__ == '__main__':
    main()
