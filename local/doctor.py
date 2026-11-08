#!/usr/bin/env python3
"""Check this Mac for what Claude Penguin needs, and say how to fix what is missing.

Run through ./local/doctor. It only reads: it never installs, starts, stops,
deletes or edits anything, and it does not contact the internet.

    ./local/doctor            the island (needed to play)
    ./local/doctor --agents   the island plus the puffles (Claude Code)

Exit status is 1 when a required check fails, otherwise 0.
"""
import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

PROJECT = Path(__file__).resolve().parent.parent
MIN_PYTHON = (3, 9)
MIN_NODE = 22
MIN_GIT = (2, 48)
MIN_MACOS = 13
MIN_FREE_GB = 10
GAME_PORTS = {8080: 'web', 6112: 'login', 9875: 'world', 7002: 'Card-Jitsu Snow'}
ENGINE_PORT = 8081
HOMEBREW_JDK = Path('/opt/homebrew/opt/openjdk')
SETUP_GUIDE = 'https://code.claude.com/docs/en/setup'
# Outputs of python3 local/client-bridge/build.py and the sources they record.
OVERLAY = (
    ('.local/client-bridge/build.json', 'local/client-bridge/bridge.as', '.local/client-bridge/engine.swf',
     'originalTagsUnchanged'),
    ('.local/client-bridge/adoption-build.json', 'local/client-bridge/ProjectAdoption.as',
     '.local/client-bridge/puffle_adoption.swf', 'deterministic'),
)


@dataclass
class Check:
    status: str  # ok, fail, warn or info
    label: str
    fix: Optional[str] = None


class Host:
    """Everything the checks observe. Tests replace it with a fake."""

    def system(self):
        return platform.system()

    def mac_version(self):
        return platform.mac_ver()[0]

    def machine(self):
        return platform.machine()

    def python_version(self):
        return tuple(sys.version_info[:3])

    def env(self, name):
        return os.environ.get(name)

    def which(self, name):
        return shutil.which(name)

    def run(self, argv, timeout=15):
        """(exit code, combined output), or (None, '') if it could not run."""
        try:
            done = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, cwd=PROJECT)
        except (OSError, subprocess.TimeoutExpired):
            return None, ''
        return done.returncode, (done.stdout + done.stderr).strip()

    def exists(self, path):
        return (PROJECT / path).exists()

    def read(self, path):
        return (PROJECT / path).read_bytes()

    def free_gb(self):
        return shutil.disk_usage(PROJECT).free / 1e9

    def http_ok(self, url):
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                return response.status == 200
        except Exception:
            return False

    def listening(self, port):
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=0.5):
                return True
        except OSError:
            return False

    def pid_alive(self, pid):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True


def version(text):
    match = re.search(r'(\d+)\.(\d+)(?:\.(\d+))?', text or '')
    return tuple(int(part or 0) for part in match.groups()) if match else None


def dotted(parts):
    return '.'.join(str(part) for part in parts)


def tool(host, name, fix):
    if host.which(name):
        return Check('ok', f'{name} is installed')
    return Check('fail', f'{name} is not installed', fix)


