import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { GameProtocolError, loginPasswordHash, worldSession } from './game-protocol.mjs';
import { createGameProvisioner, prepareOwnerIgloo, titleCase } from './game.mjs';
import { SECRETS_FILE, generateUsername, newOwnerCredentials, readSecrets, writeSecrets } from './game-secrets.mjs';
import { acquirePublication, publicationFor } from './publication.mjs';

// ------------------------------------------------------------ a fake Houdini (login + world) on loopback

const FILTERED = new Set(['badword']);

/** Implements the packets an owner session uses, with Houdini's name filter, title-casing, and error 441. */
async function fakeHoudini(t, { username = 'cpabcdefgh12', password = 'Correct-Horse-Battery', ownerId = 201, pets = [], locked = '1', iglooId = 9 } = {}) {
  const world = { pets: pets.map(pet => ({ ...pet })), packets: [], logins: [] };
  const frames = (socket, handle) => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\0')) >= 0) { const frame = buffer.slice(0, index); buffer = buffer.slice(index + 1); handle(frame); }
    });
    socket.on('error', () => {});
  };
  const send = (socket, message) => socket.write(`${message}\0`);
  const xt = (socket, command, ...args) => send(socket, `%xt%${command}%-1%${args.join('%')}%`);
  const handshake = (socket, frame) => {
    if (frame.includes('action="verChk"')) { send(socket, '<msg t="sys"><body action="apiOK" r="0" /></msg>'); return true; }
    if (frame.includes('action="rndK"')) { send(socket, '<msg t="sys"><body action="rndK" r="-1" /><k>houdini</k></msg>'); return true; }
    return false;
  };
  const login = net.createServer(socket => frames(socket, frame => {
    if (handshake(socket, frame)) return;
    const nick = /<nick>([^<]*)<\/nick>/.exec(frame)?.[1];
    const pword = /<pword>([^<]*)<\/pword>/.exec(frame)?.[1];
    world.logins.push(nick);
    if (nick === username && pword === loginPasswordHash(password, 'houdini')) xt(socket, 'l', `${ownerId}|x|${username}|loginkey|0|45|2`, 'confirm');
    else xt(socket, 'e', 101);
  }));
  const game = net.createServer(socket => frames(socket, frame => {
    if (handshake(socket, frame)) return;
    if (frame.startsWith('<msg')) { xt(socket, 'l'); return; }
    const [, , , command, , ...args] = frame.split('%').slice(0, -1); // %xt%s%<command>%-1%<args...>%
    world.packets.push(command);
    const pgu = () => world.pets.map(pet => `${pet.id}|${pet.parent ?? 0}|${pet.parent ?? 0}|${pet.name}|1700000000|100|100|100|100|0|0`);
    switch (command) {
      case 'j#js': xt(socket, 'js', 1, 0, 1, 0); xt(socket, 'lp', `${ownerId}|Owner|1`, 10000); xt(socket, 'jr', 100); xt(socket, 'pgu', ...pgu()); break;
      case 'p#pgu': xt(socket, 'pgu', ...pgu()); break;
      case 'p#checkpufflename': xt(socket, 'checkpufflename', args[0], Number(/^[A-Za-z]{1,12}$/.test(args[0]) && !FILTERED.has(args[0].toLowerCase()))); break;
      case 'p#pn': {
        if (!/^[A-Za-z]{1,12}$/.test(args[1]) || FILTERED.has(args[1].toLowerCase()) || world.reject441) { xt(socket, 'e', 441); break; }
        const pet = { id: 31 + world.pets.length, parent: 0, name: titleCase(args[1]) };
        world.pets.push(pet);
        xt(socket, 'pn', 9600, `${pet.id}|0|0|${pet.name}|1700000000|100|100|100|100|0|0`);
        break;
      }
      case 'g#gm': xt(socket, 'gm', args[0], `${iglooId}:1:0:${locked}:0:0:1:1:0:`); break;
      case 'j#jp': xt(socket, 'jp', Number(args[0]) + 2000, Number(args[0]) + 2000, 'igloo'); xt(socket, 'jr', Number(args[0]) + 2000); break;
      case 'p#pg': xt(socket, 'pg', world.pets.length, ...world.pets.map(pet => `${pet.id}|0|0|${pet.name}||100|100|100|100|0|0|0|0`)); break;
      default: xt(socket, 'e', 0);
    }
  }));
  await Promise.all([login, game].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  t.after(() => { login.close(); game.close(); });
  return { world, loginPort: login.address().port, worldPort: game.address().port, username, password, ownerId };
}

