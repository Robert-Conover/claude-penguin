#!/usr/bin/env python3
"""Create marked, disposable game-bridge accounts; never update existing ones.

Run using the seed Compose service. The marker email prevents accidentally
reusing an unrelated account with a fixture username. Game protocol requests
in verify_bridge.py create the igloos and adopt puffles through normal handlers.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

sys.dont_write_bytecode = True

import asyncpg
import bcrypt

from verify_bridge import PROJECTS, VISITOR_USERNAME
from verify_game import login_password_hash


async def seed():
    database_password = os.environ.get('POSTGRES_PASSWORD')
    if not database_password:
        raise RuntimeError('POSTGRES_PASSWORD must be set')
    user = os.environ.get('POSTGRES_USER', 'postgres')
    password = os.environ.get('CLUB_PENGUIN_TEST_PASSWORD', 'PenguinLocal2026!')
    auth_key = os.environ.get('CLUB_PENGUIN_AUTH_KEY', 'houdini')
    connection = await asyncpg.connect(
        host=os.environ.get('POSTGRES_HOST', 'db'),
        port=int(os.environ.get('POSTGRES_PORT', '5432')),
        user=user, password=database_password,
        database=os.environ.get('POSTGRES_DB', user), timeout=15,
    )
    accounts = []
    fixtures = [(project['ownerUsername'], project['name']) for project in PROJECTS]
    fixtures.append((VISITOR_USERNAME, 'Bridge Check'))
    try:
        async with connection.transaction():
            for username, nickname in fixtures:
                marker = username + '@bridge.example.invalid'
                existing = await connection.fetchrow(
                    'SELECT id, email FROM penguin WHERE lower(username) = $1', username)
                if existing is not None:
                    if existing['email'] != marker:
                        raise RuntimeError(f'Refusing unrelated existing account: {username}')
                    accounts.append({'username': username, 'id': existing['id'],
                                     'status': 'already exists; unchanged'})
                    continue
                encoded = login_password_hash(password, auth_key).encode('utf-8')
                password_hash = bcrypt.hashpw(encoded, bcrypt.gensalt(rounds=12)).decode('utf-8')
                penguin_id = await connection.fetchval(
                    '''INSERT INTO penguin
                       (username, nickname, password, email, active, approval_en, color, coins)
                       VALUES ($1, $2, $3, $4, true, true, 1, 10000) RETURNING id''',
                    username, nickname, password_hash, marker)
                await connection.execute(
                    'INSERT INTO penguin_item (penguin_id, item_id) VALUES ($1, 1)', penguin_id)
                await connection.execute(
                    '''INSERT INTO penguin_postcard (penguin_id, sender_id, postcard_id)
                       VALUES ($1, NULL, 125)''', penguin_id)
                accounts.append({'username': username, 'id': penguin_id, 'status': 'created'})
    finally:
        await connection.close()
    return {'status': 'passed', 'kind': 'game-bridge-fixture-accounts', 'accounts': accounts,
            'note': 'Only new fixture accounts were created. Existing accounts and progress are unchanged.'}


if __name__ == '__main__':
    try:
        print(json.dumps(asyncio.run(seed()), indent=2))
    except (RuntimeError, OSError, ValueError, asyncpg.PostgresError) as error:
        print(json.dumps({'status': 'failed', 'error': str(error)}, indent=2))
        sys.exit(1)
