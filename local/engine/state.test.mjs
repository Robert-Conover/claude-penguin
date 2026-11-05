import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertV1, migrateStateDir, readState, writeState } from './state.mjs';
import { migrate } from './migrate.mjs';
import { legacyState } from './testing.mjs';

const tempDir = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'penguin-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('private v2 state survives an atomic round trip and no temporary files remain', t => {
  const dir = tempDir(t);
  assert.deepEqual(readState(dir), { version: 2, revision: 0, visitor: null, projects: [], workers: [] });
  const state = { version: 2, revision: 7, visitor: null, projects: [{ id: 'project' }], workers: [{ sessionId: 'persistent-id' }] };
  writeState(dir, state);
  assert.deepEqual(readState(dir), state);
  assert.equal(fs.statSync(path.join(dir, 'state.json')).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});

test('corrupt, unsupported, and v1 state are preserved and refused without implicit migration', t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{broken');
  assert.throws(() => readState(dir), /invalid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  fs.writeFileSync(file, JSON.stringify({ version: 3, projects: [], workers: [] }));
  assert.throws(() => readState(dir), /Unsupported/);
  const v1 = JSON.stringify(legacyState('/nowhere'));
  fs.writeFileSync(file, v1);
  assert.throws(() => readState(dir), error => error.code === 'STATE_V1' && /migrate it explicitly/.test(error.message));
  assert.equal(fs.readFileSync(file, 'utf8'), v1);
});

test('migration preserves original bytes in a private backup and archives the direct-checkout worker', t => {
  const dir = tempDir(t);
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'penguin-source-'));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  const bytes = Buffer.from(`${JSON.stringify(legacyState(source), null, 1)}\n`);
  fs.writeFileSync(path.join(dir, 'state.json'), bytes);
  const at = '2026-11-04T12:00:00.000Z';
  const result = migrateStateDir(dir, { at });
  assert.equal(result.migrated, true);
  assert.deepEqual(fs.readFileSync(result.backup), bytes);
  assert.equal(fs.statSync(result.backup).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, 'state.json')).mode & 0o777, 0o600);
  const state = readState(dir);
  assert.equal(state.version, 2);
  const [project] = state.projects;
  assert.equal(project.id, 'e7c554c7-88e3-4c1f-9125-3261283a4393');
  assert.equal(project.sourcePath, source);
  assert.equal(project.sourceAvailable, true);
  assert.equal(project.activeWorkerId, null);
  assert.deepEqual(project.game, { source: 'legacy-fixture', status: 'ready', fixtureId: 'bridge-alpha', ownerId: 105, iglooId: 4, roomId: 2105, puffleId: 4, puffleName: 'Atlas', verifiedAt: null });
  const [worker] = state.workers;
  assert.equal(worker.id, '34a60f4a-0c2b-4ab8-af20-c3156de19ffd');
  assert.equal(worker.sessionId, 'c6b60407-ead8-4488-b8cb-281936dca777');
  assert.equal(worker.established, true);
  assert.deepEqual(worker.workspace, { kind: 'direct-checkout', path: source, baseCommit: 'dc4eefbdb2af3038c1298490e06538096444e4b8', sourceDirtyAtCreation: false });
  assert.equal(worker.archived.at, at);
  assert.equal(worker.taskHistory.length, 2);
  assert.equal(worker.taskHistory[1].status, 'interrupted');
  assert.equal(worker.taskHistory[0].prompt, 'first');
  assert.deepEqual(migrateStateDir(dir, { at }).migrated, false, 'v2 state is left alone');
  fs.writeFileSync(path.join(dir, 'state.json'), bytes);
  fs.writeFileSync(result.backup, 'earlier backup');
  assert.throws(() => migrateStateDir(dir, { at }), /EEXIST/, 'an existing backup is never overwritten');
  assert.equal(fs.readFileSync(result.backup, 'utf8'), 'earlier backup');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'state.json')), bytes, 'state is unchanged when the backup cannot be written');
});

test('migration succeeds when the original source checkout is missing', () => {
  const state = convertV1(legacyState('/definitely/missing/source'), { at: '2026-11-04T00:00:00.000Z' });
  assert.equal(state.projects[0].sourceAvailable, false);
  assert.equal(state.workers[0].taskHistory.length, 2);
  assert.equal(state.workers[0].archived.at, '2026-11-04T00:00:00.000Z');
});

test('migration refuses a running worker, invalid identities, and multi-worker v1 state', () => {
  const live = legacyState('/x');
  live.workers[0].pid = process.pid;
  assert.throws(() => convertV1(live), /may still be running/);
  const broken = legacyState('/x');
  broken.workers[0].sessionId = 'nope';
  assert.throws(() => convertV1(broken), /invalid/);
  const many = legacyState('/x');
  many.workers.push({ ...many.workers[0] });
  assert.throws(() => convertV1(many), /at most one/);
  const renamed = legacyState('/x');
  renamed.projects[0].name = 'Bridge: Alpha!';
  const converted = convertV1(renamed);
  assert.equal(converted.projects[0].name, 'Bridge Alpha');
  assert.equal(converted.projects[0].legacy.originalName, 'Bridge: Alpha!');
});

test('the migration command requires a stopped runtime and rehearses only outside the checkout', async t => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(legacyState('/missing')));
  await assert.rejects(migrate({ stateDir: dir }), /rehearsal/);
  fs.writeFileSync(path.join(dir, 'runtime.lock'), JSON.stringify({ pid: 2147483647, nonce: 'stale' }));
  await assert.rejects(migrate({ stateDir: dir, rehearsal: true }), /stale engine lock/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).version, 1);
  fs.writeFileSync(path.join(dir, 'runtime.lock'), JSON.stringify({ pid: process.pid, nonce: 'live' }));
  await assert.rejects(migrate({ stateDir: dir, rehearsal: true }), /already be running/);
  fs.rmSync(path.join(dir, 'runtime.lock'));
  const result = await migrate({ stateDir: dir, rehearsal: true });
  assert.equal(result.migrated, true);
  assert.equal(fs.existsSync(path.join(dir, 'runtime.lock')), false, 'the migration releases its lock');
});
