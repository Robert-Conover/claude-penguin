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
  {"op": "verify", "mappings": [{key, marker, username, ownerId, iglooId, puffles: [{puffleId, name, puffleType}]}]}
      Check complete owner/layout/puffle mappings, including that the managed
      igloo is still locked in the database. The owner's puffles must be
      exactly the recorded set (ID, name, type, indoors), at most 10, with no
      backyard puffles; an unrecorded puffle is reported with its adoption
      receipt ID, if any, and is never adopted into state here. A legacy
      fixture mapping ({key, fixtureId, ownerId, iglooId, puffleId, puffleName})
      keeps its one-puffle check.
  {"op": "receipts", "adoptionIds": [uuid, ...]}
      Read-only: stored project-adoption receipts for these IDs. The receipt
      table belongs to project_adoption.py, which the world server creates.
  {"op": "settle", "adoptions": [{adoptionId, visitorId, ownerId, expiresAt}, ...]}
      Decide expired adoptions (expiresAt in Unix seconds) as charged or not
      charged, each in its own transaction on the visitor's row lock
      (project_adoption.settle). Each result is reported only after its
      transaction committed; a lost response is safe to repeat. Refused with
      SCHEMA until the world server has recorded adoption schema version 2,
      which is what makes its purchase handler honor settlements. Only a marked
      test visitor's adoptions can be settled.

Igloo creation is not done here; the engine performs it through the owner's
ordinary game session. Project adoption happens only through the visitor's own
purchase (project_adoption.py). Existing accounts are never updated.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys

sys.dont_write_bytecode = True

import game_accounts
import project_adoption
from game_accounts import MANAGED_USERNAME, VISITOR_USERNAMES, managed_marker

MAX_REQUEST = 64 * 1024
MAX_MAPPINGS = 64
MAX_RECEIPTS = 256
MAX_PUFFLES = project_adoption.CAPACITY
PROJECT_NAME = re.compile(r'^[A-Za-z0-9](?:[A-Za-z0-9._-]| (?! ))*$')
PUFFLE_NAME = re.compile(r'^[A-Za-z]{1,16}$')
BLUE_PUFFLE = 0
PUFFLE_TYPES = set(project_adoption.CATALOG.values())


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
    username = request.get('username', 'bridgecheck')
    if username not in VISITOR_USERNAMES:
        raise RequestError('The visitor must be one of the marked fixture visitors')
    password = request.get('password')
    if password is None:
        password = game_accounts.test_password(environ)
    elif not isinstance(password, str) or not 1 <= len(password) <= 128:
        raise RequestError('The visitor password must be 1 to 128 characters')
    async with connection.transaction():
        if recorded is not None:
            # Verify only: a recorded visitor is never recreated or remapped.
            existing = await connection.fetchrow(
                'SELECT id, email FROM penguin WHERE lower(username) = $1', username)
            if existing is None:
                return failure('MISSING', f'No {username} account exists.')
            if existing['email'] != game_accounts.fixture_marker(username):
                return failure('MISMATCH', f'The {username} account is not the marked fixture visitor. Nothing was changed.')
            if existing['id'] != recorded:
                return failure('MISMATCH', f'The {username} visitor has game ID {existing["id"]}, not the recorded '
                                           f'{recorded}. Refusing to remap it; repair the visitor record explicitly.')
            return {'status': 'ok', 'penguinId': recorded, 'username': username, 'created': False}
        penguin_id, created = await game_accounts.ensure_fixture_account(
            connection, username, VISITOR_USERNAMES[username], password, game_accounts.auth_key(environ))
    return {'status': 'ok', 'penguinId': penguin_id, 'username': username, 'created': created}


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


def recorded_puffles(mapping):
    """The managed mapping's recorded puffle set, validated."""
    puffles = mapping.get('puffles')
    if not isinstance(puffles, list) or len(puffles) > MAX_PUFFLES:
        raise RequestError(f'Managed mappings list at most {MAX_PUFFLES} recorded puffles')
    recorded = {}
    for puffle in puffles:
        if not isinstance(puffle, dict) or set(puffle) != {'puffleId', 'name', 'puffleType'} \
                or not positive(puffle['puffleId']) or puffle['puffleId'] in recorded \
                or not isinstance(puffle['name'], str) or not PUFFLE_NAME.match(puffle['name']) \
                or puffle['puffleType'] not in PUFFLE_TYPES:
            raise RequestError('Each recorded puffle needs a unique ID, a name and a catalog type')
        recorded[puffle['puffleId']] = puffle
    return recorded


