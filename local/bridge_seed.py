#!/usr/bin/env python3
"""Create marked, disposable game-bridge accounts; never update existing ones.

Run using the seed Compose service. The marker email prevents accidentally
reusing an unrelated account with a fixture username. Game protocol requests
in verify_bridge.py create the igloos and adopt puffles through normal handlers.
The `bridgecheck` visitor identity (username, marker email, and disposable
password source) is shared with the agent engine's provisioning service through
game_accounts.py, so either accepts the same marked account.
"""
from __future__ import annotations

import asyncio
import json
import sys

sys.dont_write_bytecode = True

import asyncpg

import game_accounts
from game_accounts import VISITOR_NICKNAME, VISITOR_USERNAME
from verify_bridge import PROJECTS, VISITOR_USERNAME as BRIDGE_VISITOR_USERNAME

if BRIDGE_VISITOR_USERNAME != VISITOR_USERNAME:
    raise RuntimeError('verify_bridge.py and game_accounts.py disagree about the visitor account')


async def seed():
    password = game_accounts.test_password()
    key = game_accounts.auth_key()
    connection = await game_accounts.connect()
    accounts = []
    fixtures = [(project['ownerUsername'], project['name']) for project in PROJECTS]
    fixtures.append((VISITOR_USERNAME, VISITOR_NICKNAME))
    try:
        async with connection.transaction():
            for username, nickname in fixtures:
                penguin_id, created = await game_accounts.ensure_fixture_account(
                    connection, username, nickname, password, key)
                accounts.append({'username': username, 'id': penguin_id,
                                 'status': 'created' if created else 'already exists; unchanged'})
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
