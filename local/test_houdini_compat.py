#!/usr/bin/env python3
"""Regression checks against the actual pinned Houdini callbacks, with fake I/O."""
import json
import os
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, '/usr/src/houdini')
from houdini.houdini import Houdini  # noqa: F401, normal startup import order
import houdini.handlers.games  # noqa: F401, upstream discovery order
from houdini.handlers.play import igloo
import houdini_bootstrap
from houdini_bootstrap import (NativeIglooPublication, corrected_igloo_callback, install_native_igloo_adapter,
                               require_upstream_shape, visitor_igloo_open, visitor_open_igloo_list)


class Cache(dict):
    def set(self, key, value):
        self[key] = value

    def delete(self, key):
        self.pop(key, None)


class Record(SimpleNamespace):
    def update(self, **fields):
        self.__dict__.update(fields)
        return SimpleNamespace(apply=AsyncMock())


def penguin():
    layout = Record(id=7, locked=True, music=0, flooring=0, location=1, type=1)
    return Record(
        id=1, igloo=7, igloo_rooms={7: layout}, igloos={1}, flooring={0}, locations={1},
        room=SimpleNamespace(igloo=True, penguin_id=1, send_xt=AsyncMock()),
        server=SimpleNamespace(igloos_by_penguin_id={}, cache=Cache({'layout_like_count.7': 0}), stamps={23: object()}),
        add_stamp=AsyncMock(),
    )


class IglooCompatibilityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.original = igloo.handle_update_igloo_configuration.callback
        self.corrected = corrected_igloo_callback(self.original)

    async def test_original_empty_layout_reproduces_reported_exception(self):
        p = penguin()
        with patch.object(igloo, 'save_igloo_furniture', new=AsyncMock(return_value=True)):
            with self.assertRaisesRegex(TypeError, 'NoneType'):
                await self.original(p, 7, 1, 0, 1, 0, '')

    async def test_empty_layout_saves_and_broadcasts_without_awarding_stamp(self):
        p = penguin()
        with patch.object(igloo, 'save_igloo_furniture', new=AsyncMock(return_value=True)) as save:
            await self.corrected(p, 7, 1, 0, 1, 0, '')
            save.assert_awaited_once_with(p, [])
        p.room.send_xt.assert_awaited_once_with('uvi', 1, '7:1:0:1:0:0:1:1:0:')
        self.assertEqual(p.server.cache['layout_furniture.7'], '')
        p.add_stamp.assert_not_awaited()

    async def test_nonempty_layout_keeps_original_save_and_stamp_behavior(self):
        p = penguin()
        furniture = ['42|240|180|0|1'] * 99
        with patch.object(igloo, 'save_igloo_furniture', new=AsyncMock(return_value=True)) as save:
            await self.corrected(p, 7, 1, 0, 1, 0, ','.join(furniture))
            save.assert_awaited_once_with(p, furniture)
        self.assertEqual(p.server.cache['layout_furniture.7'], ','.join(furniture))
        p.add_stamp.assert_awaited_once_with(p.server.stamps[23])

    async def test_foreign_igloo_remains_unauthorized(self):
        p = penguin()
        p.room.penguin_id = 2
        with patch.object(igloo, 'save_igloo_furniture', new=AsyncMock(return_value=True)) as save:
            await self.corrected(p, 7, 1, 0, 1, 0, '')
            save.assert_not_awaited()
        p.room.send_xt.assert_not_awaited()


VISITOR, PLAYER, OPEN_OWNER, MANAGED, LEGACY, UNAPPROVED = 107, 101, 150, 201, 105, 202


def published(visitor=VISITOR, igloos=((MANAGED, 9), (LEGACY, 4), (UNAPPROVED, 12))):
    return {'version': 1, 'visitorId': visitor, 'igloos': [{'ownerId': o, 'iglooId': i} for o, i in igloos]}


def online(penguin_id, name, active_igloo):
    return SimpleNamespace(id=penguin_id, safe_name=name, igloo=active_igloo)


def world_penguin(penguin_id):
    """A requesting penguin on a server with one genuinely open igloo (OPEN_OWNER)."""
    open_layout = SimpleNamespace(id=50, penguin_id=OPEN_OWNER, locked=False, penguins_by_id={1: object(), 2: object()})
    managed_room = SimpleNamespace(penguins_by_id={VISITOR: object()})
    server = SimpleNamespace(
        penguins_by_id={OPEN_OWNER: online(OPEN_OWNER, 'Open Owner', 50), LEGACY: online(LEGACY, 'Bridge Alpha', 4)},
        open_igloos_by_penguin_id={OPEN_OWNER: open_layout},
        igloos_by_penguin_id={MANAGED: managed_room},
        cache=Cache({'layout_like_count.50': 3, 'layout_like_count.4': 1}),
        config=SimpleNamespace(lang=1))
    return SimpleNamespace(id=penguin_id, igloo=None, moderator=False, server=server, send_xt=AsyncMock())


