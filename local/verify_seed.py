#!/usr/bin/env python3
"""Create two disposable local accounts, without changing existing accounts.

Run inside the Houdini container, which provides asyncpg and bcrypt:
    python /project/local/verify_seed.py

Connection environment: POSTGRES_HOST (db), POSTGRES_PORT (5432),
POSTGRES_USER (postgres), POSTGRES_PASSWORD (required), POSTGRES_DB
(defaults to POSTGRES_USER). CLUB_PENGUIN_TEST_PASSWORD overrides the
public, disposable default password PenguinLocal2026! for both accounts.
CLUB_PENGUIN_AUTH_KEY overrides Houdini's default authentication key houdini.

Mirrors Dash registration: hash the game login credential with bcrypt, create
an activated/approved penguin, chosen blue color, and welcome postcard 125.
World login supplies normal default item/igloo/furniture inventories. The game
creates the first igloo on its ordinary g#gm request and awards starter cards
when the player obtains a starter deck. This helper deliberately leaves those
normal initialization paths intact for the baseline verifier and client.

Only player gets an explicit perpetual membership record. Houdini's unchanged
default grants membership to everyone (including localcheck) unless its
--expire-membership flag is enabled. No administrator/moderator role is given.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

sys.dont_write_bytecode = True

import asyncpg
import bcrypt

from verify_game import login_password_hash


ACCOUNTS = (
    ('localcheck', 'Local Check', 10000, False),
    ('player', 'Player', 100000, True),
)


async def seed():
    database_password = os.environ.get('POSTGRES_PASSWORD')
    if not database_password:
        raise RuntimeError('POSTGRES_PASSWORD must be set')
    password = os.environ.get('CLUB_PENGUIN_TEST_PASSWORD', 'PenguinLocal2026!')
    auth_key = os.environ.get('CLUB_PENGUIN_AUTH_KEY', 'houdini')
    user = os.environ.get('POSTGRES_USER', 'postgres')
    connection = await asyncpg.connect(
        host=os.environ.get('POSTGRES_HOST', 'db'),
        port=int(os.environ.get('POSTGRES_PORT', '5432')),
        user=user,
        password=database_password,
        database=os.environ.get('POSTGRES_DB', user),
        timeout=15,
    )
    results = []
    try:
        for username, nickname, coins, membership in ACCOUNTS:
            async with connection.transaction():
                existing = await connection.fetchval(
                    'SELECT id FROM penguin WHERE lower(username) = $1', username)
                if existing is not None:
                    results.append({'username': username, 'id': existing,
                                    'status': 'already exists; unchanged'})
                    continue
                encoded = login_password_hash(password, auth_key).encode('utf-8')
                password_hash = bcrypt.hashpw(encoded, bcrypt.gensalt(rounds=12)).decode('utf-8')
                penguin_id = await connection.fetchval(
                    '''INSERT INTO penguin
                       (username, nickname, password, email, active, approval_en, color, coins)
                       VALUES ($1, $2, $3, $4, true, true, 1, $5)
                       ON CONFLICT (username) DO NOTHING RETURNING id''',
                    username, nickname, password_hash, username + '@example.invalid', coins)
                if penguin_id is None:
                    existing = await connection.fetchval(
                        'SELECT id FROM penguin WHERE username = $1', username)
                    results.append({'username': username, 'id': existing,
                                    'status': 'already exists; unchanged'})
                    continue
                await connection.execute(
                    'INSERT INTO penguin_item (penguin_id, item_id) VALUES ($1, 1)', penguin_id)
                await connection.execute(
                    '''INSERT INTO penguin_postcard (penguin_id, sender_id, postcard_id)
                       VALUES ($1, NULL, 125)''', penguin_id)
                if membership:
                    await connection.execute(
                        '''INSERT INTO penguin_membership (penguin_id, start, expires)
                           VALUES ($1, now() - interval '1 day', NULL)''', penguin_id)
                results.append({'username': username, 'id': penguin_id, 'status': 'created',
                                'starting_coins': coins, 'explicit_membership': membership})
    finally:
        await connection.close()
    return {'status': 'passed', 'accounts': results,
            'note': 'Upstream default grants both accounts membership; existing accounts were not changed.'}


if __name__ == '__main__':
    try:
        print(json.dumps(asyncio.run(seed()), indent=2))
    except (RuntimeError, OSError, ValueError, asyncpg.PostgresError) as error:
        print(json.dumps({'status': 'failed', 'error': str(error)}, indent=2))
        sys.exit(1)
