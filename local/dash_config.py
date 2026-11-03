"""Local-only settings layered over upstream defaults."""
import os
from pathlib import Path
exec(compile(Path('/usr/src/dash/config.sample.py').read_text(), 'config.sample.py', 'exec'))
POSTGRES_HOST = 'db'
POSTGRES_USER = os.environ['POSTGRES_USER']
POSTGRES_NAME = os.environ['POSTGRES_DB']
POSTGRES_PASSWORD = os.environ['POSTGRES_PASSWORD']
REDIS_ADDRESS = 'redis'
APPROVE_USERNAME = True
ACTIVATE_PLAYER = True
EMAIL_METHOD = ''
EMAIL_WHITELIST = []
SITE_NAME = 'Local Club Penguin'
LEGACY_PLAY_LINK = VANILLA_PLAY_LINK = 'http://localhost:8080'
LEGACY_ACTIVATE_REDIRECT = VANILLA_ACTIVATE_REDIRECT = VANILLA_PLAY_LINK
CJS_HOST = '127.0.0.1'
CJS_PORT = 7002
