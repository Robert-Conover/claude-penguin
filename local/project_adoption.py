#!/usr/bin/env python3
"""Owned project adoption: the only writer of the coin debit, puffle row and receipt.

The agent visitor adopts a puffle *into a project igloo* through the original Pet
Shop screens. The browser overlay sends ``p#cpadopt`` with an adoption ID that the
host engine reserved and published (``published.json`` version 2). This module
validates it against that publication and performs one database transaction:

  lock the visitor, then the owner; reuse a stored receipt for the same ID;
  check coins and the owner's indoor capacity (at most 10, an intentional
  departure from upstream's 75-puffle limit with backyard eviction); debit the
  visitor; insert the puffle with ``penguin_id = owner``; insert the receipt.

Then it sets the visitor's in-memory coins from the committed value. Houdini
caches coins and writes ``p.coins - cost`` on the next change, so a debit made
anywhere else while the visitor is online would be overwritten. Supplies are not
granted: the visitor does not own the puffle and the managed owner never plays.

The receipt table is project-owned DDL created idempotently at world start with
a version check; vendored ``houdini.sql`` is not edited. ``game_provision.py``
reads receipts with ``read_receipts`` (the engine's ``receipts`` operation).
"""
# No `from __future__ import annotations`: Houdini converts packet arguments by
# reading the handler's annotations as real types (str, int).
import re
import time
from types import SimpleNamespace

SCHEMA_COMPONENT = 'adoption-receipts'
SCHEMA_VERSION = 1
CAPACITY = 10
ADOPTION_ID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
# (client type ID, client subtype ID) -> server puffle ID. Ten ordinary colors,
# the Blue Dog and the Orange Cat. Rainbow (10) and Gold (11) have special
# upstream adoption rules and are not offered for project igloos.
CATALOG = {**{(type_id, 0): type_id for type_id in range(10)}, (0, 1006): 1006, (8, 1007): 1007}

DDL = (
    '''CREATE TABLE IF NOT EXISTS claude_penguin_schema (
           component TEXT PRIMARY KEY,
           version INTEGER NOT NULL)''',
    # Plain integer IDs, not foreign keys: a receipt must never block or
    # cascade with upstream account maintenance. Receipts are never deleted.
    '''CREATE TABLE IF NOT EXISTS claude_penguin_adoption_receipt (
           adoption_id UUID PRIMARY KEY,
           visitor_id INTEGER NOT NULL,
           owner_id INTEGER NOT NULL,
           penguin_puffle_id INTEGER NOT NULL UNIQUE,
           puffle_id INTEGER NOT NULL,
           name VARCHAR(16) NOT NULL,
           cost INTEGER NOT NULL,
           coins_after INTEGER NOT NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT now())''',
)

RECEIPT_COLUMNS = 'adoption_id::text AS adoption_id, visitor_id, owner_id, penguin_puffle_id, puffle_id, name, cost, ' \
                  'coins_after, extract(epoch FROM created_at)::bigint AS created_at'


class SchemaError(RuntimeError):
    pass


async def ensure_schema(connection):
    """Create the receipt table once; refuse an unknown recorded schema version."""
    async with connection.transaction():
        # Serialize concurrent world starts on this DDL.
        await connection.execute("SELECT pg_advisory_xact_lock(hashtext('claude_penguin_schema'))")
        for statement in DDL:
            await connection.execute(statement)
        recorded = await connection.fetchval(
            'SELECT version FROM claude_penguin_schema WHERE component = $1', SCHEMA_COMPONENT)
        if recorded is None:
            await connection.execute('INSERT INTO claude_penguin_schema (component, version) VALUES ($1, $2)',
                                     SCHEMA_COMPONENT, SCHEMA_VERSION)
        elif recorded != SCHEMA_VERSION:
            raise SchemaError(f'Adoption receipt schema version {recorded} is not the supported {SCHEMA_VERSION}; '
                              'refusing to start the project adoption handler.')


async def schema_ready(connection):
    """True when the receipt table exists at the supported version."""
    exists = await connection.fetchval("SELECT to_regclass('claude_penguin_schema') IS NOT NULL")
    if not exists:
        return False
    recorded = await connection.fetchval(
        'SELECT version FROM claude_penguin_schema WHERE component = $1', SCHEMA_COMPONENT)
    if recorded is None:
        return False
    if recorded != SCHEMA_VERSION:
        raise SchemaError(f'Adoption receipt schema version {recorded} is not supported.')
    return True


def receipt_view(row):
    return {key: row[key] for key in ('adoption_id', 'visitor_id', 'owner_id', 'penguin_puffle_id', 'puffle_id',
                                      'name', 'cost', 'coins_after', 'created_at')}


async def read_receipts(connection, adoption_ids):
    """Stored receipts for the given adoption IDs (read-only)."""
    if not await schema_ready(connection):
        return []
    rows = await connection.fetch(f'SELECT {RECEIPT_COLUMNS} FROM claude_penguin_adoption_receipt '
                                  'WHERE adoption_id = ANY($1::uuid[]) ORDER BY created_at, adoption_id',
                                  list(adoption_ids))
    return [receipt_view(row) for row in rows]


