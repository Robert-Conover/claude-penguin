#!/usr/bin/env python3
"""Host-runnable checks for game_provision.py with an in-memory database fake.

Run: python3 -m unittest local/test_game_provision.py
No asyncpg, bcrypt, Docker, or running game is needed. Real database behavior
is covered only by the live provisioning path behind ./local/start.
"""
import asyncio
import contextlib
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import game_accounts  # noqa: E402
import game_provision  # noqa: E402

MARKER = '6f1c2f8e-7f55-4d1a-9b8e-2b1f3c4d5e6f'
EMAIL = f'{MARKER}@managed.claude-penguin.invalid'


class FakeConnection:
    def __init__(self):
        self.penguins = []
        self.rooms = {}
        self.pets = []
        self.statements = []

    @contextlib.asynccontextmanager
    async def _transaction(self):
        yield

    def transaction(self):
        return self._transaction()

    async def fetch(self, query, value):
        self.statements.append(query)
        if 'FROM penguin_puffle' in query:
            return [pet for pet in self.pets if pet['penguin_id'] == value]
        if 'WHERE email' in query:
            return [row for row in self.penguins if row['email'] == value]
        raise AssertionError(query)

    async def fetchrow(self, query, value):
        self.statements.append(query)
        if 'FROM penguin_igloo_room' in query:
            return self.rooms.get(value)
        if 'lower(username)' in query:
            return next((row for row in self.penguins if row['username'].lower() == value), None)
        raise AssertionError(query)

    async def fetchval(self, query, *values):
        self.statements.append(query)
        if 'FROM penguin WHERE id' in query:
            return next((row['id'] for row in self.penguins if row['id'] == values[0]), None)
        if 'lower(username)' in query:
            row = next((row for row in self.penguins if row['username'].lower() == values[0]), None)
            return row and row['id']
        if query.lstrip().startswith('INSERT INTO penguin\n') or 'INSERT INTO penguin\n' in query:
            username, nickname, password, email, coins = values
            row = {'id': 100 + len(self.penguins), 'username': username, 'nickname': nickname, 'password': password,
                   'email': email, 'coins': coins, 'igloo': None}
            self.penguins.append(row)
            return row['id']
        raise AssertionError(query)

    async def execute(self, query, *values):
        self.statements.append(query)


def run(coroutine):
    return asyncio.run(coroutine)


def owner_request(**overrides):
    return {'op': 'owner', 'marker': MARKER, 'username': 'cpabcdefgh12', 'password': 'x' * 24, 'nickname': 'My Project', **overrides}


