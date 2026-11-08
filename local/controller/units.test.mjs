import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findUserGit, baseEnvironment } from './engine-service.mjs';
import { rotateIfNeeded } from './logs.mjs';
import { estimateSteps } from './setup.mjs';
import { validateServices } from './orchestrator.mjs';
import { freeBytes } from './preflight.mjs';

const fakeGit = dir => { mkdirSync(dir, { recursive: true }); const f = path.join(dir, 'git'); writeFileSync(f, '#!/bin/sh\n'); chmodSync(f, 0o755); return f; };

test('findUserGit prefers a real git on PATH and skips the /usr/bin stub when no developer directory has one', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cps-git-'));
  const brew = fakeGit(path.join(root, 'brew'));
  assert.equal(findUserGit({ env: { PATH: `/usr/bin:${path.join(root, 'brew')}` }, developerDir: () => null, exists: () => false }), brew);
  // Nothing but /usr/bin (which exists on every Mac as a stub): never chosen without developer tools.
  assert.equal(findUserGit({ env: { PATH: '/usr/bin:/bin' }, developerDir: () => null, exists: () => false }) === '/usr/bin/git', false);
  // The bundled git is never reported as the user's.
  const bundled = fakeGit(path.join(root, 'bundled'));
  assert.equal(findUserGit({ env: { PATH: path.join(root, 'bundled') }, bundledGit: bundled, developerDir: () => null, exists: () => false }) === bundled, false);
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
