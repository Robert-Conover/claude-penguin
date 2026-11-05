import { engineStateDir, stateDirProblem } from './state-dir.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createEngineServer, acquireLock } from './server.mjs';

async function fixture(manager, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'penguin-engine-http-'));
  await mkdir(path.join(root, 'templates/vanilla-media/play'), { recursive: true });
  await writeFile(path.join(root, 'templates/vanilla-media/play/index.html.template'), '<html><head></head><body>Original game</body></html>');
  const publicOrigin = 'http://localhost:8081';
  const token = 'fixture_secret';
  const host = createEngineServer({ manager, root, publicOrigin, uiToken: token, ...options });
  host.server.listen(0, '127.0.0.1');
  await once(host.server, 'listening');
  const address = `http://127.0.0.1:${host.server.address().port}`;
  const headers = { Host: 'localhost:8081', Origin: publicOrigin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  return { ...host, address, headers, token, publicOrigin, async cleanup() { await host.close(); await rm(root, { recursive: true, force: true }); } };
}
const stub = () => ({ snapshot: () => ({ projects: [], workers: [] }), hook: async () => { throw Object.assign(new Error('Invalid run token.'), { statusCode: 403 }); } });
function requestHTTP(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: new Headers(res.headers), text: async () => text, json: async () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('engine rejects cross-origin, rebinding, missing authentication, and non-JSON mutations', async () => {
  const called = [];
  const manager = { ...stub(), registerProject: async body => { called.push(body); return { id: 'project-explicit' }; } };
  const f = await fixture(manager);
  try {
    const request = (endpoint, init = {}) => requestHTTP(f.address + endpoint, { ...init, headers: { ...f.headers, ...init.headers } });
    const bootstrap = await request('/engine/bootstrap');
    assert.equal(bootstrap.headers.get('access-control-allow-origin'), null);
    assert.equal(bootstrap.headers.get('cache-control'), 'no-store');
    assert.equal((await bootstrap.json()).token, f.token);
    assert.equal((await request('/engine/bootstrap', { headers: { Origin: 'http://localhost:8080' } })).status, 403);
    assert.equal((await request('/engine/bootstrap', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await request('/engine/bootstrap', { headers: { Host: 'attacker.example:8081' } })).status, 403);
    for (const headers of [{ Authorization: '' }, { Authorization: 'Bearer wrong' }, { Origin: 'null' }]) {
      assert.equal((await request('/engine/action', { method: 'POST', headers, body: '{"action":"register"}' })).status, 403);
    }
    assert.equal((await request('/engine/action', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"action":"register"}' })).status, 415);
    assert.equal((await request('/engine/action', { method: 'POST', body: '{"action":"__proto__"}' })).status, 400);
    assert.equal((await request('/engine/action', { method: 'POST', body: JSON.stringify({ action: 'register', path: '/tmp/fixture', name: 'Fixture' }) })).status, 200);
    assert.equal(called.length, 1);
    assert.equal(called[0].path, '/tmp/fixture');
    assert.equal((await request('/engine/hooks', { method: 'POST', body: '{}' })).status, 403);
    const hook = await requestHTTP(f.address + '/engine/hooks', { method: 'POST', headers: { Host: 'localhost:8081', Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(hook.status, 403, 'browser token cannot authorize a hook');
    const standard = await request('/').then(r => r.text());
    assert.doesNotMatch(standard, /CP_AGENT_MODE/);
    const agent = await request('/?bridge=1&agents=1').then(r => r.text());
    assert.match(agent, /CP_AGENT_MODE=true/);
    assert.ok(agent.indexOf('/engine/vendor/xterm.js') < agent.indexOf('/engine/client.mjs'));
    assert.ok(agent.indexOf('/engine/client.mjs') < agent.indexOf('/bridge/panel.mjs'));
  } finally { await f.cleanup(); }
  assert.throws(() => createEngineServer({ manager, publicOrigin: 'http://0.0.0.0:8081' }), /loopback/);
});

test('host routes game web-service paths through the existing container wrapper once', async () => {
  const upstream = http.createServer((req, res) => { res.end(req.url); });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const f = await fixture(stub(), { dashOrigin: `http://127.0.0.1:${upstream.address().port}` });
  try {
    const response = await requestHTTP(f.address + '/en/penguin/create?source=test', { headers: { Host: 'localhost:8081' } });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '/en/penguin/create?source=test');
  } finally { await f.cleanup(); await new Promise(resolve => upstream.close(resolve)); }
});

test('WebSocket authenticates before subscribing and replays terminal data without overlap', async () => {
  let releaseTerminal, startedTerminal;
  const terminalStarted = new Promise(resolve => { startedTerminal = resolve; });
  const inputs = [];
  const manager = {
    ...stub(),
    terminal: async ({ projectId, workerId }) => {
      assert.equal(projectId, 'p1'); assert.equal(workerId, 'w1');
      startedTerminal();
      return new Promise(resolve => { releaseTerminal = resolve; });
    },
    input: async message => inputs.push(message.data),
  };
  const f = await fixture(manager);
  const socket = new WebSocket(f.address.replace('http:', 'ws:') + '/engine/ws', { origin: f.publicOrigin, headers: { Host: 'localhost:8081' } });
  const messages = [];
  socket.on('message', bytes => messages.push(JSON.parse(bytes)));
  const next = async action => {
    const message = once(socket, 'message');
    action();
    return JSON.parse((await message)[0]);
  };
  try {
    await once(socket, 'open');
    const welcome = await next(() => socket.send(JSON.stringify({ type: 'auth', token: f.token })));
    assert.equal(welcome.type, 'snapshot');
    socket.send(JSON.stringify({ type: 'attach', projectId: 'p1', workerId: 'w1', attachment: 7 }));
    await terminalStarted;
    f.publish({ type: 'terminal', projectId: 'p1', workerId: 'w1', data: 'already-serialized', sequence: 1 });
    const replay = await next(() => releaseTerminal({ data: 'screen', cols: 120, rows: 32, sequence: 1 }));
    assert.equal(replay.type, 'terminal.snapshot');
    assert.equal(replay.data, 'screen');
    const delta = await next(() => f.publish({ type: 'terminal', projectId: 'p1', workerId: 'w1', data: 'new-data', sequence: 2 }));
    assert.equal(delta.data, 'new-data');
    assert.equal(delta.attachment, 7);
    assert.equal(replay.attachment, 7);
    assert.equal(messages.filter(message => message.data === 'already-serialized').length, 0);
    const mismatch = await next(() => socket.send(JSON.stringify({ type: 'input', projectId: 'p2', workerId: 'w1', data: 'wrong' })));
    assert.equal(mismatch.type, 'error');
    assert.deepEqual(inputs, []);
    socket.close();
    await once(socket, 'close');
    const bad = new WebSocket(f.address.replace('http:', 'ws:') + '/engine/ws', { origin: f.publicOrigin, headers: { Host: 'localhost:8081' } });
    await once(bad, 'open');
    bad.send(JSON.stringify({ type: 'auth', token: 'wrong' }));
    assert.equal((await once(bad, 'close'))[0], 1008);
  } finally { socket.terminate(); await f.cleanup(); }
});

test('runtime lock prevents two engines from owning the same state directory', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'penguin-lock-'));
  try {
    const release = await acquireLock(dir);
    await assert.rejects(acquireLock(dir), /already be running/);
    await release();
    const releaseAgain = await acquireLock(dir);
    await releaseAgain();
    await writeFile(path.join(dir, 'runtime.lock'), JSON.stringify({ pid: 2147483647, nonce: 'stale' }));
    await assert.rejects(acquireLock(dir), /stale engine lock/);
    await assert.rejects(acquireLock(dir), /stale engine lock/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('startup uses the documented state folder or an explicit override', () => {
  assert.equal(engineStateDir({}, '/repo'), '/repo/.local/agent-engine');
  assert.equal(engineStateDir({ CP_ENGINE_STATE_DIR: 'mine' }, '/repo'), '/repo/mine');
});

test('private state is allowed in the default folder and refused in served or mounted folders', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'penguin-state-dir-'));
  try {
    for (const dir of ['.local/agent-engine', '.local/ruffle', '.local/client-bridge', '.local/native-igloos', '.local/logs', 'vanilla-media/media', 'templates', 'local/web/bridge']) {
      await mkdir(path.join(root, dir), { recursive: true });
    }
    await symlink(path.join(root, '.local/agent-engine'), path.join(root, 'alias'));
    await symlink(path.join(root, '.local/ruffle'), path.join(root, 'ruffle-link'));
    const problem = (dir, platform = process.platform) => stateDirProblem(path.resolve(root, dir), { root, platform });
    for (const dir of ['.local/agent-engine', 'alias']) assert.equal(problem(dir), null);
    for (const dir of ['.local/ruffle/x', 'ruffle-link/x', '.local/client-bridge', '.local/native-igloos/state', '.local/logs/engine', 'vanilla-media',
      'vanilla-media/media/x', 'templates/state', 'local/web/bridge/x', 'local/engine', 'dash', 'houdini', 'snowflake', '.local/bridge-public']) {
      assert.match(problem(dir), /served over HTTP or mounted into the game containers/, dir);
    }
    assert.match(problem('.local/RUFFLE/new', 'darwin'), /served over HTTP/);
    for (const dir of ['.local/engine-preview', '.local/agent-engine-preview', '.local/ruffle-state', path.join(root, '..', 'outside-state')]) assert.equal(problem(dir), null, dir);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('hook events up to the hook client limit are accepted; other endpoints keep their smaller limit', async () => {
  const received = [];
  const manager = { ...stub(), hook: async ({ event }) => { received.push(event.payload.length); return { accepted: true }; }, registerProject: async () => ({}) };
  const f = await fixture(manager);
  try {
    // hook-client.mjs forwards events up to 1 MiB, wrapped with the worker ID.
    const shell = JSON.stringify({ hook_event_name: 'PermissionRequest', payload: '' });
    const event = size => `{"workerId":"34a60f4a-0c2b-4ab8-af20-c3156de19ffd","event":${shell.replace('""', `"${'x'.repeat(size - shell.length)}"`)}}`;
    const hook = body => requestHTTP(f.address + '/engine/hooks', { method: 'POST', body,
      headers: { Host: 'localhost:8081', Authorization: 'Bearer run_token', 'Content-Type': 'application/json' } }).then(response => response.status, () => 'reset');
    assert.equal(await hook(event(1024 * 1024)), 200, 'a large PermissionRequest at the client limit is delivered');
    assert.deepEqual(received, [1024 * 1024 - shell.length]);
    assert.ok([413, 'reset'].includes(await hook(event(1024 * 1024 + 64 * 1024))));
    const action = await requestHTTP(f.address + '/engine/action', { method: 'POST', headers: f.headers, body: JSON.stringify({ action: 'register', path: 'x'.repeat(300 * 1024) }) })
      .then(response => response.status, () => 'reset');
    assert.ok([413, 'reset'].includes(action), 'the action endpoint keeps its 256 KiB limit');
    assert.equal(received.length, 1);
  } finally { await f.cleanup(); }
});

test('the engine starts without a preview gate, holds its lock, and releases it on a clean shutdown', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'penguin-main-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
    env: { ...process.env, CP_ENGINE_STATE_DIR: path.join(dir, 'state'), CP_ENGINE_WORKTREE_ROOT: path.join(dir, 'worktrees'), CP_ENGINE_PORT: String(port),
      CP_NATIVE_IGLOOS_DIR: path.join(dir, 'native-igloos'), CP_ENGINE_GAME_PROVISIONING: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let output = '';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Engine did not start: ${output}`)), 10000);
      const read = chunk => { output += chunk; if (output.includes(`http://localhost:${port}/`)) { clearTimeout(timer); resolve(); } };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      child.on('exit', () => { clearTimeout(timer); reject(new Error(`Engine exited: ${output}`)); });
    });
    assert.ok(existsSync(path.join(dir, 'state', 'runtime.lock')));
    assert.ok(existsSync(path.join(dir, 'native-igloos', 'owner.lock')), 'the engine owns native igloo publication');
    const exit = once(child, 'exit');
    child.kill('SIGINT');
    assert.deepEqual(await exit, [0, null]);
    assert.equal(existsSync(path.join(dir, 'state', 'runtime.lock')), false);
    assert.equal(existsSync(path.join(dir, 'native-igloos', 'owner.lock')), false, 'a clean shutdown releases publication');
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'native-igloos', 'published.json'), 'utf8')), { version: 1, visitorId: null, igloos: [] });
  } finally { child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); }
});

