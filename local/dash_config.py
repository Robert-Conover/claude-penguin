"""Local-only settings layered over upstream defaults.

Container defaults are unchanged. The native macOS runtime overrides them with:
  CP_DASH_ROOT        Dash source directory (default /usr/src/dash)
  POSTGRES_HOST/PORT  database address (defaults db / 5432)
  REDIS_HOST/PORT     Redis/Valkey address (defaults redis / 6379)
  CP_DASH_ADDRESS     bind address (upstream default 0.0.0.0; Dash ignores --address)
  CP_DASH_PORT        listen port (upstream default 3000)
  CP_PLAY_LINK        game origin for play/activate links (default http://localhost:8080)
  CP_CJS_HOST/PORT    Snowflake address handed to the client (defaults 127.0.0.1 / 7002)
"""
import os
from pathlib import Path
exec(compile(Path(os.environ.get('CP_DASH_ROOT', '/usr/src/dash'), 'config.sample.py').read_text(), 'config.sample.py', 'exec'))
# Dash builds postgresql://user:password@{POSTGRES_HOST}/{name}, so a port rides along in the host.
POSTGRES_HOST = os.environ.get('POSTGRES_HOST', 'db')
if os.environ.get('POSTGRES_PORT'):
    POSTGRES_HOST = f"{POSTGRES_HOST}:{os.environ['POSTGRES_PORT']}"
POSTGRES_USER = os.environ['POSTGRES_USER']
POSTGRES_NAME = os.environ['POSTGRES_DB']
POSTGRES_PASSWORD = os.environ['POSTGRES_PASSWORD']
REDIS_ADDRESS = os.environ.get('REDIS_HOST', 'redis')
REDIS_PORT = int(os.environ.get('REDIS_PORT', '6379'))
if os.environ.get('CP_DASH_ADDRESS'):
    ADDRESS = os.environ['CP_DASH_ADDRESS']
if os.environ.get('CP_DASH_PORT'):
    PORT = int(os.environ['CP_DASH_PORT'])
APPROVE_USERNAME = True
ACTIVATE_PLAYER = True
EMAIL_METHOD = ''
EMAIL_WHITELIST = []
SITE_NAME = 'Local Club Penguin'
LEGACY_PLAY_LINK = VANILLA_PLAY_LINK = os.environ.get('CP_PLAY_LINK', 'http://localhost:8080')
LEGACY_ACTIVATE_REDIRECT = VANILLA_ACTIVATE_REDIRECT = VANILLA_PLAY_LINK
CJS_HOST = os.environ.get('CP_CJS_HOST', '127.0.0.1')
CJS_PORT = int(os.environ.get('CP_CJS_PORT', '7002'))