class Refusal(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def client_ids(puffle_id):
    """(type ID, subtype ID) as the client names a server puffle ID."""
    return next(key for key, value in CATALOG.items() if value == puffle_id)


def success_reply(adoption_id, receipt, coins):
    type_id, subtype_id = client_ids(receipt['puffle_id'])
    return [adoption_id, 'ok', receipt['penguin_puffle_id'], type_id, subtype_id, receipt['name'], coins,
            receipt['cost'], receipt['created_at'], receipt['owner_id']]


def validate(p, publication, adoption_id, type_id, name, subtype_id, *, check_name):
    """Everything that needs no database: the publication, catalog and name."""
    published = publication.for_visitor(p.id)
    if published is None or not isinstance(adoption_id, str) or not ADOPTION_ID.match(adoption_id):
        raise Refusal('unknown-adoption')
    reservation = published.adoptions.get(adoption_id)
    if reservation is None:
        raise Refusal('unknown-adoption')
    owner_id = reservation.owner_id
    if owner_id not in published.igloos or owner_id == p.id:
        raise Refusal('unknown-adoption')
    puffle_id = CATALOG.get((type_id, subtype_id))
    if puffle_id is None or puffle_id not in p.server.puffles:
        raise Refusal('unknown-puffle')
    if not isinstance(name, str) or not check_name(p, name):
        raise Refusal('441')
    return SimpleNamespace(adoption_id=adoption_id, owner_id=owner_id, puffle_id=puffle_id, name=name.title(),
                           cost=p.server.puffles[puffle_id].cost, expires_at=reservation.expires_at)


async def transact(p, request, connection, now=time.time):
    """Perform one validated adoption in one transaction. Returns the reply fields."""
    adoption_id, owner_id, puffle_id, name, cost = (request.adoption_id, request.owner_id, request.puffle_id,
                                                    request.name, request.cost)
    expired = request.expires_at <= now()

    async with connection.transaction():
        # Lock order: visitor, then owner. Duplicates of one adoption ID and any
        # two adoptions by this visitor serialize on the first lock.
        visitor_coins = await connection.fetchval('SELECT coins FROM penguin WHERE id = $1 FOR UPDATE', p.id)
        if visitor_coins is None:
            raise Refusal('unknown-adoption')
        stored = await connection.fetchrow(f'SELECT {RECEIPT_COLUMNS} FROM claude_penguin_adoption_receipt '
                                           'WHERE adoption_id = $1::uuid', adoption_id)
        if stored is not None:
            if (stored['visitor_id'], stored['owner_id'], stored['puffle_id'], stored['name']) != \
                    (p.id, owner_id, puffle_id, name):
                raise Refusal('conflict')
            return success_reply(adoption_id, receipt_view(stored), visitor_coins)
        if expired:
            raise Refusal('expired')
        # The engine refuses a reservation while it holds the owner's game
        # session; this also covers any other login, whose in-memory puffle
        # list would otherwise go stale.
        if owner_id in p.server.penguins_by_id:
            raise Refusal('owner-online')
        if await connection.fetchval('SELECT id FROM penguin WHERE id = $1 FOR UPDATE', owner_id) is None:
            raise Refusal('unknown-adoption')
        if visitor_coins < cost:
            raise Refusal('401')
        indoor = await connection.fetchval(
            'SELECT count(*) FROM penguin_puffle WHERE penguin_id = $1 AND backyard IS NOT TRUE', owner_id)
        if indoor >= CAPACITY:
            raise Refusal('440')
        coins_after = await connection.fetchval(
            'UPDATE penguin SET coins = coins - $2 WHERE id = $1 RETURNING coins', p.id, cost)
        penguin_puffle_id = await connection.fetchval(
            'INSERT INTO penguin_puffle (penguin_id, puffle_id, name) VALUES ($1, $2, $3) RETURNING id',
            owner_id, puffle_id, name)
        stored = await connection.fetchrow(
            f'''INSERT INTO claude_penguin_adoption_receipt
                   (adoption_id, visitor_id, owner_id, penguin_puffle_id, puffle_id, name, cost, coins_after)
                VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8) RETURNING {RECEIPT_COLUMNS}''',
            adoption_id, p.id, owner_id, penguin_puffle_id, puffle_id, name, cost, coins_after)
    # Committed. Mirror the authoritative balance into Houdini's cache.
    await p.update(coins=coins_after).apply()
    return success_reply(adoption_id, receipt_view(stored), coins_after)


async def adopt(p, publication, adoption_id, type_id, name, subtype_id, *, connection, check_name, now=time.time):
    """Validate and perform one adoption. Returns the ``cpadopt`` reply fields."""
    request = validate(p, publication, adoption_id, type_id, name, subtype_id, check_name=check_name)
    return await transact(p, request, connection, now)


def adoption_handler(publication, acquire, check_name, logger=None):
    """The ``p#cpadopt`` callback. ``acquire`` yields an asyncpg connection."""
    async def handle_project_adopt(p, adoption_id: str, type_id: int, name: str, subtype_id: int):
        try:
            # Validate first: a penguin without a published reservation never reaches the database.
            request = validate(p, publication, adoption_id, type_id, name, subtype_id, check_name=check_name)
            async with acquire() as connection:
                reply = await transact(p, request, connection)
        except Refusal as refusal:
            reply = [adoption_id if isinstance(adoption_id, str) and ADOPTION_ID.match(adoption_id) else '',
                     'error', refusal.code]
        except Exception as error:  # Never leak details to the client; the transaction rolled back.
            if logger is not None:
                logger.error(f'Project adoption failed: {type(error).__name__}: {str(error)[:200]}')
            reply = [adoption_id if isinstance(adoption_id, str) and ADOPTION_ID.match(adoption_id) else '',
                     'error', 'failed']
        await p.send_xt('cpadopt', *reply)
    return handle_project_adopt