const open = server => worldSession({ username: server.username, password: server.password, loginPort: server.loginPort, worldPort: server.worldPort, timeoutMs: 3000 });

test('the login hash matches the Python reference implementation', () => {
  // python3 -c "from verify_game import login_password_hash as h; print(h('PenguinLocal2026!', 'houdini'))"
  assert.equal(loginPasswordHash('PenguinLocal2026!', 'houdini'), 'e2432dfd22246f839435aadeabff48a0');
});

test('an owner session creates or loads the igloo, enters it, and never adopts', async t => {
  const server = await fakeHoudini(t);
  const { world, penguinId } = await open(server);
  try {
    assert.equal(penguinId, 201);
    assert.deepEqual(await prepareOwnerIgloo(world, { ownerId: 201 }), { iglooId: 9, roomId: 2201 });
  } finally { world.close(); }
  assert.deepEqual(server.world.packets.filter(packet => packet !== 'j#js'), ['g#gm', 'j#jp']);
  assert.equal(server.world.pets.length, 0, 'registration creates an empty igloo');
});

test('an owner with puffles is entered unchanged; a changed layout or an unlocked igloo needs repair', async t => {
  const existing = await fakeHoudini(t, { pets: [{ id: 44, name: 'Atlas' }, { id: 45, name: 'Comet' }] });
  let session = await open(existing);
  assert.deepEqual(await prepareOwnerIgloo(session.world, { ownerId: 201, recorded: { iglooId: 9 } }), { iglooId: 9, roomId: 2201 });
  session.world.close();
  assert.equal(existing.world.packets.includes('p#pn'), false, 'the owner session never adopts');
  session = await open(existing);
  await assert.rejects(prepareOwnerIgloo(session.world, { ownerId: 201, recorded: { iglooId: 8 } }), error => error.code === 'MISMATCH' && /active igloo changed/.test(error.message));
  session.world.close();
  const unlocked = await fakeHoudini(t, { locked: '0' });
  session = await open(unlocked);
  await assert.rejects(prepareOwnerIgloo(session.world, { ownerId: 201 }), /must stay locked/);
  session.world.close();
});

test('wrong credentials and a stopped game fail without exposing secrets', async t => {
  const server = await fakeHoudini(t);
  await assert.rejects(worldSession({ username: server.username, password: 'wrong-password-123', loginPort: server.loginPort, worldPort: server.worldPort, timeoutMs: 3000 }),
    error => error instanceof GameProtocolError && error.code === 'LOGIN_REFUSED' && !error.message.includes('wrong-password-123'));
  const closed = net.createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  await assert.rejects(worldSession({ username: 'cpabcdefgh12', password: 'x'.repeat(20), loginPort: port, worldPort: port, timeoutMs: 1000 }), error => error.code === 'UNAVAILABLE');
});

test('the provisioner uses the owner session against loopback ports and refuses non-managed accounts', async t => {
  const server = await fakeHoudini(t);
  const provisioner = createGameProvisioner({ root: os.tmpdir(), loginPort: server.loginPort, worldPort: server.worldPort, timeoutMs: 3000 });
  assert.deepEqual(await provisioner.prepareIgloo({ username: server.username, password: server.password, ownerId: 201, recorded: {} }), { iglooId: 9, roomId: 2201 });
  for (const username of ['bridgecheck', 'adoptcheck', 'player']) {
    await assert.rejects(provisioner.prepareIgloo({ username, password: 'PenguinLocal2026!', ownerId: 107 }), /non-managed/, username);
  }
  await assert.rejects(provisioner.prepareIgloo({ username: server.username, password: server.password, ownerId: 999, recorded: {} }), error => error.code === 'MISMATCH');
  assert.throws(() => createGameProvisioner({ root: os.tmpdir(), visitorUsername: 'player' }), /visitor must be one of/);
  assert.deepEqual(server.world.logins.filter(name => !name.includes('|')), [server.username, server.username], 'only the managed owner ever logged in');
});