def offline_rows(owner_id):
    rows = {MANAGED: SimpleNamespace(id=MANAGED, nickname='My Project', approval=1, igloo=9),
            UNAPPROVED: SimpleNamespace(id=UNAPPROVED, nickname='Hidden Name', approval=0, igloo=12)}
    return rows.get(owner_id)


class NativeIglooTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.file = os.path.join(self.directory.name, 'published.json')
        self.notes = []
        self.publication = NativeIglooPublication(self.file, report=self.notes.append)
        self.gr = visitor_open_igloo_list(igloo.handle_get_open_igloo_list.callback, self.publication)
        self.pio = visitor_igloo_open(igloo.handle_is_player_igloo_open.callback, self.publication)
        patches = [patch.object(houdini_bootstrap, 'load_owner', new=AsyncMock(side_effect=offline_rows)),
                   patch.object(igloo, 'get_layout_like_count', new=AsyncMock(return_value=5))]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def publish(self, value):
        temporary = self.file + '.tmp'
        with open(temporary, 'w') as stream:
            stream.write(value if isinstance(value, str) else json.dumps(value))
        os.replace(temporary, self.file)  # The engine also replaces the file (new inode).

    async def upstream_and_adapted(self, penguin_id, command='gr', *args):
        original = igloo.handle_get_open_igloo_list.callback if command == 'gr' else igloo.handle_is_player_igloo_open.callback
        adapted = self.gr if command == 'gr' else self.pio
        expected, actual = world_penguin(penguin_id), world_penguin(penguin_id)
        await original(expected, *args)
        await adapted(actual, *args)
        return expected.send_xt.await_args_list, actual.send_xt.await_args_list

    async def test_pinned_handler_shapes_are_recognized_and_changes_fail_explicitly(self):
        require_upstream_shape(igloo.handle_get_open_igloo_list.callback, houdini_bootstrap.UPSTREAM_OPEN_IGLOO_LIST)
        require_upstream_shape(igloo.handle_is_player_igloo_open.callback, houdini_bootstrap.UPSTREAM_IS_IGLOO_OPEN)

        async def handle_get_open_igloo_list(p):
            await p.send_xt('gr', 0, 0)
        with self.assertRaisesRegex(RuntimeError, 'changed; review'):
            require_upstream_shape(handle_get_open_igloo_list, houdini_bootstrap.UPSTREAM_OPEN_IGLOO_LIST)

    async def test_other_penguins_including_player_keep_upstream_behavior(self):
        self.publish(published())
        for penguin_id in (PLAYER, MANAGED, OPEN_OWNER):
            expected, actual = await self.upstream_and_adapted(penguin_id)
            self.assertEqual(actual, expected)
            expected, actual = await self.upstream_and_adapted(penguin_id, 'pio', MANAGED)
            self.assertEqual(actual, expected)
            self.assertEqual(actual[0].args, ('pio', 0), 'managed igloos stay closed for everyone else')

    async def test_visitor_sees_published_owners_appended_as_open(self):
        self.publish(published())
        p = world_penguin(VISITOR)
        await self.gr(p)
        p.send_xt.assert_awaited_once()
        sent = p.send_xt.await_args.args
        self.assertEqual(sent[:4], ('gr', 0, 0, f'{OPEN_OWNER}|Open Owner|3|2|0'), 'upstream entries come first, unchanged')
        self.assertEqual(sent[4:], (
            f'{MANAGED}|My Project|5|1|0',     # offline owner, approved nickname, like query, loaded room population
            f'{LEGACY}|Bridge Alpha|1|0|0',    # online owner, locked igloo: cached likes, no loaded room
            f'{UNAPPROVED}|P{UNAPPROVED}|5|0|0',  # same approval rule as safe_name
        ))
        self.assertNotIn(MANAGED, p.server.penguins_by_id, 'no fake online penguins are inserted')
        self.assertNotIn(MANAGED, p.server.open_igloos_by_penguin_id, 'shared open-igloo map is unchanged')
        self.assertEqual(p.server.cache['layout_like_count.9'], 5)

    async def test_visitor_pio_is_open_only_for_published_owners(self):
        self.publish(published())
        for owner, expected in ((MANAGED, 1), (LEGACY, 1), (OPEN_OWNER, 1), (PLAYER, 0)):
            p = world_penguin(VISITOR)
            await self.pio(p, owner)
            self.assertEqual(p.send_xt.await_args.args, ('pio', expected), owner)

    async def test_already_open_and_mismatched_layouts_are_not_duplicated(self):
        self.publish(published(igloos=((OPEN_OWNER, 50), (MANAGED, 99))))
        p = world_penguin(VISITOR)
        await self.gr(p)
        self.assertEqual(p.send_xt.await_args.args, ('gr', 0, 0, f'{OPEN_OWNER}|Open Owner|3|2|0'))
        self.assertTrue(any('no longer uses published igloo 99' in note for note in self.notes))

    async def test_missing_invalid_or_visitorless_publication_adds_nothing(self):
        for content in (None, '{not json', json.dumps({'version': 2}), json.dumps(published(visitor=None, igloos=())),
                        json.dumps(published(igloos=((MANAGED, 9), (MANAGED, 9)))), json.dumps(published(igloos=((VISITOR, 3),)))):
            if content is None:
                if os.path.exists(self.file):
                    os.unlink(self.file)
            else:
                self.publish(content)
            expected, actual = await self.upstream_and_adapted(VISITOR)
            self.assertEqual(actual, expected, content)
        self.assertTrue(any('absent' in note for note in self.notes))
        self.assertTrue(any('ignoring invalid' in note for note in self.notes))
        self.publish(published())
        p = world_penguin(VISITOR)
        await self.gr(p)
        self.assertEqual(len(p.send_xt.await_args.args), 7, 'a replaced file is picked up without restart')

    async def test_unparseable_publication_fails_closed_without_affecting_other_penguins(self):
        self.publish(published())
        p = world_penguin(VISITOR)
        await self.gr(p)
        self.assertEqual(len(p.send_xt.await_args.args), 7)
        self.publish('[' * 20000 + ']' * 20000)  # json raises RecursionError here, not ValueError
        for penguin_id in (PLAYER, VISITOR, PLAYER, VISITOR):
            expected, actual = await self.upstream_and_adapted(penguin_id)
            self.assertEqual(actual, expected, 'nothing is published and the previous list is not kept')
        self.assertEqual(sum('ignoring invalid' in note for note in self.notes), 1, 'reported once')
        self.publish(published())
        p = world_penguin(VISITOR)
        await self.gr(p)
        self.assertEqual(len(p.send_xt.await_args.args), 7, 'a later valid file is picked up again')

    async def test_install_keeps_listener_metadata(self):
        listeners = (igloo.handle_get_open_igloo_list, igloo.handle_is_player_igloo_open)
        before = [(listener, listener.callback, listener.cooldown, listener._signature, listener.client_type) for listener in listeners]
        try:
            self.assertTrue(install_native_igloo_adapter(self.publication))
            self.assertFalse(install_native_igloo_adapter(self.publication), 'installation is idempotent')
            for listener, callback, cooldown, signature, client_type in before:
                self.assertIsNot(listener.callback, callback)
                self.assertIs(listener.cooldown, cooldown)
                self.assertEqual(listener._signature, signature)
                self.assertEqual(listener.client_type, client_type)
        finally:
            for listener, callback, *_ in before:
                listener.callback = callback


