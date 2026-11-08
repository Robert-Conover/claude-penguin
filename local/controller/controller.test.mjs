import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { alive, allGone, buildShim, cleanupRoots, killAll, makeEnvironment, portMap, readPid, sleep, startController, trackedPids, waitFor } from './fixtures.mjs';

let shim;
const envs = [];
before(() => { shim = buildShim(); });
after(() => { for (const e of envs) killAll(e); killAll(); cleanupRoots(); });

async function setupEnv(options) {
  const env = makeEnvironment({ shim, ...options });
  envs.push(env);
  return { env, ports: await portMap() };
}
const orderLog = env => readFileSync(path.join(env.track, 'order.log'), 'utf8').trim().split('\n').map(l => { const [t, kind, name, extra] = l.split(' '); return { t: Number(t), kind, name, extra }; });
const SERVICES = ['postgres', 'valkey', 'login', 'world', 'dash', 'snowflake', 'web'];

describe('controller lifecycle', () => {
  test('setup, start in dependency order, status, stop in reverse order', async () => {
    const { env, ports } = await setupEnv();
    const c = startController(env, { ports });
    let status = await c.ok('status');
    assert.equal(status.state, 'needs-setup');
    assert.equal(status.setupComplete, false);
    const setup = await c.ok('setup', { mode: 'explore' });
    assert.deepEqual(setup.ran, ['database', 'media', 'extensions'].filter(x => setup.ran.includes(x)));
    assert.ok(c.eventsOf('progress').some(e => e.task === 'database'));
    assert.ok(c.eventsOf('progress').some(e => e.task === 'extensions'));
    assert.equal(JSON.parse(readFileSync(path.join(env.data, 'setup.json'), 'utf8')).mode, 'explore');
    status = await c.ok('status');
    assert.equal(status.state, 'stopped');
    assert.equal(status.setupComplete, true);

    const started = await c.ok('start');
    assert.equal(started.state, 'running');
    assert.equal(started.urls.game, `http://localhost:${ports.web}/#/login`);
    assert.equal(started.urls.agents, undefined, 'no agents URL in explore mode');
    const log = orderLog(env).filter(e => e.kind === 'start');
    const at = n => log.find(e => e.name === n).t;
    for (const [dep, svc] of [['postgres', 'login'], ['valkey', 'world'], ['login', 'dash'], ['world', 'snowflake'], ['dash', 'web'], ['snowflake', 'web']]) {
      assert.ok(at(dep) <= at(svc), `${dep} starts before ${svc}`);
    }
    assert.ok(existsSync(path.join(env.track, 'postgres.ready')), 'ready hook ran');
    for (const name of SERVICES) assert.ok(c.eventsOf('service', e => e.name === name && e.state === 'healthy').length === 1, `${name} healthy`);
    assert.equal(existsSync(path.join(env.track, 'engine.pid')), false, 'no engine in explore mode');

    status = await c.ok('status');
    assert.equal(status.state, 'running');
    assert.equal(status.services.find(s => s.name === 'web').state, 'healthy');
    assert.ok(readFileSync(path.join(env.data, 'logs', 'web', 'web.log'), 'utf8') !== undefined);
    const controllerJson = JSON.parse(readFileSync(path.join(env.data, 'controller.json'), 'utf8'));
    assert.equal(controllerJson.pid, c.child.pid);

    // Postgres stops with SIGINT, the rest with SIGTERM.
    const pids = trackedPids(env.track);
    await c.ok('stop');
    assert.ok(allGone(pids));
    const stopLog = orderLog(env).filter(e => e.kind === 'stop');
    const stopAt = n => stopLog.find(e => e.name === n).t;
    for (const [later, earlier] of [['web', 'dash'], ['web', 'snowflake'], ['dash', 'login'], ['snowflake', 'world'], ['login', 'postgres'], ['world', 'valkey']]) {
      assert.ok(stopAt(later) <= stopAt(earlier), `${later} stops before ${earlier}`);
    }
    assert.ok(orderLog(env).some(e => e.kind === 'signal' && e.name === 'postgres' && e.extra === 'SIGINT'));
    assert.deepEqual(readdirSync(path.join(env.data, 'owners')).filter(f => f.endsWith('.json')), [], 'records removed after a clean stop');
    assert.equal((await c.ok('status')).state, 'stopped');
    await c.close();
    assert.equal(existsSync(path.join(env.data, 'controller.json')), false);
  });

  test('stdin EOF stops everything gracefully and exits', async () => {
    const { env, ports } = await setupEnv();
    const c = startController(env, { ports });
    await c.ok('setup', { mode: 'explore' });
    await c.ok('start');
    const pids = trackedPids(env.track);
    assert.ok(pids.length >= 7);
    const exit = await c.close();
    assert.equal(exit.code, 0);
    assert.ok(allGone(pids));
    const names = orderLog(env).filter(e => e.kind === 'stop').map(e => e.name);
    assert.deepEqual(new Set(names), new Set(SERVICES), 'every service handled its stop signal (graceful, not killed)');
    assert.equal(c.eventsOf('state').at(-1).state, 'stopped');
  });

  test('a second controller on the same data gets LOCKED and leaves the first alone', async () => {
    const { env, ports } = await setupEnv();
    const a = startController(env, { ports });
    await a.ok('setup', { mode: 'explore' });
    await a.ok('start');
    const b = startController(env, { ports });
    const response = await b.send('status');
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'LOCKED');
    assert.equal((await b.exited).code, 75);
    assert.equal(JSON.parse(readFileSync(path.join(env.data, 'controller.json'), 'utf8')).pid, a.child.pid, 'controller.json still names the first');
    assert.equal((await a.ok('status')).state, 'running');
    await a.close();
  });

  test('port conflict is reported and the other program is untouched', async () => {
    const { env, ports } = await setupEnv();
    const other = net.createServer(socket => socket.end('hello'));
    await new Promise(resolve => other.listen(ports.login, '127.0.0.1', resolve));
    const connections = [];
    other.on('connection', s => connections.push(s));
    const c = startController(env, { ports });
    try {
      await c.ok('setup', { mode: 'explore' });
      const pre = await c.ok('preflight', { mode: 'explore' });
      assert.deepEqual(pre.portConflicts.map(x => [x.port, x.service]), [[ports.login, 'login']]);
      assert.ok(pre.problems.some(p => p.code === 'PORT_IN_USE'));
      assert.equal(typeof pre.freeBytes, 'number');
      const started = await c.send('start');
      assert.equal(started.ok, false);
      assert.equal(started.error.code, 'PORT_IN_USE');
      assert.equal(trackedPids(env.track).length, 0, 'nothing was started');
      assert.equal((await c.ok('status')).state, 'error');
      // The foreign listener is still ours to use: it accepts and answers.
      const reply = await new Promise((resolve, reject) => { const s = net.connect(ports.login, '127.0.0.1'); let d = ''; s.on('data', x => { d += x; }); s.on('end', () => resolve(d)); s.on('error', reject); });
      assert.equal(reply, 'hello');
      assert.ok(other.listening);
    } finally {
      other.close();
      for (const s of connections) s.destroy();
      await c.close();
    }
  });

  test('a service that never becomes healthy fails the start; earlier services are stopped and dependents never start', async () => {
    const { env, ports } = await setupEnv();
    const c = startController(env, { ports, extraEnv: { FAKE_NEVER_HEALTHY: 'login', CP_HEALTH_TIMEOUT_MS: '1500' } });
    await c.ok('setup', { mode: 'explore' });
    // login is a tcp check, so make it fail by never listening: use never-healthy only affects http; switch to web.
    await c.close();
    const d = await setupEnv();
    const c2 = startController(d.env, { ports: d.ports, extraEnv: { FAKE_NEVER_HEALTHY: 'web', CP_HEALTH_TIMEOUT_MS: '1500' } });
    await c2.ok('setup', { mode: 'explore' });
    const started = Date.now();
    const response = await c2.send('start');
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'SERVICE_FAILED');
    assert.match(response.error.message, /web/);
    assert.ok(Date.now() - started < 8000);
    const problem = c2.eventsOf('problem', e => e.code === 'SERVICE_FAILED')[0];
    assert.equal(problem.detail.reason, 'health-timeout');
    assert.ok(allGone(trackedPids(d.env.track)), 'everything that had started was stopped');
    assert.equal((await c2.ok('status')).state, 'error');
    await c2.close();
  });

  test('a service that exits during startup fails fast', async () => {
    const { env, ports } = await setupEnv();
    const c = startController(env, { ports, extraEnv: { FAKE_EXIT_IMMEDIATELY: 'login' } });
    await c.ok('setup', { mode: 'explore' });
    const t = Date.now();
    const r = await c.send('start');
    assert.equal(r.error.code, 'SERVICE_FAILED');
    assert.ok(Date.now() - t < 5000);
    assert.equal(orderLog(env).some(e => e.kind === 'start' && e.name === 'dash'), false, 'dash never started');
    await c.close();
  });

  test('a service that dies while running: exited event, SERVICE_FAILED, error state, no restart', async () => {
    const { env, ports } = await setupEnv();
    const c = startController(env, { ports, extraEnv: { FAKE_EXIT_AFTER: 'valkey' } });
    await c.ok('setup', { mode: 'explore' });
    await c.ok('start');
    await waitFor(() => c.eventsOf('service', e => e.name === 'valkey' && e.state === 'exited').length, { what: 'valkey exited event' });
    const exited = c.eventsOf('service', e => e.name === 'valkey' && e.state === 'exited')[0];
    assert.equal(exited.code, 3);
    // Emitted in the same tick as the exited event, but stdout to a pipe is asynchronous on macOS,
    // so the line can arrive in a later chunk.
    const failed = () => c.eventsOf('problem', e => e.code === 'SERVICE_FAILED' && e.detail.name === 'valkey');
    await waitFor(() => failed().length, { what: 'SERVICE_FAILED problem for valkey' });
    await sleep(200);
    assert.equal(failed().length, 1, 'reported once');
    assert.equal((await c.ok('status')).state, 'error');
    await sleep(700);
    assert.equal(orderLog(env).filter(e => e.kind === 'start' && e.name === 'valkey').length, 1, 'not restarted');
    // A new start from the error state cleans up first.
    await c.ok('stop');
    assert.ok(allGone(trackedPids(env.track)));
    await c.close();
  });

  test('protocol errors', async () => {
    const { env, ports } = await setupEnv();
    const c = startController(env, { ports });
    const replies = [];
    const waitReply = () => new Promise(resolve => { const t = setInterval(() => { if (replies.length) { clearInterval(t); resolve(replies.shift()); } }, 10); });
    c.child.stdout.on('data', d => { for (const l of String(d).split('\n').filter(Boolean)) { const m = JSON.parse(l); if (!m.event && m.id === null) replies.push(m); } });
    c.sendRaw('not json\n');
    assert.equal((await waitReply()).error.code, 'BAD_REQUEST');
    c.sendRaw('[1,2]\n');
    assert.equal((await waitReply()).error.code, 'BAD_REQUEST');
    c.sendRaw('{"id":{},"cmd":"status"}\n');
    assert.equal((await waitReply()).error.code, 'BAD_REQUEST');
    const unknown = await c.send('frobnicate');
    assert.deepEqual([unknown.ok, unknown.error.code], [false, 'UNKNOWN_COMMAND']);
    assert.equal((await c.send('__proto__')).error.code, 'UNKNOWN_COMMAND');
    assert.equal((await c.send('setup', { mode: 'turbo' })).error.code, 'INVALID_MODE');
    assert.equal((await c.send('setup')).error.code, 'INVALID_MODE');
    assert.equal((await c.send('preflight', { mode: 5 })).error.code, 'INVALID_MODE');
    assert.equal((await c.send('recover', { action: 'explode' })).error.code, 'BAD_REQUEST');
    assert.equal((await c.send('recover', { action: 'ignore' })).error.code, 'NOT_IN_RECOVERY');
    const early = await c.send('start');
    assert.equal(early.error.code, 'NEEDS_SETUP');
    assert.deepEqual((await c.send('cancel')).result, { cancelled: false });
    // ids of any scalar type are echoed
    const strId = await new Promise(resolve => { c.child.stdout.once('data', d => resolve(JSON.parse(String(d).split('\n')[0]))); c.sendRaw('{"id":"abc","cmd":"status"}\n'); });
    assert.equal(strId.id, 'abc');
    assert.equal((await c.ok('status')).state, 'needs-setup');
    await c.close();
  });
});

