#!/usr/bin/env python3
"""Plan A1: record the pinned puffle_adoption.swf methods a project-adoption build would touch.

The module is AS3 (one DoABC2 tag). This script does not modify it. It decompiles the
listed classes to P-code with the pinned JPEXS that build.py already installs, hashes
each listed method body, and writes or checks adoption-methods.json. `newfunction N`
operands are normalized because recompiling any class renumbers method indices
module-wide without changing the closure bodies they refer to.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
spec = importlib.util.spec_from_file_location('bridge_build', HERE / 'build.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)

MODULE = 'vanilla-media/media/play/v2/client/puffle_adoption.swf'
MODULE_SHA256 = '8b93c984367cbc547abe40c65d9d0635e95b2bb4f83e0d200e4990df83b09e39'
MANIFEST = HERE / 'adoption-methods.json'
OUT = ROOT / '.local/client-bridge/adoption-map'
PKG = 'com.clubpenguin.puffles.adoption.'

# (role, class, trait kind, method, why it matters for project adoption)
METHODS = [
    ('entry', 'commands.SetupViewsCommand', 'method', 'execute',
     'Routes puffleAdoptionType to the pen (default) or a special view; insertion point for a destination picker.'),
    ('entry', 'AdoptionContext', 'method', 'startup',
     'Builds the model from the host local PlayerVO and socket connection.'),
    ('catalog', 'mediators.PufflePenMediator', 'method', 'setupPuffleViews',
     'Pen list: ten colors plus ORANGE_TABBY_CAT (1007) and BLUE_BORDER_COLLIE (1006).'),
    ('catalog', 'mediators.PufflePenMediator', 'method', 'onViewComplete',
     'Stats board shows the visitor puffle count and coins; Rainbow and Gold poster buttons.'),
    ('purchase', 'mediators.PufflePenMediator', 'method', 'onAdoptClick',
     'Client checks: visitor coins < price (401 prompt), member and 75-puffle limit (440).'),
    ('purchase', 'mediators.PufflePenMediator', 'method', 'showAdoptionDialog',
     'Opens the naming dialog.'),
    ('purchase', 'mediators.AdoptionDialogMediator', 'method', 'onAdoptClicked',
     'Buy button; sends only after the name is pre-approved.'),
    ('purchase', 'mediators.AdoptionDialogMediator', 'method', 'activateAdoptButton',
     'Re-arms the buy click listener (no in-flight guard).'),
    ('purchase', 'model.AdoptionModel', 'method', 'adoptSelectedPuffle',
     'Model entry for the purchase.'),
    ('purchase', 'services.PuffleAdoptionSocketService', 'method', 'adoptPuffle',
     'Sends p#pn [typeId, name, subtypeId] through the host Connection.'),
    ('naming', 'services.PuffleAdoptionSocketService', 'method', 'checkPuffleNameWithResponse',
     'p#checkpufflename; the server check_name result is cached by the model.'),
    ('response', 'services.PuffleAdoptionSocketService', 'method', 'onResponded',
     'Handles pn: sets the id, adds the puffle to the visitor PlayerVO, dispatches puffleAdopted; handles 441/401 errors.'),
    ('response', 'services.PuffleAdoptionDataParser', 'method', 'getAdoptedPuffleID',
     'Parses the puffle id from the pn reply field 2.'),
    ('response', 'mediators.AdoptionDialogMediator', 'method', 'onPuffleAdopted',
     'Opens the certificate (PuffleCongratsView).'),
    ('response', 'mediators.PufflePenMediator', 'method', 'onPuffleAdopted',
     'Shows the Gold puffle poster after any adoption.'),
    ('response', 'mediators.PufflePenMediator', 'method', 'onPuffleAdoptionNotEnoughCoins',
     'Hides the modal on a 401 reply.'),
    ('certificate', 'mediators.PuffleCongratsMediator', 'method', 'onComplete',
     'Certificate setup; loads care-item icons for ordinary colors.'),
    ('certificate', 'mediators.PuffleCongratsMediator', 'method', 'setView',
     'Frame by color name, or wild_<subtype> for the dog and cat.'),
    ('certificate', 'mediators.PuffleCongratsMediator', 'method', 'setPuffleName',
     'Name text from the model.'),
    ('certificate', 'mediators.PuffleCongratsMediator', 'method', 'localizeText',
     'Ordinary colors list 5 x item 3 and 1 x item 79 as supplies; wild uses adopted-by username and date.'),
    ('certificate', 'mediators.PuffleCongratsMediator', 'method', 'getAdoptionDateString',
     'Date from selectedPuffle.adoptionDate.'),
    ('walk', 'mediators.PuffleCongratsMediator', 'method', 'closeCurrentModule',
     'OK and close both walk the new puffle, then close the module.'),
    ('walk', 'mediators.PuffleCongratsMediator', 'method', 'walkPuffle',
     'AVM bridge walkPuffle {puffleID, showAdoptionAnimation} to the AS2 shell.'),
]


def java():
    java_home = os.environ.get('BRIDGE_JAVA_HOME')
    if not java_home and Path('/opt/homebrew/opt/openjdk/bin/java').exists():
        java_home = '/opt/homebrew/opt/openjdk'
    found = str(Path(java_home) / 'bin/java') if java_home else shutil.which('java')
    if not found:
        raise RuntimeError('A JDK is required; set BRIDGE_JAVA_HOME to its directory')
    return found


def export(module):
    jar = build.TOOLS / 'ffdec/ffdec.jar'
    if not jar.exists():
        raise RuntimeError('Pinned JPEXS is missing; run python3 local/client-bridge/build.py first')
    build.checked(build.TOOLS / 'ffdec/lib/ffdec_lib.jar', build.LIB_SHA256)
    if OUT.exists():
        shutil.rmtree(OUT)
    classes = sorted({PKG + entry[1] for entry in METHODS})
    subprocess.run([java(), f'-Duser.home={build.TOOLS}', '-jar', str(jar), '-onerror', 'ignore',
                    '-format', 'script:pcode', '-selectclass', ','.join(classes),
                    '-export', 'script', str(OUT), str(module)],
                   check=True, stdout=subprocess.DEVNULL)
    return OUT / 'scripts'


TRAIT = re.compile(r'^\s*trait (method|getter|setter) QName\((?:\w+)\("[^"]*"\),"([^"]+)"\)\s*$')
NEWFUNCTION = re.compile(r'^(newfunction) \d+$')


def bodies(text):
    """Yield (kind, name, normalized body lines) for each trait method in a P-code class file."""
    lines = text.splitlines()
    index = 0
    while index < len(lines):
        match = TRAIT.match(lines[index])
        index += 1
        if not match:
            continue
        while lines[index].strip() != 'body':
            if TRAIT.match(lines[index]):
                raise ValueError(f'Trait {match.group(2)} has no body')
            index += 1
        indent = lines[index][:len(lines[index]) - len(lines[index].lstrip())]
        index += 1
        body = []
        while lines[index] != indent + 'end ; body':
            body.append(NEWFUNCTION.sub(r'\1 <closure>', lines[index].strip()))
            index += 1
        yield match.group(1), match.group(2), body


def hashes(scripts):
    result = []
    for role, cls, kind, name, note in METHODS:
        path = scripts / (PKG + cls).replace('.', '/')
        found = [b for k, n, b in bodies(path.with_suffix('.pcode').read_text()) if (k, n) == (kind, name)]
        if len(found) != 1:
            raise ValueError(f'Expected one {kind} {cls}.{name}, found {len(found)}')
        body = '\n'.join(found[0]).encode()
        result.append({'role': role, 'class': PKG + cls, 'kind': kind, 'method': name,
                       'instructions': len(found[0]), 'sha256': build.digest(body), 'note': note})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--check', action='store_true', help='verify against adoption-methods.json')
    parser.add_argument('--module', default=str(ROOT / MODULE), help='module to map (default: pinned source)')
    args = parser.parse_args()
    module = Path(args.module)
    data = module.read_bytes()
    pinned = Path(args.module).resolve() == (ROOT / MODULE).resolve()
    if pinned and build.digest(data) != MODULE_SHA256:
        raise SystemExit(f'Unexpected SHA256 for {MODULE}; refusing to map')
    methods = hashes(export(module))
    manifest = {
        'version': 1, 'kind': 'puffle-adoption-method-map',
        'source': MODULE, 'sourceSha256': MODULE_SHA256,
        'decompiler': {'name': 'JPEXS', 'version': build.VERSION, 'librarySha256': build.LIB_SHA256,
                       'format': 'script:pcode', 'normalized': ['newfunction <method index>']},
        'methods': methods,
    }
    if args.check:
        expected = {(m['class'], m['kind'], m['method']): m['sha256']
                    for m in json.loads(MANIFEST.read_text())['methods']}
        changed = [f"{m['class']}.{m['method']}" for m in methods
                   if expected.get((m['class'], m['kind'], m['method'])) != m['sha256']]
        for name in changed:
            print(f'changed: {name}')
        print(f'{len(methods) - len(changed)}/{len(methods)} mapped method bodies match {MANIFEST.name}')
        return 1 if changed else 0
    MANIFEST.write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Wrote {MANIFEST.relative_to(ROOT)} with {len(methods)} methods')
    return 0


if __name__ == '__main__':
    sys.exit(main())
