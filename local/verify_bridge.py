#!/usr/bin/env python3
"""Prepare and verify disposable project-igloo fixtures using real game packets.

This is a game-bridge experiment, not repository registration or agent execution.
Run local/bridge-fixtures to seed accounts and create the ignored manifest.
Standalone checks reuse that manifest and require CLUB_PENGUIN_TEST_PASSWORD.
Existing accounts, furniture, puffle names/care state and coins are preserved;
first initialization adopts one puffle per new owner through the normal handler.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import xml.etree.ElementTree as ET

sys.dont_write_bytecode = True

from verify_game import VerificationError, igloo, igloo_layout, puffles, require, world_session


VISITOR_USERNAME = 'bridgecheck'
PROJECTS = (
    {'projectId': 'bridge-alpha', 'name': 'Bridge Alpha',
     'ownerUsername': 'bridgealpha', 'puffleName': 'Atlas'},
    {'projectId': 'bridge-beta', 'name': 'Bridge Beta',
     'ownerUsername': 'bridgebeta', 'puffleName': 'Comet'},
)
ROOT = Path(__file__).resolve().parent.parent


def session(args, username, password):
    require(username in {'localcheck', *(p['ownerUsername'] for p in PROJECTS)},
            'Refusing a non-fixture account')
    return world_session(SimpleNamespace(username=username, login_port=args.login_port,
                                        world_port=args.world_port, timeout=args.timeout), password)


def validate_manifest(manifest):
    require(isinstance(manifest, dict), 'Bridge manifest must be an object')
    require(manifest.get('version') == 1 and manifest.get('kind') == 'game-bridge-fixture',
            'Unexpected bridge manifest format')
    visitor = manifest.get('visitor', {})
    require(isinstance(visitor, dict), 'Bridge visitor must be an object')
    require(visitor.get('username') == VISITOR_USERNAME and type(visitor.get('penguinId')) is int
            and visitor['penguinId'] > 0, 'Invalid bridge visitor identity')
    projects = manifest.get('projects', [])
    require(isinstance(projects, list) and len(projects) == len(PROJECTS),
            'Expected exactly two bridge fixtures')
    for actual, expected in zip(projects, PROJECTS):
        require(isinstance(actual, dict), 'Bridge project must be an object')
        require(all(actual.get(key) == value for key, value in expected.items()),
                'Bridge project identity changed')
        require(all(type(actual.get(key)) is int and actual[key] > 0
                    for key in ('ownerId', 'iglooId', 'puffleId', 'roomId')),
                'Invalid game identity in bridge manifest')
        require(actual['roomId'] == actual['ownerId'] + 2000, 'Invalid igloo room address')
    require(len({visitor['penguinId'], *(p['ownerId'] for p in projects)}) == 3,
            'Bridge projects and visitor must have distinct owners')
    require(len({p['iglooId'] for p in projects}) == 2
            and len({p['puffleId'] for p in projects}) == 2,
            'Bridge layouts and puffle instances must be distinct')
    return {'version': 1, 'kind': 'game-bridge-fixture',
            'visitor': {key: visitor[key] for key in ('penguinId', 'username')},
            'projects': [{key: item[key] for key in (*expected, 'ownerId', 'iglooId', 'puffleId', 'roomId')}
                         for item, expected in zip(projects, PROJECTS)]}


def initialize(args, password):
    seed = json.loads(args.seed_report.read_text())
    require(seed.get('status') == 'passed' and seed.get('kind') == 'game-bridge-fixture-accounts',
            'Run bridge_seed.py before initializing fixtures')
    accounts = {entry['username']: entry['id'] for entry in seed['accounts']}
    require(set(accounts) == {VISITOR_USERNAME, *(p['ownerUsername'] for p in PROJECTS)},
            'Unexpected accounts in bridge seed report')
    existing = validate_manifest(json.loads(args.manifest.read_text())) if args.manifest.exists() else None
    if existing:
        expected_accounts = {p['ownerUsername']: p['ownerId'] for p in existing['projects']}
        expected_accounts[VISITOR_USERNAME] = existing['visitor']['penguinId']
        require(accounts == expected_accounts, 'Fixture account identity changed; refusing to remap')
        return existing
    projects = []
    for fixture in PROJECTS:
        world, owner_id, _ = session(args, fixture['ownerUsername'], password)
        with world:
            require(owner_id == accounts[fixture['ownerUsername']], 'Wrong fixture owner logged in')
            matches = [(key, fields) for key, fields in puffles(world).items()
                       if fields[3] == fixture['puffleName']]
            require(len(matches) <= 1, 'Ambiguous fixture puffle name')
            if matches:
                puffle_id, fields = matches[0]
                require(fields[1] == '0', 'Fixture puffle is not blue')
            else:
                world.xt('p#pn', 0, fixture['puffleName'], 0)
                adoption = world.wait_xt('pn')
                fields = adoption[1].split('|')
                require(fields[1] == '0' and fields[3] == fixture['puffleName'],
                        'Unexpected adopted puffle')
                puffle_id = int(fields[0])
            layout = igloo(world, owner_id)
            projects.append({**fixture, 'ownerId': owner_id, 'iglooId': int(layout[0]),
                             'roomId': owner_id + 2000, 'puffleId': puffle_id})
    return validate_manifest({'version': 1, 'kind': 'game-bridge-fixture',
                              'visitor': {'username': VISITOR_USERNAME,
                                          'penguinId': accounts[VISITOR_USERNAME]},
                              'projects': projects})


def visit(world, project):
    layout = igloo_layout(world, project['ownerId'])
    require(int(layout[0]) == project['iglooId'], 'Active igloo identity changed')
    world.xt('j#jp', project['ownerId'], 'igloo')
    entered = world.wait_xt('jp')
    require(entered == [str(project['roomId']), str(project['roomId']), 'igloo'],
            'Server entered the wrong project room')
    require(world.wait_xt('jr')[0] == str(project['roomId']),
            'Joined room does not match the mapped project owner')
    world.xt('p#pg', project['ownerId'], 'igloo')
    response = world.wait_xt('pg')
    pets = {int(fields[0]): fields for raw in response[1:] if raw
            for fields in [raw.split('|')]}
    require(project['puffleId'] in pets, 'Mapped puffle is absent from the project igloo')
    require(pets[project['puffleId']][3] == project['puffleName'], 'Mapped puffle name changed')


def verify(args, password, manifest):
    checks = []
    # Respect Houdini's one-second igloo cooldown across reconnects.
    time.sleep(1.1)
    visitor, visitor_id, _ = session(args, 'localcheck', password)
    with visitor:
        require(visitor_id != manifest['visitor']['penguinId'], 'Protocol checks must use localcheck')
        for project in manifest['projects']:
            visit(visitor, project)
            checks.append(f"{project['projectId']}: distinct owner, layout and igloo puffle identity")
            visitor.xt('j#jr', 100, 400, 300)
            require(visitor.wait_xt('jr')[0] == '100', 'Could not leave project igloo for Town')
            time.sleep(1.1)
        project = manifest['projects'][0]
        owner, owner_id, _ = session(args, project['ownerUsername'], password)
        with owner:
            require(owner_id == project['ownerId'], 'Wrong puffle owner logged in')
            layout = igloo(owner, owner_id)
            require(int(layout[0]) == project['iglooId'], 'Owner active igloo identity changed')
            visit(visitor, project)
            # Frame 2 is an ephemeral broadcast. This checks transport only;
            # its visual effect must be checked in the original client.
            owner.xt('p#ps', project['puffleId'], 2)
            require(visitor.wait_xt('ps') == [str(project['puffleId']), '2'],
                    'Puffle animation broadcast did not reach the visitor')
            checks.append('Mapped puffle frame broadcast reaches another client in the same igloo')
        visitor.xt('j#jr', 100, 400, 300)
        require(visitor.wait_xt('jr')[0] == '100', 'Could not return to Town')
        checks.append('Town travel and return to the first project preserve fixture mapping')
    time.sleep(1.1)
    visitor, reconnected_id, _ = session(args, 'localcheck', password)
    with visitor:
        require(reconnected_id == visitor_id, 'Verification account identity changed after reconnect')
        visit(visitor, manifest['projects'][1])
        checks.append('Reconnect retains visitor, project igloo and puffle identities')
    return {'status': 'passed', 'scope': 'real AS3 protocol; no browser click or animation rendering coverage',
            'kind': 'game-bridge-fixture-verification', 'checks': checks,
            'manifest': str(args.manifest), 'projects': manifest['projects']}


def save_manifest(path, manifest):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.bridge-fixtures-', suffix='.json', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(manifest, stream, indent=2)
            stream.write('\n')
        os.chmod(temporary, 0o644)  # Public game identities, readable by the web container.
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--initialize', action='store_true')
    parser.add_argument('--seed-report', type=Path, default=ROOT / '.local/bridge-seed.json')
    parser.add_argument('--manifest', type=Path, default=ROOT / '.local/bridge-public/fixtures.json')
    parser.add_argument('--login-port', type=int, default=6112)
    parser.add_argument('--world-port', type=int, default=9875)
    parser.add_argument('--timeout', type=float, default=15)
    args = parser.parse_args()
    password = os.environ.get('CLUB_PENGUIN_TEST_PASSWORD')
    if not password:
        parser.error('Set CLUB_PENGUIN_TEST_PASSWORD to the disposable fixture password')
    try:
        manifest = initialize(args, password) if args.initialize else validate_manifest(
            json.loads(args.manifest.read_text()))
        result = verify(args, password, manifest)
        if args.initialize:
            save_manifest(args.manifest, manifest)
    except (VerificationError, OSError, ValueError, KeyError, IndexError, TypeError, ET.ParseError) as error:
        print(json.dumps({'status': 'failed', 'error': str(error)}, indent=2))
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
