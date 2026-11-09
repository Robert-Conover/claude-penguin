// Shared helpers for the controller tests: scratch environments, a built shim, controller subprocesses.
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const spawned = new Set();
const roots = [];

export function buildShim() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cps-shim-'));
  roots.push(dir);
  const out = path.join(dir, 'cp-supervise');
  execFileSync('/bin/sh', [path.join(here, 'build-supervise.sh')], { env: { PATH: '/usr/bin:/bin', CP_SUPERVISE_OUT: out }, stdio: 'pipe' });
  return out;
}

export async function freePorts(n) {
  const servers = await Promise.all(Array.from({ length: n }, () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => resolve(s)); })));
  const ports = servers.map(s => s.address().port);
  await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
  return ports;
}

export async function portMap() {
  const names = ['web', 'engine', 'login', 'world', 'snow', 'dash', 'postgres', 'valkey'];
  const ports = await freePorts(names.length);
  return Object.fromEntries(names.map((n, i) => [n, ports[i]]));
}

/** A scratch resources/runtimes/data trio shaped like a checkout with built runtimes. */
export function makeEnvironment({ shim, release = { media: null, claude: { version: '1.0.0' }, patchset: 'ps1' } } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cps-env-'));
  roots.push(root);
  const resources = path.join(root, 'res'), runtimes = path.join(root, 'rt'), data = path.join(root, 'data dir');
  mkdirSync(path.join(resources, 'local', 'controller'), { recursive: true });
  writeFileSync(path.join(resources, 'local', 'controller', 'release.json'), JSON.stringify(release));
  mkdirSync(path.join(resources, 'vanilla-media', 'play'), { recursive: true });
  mkdirSync(path.join(resources, 'vanilla-media', 'media'), { recursive: true });
  mkdirSync(path.join(resources, '.local', 'client-bridge-patches'), { recursive: true }); // launch layout
  mkdirSync(path.join(resources, 'local', 'client-bridge', 'patches'), { recursive: true }); // app layout
  mkdirSync(path.join(resources, 'local', 'engine'), { recursive: true });
  writeFileSync(path.join(resources, 'local', 'engine', 'server.mjs'), `import ${JSON.stringify(path.join(here, 'fake-service.mjs'))};\n`);
  mkdirSync(path.join(runtimes, 'supervise'), { recursive: true });
  mkdirSync(path.join(runtimes, 'node', 'bin'), { recursive: true });
  writeFileSync(path.join(runtimes, 'manifest.json'), '{}');
  if (shim) { copyFileSync(shim, path.join(runtimes, 'supervise', 'cp-supervise')); chmodSync(path.join(runtimes, 'supervise', 'cp-supervise'), 0o755); }
  symlinkSync(process.execPath, path.join(runtimes, 'node', 'bin', 'node'));
  mkdirSync(data, { recursive: true });
  const track = path.join(root, 'track');
  mkdirSync(track);
  return { root, resources, runtimes, data, track };
}

export function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
export function readPid(file) { try { return Number(readFileSync(file, 'utf8')); } catch { return null; } }
export function trackedPids(track) {
  if (!existsSync(track)) return [];
  return readdirSync(track).filter(f => f.endsWith('.pid')).map(f => readPid(path.join(track, f))).filter(Boolean);
}
export async function waitFor(fn, { timeout = 10000, interval = 40, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(interval);
  }
}
export const allGone = pids => pids.every(p => !alive(p));

/** Spawns main.mjs with the fake dependency module and speaks the JSON-lines protocol. */
export function startController(env, { ports, extraEnv = {}, layout = 'launch', args = [] } = {}) {
  const child = spawn(process.execPath, [path.join(here, 'main.mjs'), '--resources', env.resources, '--runtimes', env.runtimes, '--data', env.data, '--layout', layout,
    '--ports', JSON.stringify(ports), '--deps-module', path.join(here, 'fake-deps.mjs'), ...args],
  { env: { PATH: '/usr/bin:/bin', HOME: os.tmpdir(), FAKE_TRACK_DIR: env.track, CP_HEALTH_TIMEOUT_MS: '8000', ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  spawned.add(child);
  const events = [];
  const waiters = new Map();
  let nextId = 1, buffer = '', stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.event) events.push(msg);
      else waiters.get(msg.id)?.(msg);
    }
  });
  child.stderr.on('data', c => { stderr += c; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    for (const [id, waiter] of waiters) waiter({ id, ok: false, error: { code: 'CONTROLLER_EXITED', message: `controller exited (${code ?? signal}): ${stderr.slice(-600)}` } });
    resolve({ code, signal });
  }));
  const api = {
    child, events, exited, get stderr() { return stderr; },
    send(cmd, extra = {}) {
      const id = nextId++;
      return new Promise(resolve => { waiters.set(id, resolve); child.stdin.write(`${JSON.stringify({ id, cmd, ...extra })}\n`); });
    },
    sendRaw(text) { child.stdin.write(text); },
    async ok(cmd, extra) { const r = await api.send(cmd, extra); if (!r.ok) throw new Error(`${cmd} failed: ${JSON.stringify(r.error)}`); return r.result; },
    eventsOf(kind, pred = () => true) { return events.filter(e => e.event === kind && pred(e)); },
    close() { child.stdin.end(); return exited; },
  };
  return api;
}

export function killAll(env) {
  for (const child of spawned) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }
  spawned.clear();
  if (env?.track) for (const pid of trackedPids(env.track)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  if (env?.data) {
    const owners = path.join(env.data, 'owners');
    if (existsSync(owners)) for (const f of readdirSync(owners).filter(f => f.endsWith('.json'))) {
      try {
        const rec = JSON.parse(readFileSync(path.join(owners, f), 'utf8'));
        if (rec.pgid > 1) process.kill(-rec.pgid, 'SIGKILL');
        if (rec.shimPid > 1) process.kill(rec.shimPid, 'SIGKILL');
      } catch { /* gone */ }
    }
  }
}
export function cleanupRoots() { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); }
