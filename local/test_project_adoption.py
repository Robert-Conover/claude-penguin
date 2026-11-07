#!/usr/bin/env python3
"""Host checks for the owned project adoption transaction (project_adoption.py).

Run: python3 -m unittest local/test_project_adoption.py
A small in-memory stand-in for asyncpg models the rows, the database clock and
the transaction rollback. It cannot model lock waits or commit visibility; the
real concurrency guarantees are checked against PostgreSQL by
local/test_adoption_postgres.py (./local/adoption-db-check).
"""
import asyncio
import copy
import contextlib
from pathlib import Path
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import project_adoption  # noqa: E402
from houdini_bootstrap import parse_publication  # noqa: E402
from project_adoption import Refusal, adopt, adoption_handler  # noqa: E402

VISITOR, OWNER, OTHER_OWNER, STRANGER = 107, 201, 202, 101
ADOPTION = '0b6f8a52-5f1e-4f53-9d0e-4b8e8b7e2a11'
SECOND = '6a1d7f3e-2c4b-4e8f-9a1b-3c5d7e9f1a2b'
NOW = 1_800_000_000


class FakeDatabase:
    """Tables: penguin {id: coins}, penguin_puffle [rows], receipts and settlements {id: row}, schema {component: version}."""

    def __init__(self, coins=1000, puffles=(), clock=NOW):
        self.penguins = {VISITOR: coins, OWNER: 0, OTHER_OWNER: 0, STRANGER: 5000}
        self.puffles = [dict(row) for row in puffles]
        self.receipts = {}
        self.settlements = {}
        self.schema = {}
        self.tables = set()
        self.clock = clock
        self.fail_on = None
        self.locks = []

    def state(self):
        return copy.deepcopy((self.penguins, self.puffles, self.receipts, self.settlements, self.schema, self.tables))

    @contextlib.asynccontextmanager
    async def transaction(self):
        saved = self.state()
        try:
            yield
        except BaseException:
            self.penguins, self.puffles, self.receipts, self.settlements, self.schema, self.tables = saved
            raise

    def _fail(self, statement):
        if self.fail_on and self.fail_on in statement:
            raise RuntimeError('simulated database failure')

    async def execute(self, statement, *args):
        self._fail(statement)
        if statement.startswith('CREATE TABLE IF NOT EXISTS'):
            self.tables.add(statement.split()[5])
        elif statement.startswith('INSERT INTO claude_penguin_schema'):
            self.schema[args[0]] = args[1]
        elif statement.startswith('UPDATE claude_penguin_schema'):
            self.schema[args[0]] = args[1]

    async def fetchval(self, statement, *args):
        self._fail(statement)
        if statement.startswith('SELECT coins FROM penguin'):
            self.locks.append(('penguin', args[0]))
            return self.penguins.get(args[0])
        if statement.startswith('SELECT id FROM penguin'):
            self.locks.append(('penguin', args[0]))
            return args[0] if args[0] in self.penguins else None
        if statement.startswith('SELECT count(*) FROM penguin_puffle'):
            return sum(1 for row in self.puffles if row['penguin_id'] == args[0] and not row['backyard'])
        if statement.startswith('UPDATE penguin SET coins'):
            self.penguins[args[0]] -= args[1]
            return self.penguins[args[0]]
        if statement.startswith('INSERT INTO penguin_puffle'):
            row = {'id': 500 + len(self.puffles), 'penguin_id': args[0], 'puffle_id': args[1], 'name': args[2], 'backyard': False}
            self.puffles.append(row)
            return row['id']
        if statement.startswith('SELECT version FROM claude_penguin_schema'):
            return self.schema.get(args[0])
        if statement.startswith("SELECT to_regclass"):
            return 'claude_penguin_schema' in self.tables
        if statement.startswith('SELECT clock_timestamp() >= to_timestamp'):
            return self.clock >= args[0]
        if statement.startswith('SELECT 1 FROM claude_penguin_adoption_settlement'):
            return 1 if args[0] in self.settlements else None
        raise AssertionError(statement)

    async def fetchrow(self, statement, *args):
        self._fail(statement)
        if 'FROM claude_penguin_adoption_receipt' in statement:
            return copy.deepcopy(self.receipts.get(args[0]))
        if statement.lstrip().startswith('INSERT INTO claude_penguin_adoption_receipt'):
            if args[0] in self.receipts:
                raise RuntimeError('duplicate key')
            row = dict(zip(('adoption_id', 'visitor_id', 'owner_id', 'penguin_puffle_id', 'puffle_id', 'name', 'cost',
                            'coins_after'), args), created_at=NOW)
            self.receipts[args[0]] = row
            return copy.deepcopy(row)
        if 'FROM claude_penguin_adoption_settlement' in statement:
            return copy.deepcopy(self.settlements.get(args[0]))
        if statement.lstrip().startswith('INSERT INTO claude_penguin_adoption_settlement'):
            if args[0] in self.settlements:
                raise RuntimeError('duplicate key')
            row = dict(zip(('adoption_id', 'visitor_id', 'owner_id', 'expires_at'), args), settled_at=self.clock)
            self.settlements[args[0]] = row
            return copy.deepcopy(row)
        raise AssertionError(statement)

    async def fetch(self, statement, *args):
        return [copy.deepcopy(self.receipts[key]) for key in args[0] if key in self.receipts]


