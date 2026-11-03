#!/usr/bin/env python3
"""Regression checks against the actual pinned Houdini callback, with fake I/O."""
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, '/usr/src/houdini')
from houdini.houdini import Houdini  # noqa: F401, normal startup import order
import houdini.handlers.games  # noqa: F401, upstream discovery order
from houdini.handlers.play import igloo
from houdini_bootstrap import corrected_igloo_callback


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


if __name__ == '__main__':
    unittest.main(verbosity=2)
