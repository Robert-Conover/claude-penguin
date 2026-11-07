#!/usr/bin/env python3
"""Real-PostgreSQL concurrency checks for project adoption (project_adoption.py).

Run: ./local/adoption-db-check
That starts a throwaway PostgreSQL 16 container loaded with the vendored
houdini.sql on an internal Docker network and runs this file in the Houdini
image (which has asyncpg). Each test gets its own database cloned from that
template, so nothing touches the game's database. Without
CP_ADOPTION_PG_DSN the tests skip.

Purchases and settlements run on separate connections. A third connection
holds the visitor's row lock so the tests can queue the other two behind it in
a known order, confirmed through pg_locks before the next step.
"""
import asyncio
import os
from pathlib import Path
import sys
import unittest
import uuid
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
import project_adoption  # noqa: E402
from project_adoption import Refusal, settle, transact  # noqa: E402

DSN = os.environ.get('CP_ADOPTION_PG_DSN')
try:
    import asyncpg
except ImportError:  # The host suite has no asyncpg; the runner uses the Houdini image.
    asyncpg = None

BLUE = 0
COST = 400


def visitor(penguin_id):
    record = SimpleNamespace(id=penguin_id, coins=None, server=SimpleNamespace(penguins_by_id={}))

    def update(**fields):
        async def apply():
            record.__dict__.update(fields)
        return SimpleNamespace(apply=apply)
    record.update = update
    return record


def request(adoption_id, owner_id, expires_at, puffle_id=BLUE, name='Pebble'):
    return SimpleNamespace(adoption_id=adoption_id, owner_id=owner_id, puffle_id=puffle_id, name=name, cost=COST,
                           expires_at=expires_at)