test('game container bind mounts exclude the checkout, private engine state and environment file', async () => {
  const config = await readFile(new URL('../compose.yml', import.meta.url), 'utf8');
  const sources = [...config.matchAll(/^\s+- (\.\.?\/[^:\n]*|\.\.?):[^\n]+$/gm)].map(match => path.resolve('/repo/local', match[1]));
  assert.ok(sources.includes('/repo/.local/bridge-public'));
  assert.ok(sources.includes('/repo/local'));
  for (const name of ['.local/agent-engine/state.json','.local/agent-engine-demo/game-secrets.json','.local/env']) {
    const file = path.resolve('/repo', name);
    assert.ok(sources.every(source => file !== source && !file.startsWith(source + '/')), name);
  }
});

test('normal startup refuses a legacy state with migration guidance and preserves its bytes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'penguin-legacy-start-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const state = path.join(root, 'state');
  await mkdir(state);
  const bytes = '{"version":1,"revision":79,"projects":[],"workers":[]}';
  await writeFile(path.join(state, 'state.json'), bytes);
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
    env:{...process.env, CP_ENGINE_STATE_DIR:state, CP_NATIVE_IGLOOS_DIR:path.join(root,'publication'), CP_ENGINE_GAME_PROVISIONING:'off'},
    stdio:['ignore','ignore','pipe'],
  });
  let message = '';
  child.stderr.on('data', chunk => { message += chunk; });
  assert.deepEqual(await once(child,'close'), [1,null]);
  assert.match(message, /migrate.mjs/);
  assert.equal(await readFile(path.join(state,'state.json'),'utf8'), bytes);
  assert.equal(existsSync(path.join(state,'runtime.lock')),false);
});
