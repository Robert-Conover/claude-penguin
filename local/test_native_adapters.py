"""Host checks for the environment-driven adapters the native macOS runtime relies on.

Plain `python3 -m unittest local/test_native_adapters.py`; standard library only.
Each test proves two things: the container defaults are unchanged, and the
native override takes effect.
"""
import ast
import contextlib
import importlib.util
import os
import runpy
import sys
import tempfile
import types
import unittest
from pathlib import Path

LOCAL = Path(__file__).resolve().parent


@contextlib.contextmanager
def environment(**values):
    saved = dict(os.environ)
    for key in [k for k in os.environ if k.startswith(('CP_', 'POSTGRES_', 'REDIS_'))]:
        del os.environ[key]
    os.environ.update({k: v for k, v in values.items() if v is not None})
    try:
        yield
    finally:
        os.environ.clear()
        os.environ.update(saved)


class DashConfigTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        (Path(self.root.name) / 'config.sample.py').write_text(
            "ADDRESS = '0.0.0.0'\nPORT = 3000\nREDIS_PORT = 6379\nCJS_HOST = 'localhost'\nCJS_PORT = 7002\n")

    def load(self, **extra):
        values = {'POSTGRES_USER': 'u', 'POSTGRES_DB': 'd', 'POSTGRES_PASSWORD': 'p', 'CP_DASH_ROOT': self.root.name}
        values.update(extra)
        with environment(**values):
            return runpy.run_path(str(LOCAL / 'dash_config.py'))

    def test_container_defaults_are_unchanged(self):
        with environment(POSTGRES_USER='u', POSTGRES_DB='d', POSTGRES_PASSWORD='p'):
            # Without CP_DASH_ROOT the container path /usr/src/dash is read; fake it by pointing at our sample.
            source = (LOCAL / 'dash_config.py').read_text().replace("'/usr/src/dash'", repr(self.root.name))
            namespace = {}
            exec(compile(source, 'dash_config.py', 'exec'), namespace)
        self.assertEqual(namespace['POSTGRES_HOST'], 'db')
        self.assertEqual(namespace['REDIS_ADDRESS'], 'redis')
        self.assertEqual(namespace['REDIS_PORT'], 6379)
        self.assertEqual(namespace['ADDRESS'], '0.0.0.0')   # upstream default is untouched
        self.assertEqual(namespace['PORT'], 3000)
        self.assertEqual(namespace['VANILLA_PLAY_LINK'], 'http://localhost:8080')
        self.assertEqual(namespace['LEGACY_PLAY_LINK'], 'http://localhost:8080')
        self.assertEqual((namespace['CJS_HOST'], namespace['CJS_PORT']), ('127.0.0.1', 7002))
        self.assertIn("'/usr/src/dash'", (LOCAL / 'dash_config.py').read_text())

    def test_native_overrides(self):
        config = self.load(POSTGRES_HOST='127.0.0.1', POSTGRES_PORT='47432', REDIS_HOST='127.0.0.1', REDIS_PORT='47379',
                           CP_DASH_ADDRESS='127.0.0.1', CP_DASH_PORT='47300', CP_PLAY_LINK='http://localhost:47080', CP_CJS_PORT='47002')
        self.assertEqual(config['POSTGRES_HOST'], '127.0.0.1:47432')   # Dash appends it to postgresql://user:pw@HOST/name
        self.assertEqual((config['REDIS_ADDRESS'], config['REDIS_PORT']), ('127.0.0.1', 47379))
        self.assertEqual((config['ADDRESS'], config['PORT']), ('127.0.0.1', 47300))
        self.assertEqual(config['VANILLA_PLAY_LINK'], 'http://localhost:47080')
        self.assertEqual(config['VANILLA_ACTIVATE_REDIRECT'], 'http://localhost:47080')
        self.assertEqual(config['CJS_PORT'], 47002)

    def test_postgres_port_alone_keeps_the_default_host(self):
        self.assertEqual(self.load(POSTGRES_PORT='5433')['POSTGRES_HOST'], 'db:5433')


