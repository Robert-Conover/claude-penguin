#!/usr/bin/env python3
"""Shared identities for disposable game accounts.

The bridge fixture seeder (bridge_seed.py) and the agent engine's provisioning
service (game_provision.py) both create or accept the marked `bridgecheck`
visitor. They share its username, marker email, and disposable password source
here, so either accepts an account the other created. Managed project owners
use a separate UUID marker namespace and generated credentials.

Database packages are imported lazily so helpers can be unit-tested on a host
without asyncpg or bcrypt.
"""
from __future__ import annotations

import os
import re
import sys

sys.dont_write_bytecode = True

from verify_game import login_password_hash

VISITOR_USERNAME = 'bridgecheck'
VISITOR_NICKNAME = 'Bridge Check'
# `adoptcheck` is the marked test visitor for mutating adoption checks, so
# bridgecheck's coins and map stay untouched. Both carry the fixture marker.
VISITOR_USERNAMES = {VISITOR_USERNAME: VISITOR_NICKNAME, 'adoptcheck': 'Adopt Check'}
DEFAULT_TEST_PASSWORD = 'PenguinLocal2026!'
FIXTURE_MARKER_DOMAIN = 'bridge.example.invalid'
MANAGED_MARKER_DOMAIN = 'managed.claude-penguin.invalid'
MANAGED_USERNAME = re.compile(r'^cp[a-z0-9]{10}$')
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')


def fixture_marker(username: str) -> str:
    return f'{username}@{FIXTURE_MARKER_DOMAIN}'


def managed_marker(marker: str) -> str:
    if not UUID.match(marker or ''):
        raise ValueError('Managed ownership markers must be lowercase UUIDs')
    return f'{marker}@{MANAGED_MARKER_DOMAIN}'


def test_password(environ=os.environ) -> str:
    return environ.get('CLUB_PENGUIN_TEST_PASSWORD') or DEFAULT_TEST_PASSWORD


def auth_key(environ=os.environ) -> str:
    return environ.get('CLUB_PENGUIN_AUTH_KEY', 'houdini')


def stored_password_hash(password: str, key: str) -> str:
    """bcrypt of the game login hash, as Dash registration stores it."""
    import bcrypt
    encoded = login_password_hash(password, key).encode('utf-8')
    return bcrypt.hashpw(encoded, bcrypt.gensalt(rounds=12)).decode('utf-8')


async def connect(environ=os.environ):
    import asyncpg
    database_password = environ.get('POSTGRES_PASSWORD')
    if not database_password:
        raise RuntimeError('POSTGRES_PASSWORD must be set')
    user = environ.get('POSTGRES_USER', 'postgres')
    return await asyncpg.connect(
        host=environ.get('POSTGRES_HOST', 'db'),
        port=int(environ.get('POSTGRES_PORT', '5432')),
        user=user, password=database_password,
        database=environ.get('POSTGRES_DB', user), timeout=15,
    )


async def insert_account(connection, username, nickname, password_hash, email, coins=10000):
    """Mirror Dash registration: activated, English-approved, blue, welcome postcard."""
    penguin_id = await connection.fetchval(
        '''INSERT INTO penguin
           (username, nickname, password, email, active, approval_en, color, coins)
           VALUES ($1, $2, $3, $4, true, true, 1, $5) RETURNING id''',
        username, nickname, password_hash, email, coins)
    await connection.execute(
        'INSERT INTO penguin_item (penguin_id, item_id) VALUES ($1, 1)', penguin_id)
    await connection.execute(
        '''INSERT INTO penguin_postcard (penguin_id, sender_id, postcard_id)
           VALUES ($1, NULL, 125)''', penguin_id)
    return penguin_id


async def ensure_fixture_account(connection, username, nickname, password, key):
    """Create a marked fixture account, or accept the same marked account unchanged."""
    marker = fixture_marker(username)
    existing = await connection.fetchrow(
        'SELECT id, email FROM penguin WHERE lower(username) = $1', username)
    if existing is not None:
        if existing['email'] != marker:
            raise RuntimeError(f'Refusing unrelated existing account: {username}')
        return existing['id'], False
    penguin_id = await insert_account(connection, username, nickname,
                                      stored_password_hash(password, key), marker)
    return penguin_id, True