// ------------------------------------------------------------ the Compose seed service adapter

function fakeSpawn(respond) {
  const runs = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = signal => { child.killed = signal; };
    let input = '';
    child.stdin.on('data', chunk => { input += chunk; });
    child.stdin.on('end', () => {
      const run = { command, args, options, request: JSON.parse(input) };
      runs.push(run);
      const { stdout = '', stderr = '', code = 0 } = respond(run.request, run);
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      setImmediate(() => child.emit('close', code, null));
    });
    return child;
  };
  return { spawn, runs };
}

test('seed requests and credentials travel on stdin only, with fixed Compose arguments', async () => {
  const password = 'Generated-Secret-Value-1234';
  const { spawn, runs } = fakeSpawn(request => request.op === 'owner'
    ? { stdout: `Creating container\n${JSON.stringify({ status: 'ok', ownerId: 201, created: true })}\n` }
    : request.op === 'visitor' ? { stdout: JSON.stringify({ status: 'ok', penguinId: 107, username: request.username, created: false }) }
      : { stdout: JSON.stringify({ status: 'ok', results: request.mappings.map(mapping => ({ key: mapping.key, ok: true, problems: [] })) }) });
  const visitorPassword = 'Visitor-Fixture-Secret-77';
  const env = { PATH: process.env.PATH, CLUB_PENGUIN_TEST_PASSWORD: visitorPassword };
  const provisioner = createGameProvisioner({ root: '/repo', spawn, env });
  assert.deepEqual(await provisioner.ensureVisitor(), { penguinId: 107, username: 'bridgecheck', created: false });
  const marker = 'f'.repeat(8) + '-0000-4000-8000-' + '0'.repeat(12);
  assert.deepEqual(await provisioner.ensureOwner({ marker, username: 'cpabcdefgh12', password, nickname: 'My Project' }), { ownerId: 201, created: true });
  const verified = await provisioner.verifyOwners([{ key: 'p', username: 'cpabcdefgh12' }]);
  assert.deepEqual(verified, [{ key: 'p', ok: true, problems: [], unrecorded: [] }]);
  assert.deepEqual(runs.map(run => [run.command, run.args]), Array(3).fill(['/repo/local/compose', ['run', '--rm', '--no-deps', '-T', 'provision']]));
  assert.equal(runs[1].request.password, password, 'the credential is in the stdin request');
  assert.deepEqual(runs[0].request, { op: 'visitor', username: 'bridgecheck', penguinId: null, password: visitorPassword }, 'the visitor password is in the stdin request, not the container environment');
  assert.equal(runs[1].request.ownerId, null);
  for (const run of runs) {
    assert.equal([password, visitorPassword, 'cpabcdefgh12'].some(secret => run.args.join(' ').includes(secret)), false);
    assert.equal('CLUB_PENGUIN_TEST_PASSWORD' in run.options.env, false, 'the Compose process does not carry the visitor password');
  }
  // Recorded identities are sent so the service only verifies them.
  await provisioner.ensureVisitor({ penguinId: 107 });
  await provisioner.ensureOwner({ marker, username: 'cpabcdefgh12', password, nickname: 'My Project', ownerId: 201 });
  assert.equal(runs[3].request.penguinId, 107);
  assert.equal(runs[4].request.ownerId, 201);
  // Without a host override the service applies its own default, as before.
  await createGameProvisioner({ root: '/repo', spawn, env: { PATH: process.env.PATH } }).ensureVisitor();
  assert.deepEqual(runs.at(-1).request, { op: 'visitor', username: 'bridgecheck', penguinId: null });
  // The adoption test visitor is a separate marked fixture.
  assert.equal((await createGameProvisioner({ root: '/repo', spawn, env: { PATH: process.env.PATH }, visitorUsername: 'adoptcheck' }).ensureVisitor()).username, 'adoptcheck');
  assert.equal(runs.at(-1).request.username, 'adoptcheck');
  await assert.rejects(provisioner.ensureOwner({ marker: 'x', username: 'bridgecheck', password, nickname: 'X' }), /managed-owner namespace/);
  await assert.rejects(provisioner.verifyOwners([{ key: 'p', username: 'player' }]), /non-managed/);
});

