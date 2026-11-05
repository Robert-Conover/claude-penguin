#!/usr/bin/env python3
"""Apply local compatibility adapters, then run upstream Houdini.

1. Empty-igloo fix. The pinned vanilla handler saves an empty furniture layout
   and broadcasts it, then calls len(None) while checking a furniture-count
   stamp. Normalize only that empty collection to [] in memory. Source files,
   packet rules, authorization, cooldowns, persistence, and nonempty layouts
   remain upstream behavior.

2. Visitor-only native igloo list. The AS3 igloo map asks for open igloos with
   g#gr and the player card asks whether one is open with g#pio. Managed
   project igloos stay locked in the database. For the one visitor named in the
   agent engine's publication file, g#gr also lists the published owners that
   are absent from the normal open-igloo collection, and g#pio answers open for
   them. Every other penguin, including `player`, gets upstream behavior.
"""
import ast
import functools
import inspect
import json
import os
from pathlib import Path
import runpy
import sys
import textwrap
from types import SimpleNamespace


def corrected_igloo_callback(callback):
    """Compile the original callback with its one known empty-list bug fixed.

    Fail explicitly if an upstream update changes the expected expression;
    silently patching unrelated code would conceal a compatibility regression.
    """
    source_lines, first_line = inspect.getsourcelines(callback)
    tree = ast.parse(textwrap.dedent(''.join(source_lines)))
    if len(tree.body) != 1 or not isinstance(tree.body[0], ast.AsyncFunctionDef):
        raise RuntimeError('Unexpected upstream igloo handler structure')
    function = tree.body[0]
    expected = ast.parse("furniture_list = furniture_data.split(',') if furniture_data else None").body[0]
    matches = [node for node in ast.walk(function)
               if isinstance(node, ast.Assign)
               and ast.dump(node) == ast.dump(expected)]
    if len(matches) != 1:
        raise RuntimeError('Upstream empty-igloo expression changed; review local compatibility fix')
    matches[0].value.orelse = ast.copy_location(ast.List(elts=[], ctx=ast.Load()), matches[0].value.orelse)
    # Keep the existing listener and all its authorization/cooldown metadata.
    # Reapplying decorators would create a separate listener object.
    function.decorator_list = []
    ast.fix_missing_locations(tree)
    ast.increment_lineno(tree, first_line - 1)
    namespace = {}
    exec(compile(tree, inspect.getsourcefile(callback), 'exec'), callback.__globals__, namespace)
    return functools.update_wrapper(namespace[function.name], callback)


def install_compatibility_fix():
    # Normal handler discovery imports games before play; they cross-reference.
    import houdini.handlers.games  # noqa: F401
    from houdini.handlers.play import igloo
    listener = igloo.handle_update_igloo_configuration
    if getattr(listener.callback, '__local_empty_igloo_fix__', False):
        return False
    listener.callback = corrected_igloo_callback(listener.callback)
    listener.callback.__local_empty_igloo_fix__ = True
    return True


# ---------------------------------------------------------------- native igloo list

MAX_PUBLISHED_IGLOOS = 64

# The pinned vanilla handlers this adapter wraps. Any upstream change to them
# stops startup so the adapter is reviewed instead of silently misbehaving.
UPSTREAM_OPEN_IGLOO_LIST = '''
async def handle_get_open_igloo_list(p):
    async def get_igloo_string(igloo):
        owner_name = p.server.penguins_by_id[igloo.penguin_id].safe_name
        like_count = p.server.cache.get(f'layout_like_count.{igloo.id}')
        like_count = await get_layout_like_count(igloo.id) if like_count is None else like_count
        p.server.cache.set(f'layout_like_count.{igloo.id}', like_count)
        igloo_population = len(igloo.penguins_by_id)
        return f'{igloo.penguin_id}|{owner_name}|{like_count}|{igloo_population}|{int(igloo.locked)}'

    open_igloos = [await get_igloo_string(igloo) for igloo in p.server.open_igloos_by_penguin_id.values()]
    local_room_population = 0

    own_layout_like_count = p.server.cache.get(f'layout_like_count.{p.igloo}')
    own_layout_like_count = 0 if p.igloo is None else await get_layout_like_count(p.igloo) \\
        if own_layout_like_count is None else own_layout_like_count
    p.server.cache.set(f'layout_like_count.{p.igloo}', own_layout_like_count)

    own_layout_like_count = 0 if p.igloo is None else await get_layout_like_count(p.igloo)
    await p.send_xt('gr', own_layout_like_count, local_room_population, *open_igloos)
'''

