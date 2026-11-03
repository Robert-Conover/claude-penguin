#!/usr/bin/env python3
"""Exercise the local AS3 Houdini game protocol using a disposable test account.

Requires no third-party Python packages. This is a backend smoke test, not a
substitute for checking Flash/Ruffle rendering or playing the minigames.

Seed account: username localcheck, active=true, approval_en=true, color=1,
coins=10000, nickname='Local Check', email='localcheck@example.invalid'.
Store bcrypt(login_password_hash(raw_password, 'houdini')) in penguin.password,
as Dash does; do NOT bcrypt the raw password. Other account fields use defaults.

Run with CLUB_PENGUIN_TEST_PASSWORD set, then:
    python3 local/verify_game.py

The verifier buys green (item 2), adopts a blue puffle named Localcheck if absent,
brushes/walks it, and creates the account's default igloo if necessary. These
ordinary game actions persist only on the dedicated test account. Subsequent
runs reuse those fixtures. No source files or gameplay code are modified.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import socket
import sys
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from xml.sax.saxutils import escape


class VerificationError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise VerificationError(message)


def md5(value: str) -> str:
    return hashlib.md5(value.encode('utf-8')).hexdigest()


def swap(value: str) -> str:
    return value[16:32] + value[:16]


def login_password_hash(password: str, random_key: str) -> str:
    # Mirrors Houdini Crypto.get_login_hash and Dash account registration.
    return swap(md5(swap(md5(password).upper()) + random_key + 'Y(02.>\'H}t":E1'))


@dataclass
class Packet:
    kind: str
    command: str
    args: list[str]
    xml: ET.Element | None = None


class Connection:
    def __init__(self, port: int, timeout: float):
        self.sock = socket.create_connection(('127.0.0.1', port), timeout)
        self.timeout = timeout
        self.buffer = bytearray()
        self.pending: list[Packet] = []

    def __enter__(self):
        return self

    def __exit__(self, *unused):
        self.close()

    def close(self):
        self.sock.close()

    def send(self, message: str):
        self.sock.sendall(message.encode('utf-8') + b'\x00')

    def xt(self, command: str, *args):
        self.send('%xt%s%' + command + '%-1%' + '%'.join(map(str, args)) + '%')

    def xml(self, action: str, children: str = ''):
        self.send(f'<msg t="sys"><body action="{action}" r="0">{children}</body></msg>')

    def login(self, username: str, credential: str):
        self.xml('login', '<login z="w1"><nick>' + escape(username)
                 + '</nick><pword>' + escape(credential) + '</pword></login>')

    def receive(self, deadline: float) -> Packet:
        while b'\x00' not in self.buffer:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise VerificationError('Timed out waiting for the game server')
            self.sock.settimeout(remaining)
            chunk = self.sock.recv(65536)
            if not chunk:
                raise VerificationError('Game server closed the connection unexpectedly')
            self.buffer.extend(chunk)
            require(len(self.buffer) < 4_000_000, 'Unexpectedly large server packet')
        raw, _, remainder = self.buffer.partition(b'\x00')
        self.buffer = bytearray(remainder)
        message = raw.decode('utf-8')
        if message.startswith('<'):
            root = ET.fromstring(message)
            body = root.find('body')
            require(body is not None, 'Malformed XML server response')
            return Packet('xml', body.get('action', ''), [], root)
        require(message.startswith('%xt%') and message.endswith('%'),
                'Malformed game response')
        parts = message.split('%')[1:-1]
        packet = Packet('xt', parts[1], parts[3:])
        if packet.command == 'e':
            raise VerificationError('Houdini returned game error ' + ', '.join(packet.args))
        return packet

    def wait(self, kind: str, command: str) -> Packet:
        for index, packet in enumerate(self.pending):
            if (packet.kind, packet.command) == (kind, command):
                return self.pending.pop(index)
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                packet = self.receive(deadline)
            except TimeoutError as error:
                raise VerificationError(f"Timed out waiting for {kind}:{command}") from error
            if (packet.kind, packet.command) == (kind, command):
                return packet
            self.pending.append(packet)
            require(len(self.pending) < 1000, 'Too many unrelated server responses')

    def wait_xt(self, command: str) -> list[str]:
        return self.wait('xt', command).args

    def handshake(self) -> str:
        self.xml('verChk', '<ver v="253"/>')
        self.wait('xml', 'apiOK')
        self.xml('rndK')
        random_key = self.wait('xml', 'rndK').xml.findtext('./body/k')
        require(bool(random_key), 'Server did not return a random/authentication key')
        return random_key


def world_session(args, password):
    with Connection(args.login_port, args.timeout) as login:
        random_key = login.handshake()
        login.login(args.username, login_password_hash(password, random_key))
        response = login.wait_xt('l')
        require(len(response) >= 2, 'Incomplete AS3 login response')
        raw_login, confirmation = response[:2]
        fields = raw_login.split('|')
        require(len(fields) == 7 and fields[2] == args.username.lower(),
                'AS3 login response identifies the wrong account')
        penguin_id, login_key = int(fields[0]), fields[3]

    world = Connection(args.world_port, args.timeout)
    try:
        random_key = world.handshake()
        client_key = swap(md5(login_key + random_key)) + login_key
        world.login(raw_login, client_key + '#' + confirmation)
        world.wait_xt('l')
        world.xt('j#js', penguin_id, login_key)
        world.wait_xt('js')
        player = world.wait_xt('lp')
        require(player[0].split('|')[0] == str(penguin_id), 'World loaded the wrong player')
        spawn = world.wait_xt('jr')
        world.wait_xt('pgu')  # Drain the unsolicited initial puffle list.
        require(bool(spawn) and spawn[0].isdigit(), 'World did not place player in a room')
        return world, penguin_id, int(player[1])
    except BaseException:
        world.close()
        raise


def inventory(world):
    world.xt('i#gi')
    return {int(item) for item in world.wait_xt('gi') if item}


def puffles(world):
    world.xt('p#pgu')
    result = {}
    for value in world.wait_xt('pgu'):
        if value:
            fields = value.split('|')
            require(len(fields) >= 9, 'Incomplete puffle data')
            result[int(fields[0])] = fields
    return result


def igloo(world, penguin_id):
    world.xt('g#gm', penguin_id)
    details = world.wait_xt('gm')
    require(details[0] == str(penguin_id), 'Igloo belongs to the wrong player')
    igloo_id = int(details[1].split(':')[0])
    world.xt('j#jp', penguin_id, 'igloo')
    response = world.wait_xt('jp')
    require(response[-1] == 'igloo', 'Server did not enter an igloo')
    joined = world.wait_xt('jr')
    require(joined[0] == response[0], 'Joined room does not match the player igloo')
    return igloo_id


def run(args, password):
    checks = []
    world, penguin_id, initial_coins = world_session(args, password)
    with world:
        checks.append('AS3 login, world authentication, player load and spawn')
        for room_id in (100, 310):
            world.xt('j#jr', room_id, 400, 300)
            joined = world.wait_xt('jr')
            require(joined[0] == str(room_id), f'Room transition failed: {room_id}')
            time.sleep(0.55)  # Upstream room change cooldown is 0.5 seconds.
        checks.append('Town Center and Pet Shop room transitions')
        world.xt('u#sp', 420, 310)
        moved = world.wait_xt('sp')
        require(moved[:3] == [str(penguin_id), '420', '310'], 'Movement was not echoed')
        checks.append('Player movement broadcast')

        owned = inventory(world)
        require(1 in owned, 'Seed blue color is missing from player inventory')
        purchased = 2 not in owned
        if purchased:
            world.xt('i#ai', 2)
            bought = world.wait_xt('ai')
            require(bought[0] == '2', 'Purchased inventory item did not match')
            require(int(bought[1]) == initial_coins - 20, 'Color purchase did not debit 20 coins')
        checks.append('Inventory load and green color purchase' if purchased else
                      'Inventory load (green color fixture already owned)')

        pets = puffles(world)
        matches = [(key, value) for key, value in pets.items() if value[3] == 'Localcheck']
        adopted = not matches
        if adopted:
            world.xt('p#pn', 0, 'Localcheck', 0)
            adoption = world.wait_xt('pn')
            fields = adoption[1].split('|')
            require(fields[1] == '0' and fields[3] == 'Localcheck', 'Unexpected adopted puffle')
            puffle_id = int(fields[0])
        else:
            puffle_id, fields = matches[0]
            require(fields[1] == '0', 'Existing Localcheck puffle is not the blue test fixture')
        checks.append('Blue puffle adoption' if adopted else 'Existing blue puffle fixture loaded')

        igloo_id = igloo(world, penguin_id)
        checks.append('Default igloo creation/load and entry')
        world.xt('p#pcid', puffle_id, 1)  # Brush: free basic care item.
        care = world.wait_xt('pcid')
        require(care[0] == str(penguin_id), 'Care update identifies the wrong player')
        stats = care[1].split('|')
        require(int(stats[0]) == puffle_id, 'Care update identifies the wrong puffle')
        expected_stats = stats[1:5]
        require(len(expected_stats) == 4 and all(0 <= int(v) <= 100 for v in expected_stats),
                'Puffle care returned invalid stats')
        checks.append('Puffle brushing and care statistics')
        for walking in (1, 0):
            world.xt('p#pw', puffle_id, walking)
            walked = world.wait_xt('pw')
            require(walked[0:2] == [str(penguin_id), str(puffle_id)] and walked[4] == str(walking),
                    'Puffle walking state did not match')
        checks.append('Puffle walking and returning to igloo')
        world.xt('r#gtc')
        expected_coins = int(world.wait_xt('gtc')[0])

    # Houdini cooldowns use penguin IDs and survive reconnect. g#gm and j#jp
    # have one-second windows, so relogin must not issue them inside that window.
    time.sleep(1.1)
    world, second_id, second_coins = world_session(args, password)
    with world:
        require(second_id == penguin_id, 'Relogin changed player identity')
        require(second_coins == expected_coins, 'Coin balance did not persist across relogin')
        require(2 in inventory(world), 'Purchased inventory did not persist across relogin')
        saved_puffles = puffles(world)
        require(puffle_id in saved_puffles, 'Adopted puffle did not persist across relogin')
        saved = saved_puffles[puffle_id]
        require(saved[3] == 'Localcheck' and saved[5:9] == expected_stats,
                'Puffle name/care statistics did not persist across relogin')
        require(igloo(world, penguin_id) == igloo_id, 'Igloo identity did not persist across relogin')
        checks.append('Relogin persistence: identity, coins, inventory, puffle, care stats and igloo')

    return {'status': 'passed', 'scope': 'local Houdini AS3 protocol; no visual or minigame coverage',
            'username': args.username, 'penguin_id': penguin_id, 'puffle_id': puffle_id,
            'igloo_id': igloo_id, 'coins': expected_coins, 'checks': checks}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--username', default='localcheck')
    parser.add_argument('--password-env', default='CLUB_PENGUIN_TEST_PASSWORD')
    parser.add_argument('--login-port', type=int, default=6112)
    parser.add_argument('--world-port', type=int, default=9875)
    parser.add_argument('--timeout', type=float, default=15)
    args = parser.parse_args()
    password = os.environ.get(args.password_env)
    if not password:
        parser.error(f'Set {args.password_env} to the dedicated local test account password')
    try:
        result = run(args, password)
    except (VerificationError, OSError, ValueError, IndexError, ET.ParseError) as error:
        print(json.dumps({'status': 'failed', 'error': str(error)}, indent=2))
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