test('receipts are read through the service by adoption ID and validated before use', async () => {
  const id = '0b6f8a52-5f1e-4f53-9d0e-4b8e8b7e2a11';
  const row = { adoption_id: id, visitor_id: 107, owner_id: 201, penguin_puffle_id: 40, puffle_id: 1006, name: 'Rex', cost: 800, coins_after: 4200, created_at: 1800000000 };
  const { spawn, runs } = fakeSpawn(() => ({ stdout: JSON.stringify({ status: 'ok', schema: true, receipts: [row, { ...row, adoption_id: 'not-a-uuid' }, { ...row, adoption_id: id.replace('0b', '1b'), cost: 'x' }] }) }));
  const provisioner = createGameProvisioner({ root: '/repo', spawn });
  assert.deepEqual(await provisioner.readReceipts([id]), [{ adoptionId: id, visitorId: 107, ownerId: 201, puffleId: 40, puffleType: 1006, name: 'Rex', cost: 800, coinsAfter: 4200, createdAt: 1800000000 }]);
  assert.deepEqual(runs[0].request, { op: 'receipts', adoptionIds: [id] });
  assert.deepEqual(await provisioner.readReceipts([]), [], 'nothing to read runs nothing');
  assert.equal(runs.length, 1);
  await assert.rejects(provisioner.readReceipts(['nope']), /Invalid adoption IDs/);
});

test('seed failures map to explicit codes and redact credentials from diagnostics', async () => {
  const password = 'Another-Generated-Secret-99';
  const outcomes = [
    { stdout: JSON.stringify({ status: 'failed', code: 'USERNAME_TAKEN', error: 'taken' }), code: 1 },
    { stdout: JSON.stringify({ status: 'failed', code: 'MISMATCH', error: 'marker belongs elsewhere' }), code: 1 },
    { stdout: JSON.stringify({ status: 'failed', code: 'MISSING', error: 'recorded owner is missing' }), code: 1 },
    { stdout: '', stderr: `boom ${password}\n`, code: 1 },
  ];
  const { spawn } = fakeSpawn(() => outcomes.shift());
  const provisioner = createGameProvisioner({ root: '/repo', spawn });
  const owner = { marker: 'm', username: 'cpabcdefgh12', password, nickname: 'P' };
  await assert.rejects(provisioner.ensureOwner(owner), error => error.code === 'USERNAME_TAKEN');
  await assert.rejects(provisioner.ensureOwner(owner), error => error.code === 'MISMATCH');
  await assert.rejects(provisioner.ensureOwner({ ...owner, ownerId: 201 }), error => error.code === 'MISSING');
  await assert.rejects(provisioner.ensureOwner(owner), error => error.code === 'UNAVAILABLE' && !error.message.includes(password) && error.message.includes('[redacted]'));
});

// ------------------------------------------------------------ secrets and publication

test('managed credentials use a 12-character namespace and a separate 0600 secrets file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'penguin-secrets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (let index = 0; index < 50; index++) assert.match(generateUsername(), /^cp[a-z0-9]{10}$/);
  const credentials = newOwnerCredentials();
  assert.match(credentials.marker, /^[0-9a-f-]{36}$/);
  assert.ok(credentials.password.length >= 24);
  writeSecrets(dir, { version: 1, owners: { project: credentials } });
  assert.equal(fs.statSync(path.join(dir, SECRETS_FILE)).mode & 0o777, 0o600);
  assert.deepEqual(readSecrets(dir).owners.project, credentials);
  fs.writeFileSync(path.join(dir, SECRETS_FILE), JSON.stringify({ version: 1, owners: { project: { username: 'player' } } }));
  assert.throws(() => readSecrets(dir), /invalid entry/);
});

