#!/usr/bin/env python3
"""Host-runnable checks for the visitor-only native igloo adapter.

Run: python3 -m unittest local/test_native_igloos.py
Houdini's dependencies are not installed on the host, so this compiles the
vendored upstream g#gr/g#pio handlers and Penguin.safe_nickname directly from
source with fake I/O. test_houdini_compat.py repeats these checks against the
imported upstream modules inside the world image.
"""
import ast
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'local'))
import houdini_bootstrap  # noqa: E402
from houdini_bootstrap import NativeIglooPublication, parse_publication, visitor_igloo_open, visitor_open_igloo_list  # noqa: E402


def upstream(path, name, namespace):
    tree = ast.parse((ROOT / path).read_text(encoding='utf-8'))
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            node.decorator_list = []
            module = ast.Module(body=[node], type_ignores=[])
            exec(compile(module, str(ROOT / path), 'exec'), namespace)
            return namespace[name]
    raise AssertionError(f'{name} not found in {path}')


like_query = AsyncMock(return_value=5)
handlers = {'get_layout_like_count': like_query}
OPEN_LIST = upstream('houdini/houdini/handlers/play/igloo.py', 'handle_get_open_igloo_list', handlers)
IS_OPEN = upstream('houdini/houdini/handlers/play/igloo.py', 'handle_is_player_igloo_open', handlers)
SAFE_NICKNAME = upstream('houdini/houdini/data/penguin.py', 'safe_nickname', {})

# Stand-ins for the two upstream modules published_igloo_entry imports lazily.
penguin_module = types.ModuleType('houdini.data.penguin')
penguin_module.Penguin = SimpleNamespace(safe_nickname=SAFE_NICKNAME)
igloo_module = types.ModuleType('houdini.handlers.play.igloo')
igloo_module.get_layout_like_count = like_query
STUBS = {'houdini': types.ModuleType('houdini'), 'houdini.data': types.ModuleType('houdini.data'),
         'houdini.data.penguin': penguin_module, 'houdini.handlers': types.ModuleType('houdini.handlers'),
         'houdini.handlers.play': types.ModuleType('houdini.handlers.play'), 'houdini.handlers.play.igloo': igloo_module}
STUBS['houdini.handlers.play'].igloo = igloo_module

VISITOR, PLAYER, OPEN_OWNER, MANAGED, LEGACY, UNAPPROVED = 107, 101, 150, 201, 105, 202


class Cache(dict):
    def set(self, key, value):
        self[key] = value


def published(visitor=VISITOR, igloos=((MANAGED, 9), (LEGACY, 4), (UNAPPROVED, 12))):
    return {'version': 1, 'visitorId': visitor, 'igloos': [{'ownerId': o, 'iglooId': i} for o, i in igloos]}


def world_penguin(penguin_id):
    open_layout = SimpleNamespace(id=50, penguin_id=OPEN_OWNER, locked=False, penguins_by_id={1: 0, 2: 0})
    server = SimpleNamespace(
        penguins_by_id={OPEN_OWNER: SimpleNamespace(safe_name='Open Owner', igloo=50),
                        LEGACY: SimpleNamespace(safe_name='Bridge Alpha', igloo=4)},
        open_igloos_by_penguin_id={OPEN_OWNER: open_layout},
        igloos_by_penguin_id={MANAGED: SimpleNamespace(penguins_by_id={VISITOR: 0})},
        cache=Cache({'layout_like_count.50': 3, 'layout_like_count.4': 1}), config=SimpleNamespace(lang=1))
    return SimpleNamespace(id=penguin_id, igloo=None, moderator=False, server=server, send_xt=AsyncMock())


async def offline_rows(owner_id):
    return {MANAGED: SimpleNamespace(id=MANAGED, nickname='My Project', approval=1, igloo=9),
            UNAPPROVED: SimpleNamespace(id=UNAPPROVED, nickname='Hidden Name', approval=0, igloo=12)}.get(owner_id)


class NativeIglooHostTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.file = os.path.join(directory.name, 'published.json')
        self.notes = []
        self.publication = NativeIglooPublication(self.file, report=self.notes.append)
        self.gr = visitor_open_igloo_list(OPEN_LIST, self.publication)
        self.pio = visitor_igloo_open(IS_OPEN, self.publication)
        for item in (patch.dict(sys.modules, STUBS), patch.object(houdini_bootstrap, 'load_owner', offline_rows)):
            item.start()
            self.addCleanup(item.stop)

    def publish(self, value):
        temporary = self.file + '.tmp'
        Path(temporary).write_text(value if isinstance(value, str) else json.dumps(value))
        os.replace(temporary, self.file)

    def call(self, handler, penguin_id, *args):
        p = world_penguin(penguin_id)
        asyncio.run(handler(p, *args))
        return [call.args for call in p.send_xt.await_args_list]

    def test_other_penguins_keep_upstream_behavior(self):
        self.publish(published())
        for penguin_id in (PLAYER, MANAGED, OPEN_OWNER):
            self.assertEqual(self.call(self.gr, penguin_id), self.call(OPEN_LIST, penguin_id))
            self.assertEqual(self.call(self.pio, penguin_id, MANAGED), [('pio', 0)])

    def test_visitor_gets_published_offline_and_locked_owners_as_open(self):
        self.publish(published())
        self.assertEqual(self.call(self.gr, VISITOR), [(
            'gr', 0, 0, f'{OPEN_OWNER}|Open Owner|3|2|0',
            f'{MANAGED}|My Project|5|1|0', f'{LEGACY}|Bridge Alpha|1|0|0', f'{UNAPPROVED}|P{UNAPPROVED}|5|0|0')])
        self.assertEqual(self.call(self.pio, VISITOR, MANAGED), [('pio', 1)])
        self.assertEqual(self.call(self.pio, VISITOR, PLAYER), [('pio', 0)])

    def test_missing_invalid_and_mismatched_publications_add_nothing(self):
        baseline = self.call(OPEN_LIST, VISITOR)
        self.assertEqual(self.call(self.gr, VISITOR), baseline)
        for content in ('{', json.dumps({'version': 1}), json.dumps(published(visitor=True)),
                        json.dumps(published(igloos=((MANAGED, 0),))), json.dumps(published(visitor=None, igloos=()))):
            self.publish(content)
            self.assertEqual(self.call(self.gr, VISITOR), baseline, content)
        self.publish(published(igloos=((MANAGED, 99), (OPEN_OWNER, 50))))
        self.assertEqual(self.call(self.gr, VISITOR), baseline)
        self.assertTrue(any('absent' in note for note in self.notes))
        self.assertTrue(any('ignoring invalid' in note for note in self.notes))
        self.assertTrue(any('no longer uses published igloo 99' in note for note in self.notes))

    def test_a_parse_failure_fails_closed_once_and_never_affects_other_penguins(self):
        self.publish(published())
        self.assertEqual(len(self.call(self.gr, VISITOR)[0]), 7)
        baseline = self.call(OPEN_LIST, VISITOR)
        self.publish('[' * 20000 + ']' * 20000)  # json raises RecursionError here, not ValueError
        for _ in range(2):
            self.assertEqual(self.call(self.gr, PLAYER), self.call(OPEN_LIST, PLAYER))
            self.assertEqual(self.call(self.pio, PLAYER, MANAGED), [('pio', 0)])
            self.assertEqual(self.call(self.gr, VISITOR), baseline, 'the previously published list is not kept')
            self.assertEqual(self.call(self.pio, VISITOR, MANAGED), [('pio', 0)])
        self.assertEqual(sum('ignoring invalid' in note for note in self.notes), 1, 'an unchanged invalid file is reported once')
        with patch.object(houdini_bootstrap, 'parse_publication', side_effect=TypeError('unexpected shape')):
            self.publish(published())
            self.assertEqual(self.call(self.gr, VISITOR), baseline)
            self.assertEqual(self.call(self.gr, PLAYER), self.call(OPEN_LIST, PLAYER))
        self.publish(' ' * (houdini_bootstrap.MAX_PUBLICATION_BYTES + 1) + json.dumps(published()))
        self.assertEqual(self.call(self.gr, VISITOR), baseline, 'an oversized file is not read')
        self.assertTrue(any('too large' in note for note in self.notes))
        self.publish(published())
        self.assertEqual(len(self.call(self.gr, VISITOR)[0]), 7, 'a later valid file is picked up again')

    def test_publication_parser_is_strict(self):
        self.assertIsNone(parse_publication({'version': 1, 'visitorId': None, 'igloos': []}))
        value = parse_publication(published())
        self.assertEqual((value.visitor_id, value.igloos), (VISITOR, {MANAGED: 9, LEGACY: 4, UNAPPROVED: 12}))
        for bad in ({**published(), 'extra': 1}, published(igloos=((MANAGED, 9), (MANAGED, 10))), published(igloos=((VISITOR, 1),)),
                    published(igloos=[(n, n) for n in range(1, 66)]), {'version': 1, 'visitorId': None, 'igloos': [{'ownerId': 1, 'iglooId': 1}]}):
            with self.assertRaises(ValueError):
                parse_publication(bad)


if __name__ == '__main__':
    unittest.main(verbosity=2)
