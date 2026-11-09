"""Preserve the full local media host/path without editing upstream Snowflake.

Container defaults are unchanged. The native macOS runtime sets:
  CP_SNOWFLAKE_ROOT         source directory (default /usr/src/snowflake)
  CP_SNOWFLAKE_BIND         interface every listener binds (default: all, as upstream)
  CP_SNOWFLAKE_NO_DOTENV    ignore any .env file (upstream's override=True would let one beat the environment)
  CP_SNOWFLAKE_POLICY_PORT  replaces upstream's hard-coded Flash policy port 843
                            (the policy server itself stays off unless ENABLE_POLICY_SERVER=true)
"""
import os
import runpy
import sys
from urllib.parse import urlparse

source_root = os.environ.get('CP_SNOWFLAKE_ROOT', '/usr/src/snowflake')
sys.path.insert(0, source_root)
if os.environ.get('CP_SNOWFLAKE_NO_DOTENV'):
    # Upstream config.py calls load_dotenv(override=True), which searches parent
    # directories of the sources; natively the environment is the only input.
    import dotenv
    dotenv.load_dotenv = lambda *args, **kwargs: False
import config

# Upstream takes only .hostname, losing our nonstandard port and /media prefix.
# Its login packet appends /game/mpassets and expects this value without a scheme.
media = urlparse(config.MEDIA_LOCATION)
config.MEDIA_DOMAIN = media.netloc + media.path.rstrip('/')


def bind_listeners(interface, policy_port=None):
    """Upstream calls reactor.listenTCP(port, factory) with no interface."""
    from twisted.internet import reactor
    original = reactor.listenTCP

    def listen_tcp(port, factory, backlog=50, interface_=''):
        if policy_port and port == 843:
            port = policy_port
        return original(port, factory, backlog, interface_ or interface or '')
    reactor.listenTCP = listen_tcp


if __name__ == '__main__':
    bind = os.environ.get('CP_SNOWFLAKE_BIND', '')
    policy = os.environ.get('CP_SNOWFLAKE_POLICY_PORT', '')
    if bind or policy:
        bind_listeners(bind, int(policy) if policy else None)
    runpy.run_path(os.path.join(source_root, 'main.py'), run_name='__main__')