class Publication:
    def __init__(self, value):
        self.value = parse_publication(value)

    def for_visitor(self, penguin_id):
        return self.value if self.value is not None and self.value.visitor_id == penguin_id else None


def publication(adoptions=((ADOPTION, OWNER, NOW + 600),), igloos=((OWNER, 9), (OTHER_OWNER, 10))):
    return Publication({'version': 2, 'visitorId': VISITOR, 'igloos': [{'ownerId': o, 'iglooId': i} for o, i in igloos],
                        'adoptions': [{'adoptionId': a, 'ownerId': o, 'expiresAt': e} for a, o, e in adoptions]})


def penguin(penguin_id=VISITOR, online=()):
    costs = {**{type_id: 400 for type_id in range(10)}, 10: 0, 11: 0, 1006: 800, 1007: 800}
    record = SimpleNamespace(id=penguin_id, coins=None, send_xt=AsyncMock(),
                             server=SimpleNamespace(puffles={key: SimpleNamespace(cost=value) for key, value in costs.items()},
                                                    penguins_by_id={owner: object() for owner in online}))

    def update(**fields):
        async def apply():
            record.__dict__.update(fields)
        return SimpleNamespace(apply=apply)
    record.update = update
    return record


def name_ok(_, name):
    return name.isalpha() and 1 <= len(name) <= 12 and name.lower() != 'badword'


