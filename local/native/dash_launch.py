"""Run upstream Dash natively with the avatar item directory taken from CP_DASH_ITEMS.

Upstream resolves avatar art from ./items next to its working directory, which
the container mounts from the media archive. Natively the sources live in
read-only resources and the media elsewhere, so this adapter points the one
module variable at the configured directory and then runs Dash's own bootstrap
unchanged. (Dash binds app.config.ADDRESS/PORT; local/dash_config.py sets both.)
Usage: dash_launch.py -c ../local/dash_config.py   (working directory: the Dash sources)
"""
import os
import runpy
import sys

root = os.environ.get('CP_DASH_ROOT') or os.getcwd()
sys.path.insert(0, root)
items = os.environ.get('CP_DASH_ITEMS')
if items:
    import importlib
    importlib.import_module('dash.routes.avatar').avatar_item_directory = items
runpy.run_path(os.path.join(root, 'bootstrap.py'), run_name='__main__')