describe('setup', () => {
  test('is resumable and explore -> code runs only the missing steps; cancel keeps finished work', async () => {
    const { env, ports } = await setupEnv();
    const c = startController(env, { ports, extraEnv: { FAKE_SLOW_PREPARE: '5000' } });
    const slow = c.send('setup', { mode: 'explore' });
    await waitFor(() => c.eventsOf('progress', e => e.task === 'database' && e.label === 'initdb').length, { what: 'database step running' });
    assert.equal((await c.send('start')).error.code, 'BUSY');
    assert.equal((await c.send('setup', { mode: 'explore' })).error.code, 'BUSY');
    assert.deepEqual((await c.ok('cancel')).cancelled, true);
    const cancelled = await slow;
    assert.equal(cancelled.error.code, 'CANCELLED');
    assert.equal((await c.ok('status')).state, 'needs-setup');
    await c.close();

    const again = startController(env, { ports });
    const explore = await again.ok('setup', { mode: 'explore' });
    assert.ok(explore.skipped.includes('runtimes'));
    assert.ok(explore.ran.includes('database') && explore.ran.includes('media') && explore.ran.includes('extensions'));
    assert.equal((await again.ok('status')).mode, 'explore');
    const noop = await again.ok('setup', { mode: 'explore' });
    assert.deepEqual(noop.ran, [], 'nothing left to do');

    writeFileSync(path.join(env.track, 'fail-claude'), '');
    const failed = await again.send('setup', { mode: 'code' });
    assert.equal(failed.ok, false);
    assert.equal((await again.ok('status')).mode, 'explore', 'a failed code setup does not claim code mode');
    assert.equal((await again.send('start', { mode: 'code' })).error.code, 'NEEDS_SETUP');
    rm(path.join(env.track, 'fail-claude'));
    const code = await again.ok('setup', { mode: 'code' });
    assert.deepEqual(code.ran, ['claude'], 'only Claude was missing');
    assert.deepEqual(code.skipped.sort(), ['database', 'extensions', 'media', 'runtimes']);
    assert.equal((await again.ok('status')).mode, 'code');
    await again.close();
  });

  test('preflight reports sizes, free space and unknowns as null', async () => {
    const { env, ports } = await setupEnv();
    const c = startController(env, { ports });
    const pre = await c.ok('preflight', { mode: 'code' });
    assert.equal(pre.downloadBytes, null, 'Claude size is not known in the fake release');
    assert.equal(pre.requiredBytes, null);
    assert.ok(pre.freeBytes > 0);
    assert.deepEqual(pre.portConflicts, []);
    await c.close();
  });

  test('app layout without a media source reports DOWNLOAD; CP_MEDIA_DIR is used in place', async () => {
    const { env, ports } = await setupEnv();
    const c = startController(env, { ports, layout: 'app' });
    const pre = await c.ok('preflight', { mode: 'explore' });
    assert.ok(pre.problems.some(p => p.code === 'DOWNLOAD' && /media source/.test(p.message)));
    const failed = await c.send('setup', { mode: 'explore' });
    assert.equal(failed.error.code, 'DOWNLOAD');
    await c.close();

    const media = path.join(env.root, 'external-media');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.join(media, 'play'), { recursive: true }); mkdirSync(path.join(media, 'media'));
    const d = startController(env, { ports, layout: 'app', extraEnv: { CP_MEDIA_DIR: media } });
    const ok = await d.ok('setup', { mode: 'explore' });
    assert.ok(ok.ran.includes('media'));
    assert.equal(JSON.parse(readFileSync(path.join(env.data, 'setup.json'), 'utf8')).steps.media.root, media);
    await d.close();
  });

  test('launch mode falls back to an existing .local/client-bridge build when patches are not available', async () => {
    const { env, ports } = await setupEnv();
    const { rmSync, mkdirSync } = await import('node:fs');
    rmSync(path.join(env.resources, '.local', 'client-bridge-patches'), { recursive: true });
    mkdirSync(path.join(env.resources, '.local', 'client-bridge'), { recursive: true });
    writeFileSync(path.join(env.resources, '.local', 'client-bridge', 'engine.swf'), 'swf');
    const c = startController(env, { ports });
    await c.ok('setup', { mode: 'explore' });
    const label = c.eventsOf('progress', e => e.task === 'extensions').map(e => e.label).join('|');
    assert.match(label, /using the existing build in \.local\/client-bridge/);
    assert.equal(JSON.parse(readFileSync(path.join(env.data, 'setup.json'), 'utf8')).steps.extensions.fallback, true);
    await c.close();
  });
});

