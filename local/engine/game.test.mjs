import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { GameProtocolError, loginPasswordHash, worldSession } from './game-protocol.mjs';
import { ProvisionError, createGameProvisioner, prepareOwnerIgloo, titleCase } from './game.mjs';
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

test('an owner session validates, adopts, and records the server-normalized puffle name', async t => {
  const server = await fakeHoudini(t);
  const { world, penguinId } = await open(server);
  try {
    assert.equal(penguinId, 201);
    const result = await prepareOwnerIgloo(world, { ownerId: 201, requestedName: 'aTLAS' });
    assert.deepEqual(result, { iglooId: 9, roomId: 2201, puffleId: 31, puffleName: 'Atlas' });
  } finally { world.close(); }
  assert.deepEqual(server.world.packets.filter(packet => packet !== 'j#js'), ['p#pgu', 'p#checkpufflename', 'p#pn', 'g#gm', 'j#jp', 'p#pg']);
});

test('filtered names are rejected before adoption; error 441 is an explicit rejection', async t => {
  const server = await fakeHoudini(t);
  let session = await open(server);
  await assert.rejects(prepareOwnerIgloo(session.world, { ownerId: 201, requestedName: 'Badword' }), error => error instanceof ProvisionError && error.code === 'NAME_REJECTED');
  session.world.close();
  assert.equal(server.world.packets.includes('p#pn'), false, 'nothing is adopted after the pre-check fails');
  server.world.reject441 = true;
  session = await open(server);
  await assert.rejects(prepareOwnerIgloo(session.world, { ownerId: 201, requestedName: 'Atlas' }), error => error.code === 'NAME_REJECTED' && /during adoption/.test(error.message));
  session.world.close();
  assert.equal(server.world.pets.length, 0);
});

test('retries reconcile an adopted puffle; unexpected puffles, layouts, or unlocked igloos need repair', async t => {
  const reconcile = await fakeHoudini(t, { pets: [{ id: 44, name: 'Atlas' }] });
  let session = await open(reconcile);
  assert.deepEqual(await prepareOwnerIgloo(session.world, { ownerId: 201, requestedName: 'atlas' }), { iglooId: 9, roomId: 2201, puffleId: 44, puffleName: 'Atlas' });
  session.world.close();
  assert.equal(reconcile.world.packets.includes('p#pn'), false, 'an adopted puffle is never adopted twice');
  session = await open(reconcile);
  await assert.rejects(prepareOwnerIgloo(session.world, { ownerId: 201, requestedName: 'Atlas', recorded: { puffleId: 45, puffleName: 'Atlas' } }), error => error.code === 'MISMATCH');
  session.world.close();
  session = await open(reconcile);
  await assert.rejects(prepareOwnerIgloo(session.world, { ownerId: 201, requestedName: 'Atlas', recorded: { iglooId: 8 } }), /active igloo changed/);
  session.world.close();

  const several = await fakeHoudini(t, { pets: [{ id: 44, name: 'Atlas' }, { id: 45, name: 'Comet' }] });
  session = await open(several);
  await assert.rejects(prepareOwnerIgloo(session.world, { ownerId: 201, requestedName: 'Atlas' }), error => error.code === 'MISMATCH' && /do not match/.test(error.message));
  session.world.close();
  const unlocked = await fakeHoudini(t, { locked: '0' });
  session = await open(unlocked);
  await assert.rejects(prepareOwnerIgloo(session.world, { ownerId: 201, requestedName: 'Atlas' }), /must stay locked/);
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
  const result = await provisioner.prepareIgloo({ username: server.username, password: server.password, ownerId: 201, requestedName: 'Nova', recorded: {} });
  assert.equal(result.puffleName, 'Nova');
  await assert.rejects(provisioner.prepareIgloo({ username: 'bridgecheck', password: 'PenguinLocal2026!', ownerId: 107, requestedName: 'Nova' }), /non-managed/);
  await assert.rejects(provisioner.prepareIgloo({ username: 'player', password: 'x'.repeat(20), ownerId: 101, requestedName: 'Nova' }), /non-managed/);
  await assert.rejects(provisioner.prepareIgloo({ username: server.username, password: server.password, ownerId: 999, requestedName: 'Nova', recorded: {} }), error => error.code === 'MISMATCH');
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
    : request.op === 'visitor' ? { stdout: JSON.stringify({ status: 'ok', penguinId: 107, username: 'bridgecheck', created: false }) }
      : { stdout: JSON.stringify({ status: 'ok', results: request.mappings.map(mapping => ({ key: mapping.key, ok: true, problems: [] })) }) });
  const provisioner = createGameProvisioner({ root: '/repo', spawn });
  assert.deepEqual(await provisioner.ensureVisitor(), { penguinId: 107, username: 'bridgecheck', created: false });
  assert.deepEqual(await provisioner.ensureOwner({ marker: 'f'.repeat(8) + '-0000-4000-8000-' + '0'.repeat(12), username: 'cpabcdefgh12', password, nickname: 'My Project' }), { ownerId: 201, created: true });
  const verified = await provisioner.verifyOwners([{ key: 'p', username: 'cpabcdefgh12' }]);
  assert.deepEqual(verified, [{ key: 'p', ok: true, problems: [] }]);
  assert.deepEqual(runs.map(run => [run.command, run.args]), [
    ['/repo/local/compose', ['run', '--rm', '--no-deps', '-T', '-e', 'CLUB_PENGUIN_TEST_PASSWORD', 'provision']],
    ['/repo/local/compose', ['run', '--rm', '--no-deps', '-T', 'provision']],
    ['/repo/local/compose', ['run', '--rm', '--no-deps', '-T', 'provision']]]);
  assert.equal(runs[1].request.password, password, 'the credential is in the stdin request');
  for (const run of runs) assert.equal(run.args.join(' ').includes(password) || run.args.join(' ').includes('cpabcdefgh12'), false);
  await assert.rejects(provisioner.ensureOwner({ marker: 'x', username: 'bridgecheck', password, nickname: 'X' }), /managed-owner namespace/);
  await assert.rejects(provisioner.verifyOwners([{ key: 'p', username: 'player' }]), /non-managed/);
});