def island_checks(host):
    checks = []
    if host.system() != 'Darwin':
        checks.append(Check('fail', f'This is {host.system() or "an unknown system"}; the launcher supports macOS only',
                            'See LOCAL_SETUP.md for the supported setup.'))
    else:
        mac = version(host.mac_version())
        chip = 'Apple Silicon' if host.machine() == 'arm64' else host.machine()
        if not mac or mac[0] < MIN_MACOS:
            checks.append(Check('fail', f'macOS {host.mac_version() or "unknown"}; the VM needs macOS {MIN_MACOS} or newer',
                                'Update macOS, or run the game on a newer Mac.'))
        else:
            checks.append(Check('ok', f'macOS {host.mac_version()} on {chip}'))
        if host.machine() != 'arm64':
            checks.append(Check('warn', 'Intel Macs have not been tested; the game may still work'))

    have = host.python_version()
    if have < MIN_PYTHON:
        checks.append(Check('fail', f'Python {dotted(have)}; {dotted(MIN_PYTHON)} or newer is needed', 'brew install python'))
    else:
        checks.append(Check('ok', f'Python {dotted(have)}'))
    for name, fix in (('git', 'brew install git'), ('colima', 'brew install colima'),
                      ('docker', 'brew install docker'), ('docker-compose', 'brew install docker-compose'),
                      ('curl', 'brew install curl'), ('unzip', 'brew install unzip')):
        checks.append(tool(host, name, fix))

    media = host.exists('vanilla-media/media')
    free = host.free_gb()
    if media:
        checks.append(Check('ok', 'Game media is downloaded'))
    else:
        checks.append(Check('info', 'Game media is not downloaded yet; ./local/start fetches about 4.1 GB on first run'))
    if not media and free < MIN_FREE_GB:
        checks.append(Check('warn', f'{free:.0f} GB free; the first start needs about {MIN_FREE_GB} GB for media and images',
                            'Free up some disk space before ./local/start.'))

    if host.which('colima'):
        code, _ = host.run(['colima', 'status', '--profile', 'club-penguin'])
        if code == 0:
            checks.append(Check('ok', 'The club-penguin VM is running'))
        else:
            checks.append(Check('info', 'The club-penguin VM is stopped; ./local/start starts it'))

    if host.http_ok('http://localhost:8080/healthz'):
        checks.append(Check('ok', 'The game is up at http://localhost:8080/ (player / PenguinLocal2026!)'))
    else:
        busy = [port for port in GAME_PORTS if host.listening(port)]
        for port in busy:
            checks.append(Check('fail', f'Port {port} ({GAME_PORTS[port]}) is in use by another program',
                                f'lsof -nP -iTCP:{port} -sTCP:LISTEN   # find it, then stop it'))
        if not busy:
            checks.append(Check('info', 'The game is not running; start it with ./local/start'))
    return checks


def jdk(host):
    java_home = host.env('BRIDGE_JAVA_HOME')
    if not java_home and host.exists(HOMEBREW_JDK / 'bin/java'):
        java_home = str(HOMEBREW_JDK)
    javac = str(Path(java_home) / 'bin/javac') if java_home else host.which('javac')
    # macOS ships a /usr/bin/javac stub that only says Java is missing.
    code, out = host.run([javac, '-version']) if javac else (None, '')
    if code == 0:
        return Check('ok', f'JDK {dotted(version(out) or ("?",))}')
    return Check('fail', 'No JDK found (needed once, to build the in-game menu)',
                 'brew install openjdk   # found automatically; or set BRIDGE_JAVA_HOME')


def overlay_state(host):
    """'current', 'missing' or 'stale', using the same hashes agent-start checks."""
    for record, source, output, flag in OVERLAY:
        if not (host.exists(record) and host.exists(output)):
            return 'missing'
        try:
            build = json.loads(host.read(record))
        except ValueError:
            return 'stale'
        digest = lambda path: hashlib.sha256(host.read(path)).hexdigest()
        if (build.get('extensionSha256') != digest(source) or build.get('outputSha256') != digest(output)
                or build.get(flag) is not True):
            return 'stale'
    return 'current'


def lock_check(host, path, label):
    if not host.exists(path):
        return None
    try:
        pid = json.loads(host.read(path)).get('pid')
    except (ValueError, AttributeError):
        pid = None
    if isinstance(pid, int) and pid > 0 and host.pid_alive(pid):
        return Check('ok', f'{label} is held by running process {pid}')
    return Check('warn', f'{label} was left behind by an engine that is no longer running',
                 'Confirm the old engine and its Claude processes have stopped, then follow '
                 '"Persistence and recovery" in local/AGENT_ENGINE.md. The doctor never removes locks.')