class ProjectAdoptionTests(unittest.TestCase):
    def run_adopt(self, db, p=None, pub=None, adoption=ADOPTION, type_id=0, name='pebble', subtype=0):
        p = p or penguin()
        return p, asyncio.run(adopt(p, pub or publication(), adoption, type_id, name, subtype,
                                    connection=db, check_name=name_ok))

    def refused(self, db, code, **kwargs):
        before = db.state()
        with self.assertRaises(Refusal) as raised:
            self.run_adopt(db, **kwargs)
        self.assertEqual(raised.exception.code, code)
        self.assertEqual(db.state(), before, 'a refusal changes nothing')

    def settle(self, db, adoption=ADOPTION, visitor=VISITOR, owner=OWNER, expires_at=NOW + 600):
        return asyncio.run(project_adoption.settle(db, adoption, visitor, owner, expires_at))

    def test_adoption_debits_once_and_binds_the_puffle_to_the_owner(self):
        db = FakeDatabase(coins=1000)
        p, reply = self.run_adopt(db, name='pebble')
        self.assertEqual(reply, [ADOPTION, 'ok', 500, 0, 0, 'Pebble', 600, 400, NOW, OWNER])
        self.assertEqual(db.penguins[VISITOR], 600)
        self.assertEqual(db.puffles, [{'id': 500, 'penguin_id': OWNER, 'puffle_id': 0, 'name': 'Pebble', 'backyard': False}])
        self.assertEqual(db.receipts[ADOPTION]['owner_id'], OWNER)
        self.assertEqual(p.coins, 600, 'the visitor cache mirrors the committed balance')
        self.assertEqual(db.locks[:2], [('penguin', VISITOR), ('penguin', OWNER)], 'visitor is locked before the owner')

    def test_dog_and_cat_cost_800_and_report_their_client_ids(self):
        db = FakeDatabase(coins=2000)
        _, dog = self.run_adopt(db, type_id=0, subtype=1006, name='Rex')
        self.assertEqual((dog[3], dog[4], dog[6], dog[7]), (0, 1006, 1200, 800))
        _, cat = self.run_adopt(db, pub=publication(adoptions=((SECOND, OWNER, NOW + 600),)), adoption=SECOND, type_id=8, subtype=1007, name='Tom')
        self.assertEqual((cat[3], cat[4], cat[6]), (8, 1007, 400))
        self.assertEqual([row['puffle_id'] for row in db.puffles], [1006, 1007])

    def test_replaying_an_adoption_returns_its_receipt_without_charging(self):
        db = FakeDatabase(coins=1000)
        _, first = self.run_adopt(db)
        p, again = self.run_adopt(db)
        self.assertEqual(again, first[:6] + [600] + first[7:])
        self.assertEqual(db.penguins[VISITOR], 600)
        self.assertEqual(len(db.puffles), 1)
        self.assertIsNone(p.coins, 'a replay does not rewrite the cache')

    def test_a_receipt_wins_after_expiry_but_a_new_expired_adoption_is_refused(self):
        db = FakeDatabase(coins=1000)
        self.run_adopt(db)
        db.clock = NOW + 10_000
        _, late = self.run_adopt(db)
        self.assertEqual(late[1], 'ok')
        self.refused(FakeDatabase(clock=NOW + 600), 'expired')
        self.refused(FakeDatabase(clock=NOW + 10_000), 'expired')

    def test_expiry_is_checked_on_the_database_clock_after_both_locks(self):
        db = FakeDatabase(coins=1000, clock=NOW + 600)
        self.refused(db, 'expired')
        self.assertEqual(db.locks, [('penguin', VISITOR), ('penguin', OWNER)], 'checked only once both locks are held')

    def test_a_settled_adoption_is_refused_and_never_charges(self):
        db = FakeDatabase(coins=1000, clock=NOW + 601)
        settled = self.settle(db)
        self.assertEqual((settled['outcome'], settled['created']), ('not-charged', True))
        db.clock = NOW  # even if the clock disagreed, the settlement decides
        self.refused(db, 'settled')
        self.assertEqual((db.penguins[VISITOR], db.puffles, db.receipts), (1000, [], {}))

    def test_settlement_returns_a_receipt_first_and_repeats_its_own_row(self):
        db = FakeDatabase(coins=1000)
        self.assertEqual(self.settle(db)['outcome'], 'open', 'not expired on the database clock')
        self.assertEqual(db.settlements, {})
        self.run_adopt(db)
        db.clock = NOW + 601
        charged = self.settle(db)
        self.assertEqual((charged['outcome'], charged['receipt']['coins_after']), ('charged', 600))
        self.assertEqual(self.settle(db, owner=OTHER_OWNER)['outcome'], 'conflict')
        self.assertEqual(db.settlements, {})
        first = self.settle(db, adoption=SECOND)
        again = self.settle(db, adoption=SECOND)
        self.assertEqual((first['created'], again['created'], first['settlement'], len(db.settlements)),
                         (True, False, again['settlement'], 1))
        self.assertEqual(self.settle(db, adoption=SECOND, visitor=STRANGER)['outcome'], 'conflict')
        self.assertEqual(self.settle(db, adoption=SECOND, visitor=999)['outcome'], 'unknown-visitor')
        self.assertEqual(db.locks[-1], ('penguin', 999), 'settlement locks the visitor first')

    def test_the_same_id_with_different_parameters_is_refused(self):
        db = FakeDatabase(coins=1000)
        self.run_adopt(db, name='pebble')
        self.refused(db, 'conflict', name='other')
        self.refused(db, 'conflict', type_id=3)

    def test_insufficient_coins_and_capacity_are_refused_before_any_charge(self):
        self.refused(FakeDatabase(coins=399), '401')
        indoor = [{'id': n, 'penguin_id': OWNER, 'puffle_id': 0, 'name': 'P', 'backyard': False} for n in range(10)]
        self.refused(FakeDatabase(coins=5000, puffles=indoor), '440')
        db = FakeDatabase(coins=5000, puffles=indoor[:9] + [dict(indoor[9], backyard=True)])
        _, reply = self.run_adopt(db)
        self.assertEqual(reply[1], 'ok', 'the tenth indoor puffle is allowed; backyard puffles do not count')

    def test_unpublished_expired_foreign_and_special_adoptions_are_refused(self):
        self.refused(FakeDatabase(), 'unknown-adoption', adoption=SECOND)
        self.refused(FakeDatabase(), 'unknown-adoption', adoption='not-a-uuid')
        self.refused(FakeDatabase(), 'unknown-adoption', p=penguin(STRANGER))
        self.refused(FakeDatabase(), 'owner-online', p=penguin(online=(OWNER,)))
        for type_id, subtype in ((10, 0), (11, 0), (0, 1007), (12, 0), (0, 1000)):
            self.refused(FakeDatabase(), 'unknown-puffle', type_id=type_id, subtype=subtype)
        self.refused(FakeDatabase(), '441', name='badword')
        self.refused(FakeDatabase(), '441', name='Bad Name')

    def test_a_failure_inside_the_transaction_rolls_everything_back(self):
        db = FakeDatabase(coins=1000)
        db.fail_on = 'INSERT INTO claude_penguin_adoption_receipt'
        p = penguin()
        with self.assertRaises(RuntimeError):
            self.run_adopt(db, p=p)
        self.assertEqual((db.penguins[VISITOR], db.puffles, db.receipts, p.coins), (1000, [], {}, None))

    def test_the_handler_replies_with_errors_and_never_leaks_details(self):
        db = FakeDatabase(coins=10)

        @contextlib.asynccontextmanager
        async def acquire():
            yield db
        handler = adoption_handler(publication(adoptions=((ADOPTION, OWNER, 4_000_000_000),)), acquire, name_ok)
        p = penguin()
        asyncio.run(handler(p, ADOPTION, 0, 'pebble', 0))
        self.assertEqual(p.send_xt.await_args.args, ('cpadopt', ADOPTION, 'error', '401'))
        db.fail_on = 'SELECT coins'
        asyncio.run(handler(p, 'junk', 0, 'pebble', 0))
        self.assertEqual(p.send_xt.await_args.args, ('cpadopt', '', 'error', 'unknown-adoption'))
        asyncio.run(handler(p, ADOPTION, 0, 'pebble', 0))
        self.assertEqual(p.send_xt.await_args.args, ('cpadopt', ADOPTION, 'error', 'failed'))

    def test_schema_is_created_once_and_an_unknown_version_is_refused(self):
        db = FakeDatabase()
        self.assertEqual(asyncio.run(project_adoption.read_receipts(db, [ADOPTION])), [], 'no table means no receipts')
        asyncio.run(project_adoption.ensure_schema(db))
        asyncio.run(project_adoption.ensure_schema(db))
        self.assertEqual(db.schema, {'adoption-receipts': 2})
        self.assertIn('claude_penguin_adoption_settlement', db.tables)
        upgraded = FakeDatabase()
        upgraded.schema['adoption-receipts'] = 1
        upgraded.tables = {'claude_penguin_schema', 'claude_penguin_adoption_receipt'}
        self.assertEqual(asyncio.run(project_adoption.schema_version(upgraded)), 1)
        asyncio.run(project_adoption.ensure_schema(upgraded))
        self.assertEqual((upgraded.schema, 'claude_penguin_adoption_settlement' in upgraded.tables), ({'adoption-receipts': 2}, True))
        db.schema['adoption-receipts'] = 3
        db.tables = {'claude_penguin_schema'}
        with self.assertRaises(project_adoption.SchemaError):
            asyncio.run(project_adoption.ensure_schema(db))
        self.assertEqual(db.tables, {'claude_penguin_schema'}, 'refused before any other DDL')
        with self.assertRaises(project_adoption.SchemaError):
            asyncio.run(project_adoption.read_receipts(db, [ADOPTION]))

    def test_receipts_are_read_by_id(self):
        db = FakeDatabase(coins=1000)
        asyncio.run(project_adoption.ensure_schema(db))
        self.run_adopt(db)
        receipts = asyncio.run(project_adoption.read_receipts(db, [ADOPTION, SECOND]))
        self.assertEqual([(r['adoption_id'], r['penguin_puffle_id'], r['coins_after']) for r in receipts], [(ADOPTION, 500, 600)])


