import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findUserGit, baseEnvironment } from './engine-service.mjs';
import { rotateIfNeeded } from './logs.mjs';
import { estimateSteps, makeContext } from './setup.mjs';
import { Orchestrator, validateServices } from './orchestrator.mjs';
import { freeBytes } from './preflight.mjs';

const fakeGit = dir => { mkdirSync(dir, { recursive: true }); const f = path.join(dir, 'git'); writeFileSync(f, '#!/bin/sh\n'); chmodSync(f, 0o755); return f; };

test('findUserGit prefers a real git on PATH and skips the /usr/bin stub when no developer directory has one', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cps-git-'));
  const brew = fakeGit(path.join(root, 'brew'));
  const versionOf = () => 'git version 2.50.1';
  assert.equal(findUserGit({ env: { PATH: `/usr/bin:${path.join(root, 'brew')}` }, developerDir: () => null, exists: () => false, versionOf }), brew);
  // Nothing but /usr/bin (which exists on every Mac as a stub): never chosen without developer tools.
  assert.equal(findUserGit({ env: { PATH: '/usr/bin:/bin' }, developerDir: () => null, exists: () => false, versionOf }) === '/usr/bin/git', false);
  // The bundled git is never reported as the user's.
  const bundled = fakeGit(path.join(root, 'bundled'));
  assert.equal(findUserGit({ env: { PATH: path.join(root, 'bundled') }, bundledGit: bundled, developerDir: () => null, exists: () => false, versionOf }) === bundled, false);
});

test('findUserGit skips a git older than the engine requires (2.48), so the bundled git is used instead', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cps-git-'));
  const old = fakeGit(path.join(root, 'old'));
  const current = fakeGit(path.join(root, 'current'));
  const versions = { [old]: 'git version 2.39.5 (Apple Git-154)', [current]: 'git version 2.48.0' };
  const versionOf = file => versions[file] ?? '';
  const quiet = { developerDir: () => null, exists: () => false, versionOf };
  assert.equal(findUserGit({ env: { PATH: path.join(root, 'old') }, ...quiet }), null, 'only an old git: none of the user\'s is used');
  assert.equal(findUserGit({ env: { PATH: `${path.join(root, 'old')}:${path.join(root, 'current')}` }, ...quiet }), current, 'a later, new-enough git on PATH is chosen');
  assert.equal(findUserGit({ env: { PATH: path.join(root, 'old') }, ...quiet, versionOf: () => '' }), null, 'a git that cannot report its version is not used');
  // The real version probe runs the candidate directly (a shell script standing in for git).
  writeFileSync(old, '#!/bin/sh\necho "git version 2.30.0"\n');
  writeFileSync(current, '#!/bin/sh\necho "git version 2.51.2"\n');
  assert.equal(findUserGit({ env: { PATH: `${path.join(root, 'old')}:${path.join(root, 'current')}` }, developerDir: () => null, exists: () => false }), current);
});

test('baseEnvironment passes only the documented variables', () => {
  const env = baseEnvironment({ HOME: '/h', USER: 'u', LOGNAME: 'u', SHELL: '/bin/zsh', TMPDIR: '/t', LANG: 'en_US.UTF-8', PATH: '/evil', ANTHROPIC_API_KEY: 'x' });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'USER']);
  assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
});

test('log rotation keeps one generation and truncates', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cps-log-'));
  const file = path.join(dir, 'x.log');
  writeFileSync(file, 'a'.repeat(100));
  assert.equal(await rotateIfNeeded(file, 1000), false);
  assert.equal(await rotateIfNeeded(file, 50), true);
  assert.equal(statSync(file).size, 0);
  assert.equal(statSync(`${file}.1`).size, 100);
});