test('publication lists the visitor, ready mappings, and only open unexpired reservations for listed owners', () => {
  const project = (status, ownerId, iglooId, source = 'managed') => ({ game: { source, status, ownerId, iglooId } });
  const now = Date.parse('2026-11-06T12:00:00.000Z');
  const adoption = (id, state, ownerId, minutes) => ({ id: `0b6f8a52-5f1e-4f53-9d0e-4b8e8b7e2a1${id}`, state, visitorId: 107, ownerId, expiresAt: new Date(now + minutes * 60000).toISOString() });
  const state = { visitor: { penguinId: 107 }, projects: [project('ready', 201, 9), project('failed', 202, 10), project('repair', 203, 11),
    project('provisioning', null, null), project('ready', 105, 4, 'legacy-fixture'), { game: null }],
  adoptions: [adoption(1, 'reserved', 201, 5), adoption(2, 'charged', 201, 5), adoption(3, 'bound', 201, 5), adoption(4, 'withdrawn', 201, 5),
    adoption(5, 'reserved', 201, -1), adoption(6, 'reserved', 202, 5)] };
  assert.deepEqual(publicationFor(state, now), { version: 2, visitorId: 107, igloos: [{ ownerId: 201, iglooId: 9 }, { ownerId: 105, iglooId: 4 }],
    adoptions: [{ adoptionId: state.adoptions[0].id, ownerId: 201, expiresAt: Math.floor((now + 300000) / 1000) },
      { adoptionId: state.adoptions[1].id, ownerId: 201, expiresAt: Math.floor((now + 300000) / 1000) }] });
  assert.deepEqual(publicationFor({ ...state, visitor: null }, now), { version: 2, visitorId: null, igloos: [], adoptions: [] });
});

test('one engine owns publication across state directories; stale owners fail closed and are never removed', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'penguin-publication-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'native-igloos');
  const first = acquirePublication({ dir, stateDir: path.join(root, 'a') });
  assert.equal(first.update({ version: 1, visitorId: 107, igloos: [{ ownerId: 201, iglooId: 9 }] }), true);
  assert.equal(first.update({ version: 1, visitorId: 107, igloos: [{ ownerId: 201, iglooId: 9 }] }), false, 'unchanged lists are not rewritten');
  assert.throws(() => acquirePublication({ dir, stateDir: path.join(root, 'b') }), /owns native igloo publication/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'published.json'), 'utf8')).igloos, [{ ownerId: 201, iglooId: 9 }], 'the second engine did not overwrite it');
  assert.equal(fs.statSync(path.join(dir, 'published.json')).mode & 0o777, 0o644);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['owner.lock', 'published.json'], 'no temporary files remain');
  first.close(107);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'published.json'), 'utf8')), { version: 2, visitorId: 107, igloos: [], adoptions: [] });
  assert.equal(fs.existsSync(path.join(dir, 'owner.lock')), false);

  // An unclean exit leaves the lock and the last list; both stay until explicit recovery.
  fs.writeFileSync(path.join(dir, 'owner.lock'), JSON.stringify({ pid: 2147483647, nonce: 'stale', stateDir: path.join(root, 'a') }));
  fs.writeFileSync(path.join(dir, 'published.json'), JSON.stringify({ version: 1, visitorId: 107, igloos: [{ ownerId: 201, iglooId: 9 }] }));
  assert.throws(() => acquirePublication({ dir, stateDir: path.join(root, 'a') }), /stale native igloo publication lock[^]*remove this lock explicitly/);
  assert.ok(fs.existsSync(path.join(dir, 'owner.lock')), 'a stale lock is never deleted automatically');
  fs.rmSync(path.join(dir, 'owner.lock'));
  const recovered = acquirePublication({ dir, stateDir: path.join(root, 'b') });
  recovered.update({ version: 1, visitorId: 107, igloos: [] });
  // Another process replacing the lock means this engine stops publishing.
  fs.writeFileSync(path.join(dir, 'owner.lock'), JSON.stringify({ pid: process.pid, nonce: 'other' }));
  assert.throws(() => recovered.update({ version: 1, visitorId: 107, igloos: [{ ownerId: 1, iglooId: 1 }] }), /no longer owns/);
  recovered.close();
  assert.ok(fs.existsSync(path.join(dir, 'owner.lock')), 'release never removes another owner\'s lock');
});