class SnowflakeBootstrapTests(unittest.TestCase):
    def import_bootstrap(self, **env):
        calls = []

        class FakeReactor:
            def listenTCP(self, port, factory, backlog=50, interface=''):
                calls.append((port, factory, backlog, interface))

        config = types.ModuleType('config')
        config.MEDIA_LOCATION = 'http://localhost:47080/media/'
        twisted = types.ModuleType('twisted'); internet = types.ModuleType('twisted.internet')
        reactor = FakeReactor(); internet.reactor = reactor; twisted.internet = internet
        dotenv = types.ModuleType('dotenv'); dotenv.load_dotenv = lambda *a, **k: True
        stubs = {'config': config, 'twisted': twisted, 'twisted.internet': internet, 'dotenv': dotenv}
        saved = {name: sys.modules.get(name) for name in stubs}
        sys.modules.update(stubs)
        self.addCleanup(lambda: [sys.modules.__setitem__(n, m) if m is not None else sys.modules.pop(n, None) for n, m in saved.items()])
        with tempfile.TemporaryDirectory() as root, environment(CP_SNOWFLAKE_ROOT=root, **env):
            spec = importlib.util.spec_from_file_location('snowflake_bootstrap_under_test', LOCAL / 'snowflake_bootstrap.py')
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        return module, config, calls, dotenv

    def test_media_domain_keeps_port_and_path(self):
        _, config, _, _ = self.import_bootstrap()
        self.assertEqual(config.MEDIA_DOMAIN, 'localhost:47080/media')

    def test_listeners_are_untouched_without_native_settings(self):
        module, _, calls, _ = self.import_bootstrap()
        # __main__ block is not run on import, so the reactor is not patched.
        self.assertEqual(calls, [])
        self.assertIn("os.environ.get('CP_SNOWFLAKE_BIND', '')", (LOCAL / 'snowflake_bootstrap.py').read_text())

    def test_bind_listeners_adds_the_interface_and_moves_the_policy_port(self):
        module, _, calls, _ = self.import_bootstrap()
        from twisted.internet import reactor  # the stub
        module.bind_listeners('127.0.0.1', 47843)
        reactor.listenTCP(47002, 'world')
        reactor.listenTCP(843, 'policy')
        reactor.listenTCP(8002, 'ws', 50, '10.0.0.1')   # an explicit interface is respected
        self.assertEqual(calls, [(47002, 'world', 50, '127.0.0.1'), (47843, 'policy', 50, '127.0.0.1'), (8002, 'ws', 50, '10.0.0.1')])

    def test_bind_only_leaves_policy_port_alone(self):
        module, _, calls, _ = self.import_bootstrap()
        from twisted.internet import reactor
        module.bind_listeners('127.0.0.1')
        reactor.listenTCP(843, 'policy')
        self.assertEqual(calls, [(843, 'policy', 50, '127.0.0.1')])

    def test_dotenv_can_be_disabled(self):
        _, _, _, dotenv = self.import_bootstrap(CP_SNOWFLAKE_NO_DOTENV='1')
        self.assertFalse(dotenv.load_dotenv())
        _, _, _, dotenv = self.import_bootstrap()
        self.assertTrue(dotenv.load_dotenv())


class HoudiniBootstrapTests(unittest.TestCase):
    def test_source_root_comes_from_the_environment_with_the_container_default(self):
        tree = ast.parse((LOCAL / 'houdini_bootstrap.py').read_text())
        found = [n for n in ast.walk(tree) if isinstance(n, ast.Assign) and any(getattr(t, 'id', '') == 'source_root' for t in n.targets)]
        self.assertEqual(len(found), 1)
        call = ast.unparse(found[0].value) if hasattr(ast, 'unparse') else ast.dump(found[0].value)
        self.assertIn('CP_HOUDINI_ROOT', call)
        self.assertIn('/usr/src/houdini', call)

    def test_module_still_imports_with_the_standard_library_only(self):
        spec = importlib.util.spec_from_file_location('houdini_bootstrap_under_test', LOCAL / 'houdini_bootstrap.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertTrue(callable(module.parse_publication))


class DashLaunchTests(unittest.TestCase):
    def test_points_avatar_directory_at_the_configured_items_and_runs_the_bootstrap(self):
        with tempfile.TemporaryDirectory() as root:
            package = Path(root, 'dash', 'routes')
            package.mkdir(parents=True)
            Path(root, 'dash', '__init__.py').write_text('')
            Path(package, '__init__.py').write_text('')
            Path(package, 'avatar.py').write_text("avatar_item_directory = '/nowhere'\n")
            Path(root, 'bootstrap.py').write_text(
                "import dash.routes.avatar as a, json, sys\nprint(json.dumps({'items': a.avatar_item_directory, 'argv': sys.argv[1:], 'main': __name__}))\n")
            import subprocess
            result = subprocess.run([sys.executable, '-I', str(LOCAL / 'native' / 'dash_launch.py'), '-c', '../local/dash_config.py'],
                                    env={'CP_DASH_ROOT': root, 'CP_DASH_ITEMS': '/media/avatar/paper'}, capture_output=True, text=True, cwd=root)
            self.assertEqual(result.returncode, 0, result.stderr)
            import json
            self.assertEqual(json.loads(result.stdout), {'items': '/media/avatar/paper', 'argv': ['-c', '../local/dash_config.py'], 'main': '__main__'})


if __name__ == '__main__':
    unittest.main()