class PublicationVersionTests(unittest.TestCase):
    def test_version_two_lists_reservations_for_published_owners_only(self):
        value = publication().value
        self.assertEqual(value.adoptions[ADOPTION].owner_id, OWNER)
        self.assertEqual(parse_publication({'version': 1, 'visitorId': VISITOR, 'igloos': []}).adoptions, {})
        base = {'version': 2, 'visitorId': VISITOR, 'igloos': [{'ownerId': OWNER, 'iglooId': 9}]}
        entry = {'adoptionId': ADOPTION, 'ownerId': OWNER, 'expiresAt': NOW}
        for bad in ({**base}, {**base, 'adoptions': [entry, entry]}, {**base, 'adoptions': [dict(entry, ownerId=OTHER_OWNER)]},
                    {**base, 'adoptions': [dict(entry, adoptionId=ADOPTION.upper())]}, {**base, 'adoptions': [dict(entry, expiresAt=0)]},
                    {**base, 'adoptions': [dict(entry, extra=1)]}, {**base, 'version': 3, 'adoptions': []},
                    {'version': 1, 'visitorId': VISITOR, 'igloos': [], 'adoptions': []},
                    {'version': 2, 'visitorId': None, 'igloos': [], 'adoptions': [entry]}):
            with self.assertRaises(ValueError, msg=bad):
                parse_publication(bad)


if __name__ == '__main__':
    unittest.main(verbosity=2)