UPSTREAM_IS_IGLOO_OPEN = '''
async def handle_is_player_igloo_open(p, penguin_id: int):
    await p.send_xt('pio', int(penguin_id in p.server.open_igloos_by_penguin_id or p.moderator))
'''


def require_upstream_shape(callback, expected_source):
    source_lines, _ = inspect.getsourcelines(callback)
    tree = ast.parse(textwrap.dedent(''.join(source_lines)))
    if len(tree.body) != 1 or not isinstance(tree.body[0], ast.AsyncFunctionDef):
        raise RuntimeError(f'Unexpected upstream structure for {callback.__name__}')
    actual = tree.body[0]
    actual.decorator_list = []
    expected = ast.parse(textwrap.dedent(expected_source)).body[0]
    if ast.dump(actual) != ast.dump(expected):
        raise RuntimeError(f'Upstream {callback.__name__} changed; review the native igloo adapter')


def parse_publication(data):
    """Validate {version: 1, visitorId, igloos: [{ownerId, iglooId}]}; None means no visitor."""
    positive = lambda value: type(value) is int and value > 0  # noqa: E731
    if not isinstance(data, dict) or set(data) != {'version', 'visitorId', 'igloos'} or data['version'] != 1:
        raise ValueError('unexpected publication format')
    visitor_id, igloos = data['visitorId'], data['igloos']
    if not isinstance(igloos, list) or len(igloos) > MAX_PUBLISHED_IGLOOS:
        raise ValueError('igloos must be a short list')
    if visitor_id is None:
        if igloos:
            raise ValueError('igloos require a visitor')
        return None
    if not positive(visitor_id):
        raise ValueError('invalid visitor ID')
    published = {}
    for item in igloos:
        if not isinstance(item, dict) or set(item) != {'ownerId', 'iglooId'} \
                or not positive(item['ownerId']) or not positive(item['iglooId']):
            raise ValueError('invalid igloo entry')
        if item['ownerId'] in published or item['ownerId'] == visitor_id:
            raise ValueError('duplicate or visitor-owned igloo entry')
        published[item['ownerId']] = item['iglooId']
    return SimpleNamespace(visitor_id=visitor_id, igloos=published)


class NativeIglooPublication:
    """Reads the engine's publication file on demand; invalid or missing means no extra igloos."""

    def __init__(self, path, report=None):
        self.path = Path(path)
        self._signature = None
        self._value = None
        self._last_note = None
        self._report = report or (lambda message: print(message, flush=True))

    def note(self, message):
        if message and message != self._last_note:
            self._last_note = message
            self._report(f'Native igloos: {message}')

    def current(self):
        try:
            stat = self.path.stat()
        except FileNotFoundError:
            self._signature = self._value = None
            self.note(f'{self.path} is absent; no managed igloos are listed.')
            return None
        except OSError as error:
            self._signature = self._value = None
            self.note(f'{self.path} is unreadable ({error.strerror}); no managed igloos are listed.')
            return None
        signature = (stat.st_ino, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size)
        if signature != self._signature:
            self._signature = signature
            try:
                self._value = parse_publication(json.loads(self.path.read_text(encoding='utf-8')))
            except (OSError, ValueError) as error:
                self._value = None
                self.note(f'ignoring invalid {self.path}: {error}; no managed igloos are listed.')
                return None
            if self._value is None:
                self.note('the publication names no visitor; no managed igloos are listed.')
            else:
                self.note(f'{len(self._value.igloos)} published igloos for visitor {self._value.visitor_id}.')
        return self._value

    def for_visitor(self, penguin_id):
        value = self.current()
        return value if value is not None and value.visitor_id == penguin_id else None


async def load_owner(owner_id):
    from houdini.data.penguin import Penguin
    return await Penguin.query.where(Penguin.id == owner_id).gino.first()


