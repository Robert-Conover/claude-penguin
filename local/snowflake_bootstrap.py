"""Preserve the full local media host/path without editing upstream Snowflake."""
import runpy
import sys
from urllib.parse import urlparse

sys.path.insert(0, '/usr/src/snowflake')
import config

# Upstream takes only .hostname, losing our nonstandard port and /media prefix.
# Its login packet appends /game/mpassets and expects this value without a scheme.
media = urlparse(config.MEDIA_LOCATION)
config.MEDIA_DOMAIN = media.netloc + media.path.rstrip('/')
runpy.run_path('/usr/src/snowflake/main.py', run_name='__main__')
