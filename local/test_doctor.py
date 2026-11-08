#!/usr/bin/env python3
"""Checks for the read-only setup doctor (local/doctor.py) against a fake host.

Run: python3 -m unittest local/test_doctor.py
"""
import hashlib
import io
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import doctor  # noqa: E402


def built(files):
    """Add a current overlay build record for each overlay output."""
    for record, source, output, flag in doctor.OVERLAY:
        files[source] = b'source ' + source.encode()
        files[output] = b'output ' + output.encode()
        files[record] = json.dumps({'extensionSha256': hashlib.sha256(files[source]).hexdigest(),
                                    'outputSha256': hashlib.sha256(files[output]).hexdigest(), flag: True}).encode()
    return files


class FakeHost:
    def __init__(self, **changes):
        self.tools = {'git', 'colima', 'docker', 'docker-compose', 'curl', 'unzip', 'node', 'npm', 'claude', 'javac'}
        self.versions = {'node': 'v22.11.0', 'git': 'git version 2.50.1 (Apple Git-155)',
                         'claude': '2.1.318 (Claude Code)', 'javac': 'javac 21.0.2'}
        self.failing = set()
        self.files = built({'vanilla-media/media': b''})
        self.env_vars = {}
        self.ports = set()
        self.game_up = False
        self.vm_up = False
        self.alive = set()
        self.free = 100.0
        self.os, self.mac, self.arch, self.python = 'Darwin', '15.1', 'arm64', (3, 12, 1)
        self.commands = []
        self.__dict__.update(changes)

    def system(self): return self.os
    def mac_version(self): return self.mac
    def machine(self): return self.arch
    def python_version(self): return self.python
    def env(self, name): return self.env_vars.get(name)
    def which(self, name): return f'/usr/bin/{name}' if name in self.tools else None
    def exists(self, path): return str(path) in self.files
    def read(self, path): return self.files[str(path)]
    def free_gb(self): return self.free
    def http_ok(self, url): return self.game_up and url.startswith('http://localhost:8080/')
    def listening(self, port): return port in self.ports
    def pid_alive(self, pid): return pid in self.alive

    def run(self, argv, timeout=15):
        self.commands.append(argv)
        name = Path(argv[0]).name
        if name == 'colima':
            return (0 if self.vm_up else 1), ''
        if name in self.failing:
            return 1, 'The operation couldn’t be completed. Unable to locate a Java Runtime.'
        return 0, self.versions.get(name, '')


def doctor_run(host, *args):
    out = io.StringIO()
    code = doctor.main(list(args), host=host, stream=out)
    return code, out.getvalue()