def agent_checks(host):
    checks = []
    node = host.which('node')
    code, out = host.run([node, '--version']) if node else (None, '')
    have = version(out) if code == 0 else None
    if not have:
        checks.append(Check('fail', 'Node.js is not installed', 'brew install node'))
    elif have[0] < MIN_NODE:
        checks.append(Check('fail', f'Node.js {dotted(have)}; {MIN_NODE} or newer is needed', 'brew upgrade node'))
    else:
        checks.append(Check('ok', f'Node.js {dotted(have)}'))
    checks.append(tool(host, 'npm', 'brew install node'))

    git = host.which('git')
    code, out = host.run([git, '--version']) if git else (None, '')
    have = version(out) if code == 0 else None
    if have and have < MIN_GIT:
        checks.append(Check('fail', f'Git {dotted(have)}; {dotted(MIN_GIT)} or newer is needed for puffle worktrees',
                            'brew install git'))
    elif have:
        checks.append(Check('ok', f'Git {dotted(have)}'))

    checks.append(jdk(host))

    claude = host.env('CP_CLAUDE_PATH') or 'claude'
    path = claude if os.sep in claude else host.which(claude)
    code, out = host.run([path, '--version']) if path else (None, '')
    if code == 0:
        checks.append(Check('ok', f'Claude Code {dotted(version(out) or ("?",))} (sign-in is not checked)'))
    else:
        checks.append(Check('fail', 'Claude Code was not found', f'Install it from {SETUP_GUIDE}, or set CP_CLAUDE_PATH'))

    state = overlay_state(host)
    if state == 'current':
        checks.append(Check('ok', 'The in-game puffle menu is built and current'))
    else:
        checks.append(Check('info', f'The in-game puffle menu is {"not built yet" if state == "missing" else "out of date"}; '
                                    './local/agent-start builds it (needs the JDK)'))

    state_dir = Path(host.env('CP_ENGINE_STATE_DIR') or '.local/agent-engine')
    found = [check for check in (lock_check(host, state_dir / 'runtime.lock', 'The engine lock'),
                                 lock_check(host, Path('.local/native-igloos/owner.lock'), 'The igloo publication lock'))
             if check]
    checks.extend(found)
    if not found:
        if host.listening(ENGINE_PORT):
            checks.append(Check('warn', f'Port {ENGINE_PORT} is in use but no engine lock exists',
                                f'lsof -nP -iTCP:{ENGINE_PORT} -sTCP:LISTEN   # or set CP_ENGINE_PORT'))
        else:
            checks.append(Check('info', 'The agent engine is not running; start it with ./local/agent-start'))
    return checks


MARKS = {'ok': '✓', 'fail': '✗', 'warn': '!', 'info': '·'}


def render(sections, stream):
    plain = (getattr(stream, 'encoding', None) or '').lower().replace('-', '') != 'utf8'
    marks = {'ok': '+', 'fail': 'x', 'warn': '!', 'info': '-'} if plain else MARKS
    for title, checks in sections:
        print(f'\n{title}', file=stream)
        for check in checks:
            print(f'  {marks[check.status]} {check.label}', file=stream)
            if check.fix:
                print(f'      {check.fix}', file=stream)


def main(argv=None, host=None, stream=sys.stdout):
    parser = argparse.ArgumentParser(description='Check this Mac for what Claude Penguin needs.')
    parser.add_argument('--agents', action='store_true', help='also require what the puffles (Claude Code) need')
    args = parser.parse_args(argv)
    host = host or Host()
    island = island_checks(host)
    agents = agent_checks(host)
    print('Claude Penguin setup check', file=stream)
    render([('Island (needed to play)', island),
            ('Puffles (Claude Code; required with --agents)' if not args.agents else 'Puffles (Claude Code)', agents)],
           stream)
    required = island + (agents if args.agents else [])
    failures = sum(check.status == 'fail' for check in required)
    optional = 0 if args.agents else sum(check.status == 'fail' for check in agents)
    if failures:
        print(f'\n{failures} problem{"s" if failures != 1 else ""} to fix first.', file=stream)
    else:
        game_up = any(check.label.startswith('The game is up') for check in island)
        engine_up = any(check.label.startswith('The engine lock is held') for check in agents)
        if args.agents:
            step = ' The puffles are running.' if engine_up else (
                ' Run ./local/agent-start for the puffles.' if game_up else
                ' Run ./local/start, then ./local/agent-start for the puffles.')
        else:
            step = ' The game is running.' if game_up else ' Run ./local/start to play.'
        print('\nReady.' + step, file=stream)
        if optional:
            print(f'The puffles need {optional} more thing{"s" if optional != 1 else ""}; see above.', file=stream)
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