test('seed failures map to explicit codes and redact credentials from diagnostics', async () => {
  const password = 'Another-Generated-Secret-99';
  const outcomes = [
    { stdout: JSON.stringify({ status: 'failed', code: 'USERNAME_TAKEN', error: 'taken' }), code: 1 },
    { stdout: JSON.stringify({ status: 'failed', code: 'MISMATCH', error: 'marker belongs elsewhere' }), code: 1 },
    { stdout: '', stderr: `boom ${password}\n`, code: 1 },
  ];
  const { spawn } = fakeSpawn(() => outcomes.shift());
  const provisioner = createGameProvisioner({ root: '/repo', spawn });
  const owner = { marker: 'm', username: 'cpabcdefgh12', password, nickname: 'P' };
  await assert.rejects(provisioner.ensureOwner(owner), error => error.code === 'USERNAME_TAKEN');
  await assert.rejects(provisioner.ensureOwner(owner), error => error.code === 'MISMATCH');
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

test('publication lists only the visitor and ready mappings, including the legacy fixture', () => {
  const project = (status, ownerId, iglooId, source = 'managed') => ({ game: { source, status, ownerId, iglooId } });
  const state = { visitor: { penguinId: 107 }, projects: [project('ready', 201, 9), project('failed', 202, 10), project('repair', 203, 11),
    project('provisioning', null, null), project('ready', 105, 4, 'legacy-fixture'), { game: null }] };
  assert.deepEqual(publicationFor(state), { version: 1, visitorId: 107, igloos: [{ ownerId: 201, iglooId: 9 }, { ownerId: 105, iglooId: 4 }] });
  assert.deepEqual(publicationFor({ ...state, visitor: null }), { version: 1, visitorId: null, igloos: [] });
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
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'published.json'), 'utf8')), { version: 1, visitorId: 107, igloos: [] });
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
