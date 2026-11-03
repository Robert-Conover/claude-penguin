#!/usr/bin/env python3
"""Apply the local empty-igloo compatibility fix, then run upstream Houdini.

The pinned vanilla handler saves an empty furniture layout and broadcasts it,
then calls len(None) while checking a furniture-count stamp. Normalize only that
empty collection to [] in memory. Source files, packet rules, authorization,
cooldowns, persistence, and nonempty layouts remain upstream behavior.
"""
import ast
import functools
import inspect
from pathlib import Path
import runpy
import sys
import textwrap


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


if __name__ == '__main__':
    source_root = Path('/usr/src/houdini')
    sys.path.insert(0, str(source_root))
    # Match the normal startup import order before loading the handler module.
    from houdini.houdini import Houdini  # noqa: F401
    install_compatibility_fix()
    print('Local compatibility: empty igloo furniture saves use an empty list', flush=True)
    runpy.run_path(str(source_root / 'bootstrap.py'), run_name='__main__')