@patch.object(game_accounts, 'stored_password_hash', lambda password, key: 'hashed')
class ProvisionTests(unittest.TestCase):
    def test_owner_is_created_once_and_reconciled_by_marker(self):
        db = FakeConnection()
        first = run(game_provision.handle(owner_request(), db))
        self.assertEqual(first, {'status': 'ok', 'ownerId': 100, 'created': True})
        self.assertEqual(db.penguins[0]['email'], EMAIL)
        self.assertEqual(db.penguins[0]['nickname'], 'My Project')
        self.assertEqual(db.penguins[0]['password'], 'hashed', 'only the bcrypt hash is stored')
        again = run(game_provision.handle(owner_request(), db))
        self.assertEqual(again, {'status': 'ok', 'ownerId': 100, 'created': False})
        self.assertEqual(len(db.penguins), 1, 'a retry never duplicates the owner')

    def test_username_collisions_and_marker_conflicts_fail_explicitly(self):
        db = FakeConnection()
        db.penguins.append({'id': 7, 'username': 'cpabcdefgh12', 'email': 'someone@example.invalid', 'igloo': None})
        self.assertEqual(run(game_provision.handle(owner_request(), db))['code'], 'USERNAME_TAKEN')
        db = FakeConnection()
        db.penguins.append({'id': 8, 'username': 'cpzzzzzzzzzz', 'email': EMAIL, 'igloo': None})
        self.assertEqual(run(game_provision.handle(owner_request(), db))['code'], 'MISMATCH')
        db.penguins.append({'id': 9, 'username': 'cpabcdefgh12', 'email': EMAIL, 'igloo': None})
        self.assertEqual(run(game_provision.handle(owner_request(), db))['code'], 'MISMATCH')

    def test_only_managed_usernames_and_valid_nicknames_are_accepted(self):
        db = FakeConnection()
        for bad in ({'username': 'player'}, {'username': 'bridgecheck'}, {'username': 'CPABCDEFGH12'},
                    {'nickname': 'A|B'}, {'nickname': 'a  b'}, {'password': 'short'}, {'marker': 'not-a-uuid'}):
            with self.assertRaises(game_provision.RequestError, msg=bad):
                run(game_provision.handle(owner_request(**bad), db))
        self.assertEqual(db.penguins, [])

    def test_visitor_shares_the_fixture_marker_and_never_accepts_unrelated_accounts(self):
        db = FakeConnection()
        result = run(game_provision.handle({'op': 'visitor'}, db, {'CLUB_PENGUIN_TEST_PASSWORD': 'Shared123!'}))
        self.assertEqual(result, {'status': 'ok', 'penguinId': 100, 'username': 'bridgecheck', 'created': True})
        self.assertEqual(db.penguins[0]['email'], 'bridgecheck@bridge.example.invalid')
        self.assertFalse(run(game_provision.handle({'op': 'visitor'}, db, {}))['created'])
        db = FakeConnection()
        db.penguins.append({'id': 3, 'username': 'bridgecheck', 'email': 'other@example.invalid'})
        with self.assertRaisesRegex(RuntimeError, 'unrelated'):
            run(game_provision.handle({'op': 'visitor'}, db, {}))

    def test_verify_requires_complete_locked_mapping(self):
        db = FakeConnection()
        db.penguins.append({'id': 201, 'username': 'cpabcdefgh12', 'email': EMAIL, 'igloo': 9})
        db.rooms[9] = {'penguin_id': 201, 'locked': True}
        db.pets.append({'id': 31, 'penguin_id': 201, 'puffle_id': 0, 'name': 'Atlas', 'backyard': False})
        mapping = {'key': 'p1', 'marker': MARKER, 'username': 'cpabcdefgh12', 'ownerId': 201, 'iglooId': 9,
                   'puffleId': 31, 'puffleName': 'Atlas'}
        result = run(game_provision.handle({'op': 'verify', 'mappings': [mapping]}, db))
        self.assertEqual(result, {'status': 'ok', 'results': [{'key': 'p1', 'ok': True, 'problems': []}]})
        db.rooms[9]['locked'] = False
        db.pets.append({'id': 32, 'penguin_id': 201, 'puffle_id': 0, 'name': 'Extra', 'backyard': False})
        problems = run(game_provision.handle({'op': 'verify', 'mappings': [{**mapping, 'iglooId': 9}]}, db))['results'][0]
        self.assertFalse(problems['ok'])
        self.assertTrue(any('locked' in problem for problem in problems['problems']))
        self.assertTrue(any('exactly one' in problem for problem in problems['problems']))

    def test_protocol_verifiers_refuse_interactive_accounts_before_connecting(self):
        from types import SimpleNamespace
        import verify_bridge
        import verify_game
        for username in ('player', 'bridgecheck'):
            with self.assertRaises(verify_game.VerificationError):
                verify_game.world_session(SimpleNamespace(username=username), 'unused')
            with self.assertRaises(verify_game.VerificationError):
                verify_bridge.session(SimpleNamespace(), username, 'unused')

    def test_legacy_mapping_is_read_only_and_uses_the_fixture_marker(self):
        db = FakeConnection()
        mapping = {'key': 'atlas', 'fixtureId': 'bridge-alpha', 'ownerId': 105, 'iglooId': 4,
                   'puffleId': 4, 'puffleName': 'Atlas'}
        def check():
            return run(game_provision.verify_mapping(db, mapping))['ok']
        self.assertFalse(check())
        self.assertEqual(db.penguins, [])
        db.penguins.append({'id': 105, 'username': 'bridgealpha', 'email': 'bridgealpha@bridge.example.invalid', 'igloo': 4})
        db.rooms[4] = {'penguin_id': 105, 'locked': True}
        db.pets.append({'id': 4, 'penguin_id': 105, 'puffle_id': 0, 'name': 'Atlas', 'backyard': False})
        self.assertTrue(check())
        db.penguins[0]['email'] = 'unmarked@example.invalid'
        self.assertFalse(check())

    def test_a_recorded_owner_is_only_verified_and_never_recreated(self):
        db = FakeConnection()
        missing = run(game_provision.handle(owner_request(ownerId=201), db))
        self.assertEqual(missing['code'], 'MISSING')
        self.assertIn('no longer exists', missing['error'])
        self.assertEqual(db.penguins, [], 'nothing is created for a recorded owner')
        db.penguins.append({'id': 201, 'username': 'cpabcdefgh12', 'email': 'edited@example.invalid', 'igloo': None})
        unmarked = run(game_provision.handle(owner_request(ownerId=201), db))
        self.assertEqual(unmarked['code'], 'MISSING', 'a held username is not USERNAME_TAKEN when an owner is recorded')
        self.assertIn('no longer carries', unmarked['error'])
        self.assertEqual(len(db.penguins), 1)
        db.penguins[0]['email'] = EMAIL
        self.assertEqual(run(game_provision.handle(owner_request(ownerId=201), db)), {'status': 'ok', 'ownerId': 201, 'created': False})
        moved = run(game_provision.handle(owner_request(ownerId=202), db))
        self.assertEqual(moved['code'], 'MISMATCH')
        self.assertIn('not the recorded 202', moved['error'])
        for bad in (0, -1, '201', True, 1.5):
            with self.assertRaises(game_provision.RequestError, msg=bad):
                run(game_provision.handle(owner_request(ownerId=bad), db))
        self.assertEqual(len(db.penguins), 1)

    def test_a_recorded_visitor_is_only_verified_and_never_recreated(self):
        db = FakeConnection()
        missing = run(game_provision.handle({'op': 'visitor', 'penguinId': 107}, db, {}))
        self.assertEqual(missing['code'], 'MISSING')
        self.assertEqual(db.penguins, [], 'a recorded visitor is never recreated')
        created = run(game_provision.handle({'op': 'visitor', 'penguinId': None}, db, {}))
        self.assertTrue(created['created'])
        visitor_id = created['penguinId']
        self.assertEqual(run(game_provision.handle({'op': 'visitor', 'penguinId': visitor_id}, db, {})),
                         {'status': 'ok', 'penguinId': visitor_id, 'username': 'bridgecheck', 'created': False})
        moved = run(game_provision.handle({'op': 'visitor', 'penguinId': 107}, db, {}))
        self.assertEqual(moved['code'], 'MISMATCH')
        self.assertIn('not the recorded 107', moved['error'])
        db.penguins[0]['email'] = 'other@example.invalid'
        self.assertEqual(run(game_provision.handle({'op': 'visitor', 'penguinId': visitor_id}, db, {}))['code'], 'MISMATCH')
        for bad in (0, '107', True):
            with self.assertRaises(game_provision.RequestError, msg=bad):
                run(game_provision.handle({'op': 'visitor', 'penguinId': bad}, db, {}))
        self.assertEqual(len(db.penguins), 1)

    def test_the_visitor_password_arrives_in_the_request_with_the_previous_fallbacks(self):
        used = []

        def record(password, key):
            used.append(password)
            return 'hashed'

        cases = ((({'op': 'visitor', 'password': 'FromRequest1!'}, {'CLUB_PENGUIN_TEST_PASSWORD': 'FromEnv1!'}), 'FromRequest1!'),
                 (({'op': 'visitor'}, {'CLUB_PENGUIN_TEST_PASSWORD': 'FromEnv1!'}), 'FromEnv1!'),
                 (({'op': 'visitor', 'password': None}, {}), game_accounts.DEFAULT_TEST_PASSWORD))
        with patch.object(game_accounts, 'stored_password_hash', record):
            for (request, environ), _ in cases:
                run(game_provision.handle(request, FakeConnection(), environ))
        self.assertEqual(used, [expected for _, expected in cases])
        for bad in ('', 'x' * 129, 7):
            with self.assertRaises(game_provision.RequestError, msg=bad):
                run(game_provision.handle({'op': 'visitor', 'password': bad}, FakeConnection(), {}))

    def test_main_never_echoes_credentials(self):
        connections = []

        async def connect():
            connection = type('Closable', (FakeConnection,), {'close': lambda self: asyncio.sleep(0)})()
            connections.append(connection)
            return connection

        with patch.object(game_accounts, 'connect', connect):
            result = run(game_provision.main(json.dumps(owner_request(password='SecretSecret1234!'))))
            visitor = run(game_provision.main(json.dumps({'op': 'visitor', 'password': 'VisitorSecret99!'})))
        self.assertEqual(result['status'], 'ok')
        self.assertNotIn('SecretSecret1234!', json.dumps(result))
        self.assertNotIn('SecretSecret1234!', json.dumps(connections[0].penguins), 'only a hash is stored')
        self.assertEqual(visitor['status'], 'ok')
        self.assertNotIn('VisitorSecret99!', json.dumps(visitor) + json.dumps(connections[1].penguins))


if __name__ == '__main__':
    unittest.main(verbosity=2)