describe('code mode and the engine service', () => {
  test('engine gets exactly the documented environment; no controller secrets leak; status merges engine fields', async () => {
    const { env, ports } = await setupEnv();
    const c = startController(env, { ports, extraEnv: { CONTROLLER_SECRET: 'sekrit', ANTHROPIC_API_KEY: 'nope', HOME: '/Users/someone', FAKE_GIT: '/opt/homebrew/bin/git' } });
    await c.ok('setup', { mode: 'code' });
    const started = await c.ok('start');
    assert.equal(started.urls.agents, `http://localhost:${ports.engine}/?bridge=1&agents=1#/login`);
    const engineEnv = JSON.parse(readFileSync(path.join(env.track, 'engine.env.json'), 'utf8'));
    const claudePath = path.join(env.data, 'claude', 'versions', '1.0.0', 'claude');
    assert.equal(engineEnv.CP_ENGINE_PORT, String(ports.engine));
    assert.equal(engineEnv.CP_ENGINE_STATE_DIR, path.join(env.data, 'engine'));
    assert.equal(engineEnv.CP_ENGINE_WORKTREE_ROOT, path.join(env.data, 'worktrees'));
    assert.equal(engineEnv.CP_CLAUDE_PATH, claudePath);
    assert.equal(engineEnv.CP_CLAUDE_CONFIG_DIR, path.join(env.data, 'claude', 'config'));
    assert.equal(engineEnv.CP_CLAUDE_DISABLE_UPDATES, '1');
    assert.equal(engineEnv.CP_LOGIN_SHELL_ENV, '1');
    assert.equal(engineEnv.CP_BUNDLED_GIT_DIR, path.join(env.runtimes, 'git-only'));
    assert.equal(engineEnv.CP_ENGINE_GIT, '/opt/homebrew/bin/git');
    assert.equal(engineEnv.CP_ENGINE_PTY_GUARD, path.join(env.runtimes, 'supervise', 'cp-supervise'), 'Claude terminals start through cp-supervise guard');
    assert.equal(readFileSync(path.join(env.track, 'provision-env.written'), 'utf8'), env.runtimes, 'the provisioning settings are rewritten for this start');
    assert.match(engineEnv.CP_ENGINE_CONTROL_TOKEN, /^[A-Za-z0-9_-]{20,}$/);
    assert.equal(engineEnv.FAKE_ENGINE_ENV, '1', 'engineEnvironment(config) is included');
    assert.equal(engineEnv.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
    assert.equal(engineEnv.HOME, '/Users/someone');
    const allowed = new Set(['__CF_USER_TEXT_ENCODING' /* added by macOS at exec */, 'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'FAKE_ENGINE_ENV', 'FAKE_TRACK_DIR', 'CP_WEB_ORIGIN']);
    for (const key of Object.keys(engineEnv)) assert.ok(allowed.has(key) || key.startsWith('CP_'), `unexpected engine env key ${key}`);
    assert.equal(engineEnv.CONTROLLER_SECRET, undefined);
    assert.equal(engineEnv.ANTHROPIC_API_KEY, undefined);
    for (const name of SERVICES) {
      const e = JSON.parse(readFileSync(path.join(env.track, `${name}.env.json`), 'utf8'));
      assert.equal(e.CP_ENGINE_CONTROL_TOKEN, undefined, `${name} has no engine token`);
      assert.equal(e.CONTROLLER_SECRET, undefined);
      assert.deepEqual(Object.keys(e).filter(k => k !== '__CF_USER_TEXT_ENCODING').sort(), ['FAKE_SERVICE_NAME', 'FAKE_TRACK_DIR'], `${name} gets only its own explicit environment`);
    }
    const status = await c.ok('status');
    assert.deepEqual(status.sessions, { running: 2, total: 3 });
    assert.equal(status.signIn.method, 'login');
    assert.equal(status.claude.version, '1.0.0');
    assert.equal(status.git.source, 'user');
    assert.equal(JSON.stringify(status).includes(engineEnv.CP_ENGINE_CONTROL_TOKEN), false, 'the token never appears in status');
    const orderStart = orderLog(env).filter(e => e.kind === 'start').map(e => e.name);
    assert.equal(orderStart.at(-1), 'engine', 'engine starts last');
    await c.close();
    assert.ok(allGone(trackedPids(env.track)));
  });

  test('a failed Claude verification stops the start before anything runs', async () => {
    const { env, ports } = await setupEnv();
    const c = startController(env, { ports });
    await c.ok('setup', { mode: 'code' });
    writeFileSync(path.join(env.track, 'fail-verify'), '');
    const r = await c.send('start');
    assert.equal(r.error.code, 'VERIFY');
    assert.equal(trackedPids(env.track).length, 0);
    await c.close();
  });
});

describe('supervision across crashes', () => {
  test('SIGKILL of the controller: every shim stops its service and the services\' descendants within the grace period', async () => {
    const { env, ports } = await setupEnv();
    const c = startController(env, { ports, extraEnv: { FAKE_DESCENDANT: '1', FAKE_IGNORE_TERM: '1', FAKE_GRACE_MS: '600' } });
    await c.ok('setup', { mode: 'explore' });
    await c.ok('start');
    const pids = trackedPids(env.track);
    assert.equal(pids.length, 14, '7 services + 7 descendants');
    assert.ok(pids.every(alive));
    const shims = readdirSync(path.join(env.data, 'owners')).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(path.join(env.data, 'owners', f), 'utf8')).shimPid);
    assert.equal(shims.length, 7);
    const t = Date.now();
    process.kill(c.child.pid, 'SIGKILL');
    await c.exited;
    await waitFor(() => allGone([...pids, ...shims]), { timeout: 6000, what: 'services, descendants and shims gone' });
    assert.ok(Date.now() - t < 6000);
    // The lock died with the controller: a new controller can start straight away.
    const next = startController(env, { ports });
    const status = await next.ok('status');
    assert.equal(status.state, 'stopped');
    await next.close();
  });

  test('SIGKILL of a shim: the next controller finds the survivor by its record and stops it', async () => {
    const { env, ports } = await setupEnv();
    const c = startController(env, { ports, extraEnv: { FAKE_DESCENDANT: '1', FAKE_GRACE_MS: '600' } });
    await c.ok('setup', { mode: 'explore' });
    await c.ok('start');
    const record = JSON.parse(readFileSync(path.join(env.data, 'owners', 'valkey.json'), 'utf8'));
    assert.ok(record.pid > 1 && record.pgid === record.pid && record.startTime && record.executable && record.controllerPid === c.child.pid);
    const kid = readPid(path.join(env.track, 'valkey.child.pid'));
    process.kill(record.shimPid, 'SIGKILL');
    await waitFor(() => c.eventsOf('service', e => e.name === 'valkey' && e.state === 'exited').length, { what: 'exit noticed' });
    assert.ok(alive(record.pid) && alive(kid), 'the program outlived its shim');
    assert.ok(existsSync(path.join(env.data, 'owners', 'valkey.json')), 'record kept for recovery');
    process.kill(c.child.pid, 'SIGKILL');
    await c.exited;
    await waitFor(() => allGone(trackedPids(env.track).filter(p => p !== record.pid && p !== kid)), { what: 'other services stopped by their shims' });
    assert.ok(alive(record.pid), 'still alive: nobody owns it any more');

    const next = startController(env, { ports });
    const status = await next.ok('status');
    assert.ok(next.eventsOf('problem', e => e.code === 'SURVIVOR' && e.detail.name === 'valkey' && e.detail.outcome === 'stopping').length === 1);
    await waitFor(() => allGone([record.pid, kid]), { timeout: 5000, what: 'survivor and its descendant stopped' });
    assert.notEqual(status.state, 'recovery');
    assert.deepEqual(readdirSync(path.join(env.data, 'owners')).filter(f => f.endsWith('.json')), []);
    await next.close();
  });

  test('PID reuse: a live process with a different start time or executable is left alone and its record dropped', async () => {
    const { env, ports } = await setupEnv();
    const innocent = spawn('/bin/sleep', ['300'], { stdio: 'ignore' });
    try {
      const { processIdentity } = await import('./procinfo.mjs');
      const identity = await processIdentity(innocent.pid);
      const { mkdirSync } = await import('node:fs');
      mkdirSync(path.join(env.data, 'owners'), { recursive: true });
      // Same PID, but the record describes a process that started long ago and ran a different program.
      writeFileSync(path.join(env.data, 'owners', 'valkey.json'), JSON.stringify({ name: 'valkey', pid: innocent.pid, pgid: innocent.pid, startTime: 'Mon Jan  1 00:00:00 2024', executable: identity.executable, argv: [], controllerPid: 1, createdAt: 'x', stopSignal: 'SIGTERM', graceMs: 100 }));
      writeFileSync(path.join(env.data, 'owners', 'web.json'), JSON.stringify({ name: 'web', pid: innocent.pid, pgid: innocent.pid, startTime: identity.startTime, executable: '/usr/local/bin/web-server', argv: [], controllerPid: 1, createdAt: 'x', stopSignal: 'SIGTERM', graceMs: 100 }));
      const c = startController(env, { ports });
      const status = await c.ok('status');
      assert.notEqual(status.state, 'recovery');
      assert.ok(alive(innocent.pid), 'the unrelated process is untouched');
      assert.equal(innocent.signalCode, null);
      const notOurs = c.eventsOf('problem', e => e.code === 'SURVIVOR' && e.detail.outcome === 'not-ours');
      assert.equal(notOurs.length, 2);
      assert.deepEqual(readdirSync(path.join(env.data, 'owners')).filter(f => f.endsWith('.json')), []);
      await c.close();
    } finally { innocent.kill('SIGKILL'); }
  });

  test('ambiguous records enter recovery; recover(stop-survivors) and recover(ignore) resolve it', async () => {
    const { env, ports } = await setupEnv();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.join(env.data, 'owners'), { recursive: true });
    // An unreadable record is ambiguous.
    writeFileSync(path.join(env.data, 'owners', 'dash.json'), '{not json');
    // A dead group leader whose process group still has a member: leader gone, group alive.
    const group = spawn('/bin/sh', ['-c', 'sleep 300 & echo $! > ' + path.join(env.track, 'member.pid') + '; exit 0'], { detached: true, stdio: 'ignore' });
    await new Promise(resolve => group.once('exit', resolve));
    const member = await waitFor(() => readPid(path.join(env.track, 'member.pid')), { what: 'group member' });
    writeFileSync(path.join(env.data, 'owners', 'snowflake.json'), JSON.stringify({ name: 'snowflake', pid: group.pid, pgid: group.pid, startTime: 'x', executable: '/bin/sh', argv: [], controllerPid: 1, createdAt: 'x', stopSignal: 'SIGTERM', graceMs: 300 }));
    const c = startController(env, { ports });
    let status = await c.ok('status');
    assert.equal(status.state, 'recovery');
    assert.deepEqual(status.recovery.ambiguous.map(r => r.name).sort(), ['dash', 'snowflake']);
    assert.ok(alive(member), 'nothing was killed without confirmation');
    assert.equal((await c.send('start')).error.code, 'RECOVERY_REQUIRED');
    assert.equal((await c.send('setup', { mode: 'explore' })).error.code, 'RECOVERY_REQUIRED');
    const pre = await c.ok('preflight', { mode: 'explore' });
    assert.ok(Array.isArray(pre.portConflicts));
    const result = await c.ok('recover', { action: 'stop-survivors' });
    assert.deepEqual(result.stopped, ['snowflake']);
    await waitFor(() => !alive(member), { what: 'group member stopped after confirmation' });
    status = await c.ok('status');
    assert.notEqual(status.state, 'recovery');
    await c.close();

    // ignore: records dropped, process left running
    const other = spawn('/bin/sh', ['-c', 'sleep 300'], { detached: true, stdio: 'ignore' });
    try {
      writeFileSync(path.join(env.data, 'owners', 'dash.json'), '{broken');
      const d = startController(env, { ports });
      assert.equal((await d.ok('status')).state, 'recovery');
      await d.ok('recover', { action: 'ignore' });
      assert.ok(alive(other.pid));
      assert.deepEqual(readdirSync(path.join(env.data, 'owners')).filter(f => f.endsWith('.json')), []);
      await d.close();
    } finally { try { process.kill(-other.pid, 'SIGKILL'); } catch { /* gone */ } }
  });
});
const rm = file => { try { require_rm(file); } catch { /* gone */ } };
import { rmSync as require_rm } from 'node:fs';