class ProjectAdoptionInstallTests(unittest.IsolatedAsyncioTestCase):
    async def test_cpadopt_is_registered_beside_the_pet_handlers_once_and_pn_is_unchanged(self):
        from houdini.constants import ClientType
        from houdini.handlers import XTPacket, XTListenerManager
        from houdini.handlers.play import pet
        from houdini_bootstrap import install_project_adoption
        upstream_pn = pet.handle_adopt_puffle_vanilla
        before = upstream_pn.callback
        publication = SimpleNamespace(for_visitor=lambda penguin_id: None)
        try:
            self.assertTrue(install_project_adoption(publication))
            self.assertFalse(install_project_adoption(publication), 'installation is idempotent')
            listener = pet.handle_claude_penguin_project_adopt
            self.assertEqual(listener.packet, XTPacket('p', 'cpadopt'))
            self.assertEqual(listener.client_type, ClientType.Vanilla)
            self.assertIs(upstream_pn.callback, before, 'upstream p#pn keeps its own callback')
            manager = XTListenerManager(SimpleNamespace())
            await manager.load(pet)
            self.assertIn(listener, manager[XTPacket('p', 'cpadopt')], 'discovery finds the new listener')
            # A penguin that is not the published visitor gets an error reply and nothing else. The
            # packet goes through Houdini's own argument conversion (strings to str/int), as on the wire.
            p = SimpleNamespace(id=5, send_xt=AsyncMock(), server=SimpleNamespace(puffles={}, penguins_by_id={}),
                                joined_world=True, is_vanilla_client=True, is_legacy_client=False, client_type=ClientType.Vanilla)
            await listener(p, ['0b6f8a52-5f1e-4f53-9d0e-4b8e8b7e2a11', '0', 'Pebble', '0'])
            self.assertEqual(p.send_xt.await_args.args, ('cpadopt', '0b6f8a52-5f1e-4f53-9d0e-4b8e8b7e2a11', 'error', 'unknown-adoption'))
        finally:
            for name in ('handle_claude_penguin_project_adopt', 'claude_penguin_adoption_schema', '__local_project_adoption__'):
                if hasattr(pet, name):
                    delattr(pet, name)


if __name__ == '__main__':
    unittest.main(verbosity=2)
