#!/usr/bin/env python3
"""Database side of managed game provisioning for the agent engine.

Run only through the `provision` Compose service. The host engine sends one
JSON request on stdin and reads one JSON line from stdout; database credentials
stay in the container environment and managed-owner credentials never appear
in command arguments or output.

Operations:
  {"op": "visitor", "penguinId", "password"}
      Verify or create only the marked `bridgecheck` visitor (shared with
      bridge_seed.py through game_accounts.py). Never changes an existing one.
      With a recorded `penguinId` it only verifies that visitor: a missing one
      returns MISSING and a different one MISMATCH; nothing is created. The
      optional fixture `password` is used only for creation; without it,
      CLUB_PENGUIN_TEST_PASSWORD or the shared default applies.
  {"op": "owner", "marker", "username", "password", "nickname", "ownerId"}
      Create or accept one dedicated managed owner. The UUID marker (stored as
      the account email) proves ownership; a username taken by any other
      account returns USERNAME_TAKEN; duplicated or mismatched markers fail.
      With a recorded `ownerId` it only verifies that owner: no marked account
      returns MISSING and a different ID MISMATCH; nothing is created.
  {"op": "verify", "mappings": [{key, marker, username, ownerId, iglooId, puffleId, puffleName}]}
      Check complete owner/layout/puffle mappings, including that the managed
      igloo is still locked in the database.

Igloo creation and puffle adoption are not done here; the engine performs them
through the owner's ordinary game session. Existing accounts are never updated.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys

sys.dont_write_bytecode = True

import game_accounts
from game_accounts import MANAGED_USERNAME, VISITOR_NICKNAME, VISITOR_USERNAME, managed_marker

MAX_REQUEST = 64 * 1024
MAX_MAPPINGS = 64
PROJECT_NAME = re.compile(r'^[A-Za-z0-9](?:[A-Za-z0-9._-]| (?! ))*$')
PUFFLE_NAME = re.compile(r'^[A-Za-z]{1,16}$')
BLUE_PUFFLE = 0


class RequestError(ValueError):
    pass


def unique_violations():
    try:
        import asyncpg
        return (asyncpg.UniqueViolationError,)
    except ImportError:  # Host unit tests without asyncpg.
        return ()


def failure(code, message):
    return {'status': 'failed', 'code': code, 'error': message}


def positive(value):
    return type(value) is int and value > 0


def owner_request(request):
    try:
        marker = managed_marker(request.get('marker'))
    except ValueError as error:
        raise RequestError(str(error)) from None
    username, password, nickname = request.get('username'), request.get('password'), request.get('nickname')
    if not isinstance(username, str) or not MANAGED_USERNAME.match(username):
        raise RequestError('Managed owner usernames must match cp + 10 lowercase letters or digits')
    if not isinstance(password, str) or not 16 <= len(password) <= 128:
        raise RequestError('Managed owner passwords must be 16 to 128 characters')
    if not isinstance(nickname, str) or not 1 <= len(nickname) <= 30 or not PROJECT_NAME.match(nickname) \
            or not nickname[-1].isalnum():
        raise RequestError('The owner nickname must be a valid project name')
    return marker, username, password, nickname, recorded_id(request, 'ownerId')


def recorded_id(request, key):
    value = request.get(key)
    if value is not None and not positive(value):
        raise RequestError(f'A recorded {key} must be a positive integer')
    return value


async def visitor(connection, request, environ=os.environ):
    recorded = recorded_id(request, 'penguinId')
    password = request.get('password')
    if password is None:
        password = game_accounts.test_password(environ)
    elif not isinstance(password, str) or not 1 <= len(password) <= 128:
        raise RequestError('The visitor password must be 1 to 128 characters')
    async with connection.transaction():
        if recorded is not None:
            # Verify only: a recorded visitor is never recreated or remapped.
            existing = await connection.fetchrow(
                'SELECT id, email FROM penguin WHERE lower(username) = $1', VISITOR_USERNAME)
            if existing is None:
                return failure('MISSING', f'No {VISITOR_USERNAME} account exists.')
            if existing['email'] != game_accounts.fixture_marker(VISITOR_USERNAME):
                return failure('MISMATCH', f'The {VISITOR_USERNAME} account is not the marked fixture visitor. Nothing was changed.')
            if existing['id'] != recorded:
                return failure('MISMATCH', f'The {VISITOR_USERNAME} visitor has game ID {existing["id"]}, not the recorded '
                                           f'{recorded}. Refusing to remap it; repair the visitor record explicitly.')
            return {'status': 'ok', 'penguinId': recorded, 'username': VISITOR_USERNAME, 'created': False}
        penguin_id, created = await game_accounts.ensure_fixture_account(
            connection, VISITOR_USERNAME, VISITOR_NICKNAME, password, game_accounts.auth_key(environ))
    return {'status': 'ok', 'penguinId': penguin_id, 'username': VISITOR_USERNAME, 'created': created}


async def owner(connection, request, environ=os.environ):
    marker, username, password, nickname, recorded = owner_request(request)

    async def reconcile_or_create():
        async with connection.transaction():
            marked = await connection.fetch('SELECT id, username FROM penguin WHERE email = $1', marker)
            if len(marked) > 1:
                return failure('MISMATCH', 'Several accounts carry this project\'s ownership marker; refusing to choose one.')
            if marked:
                if marked[0]['username'].lower() != username:
                    return failure('MISMATCH', 'This project\'s ownership marker belongs to an account with a different username.')
                if recorded is not None and marked[0]['id'] != recorded:
                    return failure('MISMATCH', f'The marked owner has game ID {marked[0]["id"]}, not the recorded {recorded}. '
                                               'Nothing was remapped.')
                return {'status': 'ok', 'ownerId': marked[0]['id'], 'created': False}
            if recorded is not None:
                # Verify only: never create a second owner for a project that already recorded one.
                exists = await connection.fetchval('SELECT id FROM penguin WHERE id = $1', recorded)
                detail = 'still exists but no longer carries this project\'s ownership marker' if exists is not None \
                    else 'no longer exists'
                return failure('MISSING', f'Game ID {recorded} {detail}.')
            taken = await connection.fetchval('SELECT id FROM penguin WHERE lower(username) = $1', username)
            if taken is not None:
                return failure('USERNAME_TAKEN', 'The generated username belongs to another account.')
            owner_id = await game_accounts.insert_account(
                connection, username, nickname,
                game_accounts.stored_password_hash(password, game_accounts.auth_key(environ)), marker)
            return {'status': 'ok', 'ownerId': owner_id, 'created': True}

    try:
        return await reconcile_or_create()
    except unique_violations():
        return failure('USERNAME_TAKEN', 'The generated username was claimed concurrently.')


async def verify_mapping(connection, mapping):
    problems = []
    if not isinstance(mapping, dict) or not isinstance(mapping.get('key'), str) or len(mapping['key']) > 64:
        raise RequestError('Each mapping needs a short key')
    if 'fixtureId' in mapping:
        username = {'bridge-alpha': 'bridgealpha', 'bridge-beta': 'bridgebeta'}.get(mapping['fixtureId'])
        if username is None or not PUFFLE_NAME.fullmatch(mapping.get('puffleName') or ''):
            return {'key': mapping['key'], 'ok': False, 'problems': ['Legacy fixture identity or puffle name is unknown.']}
        marker = game_accounts.fixture_marker(username)
    else:
        try:
            marker = managed_marker(mapping.get('marker'))
        except ValueError as error:
            raise RequestError(str(error)) from None
        username = mapping.get('username')
        if not isinstance(username, str) or not MANAGED_USERNAME.match(username):
            raise RequestError('Only managed owners can be verified')
    ids = {key: mapping.get(key) for key in ('ownerId', 'iglooId', 'puffleId')}
    if not all(positive(value) for value in ids.values()) or not isinstance(mapping.get('puffleName'), str) \
            or not PUFFLE_NAME.match(mapping['puffleName']):
        raise RequestError('Mappings need positive owner, igloo, and puffle IDs and a puffle name')

    marked = await connection.fetch('SELECT id, username, igloo FROM penguin WHERE email = $1', marker)
    if len(marked) != 1:
        problems.append(f'Expected one account with this project\'s marker; found {len(marked)}.')
    else:
        account = marked[0]
        if account['id'] != ids['ownerId']:
            problems.append('The marked account has a different penguin ID.')
        if account['username'].lower() != username:
            problems.append('The marked account has a different username.')
        if account['igloo'] != ids['iglooId']:
            problems.append('The owner\'s active igloo is not the recorded layout.')
    room = await connection.fetchrow('SELECT penguin_id, locked FROM penguin_igloo_room WHERE id = $1', ids['iglooId'])
    if room is None:
        problems.append('The recorded igloo layout no longer exists.')
    else:
        if room['penguin_id'] != ids['ownerId']:
            problems.append('The recorded igloo layout belongs to another penguin.')
        if room['locked'] is not True:
            problems.append('The managed igloo is open in the database; it must stay locked.')
    pets = await connection.fetch(
        'SELECT id, puffle_id, name, backyard FROM penguin_puffle WHERE penguin_id = $1', ids['ownerId'])
    if len(pets) != 1:
        problems.append(f'Expected exactly one managed puffle; found {len(pets)}.')
    else:
        pet = pets[0]
        if pet['id'] != ids['puffleId'] or pet['name'] != mapping['puffleName']:
            problems.append('The managed puffle has a different ID or name.')
        if pet['puffle_id'] != BLUE_PUFFLE or pet['backyard']:
            problems.append('The managed puffle is not the blue igloo puffle.')
    return {'key': mapping['key'], 'ok': not problems, 'problems': problems}


async def verify(connection, request):
    mappings = request.get('mappings')
    if not isinstance(mappings, list) or not 1 <= len(mappings) <= MAX_MAPPINGS:
        raise RequestError(f'Pass 1 to {MAX_MAPPINGS} mappings')
    return {'status': 'ok', 'results': [await verify_mapping(connection, mapping) for mapping in mappings]}


async def handle(request, connection, environ=os.environ):
    if not isinstance(request, dict):
        raise RequestError('Expected a JSON object')
    operation = request.get('op')
    if operation == 'visitor':
        return await visitor(connection, request, environ)
    if operation == 'owner':
        return await owner(connection, request, environ)
    if operation == 'verify':
        return await verify(connection, request)
    raise RequestError('Unknown provisioning operation')


async def main(raw):
    if len(raw) > MAX_REQUEST:
        raise RequestError('Request too large')
    request = json.loads(raw)
    connection = await game_accounts.connect()
    try:
        return await handle(request, connection)
    finally:
        await connection.close()


if __name__ == '__main__':
    try:
        result = asyncio.run(main(sys.stdin.read(MAX_REQUEST + 1)))
    except RequestError as error:
        result = failure('INVALID', str(error))
    except (RuntimeError, OSError, ValueError) as error:
        result = failure('UNAVAILABLE' if isinstance(error, OSError) else 'FAILED', str(error)[:300])
    except Exception as error:  # asyncpg errors; never echo the request.
        result = failure('FAILED', f'{type(error).__name__}: {str(error)[:300]}')
    print(json.dumps(result))
    sys.exit(0 if result.get('status') != 'failed' else 1)