async def verify_mapping(connection, mapping):
    problems = []
    if not isinstance(mapping, dict) or not isinstance(mapping.get('key'), str) or len(mapping['key']) > 64:
        raise RequestError('Each mapping needs a short key')
    legacy = 'fixtureId' in mapping
    if legacy:
        username = {'bridge-alpha': 'bridgealpha', 'bridge-beta': 'bridgebeta'}.get(mapping['fixtureId'])
        if username is None or not PUFFLE_NAME.fullmatch(mapping.get('puffleName') or ''):
            return {'key': mapping['key'], 'ok': False, 'problems': ['Legacy fixture identity or puffle name is unknown.']}
        marker = game_accounts.fixture_marker(username)
        id_keys = ('ownerId', 'iglooId', 'puffleId')
    else:
        try:
            marker = managed_marker(mapping.get('marker'))
        except ValueError as error:
            raise RequestError(str(error)) from None
        username = mapping.get('username')
        if not isinstance(username, str) or not MANAGED_USERNAME.match(username):
            raise RequestError('Only managed owners can be verified')
        id_keys = ('ownerId', 'iglooId')
    ids = {key: mapping.get(key) for key in id_keys}
    if not all(positive(value) for value in ids.values()):
        raise RequestError('Mappings need positive owner and igloo IDs')
    if legacy and (not isinstance(mapping.get('puffleName'), str) or not PUFFLE_NAME.match(mapping['puffleName'])):
        raise RequestError('Legacy mappings need a puffle ID and name')
    recorded = None if legacy else recorded_puffles(mapping)

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
    unrecorded = []
    if legacy:
        if len(pets) != 1:
            problems.append(f'Expected exactly one managed puffle; found {len(pets)}.')
        else:
            pet = pets[0]
            if pet['id'] != ids['puffleId'] or pet['name'] != mapping['puffleName']:
                problems.append('The managed puffle has a different ID or name.')
            if pet['puffle_id'] != BLUE_PUFFLE or pet['backyard']:
                problems.append('The managed puffle is not the blue igloo puffle.')
    else:
        found = {pet['id']: pet for pet in pets}
        for puffle_id, puffle in recorded.items():
            pet = found.get(puffle_id)
            if pet is None:
                problems.append(f'Recorded puffle {puffle_id} ({puffle["name"]}) no longer belongs to this owner.')
            elif pet['name'] != puffle['name'] or pet['puffle_id'] != puffle['puffleType']:
                problems.append(f'Puffle {puffle_id} has a different name or type than recorded.')
            elif pet['backyard']:
                problems.append(f'Puffle {puffle_id} ({puffle["name"]}) is in the backyard; project puffles stay indoors.')
        extra = sorted(set(found) - set(recorded))
        if extra:
            receipts = {}
            if await project_adoption.schema_ready(connection):
                rows = await connection.fetch(
                    'SELECT adoption_id::text AS adoption_id, penguin_puffle_id FROM claude_penguin_adoption_receipt '
                    'WHERE penguin_puffle_id = ANY($1::int[])', extra)
                receipts = {row['penguin_puffle_id']: row['adoption_id'] for row in rows}
            unrecorded = [{'puffleId': puffle_id, 'adoptionId': receipts.get(puffle_id)} for puffle_id in extra]
            problems.append(f'The owner has {len(extra)} puffle(s) this project has not recorded; they were not adopted '
                            'into the project automatically.')
        if len(pets) > MAX_PUFFLES:
            problems.append(f'The owner has {len(pets)} puffles; a project igloo holds at most {MAX_PUFFLES}.')
    result = {'key': mapping['key'], 'ok': not problems, 'problems': problems}
    if unrecorded:
        result['unrecorded'] = unrecorded
    return result


async def verify(connection, request):
    mappings = request.get('mappings')
    if not isinstance(mappings, list) or not 1 <= len(mappings) <= MAX_MAPPINGS:
        raise RequestError(f'Pass 1 to {MAX_MAPPINGS} mappings')
    return {'status': 'ok', 'results': [await verify_mapping(connection, mapping) for mapping in mappings]}


async def receipts(connection, request):
    ids = request.get('adoptionIds')
    if not isinstance(ids, list) or len(ids) > MAX_RECEIPTS or len(set(ids)) != len(ids) \
            or not all(isinstance(value, str) and project_adoption.ADOPTION_ID.match(value) for value in ids):
        raise RequestError(f'Pass at most {MAX_RECEIPTS} distinct lowercase adoption IDs')
    if not await project_adoption.schema_ready(connection):
        # The world server creates the table at start; without it nobody can have adopted yet.
        return {'status': 'ok', 'schema': False, 'receipts': []}
    return {'status': 'ok', 'schema': True, 'receipts': await project_adoption.read_receipts(connection, ids)}


async def settle(connection, request):
    items = request.get('adoptions')
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_RECEIPTS:
        raise RequestError(f'Pass 1 to {MAX_RECEIPTS} adoptions')
    seen = set()
    for item in items:
        if not isinstance(item, dict) or set(item) != {'adoptionId', 'visitorId', 'ownerId', 'expiresAt'} \
                or not isinstance(item['adoptionId'], str) or not project_adoption.ADOPTION_ID.match(item['adoptionId']) \
                or item['adoptionId'] in seen or not all(isinstance(item[key], int) and not isinstance(item[key], bool)
                                                         and item[key] > 0 for key in ('visitorId', 'ownerId', 'expiresAt')):
            raise RequestError('Each adoption needs a distinct lowercase adoptionId and positive visitorId, ownerId and expiresAt')
        seen.add(item['adoptionId'])
    version = await project_adoption.schema_version(connection)
    if version != project_adoption.SCHEMA_VERSION:
        return failure('SCHEMA', f'The world server has not recorded adoption schema version {project_adoption.SCHEMA_VERSION} '
                       f'(found {version}); restart it with the current handler before settling.')
    visitors = {}
    results = []
    for item in items:
        visitor_id = item['visitorId']
        if visitor_id not in visitors:
            visitors[visitor_id] = await connection.fetchval('SELECT username FROM penguin WHERE id = $1', visitor_id)
        if visitors[visitor_id] not in VISITOR_USERNAMES:
            results.append({'adoptionId': item['adoptionId'], 'outcome': 'unknown-visitor'})
            continue
        result = await project_adoption.settle(connection, item['adoptionId'], visitor_id, item['ownerId'], item['expiresAt'])
        results.append({'adoptionId': item['adoptionId'], **result})
    return {'status': 'ok', 'results': results}


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
    if operation == 'receipts':
        return await receipts(connection, request)
    if operation == 'settle':
        return await settle(connection, request)
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