@unittest.skipUnless(DSN and asyncpg, 'set CP_ADOPTION_PG_DSN (./local/adoption-db-check) to run against PostgreSQL')
class PostgresAdoptionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.database = f'adoption_{uuid.uuid4().hex[:12]}'
        admin = await asyncpg.connect(DSN, database='postgres')
        try:
            await admin.execute(f'CREATE DATABASE {self.database} TEMPLATE houdini')
        finally:
            await admin.close()
        self.connections = []
        self.db = await self.connect()

    async def asyncTearDown(self):
        for connection in self.connections:
            if not connection.is_closed():
                connection.terminate()
        admin = await asyncpg.connect(DSN, database='postgres')
        try:
            await admin.execute(f'DROP DATABASE IF EXISTS {self.database} WITH (FORCE)')
        finally:
            await admin.close()

    async def connect(self):
        connection = await asyncpg.connect(DSN, database=self.database)
        self.connections.append(connection)
        return connection

    async def penguin(self, username, coins):
        return await self.db.fetchval(
            'INSERT INTO penguin (username, nickname, password, email, coins) VALUES ($1, $1, $2, $3, $4) RETURNING id',
            username, 'x' * 60, f'{username}@local.test', coins)

    async def ready(self, coins=1000):
        await project_adoption.ensure_schema(self.db)
        self.visitor_id = await self.penguin('adoptcheck', coins)
        self.owner_id = await self.penguin('cpowner00001', 0)
        self.adoption_id = str(uuid.uuid4())

    async def db_now(self):
        return await self.db.fetchval('SELECT extract(epoch FROM clock_timestamp())::float8')

    async def counts(self):
        """(visitor coins, owner puffles, receipts, settlements) for this test's adoption."""
        return (await self.db.fetchval('SELECT coins FROM penguin WHERE id = $1', self.visitor_id),
                await self.db.fetchval('SELECT count(*) FROM penguin_puffle WHERE penguin_id = $1', self.owner_id),
                await self.db.fetchval('SELECT count(*) FROM claude_penguin_adoption_receipt WHERE adoption_id = $1::uuid',
                                       self.adoption_id),
                await self.db.fetchval('SELECT count(*) FROM claude_penguin_adoption_settlement WHERE adoption_id = $1::uuid',
                                       self.adoption_id))

    async def hold_visitor_lock(self):
        blocker = await self.connect()
        transaction = blocker.transaction()
        await transaction.start()
        await blocker.execute('SELECT 1 FROM penguin WHERE id = $1 FOR UPDATE', self.visitor_id)
        return transaction

    async def waiting(self, connection, count=1):
        """Wait until `connection`'s backend is blocked on a lock (and `count` backends wait in all)."""
        pid = connection.get_server_pid()
        for _ in range(200):
            blocked = await self.db.fetchval(
                "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'")
            mine = await self.db.fetchval(
                "SELECT wait_event_type = 'Lock' FROM pg_stat_activity WHERE pid = $1", pid)
            if mine and blocked >= count:
                return
            await asyncio.sleep(0.02)
        self.fail('the connection never waited for the visitor lock')

    async def until_db_time(self, moment):
        while await self.db_now() < moment:
            await asyncio.sleep(0.05)

    def purchase(self, connection, expires_at, **kwargs):
        p = visitor(self.visitor_id)
        return p, asyncio.create_task(transact(p, request(self.adoption_id, self.owner_id, expires_at, **kwargs), connection))

    def settlement(self, connection, expires_at):
        return asyncio.create_task(settle(connection, self.adoption_id, self.visitor_id, self.owner_id, expires_at))

    # ------------------------------------------------------------ ordering

    async def test_settlement_committed_first_refuses_the_waiting_purchase(self):
        await self.ready()
        expires_at = await self.db_now() + 1.5
        blocker = await self.hold_visitor_lock()
        settling = self.settlement(await self.connect(), expires_at)
        await self.waiting(self.connections[-1])
        buyer = await self.connect()
        _, buying = self.purchase(buyer, expires_at)  # sent before expiry
        await self.waiting(buyer, count=2)
        await self.until_db_time(expires_at + 0.2)
        await blocker.rollback()
        settled = await settling
        self.assertEqual((settled['outcome'], settled['created']), ('not-charged', True))
        with self.assertRaises(Refusal) as refused:
            await buying
        self.assertEqual(refused.exception.code, 'settled', 'the purchase saw the committed settlement after its lock wait')
        self.assertEqual(await self.counts(), (1000, 0, 0, 1))

    async def test_purchase_committed_first_is_returned_by_the_waiting_settlement(self):
        await self.ready()
        expires_at = await self.db_now() + 30
        blocker = await self.hold_visitor_lock()
        buyer = await self.connect()
        p, buying = self.purchase(buyer, expires_at)
        await self.waiting(buyer)
        settler = await self.connect()
        settling = self.settlement(settler, expires_at)
        await self.waiting(settler, count=2)
        await blocker.rollback()
        reply = await buying
        self.assertEqual((reply[1], p.coins), ('ok', 600))
        settled = await settling
        self.assertEqual(settled['outcome'], 'charged', 'a committed receipt wins even before expiry')
        self.assertEqual((settled['receipt']['adoption_id'], settled['receipt']['coins_after']), (self.adoption_id, 600))
        self.assertEqual(await self.counts(), (600, 1, 1, 0))

    async def test_a_purchase_delayed_on_the_lock_past_expiry_never_charges(self):
        """The counterexample: sent before expiry, still waiting well after it, then the lock is released."""
        await self.ready()
        expires_at = await self.db_now() + 1
        blocker = await self.hold_visitor_lock()
        buyer = await self.connect()
        _, buying = self.purchase(buyer, expires_at)
        await self.waiting(buyer)
        await self.until_db_time(expires_at + 2)
        # An ordinary receipt lookup during the wait finds nothing; that alone proves nothing.
        self.assertEqual(await project_adoption.read_receipts(self.db, [self.adoption_id]), [])
        settler = await self.connect()
        settling = self.settlement(settler, expires_at)  # queued behind the purchase
        await self.waiting(settler, count=2)
        await blocker.rollback()
        with self.assertRaises(Refusal) as refused:
            await buying
        self.assertEqual(refused.exception.code, 'expired', 'expiry is rechecked on the database clock after the wait')
        settled = await settling
        self.assertEqual(settled['outcome'], 'not-charged')
        self.assertEqual(await self.counts(), (1000, 0, 0, 1))

    async def test_expiry_while_waiting_for_the_owner_lock_refuses_the_purchase(self):
        await self.ready()
        expires_at = await self.db_now() + 1
        blocker = await self.connect()
        transaction = blocker.transaction()
        await transaction.start()
        await blocker.execute('SELECT 1 FROM penguin WHERE id = $1 FOR UPDATE', self.owner_id)
        buyer = await self.connect()
        _, buying = self.purchase(buyer, expires_at)
        await self.waiting(buyer)
        await self.until_db_time(expires_at + 0.5)
        await transaction.rollback()
        with self.assertRaises(Refusal) as refused:
            await buying
        self.assertEqual(refused.exception.code, 'expired')
        self.assertEqual(await self.counts(), (1000, 0, 0, 0))

    # ------------------------------------------------------------ settlement

    async def test_settlement_is_idempotent_and_refuses_open_or_foreign_requests(self):
        await self.ready()
        open_until = await self.db_now() + 60
        self.assertEqual((await settle(self.db, self.adoption_id, self.visitor_id, self.owner_id, open_until))['outcome'], 'open')
        self.assertEqual(await self.counts(), (1000, 0, 0, 0), 'an open reservation writes nothing')
        expired_at = await self.db_now() - 1
        first = await settle(self.db, self.adoption_id, self.visitor_id, self.owner_id, expired_at)
        again = await settle(await self.connect(), self.adoption_id, self.visitor_id, self.owner_id, expired_at)
        self.assertEqual((first['outcome'], first['created'], again['outcome'], again['created']), ('not-charged', True, 'not-charged', False))
        self.assertEqual(first['settlement'], again['settlement'], 'a repeat returns the same committed row')
        other_owner = await self.penguin('cpowner00002', 0)
        self.assertEqual((await settle(self.db, self.adoption_id, self.visitor_id, other_owner, expired_at))['outcome'], 'conflict')
        self.assertEqual((await settle(self.db, str(uuid.uuid4()), 999999, self.owner_id, expired_at))['outcome'], 'unknown-visitor')
        self.assertEqual(await self.counts(), (1000, 0, 0, 1))

    async def test_a_lost_settlement_response_is_answered_again_on_retry(self):
        await self.ready()
        expires_at = await self.db_now() - 1
        first = await self.connect()
        committed = await settle(first, self.adoption_id, self.visitor_id, self.owner_id, expires_at)
        first.terminate()  # the caller never sees `committed`
        retry = await settle(await self.connect(), self.adoption_id, self.visitor_id, self.owner_id, expires_at)
        self.assertEqual((retry['outcome'], retry['created'], retry['settlement']), ('not-charged', False, committed['settlement']))
        with self.assertRaises(Refusal) as refused:
            await transact(visitor(self.visitor_id), request(self.adoption_id, self.owner_id, await self.db_now() + 60), self.db)
        self.assertEqual(refused.exception.code, 'settled', 'a settled ID is refused even with a later expiry')
        self.assertEqual(await self.counts(), (1000, 0, 0, 1))

    async def test_a_settlement_killed_before_commit_writes_nothing_and_retry_settles(self):
        await self.ready()
        expires_at = await self.db_now() - 1
        blocker = await self.hold_visitor_lock()
        settler = await self.connect()
        settling = self.settlement(settler, expires_at)
        await self.waiting(settler)
        await self.db.execute('SELECT pg_terminate_backend($1)', settler.get_server_pid())
        with self.assertRaises((asyncpg.PostgresError, asyncpg.InterfaceError, ConnectionError, OSError)):
            await settling
        await blocker.rollback()
        self.assertEqual(await self.counts(), (1000, 0, 0, 0), 'no response and no row: still undecided')
        retry = await settle(await self.connect(), self.adoption_id, self.visitor_id, self.owner_id, expires_at)
        self.assertEqual((retry['outcome'], retry['created']), ('not-charged', True))
        self.assertEqual(await self.counts(), (1000, 0, 0, 1))

    async def test_a_purchase_that_rolls_back_leaves_nothing_and_then_settles_as_not_charged(self):
        await self.ready()
        expires_at = await self.db_now() + 1
        with self.assertRaises(asyncpg.ForeignKeyViolationError):
            # An unknown puffle type fails the puffle insert after the debit.
            await transact(visitor(self.visitor_id), request(self.adoption_id, self.owner_id, expires_at, puffle_id=987654), self.db)
        self.assertEqual(await self.counts(), (1000, 0, 0, 0), 'the debit rolled back with the failed insert')
        await self.until_db_time(expires_at + 0.1)
        self.assertEqual((await settle(self.db, self.adoption_id, self.visitor_id, self.owner_id, expires_at))['outcome'], 'not-charged')
        self.assertEqual(await self.counts(), (1000, 0, 0, 1))

    async def test_an_uncontended_purchase_charges_exactly_once(self):
        await self.ready()
        expires_at = await self.db_now() + 60
        p = visitor(self.visitor_id)
        first = await transact(p, request(self.adoption_id, self.owner_id, expires_at), self.db)
        replay = await transact(visitor(self.visitor_id), request(self.adoption_id, self.owner_id, expires_at), await self.connect())
        self.assertEqual((first[1], replay[1], first[2], replay[2]), ('ok', 'ok', first[2], first[2]))
        self.assertEqual(await self.counts(), (600, 1, 1, 0))
        settled = await settle(self.db, self.adoption_id, self.visitor_id, self.owner_id, expires_at)
        self.assertEqual(settled['outcome'], 'charged')

    # ------------------------------------------------------------ schema

    async def test_fresh_install_records_version_two_and_repeats_cleanly(self):
        self.assertIsNone(await project_adoption.schema_version(self.db))
        await asyncio.gather(project_adoption.ensure_schema(self.db), project_adoption.ensure_schema(await self.connect()))
        await project_adoption.ensure_schema(self.db)
        self.assertEqual(await project_adoption.schema_version(self.db), 2)
        self.assertEqual(await self.db.fetchval("SELECT to_regclass('claude_penguin_adoption_settlement') IS NOT NULL"), True)

    async def test_version_one_upgrades_in_place_and_keeps_every_row(self):
        await self.db.execute(project_adoption.SCHEMA_DDL)
        await self.db.execute(project_adoption.DDL[0])  # the version 1 receipt table
        await self.db.execute("INSERT INTO claude_penguin_schema VALUES ('adoption-receipts', 1)")
        self.visitor_id = await self.penguin('adoptcheck', 600)
        self.owner_id = await self.penguin('cpowner00001', 0)
        self.adoption_id = str(uuid.uuid4())
        puffle = await self.db.fetchval("INSERT INTO penguin_puffle (penguin_id, puffle_id, name) VALUES ($1, 0, 'Pebble') RETURNING id",
                                        self.owner_id)
        await self.db.execute('INSERT INTO claude_penguin_adoption_receipt (adoption_id, visitor_id, owner_id, penguin_puffle_id, '
                              "puffle_id, name, cost, coins_after) VALUES ($1::uuid, $2, $3, $4, 0, 'Pebble', 400, 600)",
                              self.adoption_id, self.visitor_id, self.owner_id, puffle)
        before = await self.db.fetch('SELECT * FROM claude_penguin_adoption_receipt')
        accounts = await self.db.fetchval('SELECT count(*) FROM penguin')
        self.assertEqual(await project_adoption.schema_version(self.db), 1)
        self.assertEqual(len(await project_adoption.read_receipts(self.db, [self.adoption_id])), 1, 'version 1 receipts stay readable')
        await project_adoption.ensure_schema(self.db)
        await project_adoption.ensure_schema(self.db)
        self.assertEqual(await project_adoption.schema_version(self.db), 2)
        self.assertEqual(await self.db.fetch('SELECT * FROM claude_penguin_adoption_receipt'), before)
        self.assertEqual((await self.db.fetchval('SELECT count(*) FROM penguin'), await self.counts()), (accounts, (600, 1, 1, 0)))
        expired = await self.db_now() - 1
        self.assertEqual((await settle(self.db, self.adoption_id, self.visitor_id, self.owner_id, expired))['outcome'], 'charged')

    async def test_an_unsupported_version_is_refused_before_any_ddl(self):
        await self.db.execute(project_adoption.SCHEMA_DDL)
        await self.db.execute("INSERT INTO claude_penguin_schema VALUES ('adoption-receipts', 3)")
        with self.assertRaises(project_adoption.SchemaError):
            await project_adoption.ensure_schema(self.db)
        with self.assertRaises(project_adoption.SchemaError):
            await project_adoption.schema_version(self.db)
        self.assertEqual(await self.db.fetchval("SELECT to_regclass('claude_penguin_adoption_receipt') IS NULL"), True)
        self.assertEqual(await self.db.fetchval("SELECT version FROM claude_penguin_schema"), 3)


if __name__ == '__main__':
    unittest.main(verbosity=2)