test('estimateSteps sums known sizes and reports null for unknown ones', () => {
  const config = { layout: 'app' };
  assert.deepEqual(estimateSteps({ release: { media: { size: 10, installedSize: 30 }, claude: { size: 5, installedSize: 12 } }, pending: ['media', 'claude'], config }), { downloadBytes: 15, requiredBytes: 52 });
  assert.deepEqual(estimateSteps({ release: { media: null, claude: { version: '1' } }, pending: ['claude'], config }), { downloadBytes: null, requiredBytes: null });
  assert.deepEqual(estimateSteps({ release: {}, pending: ['database'], config }), { downloadBytes: 0, requiredBytes: 0 });
  // CP_MEDIA_DIR is used in place: nothing to download for media.
  assert.deepEqual(estimateSteps({ release: { media: { size: 10, installedSize: 30 } }, pending: ['media'], config: { ...config, externalMediaDir: '/m' } }), { downloadBytes: 0, requiredBytes: 0 });
});

test('installer phase names reach the setup screen as readable labels', () => {
  const events = [];
  const ctx = makeContext({ config: {}, release: {}, deps: {}, state: { steps: {} }, emit: e => events.push(e) });
  ctx.forward('media', 'Downloading the game media', { label: 'checkout', done: 1, total: 2 });
  ctx.forward('claude', 'Downloading Claude Code', { label: 'verify', done: 0, total: 1 });
  ctx.forward('database', 'Preparing the game database', { label: 'Creating the database', done: 1 });
  ctx.forward('media', 'Downloading the game media', { done: 3 });
  assert.deepEqual(events.map(e => [e.task, e.label]), [
    ['media', 'Unpacking the game media'], ['claude', 'Verifying Claude Code'], ['database', 'Creating the database'], ['media', 'Downloading the game media'],
  ]);
});

test('validateServices rejects cycles, unknown dependencies and relative programs', () => {
  const svc = (name, after = [], program = '/bin/x') => ({ name, after, command: [program], env: {} });
  assert.throws(() => validateServices([svc('a', ['b']), svc('b', ['a'])]), /cycle/);
  assert.throws(() => validateServices([svc('a', ['zzz'])]), /unknown/);
  assert.throws(() => validateServices([svc('a', [], 'node')]), /absolute/);
  validateServices([svc('a'), svc('b', ['a'])]);
});

test('freeBytes walks up to an existing directory', async () => {
  assert.ok(await freeBytes(path.join(os.tmpdir(), 'does', 'not', 'exist')) > 0);
});

test('a supervisor that exits 70 with its program still running keeps the ownership record and reports a failed stop', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cps-orch-'));
  // Stands in for cp-supervise: starts the program in its own group, writes the sidecar, and on the stop
  // request exits 70 ("process group did not exit") without stopping it.
  const shim = path.join(root, 'fake-supervise');
  writeFileSync(shim, `#!${process.execPath}
const { spawn } = require('node:child_process'); const fs = require('node:fs');
const args = process.argv.slice(2); const record = args[args.indexOf('--record') + 1]; const program = args.slice(args.indexOf('--') + 1);
const child = spawn(program[0], program.slice(1), { detached: true, stdio: 'ignore' }); child.unref();
fs.writeFileSync(record + '.child', JSON.stringify({ pid: child.pid, pgid: child.pid, shimPid: process.pid, startSec: 0 }));
process.on('SIGUSR1', () => process.exit(70));
setInterval(() => {}, 1000);
`);
  chmodSync(shim, 0o755);
  const owners = path.join(root, 'owners');
  const orchestrator = new Orchestrator({ superviseBin: shim, ownersDir: owners });
  await orchestrator.start([{ name: 'svc', command: ['/bin/sleep', '300'], env: { PATH: '/usr/bin:/bin' },
    health: { type: 'command', command: ['/usr/bin/true'] }, logDir: path.join(root, 'logs'), stop: { signal: 'SIGTERM', graceMs: 200 } }]);
  const { pgid } = orchestrator.get('svc');
  try {
    assert.ok(pgid > 1);
    assert.deepEqual(await orchestrator.stopAll(), ['svc'], 'not reported as stopped');
    assert.ok(existsSync(path.join(owners, 'svc.json')), 'the record stays for recovery');
  } finally { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } }
});