class DoctorTest(unittest.TestCase):
    def test_ready_mac_passes_both_modes(self):
        code, text = doctor_run(FakeHost())
        self.assertEqual(code, 0)
        self.assertIn('Ready. Run ./local/start to play.', text)
        self.assertNotIn('✗', text)
        self.assertEqual(doctor_run(FakeHost(), '--agents')[0], 0)

    def test_missing_island_tool_fails_with_fix(self):
        host = FakeHost()
        host.tools.discard('colima')
        code, text = doctor_run(host)
        self.assertEqual(code, 1)
        self.assertIn('colima is not installed', text)
        self.assertIn('brew install colima', text)
        self.assertIn('1 problem to fix first.', text)

    def test_agent_problems_are_optional_without_flag(self):
        host = FakeHost(failing={'javac'})
        host.versions['node'] = 'v20.10.0'
        code, text = doctor_run(host)
        self.assertEqual(code, 0)
        self.assertIn('Node.js 20.10.0; 22 or newer is needed', text)
        self.assertIn('No JDK found', text)
        self.assertIn('The puffles need 2 more things', text)
        code, text = doctor_run(host, '--agents')
        self.assertEqual(code, 1)
        self.assertIn('2 problems to fix first.', text)

    def test_old_git_fails_for_agents(self):
        host = FakeHost()
        host.versions['git'] = 'git version 2.39.5 (Apple Git-154)'
        code, text = doctor_run(host, '--agents')
        self.assertEqual(code, 1)
        self.assertIn('Git 2.39.5; 2.48 or newer', text)

    def test_homebrew_jdk_preferred_over_stub(self):
        host = FakeHost(failing={'javac'})
        host.files[str(doctor.HOMEBREW_JDK / 'bin/java')] = b''
        host.failing = set()  # the Homebrew javac works; the /usr/bin stub is never run
        self.assertEqual(doctor_run(host, '--agents')[0], 0)
        self.assertIn([str(doctor.HOMEBREW_JDK / 'bin/javac'), '-version'], host.commands)

    def test_port_taken_by_another_program_fails(self):
        code, text = doctor_run(FakeHost(ports={8080}))
        self.assertEqual(code, 1)
        self.assertIn('Port 8080 (web) is in use by another program', text)
        self.assertIn('lsof -nP -iTCP:8080', text)

    def test_running_game_owns_its_ports(self):
        code, text = doctor_run(FakeHost(ports={8080, 6112}, game_up=True, vm_up=True))
        self.assertEqual(code, 0)
        self.assertIn('The game is up at http://localhost:8080/', text)
        self.assertIn('VM is running', text)
        self.assertIn('Ready. The game is running.', text)
        self.assertIn('Run ./local/agent-start for the puffles.',
                      doctor_run(FakeHost(ports={8080}, game_up=True), '--agents')[1])
        self.assertIn('Run ./local/start, then ./local/agent-start', doctor_run(FakeHost(), '--agents')[1])

    def test_running_engine_is_reported(self):
        host = FakeHost(game_up=True, ports={8080, 8081}, alive={99})
        host.files['.local/agent-engine/runtime.lock'] = json.dumps({'pid': 99}).encode()
        code, text = doctor_run(host, '--agents')
        self.assertEqual(code, 0)
        self.assertIn('Ready. The puffles are running.', text)
        self.assertNotIn('Port 8081 is in use', text)

    def test_first_start_disk_warning(self):
        host = FakeHost(free=4.0)
        del host.files['vanilla-media/media']
        code, text = doctor_run(host)
        self.assertEqual(code, 0)
        self.assertIn('fetches about 4.1 GB', text)
        self.assertIn('4 GB free', text)

    def test_overlay_missing_and_stale(self):
        host = FakeHost()
        del host.files['.local/client-bridge/engine.swf']
        self.assertIn('menu is not built yet', doctor_run(host, '--agents')[1])
        host = FakeHost()
        host.files['local/client-bridge/bridge.as'] = b'edited'
        code, text = doctor_run(host, '--agents')
        self.assertIn('menu is out of date', text)
        self.assertEqual(code, 0)  # agent-start rebuilds it

    def test_stale_lock_is_reported_not_removed(self):
        host = FakeHost()
        host.files['.local/agent-engine/runtime.lock'] = json.dumps({'pid': 4242, 'nonce': 'x'}).encode()
        code, text = doctor_run(host, '--agents')
        self.assertEqual(code, 0)
        self.assertIn('engine lock was left behind', text)
        self.assertIn('never removes locks', text)
        self.assertIn('.local/agent-engine/runtime.lock', host.files)
        host.alive.add(4242)
        self.assertIn('held by running process 4242', doctor_run(host, '--agents')[1])

    def test_custom_engine_state_dir_lock(self):
        host = FakeHost(env_vars={'CP_ENGINE_STATE_DIR': '/tmp/engine'})
        host.files['/tmp/engine/runtime.lock'] = json.dumps({'pid': 7}).encode()
        self.assertIn('engine lock was left behind', doctor_run(host)[1])

    def test_claude_path_override_and_missing(self):
        host = FakeHost(env_vars={'CP_CLAUDE_PATH': '/opt/claude/bin/claude'})
        host.tools.discard('claude')
        self.assertEqual(doctor_run(host, '--agents')[0], 0)
        host = FakeHost()
        host.tools.discard('claude')
        code, text = doctor_run(host, '--agents')
        self.assertEqual(code, 1)
        self.assertIn(doctor.SETUP_GUIDE, text)

    def test_not_macos_and_old_macos(self):
        self.assertIn('supports macOS only', doctor_run(FakeHost(os='Linux'))[1])
        code, text = doctor_run(FakeHost(mac='12.7.4', arch='x86_64'))
        self.assertEqual(code, 1)
        self.assertIn('needs macOS 13 or newer', text)
        self.assertIn('Intel Macs have not been tested', text)

    def test_plain_marks_without_utf8(self):
        class Ascii(io.StringIO):
            encoding = 'ascii'
        out = Ascii()
        doctor.main([], host=FakeHost(), stream=out)
        self.assertIn('  + macOS', out.getvalue())


if __name__ == '__main__':
    unittest.main()