async def published_igloo_entry(p, owner_id, igloo_id):
    """One open-list entry for a published owner, built without touching shared online maps."""
    from houdini.data.penguin import Penguin
    from houdini.handlers.play import igloo as igloo_handlers
    online = p.server.penguins_by_id.get(owner_id)
    if online is not None:
        name, active_igloo = online.safe_name, online.igloo
    else:
        row = await load_owner(owner_id)
        if row is None:
            return None, f'published owner {owner_id} does not exist; skipped.'
        # The same approval rule as Penguin.safe_name for online penguins.
        name, active_igloo = Penguin.safe_nickname(row, p.server.config.lang), row.igloo
    if active_igloo != igloo_id:
        return None, f'owner {owner_id} no longer uses published igloo {igloo_id}; skipped.'
    like_count = p.server.cache.get(f'layout_like_count.{igloo_id}')
    like_count = await igloo_handlers.get_layout_like_count(igloo_id) if like_count is None else like_count
    p.server.cache.set(f'layout_like_count.{igloo_id}', like_count)
    room = p.server.igloos_by_penguin_id.get(owner_id)
    population = len(room.penguins_by_id) if room is not None else 0
    return f'{owner_id}|{name}|{like_count}|{population}|0', None


class _SentCapture:
    """Delegates reads to the real penguin and records what the upstream handler sends."""

    def __init__(self, penguin):
        object.__setattr__(self, '_penguin', penguin)
        object.__setattr__(self, 'sent', [])

    def __getattr__(self, name):
        return getattr(self._penguin, name)

    def __setattr__(self, name, value):
        raise AttributeError('The open-igloo capture is read-only')

    async def send_xt(self, handler_id, *data):
        self.sent.append((handler_id, data))


def visitor_open_igloo_list(original, publication):
    async def handle_get_open_igloo_list(p):
        published = publication.for_visitor(p.id)
        if published is None:
            return await original(p)
        capture = _SentCapture(p)
        await original(capture)
        if len(capture.sent) != 1 or capture.sent[0][0] != 'gr':
            raise RuntimeError('Upstream open-igloo handler did not send exactly one list')
        data = list(capture.sent[0][1])
        listed = {int(str(entry).split('|', 1)[0]) for entry in data[2:]}
        for owner_id, igloo_id in published.igloos.items():
            if owner_id in listed or owner_id == p.id:
                continue
            entry, problem = await published_igloo_entry(p, owner_id, igloo_id)
            if entry is None:
                publication.note(problem)
            else:
                data.append(entry)
        await p.send_xt('gr', *data)
    return functools.update_wrapper(handle_get_open_igloo_list, original)


def visitor_igloo_open(original, publication):
    async def handle_is_player_igloo_open(p, penguin_id: int):
        published = publication.for_visitor(p.id)
        if published is not None and penguin_id in published.igloos:
            return await p.send_xt('pio', 1)
        return await original(p, penguin_id)
    return functools.update_wrapper(handle_is_player_igloo_open, original)


def install_native_igloo_adapter(publication):
    import houdini.handlers.games  # noqa: F401
    from houdini.constants import ClientType
    from houdini.handlers.play import igloo
    open_list, is_open = igloo.handle_get_open_igloo_list, igloo.handle_is_player_igloo_open
    if getattr(open_list.callback, '__local_native_igloos__', False):
        return False
    if open_list.client_type != ClientType.Vanilla or is_open.client_type != ClientType.Vanilla:
        raise RuntimeError('Upstream open-igloo listeners changed client type; review the native igloo adapter')
    require_upstream_shape(open_list.callback, UPSTREAM_OPEN_IGLOO_LIST)
    require_upstream_shape(is_open.callback, UPSTREAM_IS_IGLOO_OPEN)
    # Replace only the callbacks; each listener keeps its authorization and cooldown metadata.
    open_list.callback = visitor_open_igloo_list(open_list.callback, publication)
    is_open.callback = visitor_igloo_open(is_open.callback, publication)
    open_list.callback.__local_native_igloos__ = True
    is_open.callback.__local_native_igloos__ = True
    return True


if __name__ == '__main__':
    source_root = Path('/usr/src/houdini')
    sys.path.insert(0, str(source_root))
    # Match the normal startup import order before loading the handler module.
    from houdini.houdini import Houdini  # noqa: F401
    install_compatibility_fix()
    print('Local compatibility: empty igloo furniture saves use an empty list', flush=True)
    publication = NativeIglooPublication(os.environ.get('CP_NATIVE_IGLOOS_FILE', '/native-igloos/published.json'))
    install_native_igloo_adapter(publication)
    print('Local compatibility: published project igloos are listed as open for the agent visitor only', flush=True)
    runpy.run_path(str(source_root / 'bootstrap.py'), run_name='__main__')
