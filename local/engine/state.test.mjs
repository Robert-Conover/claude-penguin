import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertV1, convertV2, migrateStateDir, readState, writeState } from './state.mjs';
import { migrate } from './migrate.mjs';
import { legacyState } from './testing.mjs';

const tempDir = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'penguin-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('private v3 state survives an atomic round trip and no temporary files remain', t => {
  const dir = tempDir(t);
  assert.deepEqual(readState(dir), { version: 3, revision: 0, visitor: null, projects: [], workers: [], adoptions: [] });
  const state = { version: 3, revision: 7, visitor: null, projects: [{ id: 'project' }], workers: [{ sessionId: 'persistent-id' }], adoptions: [] };
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
  fs.writeFileSync(file, JSON.stringify({ version: 4, projects: [], workers: [], adoptions: [] }));
  assert.throws(() => readState(dir), /Unsupported/);
  fs.writeFileSync(file, JSON.stringify({ version: 2, projects: [], workers: [] }));
  assert.throws(() => readState(dir), error => error.code === 'STATE_V2' && /migrate it explicitly/.test(error.message), 'the v3 engine refuses v2 state until migrated');
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
  assert.equal(result.backups.length, 2, 'one backup per step: v1, then v2');
  assert.deepEqual(fs.readFileSync(result.backup), bytes);
  assert.equal(JSON.parse(fs.readFileSync(result.backups[1], 'utf8')).version, 2);
  for (const backup of result.backups) assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, 'state.json')).mode & 0o777, 0o600);
  const state = readState(dir);
  assert.equal(state.version, 3);
  assert.deepEqual(state.adoptions, []);
  const [project] = state.projects;
  assert.equal(project.id, 'e7c554c7-88e3-4c1f-9125-3261283a4393');
  assert.equal(project.sourcePath, source);
  assert.equal(project.sourceAvailable, true);
  assert.equal(Object.hasOwn(project, 'activeWorkerId'), false);
  assert.equal(project.setup.phase, 'needs-worker');
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
  assert.equal(worker.puffle, null, 'an archived direct-checkout worker keeps no puffle binding');
  assert.deepEqual(migrateStateDir(dir, { at }).migrated, false, 'v3 state is left alone');
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

test('the migration command requires a stopped runtime and explicitly migrates a missing source', async t => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(legacyState('/missing')));
  fs.writeFileSync(path.join(dir, 'runtime.lock'), JSON.stringify({ pid: 2147483647, nonce: 'stale' }));
  await assert.rejects(migrate({ stateDir: dir }), /stale engine lock/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).version, 1);
  fs.writeFileSync(path.join(dir, 'runtime.lock'), JSON.stringify({ pid: process.pid, nonce: 'live' }));
  await assert.rejects(migrate({ stateDir: dir }), /already be running/);
  fs.rmSync(path.join(dir, 'runtime.lock'));
  const result = await migrate({ stateDir: dir });
  assert.equal(result.migrated, true);
  assert.equal(fs.existsSync(path.join(dir, 'runtime.lock')), false, 'the migration releases its lock');
});

test('v2 to v3 moves the single puffle onto its worker and keeps every identity, session, worktree and history', () => {
  const at = '2026-11-06T12:00:00.000Z';
  const project = 'a1b2c3d4-0000-4000-8000-000000000001';
  const workerId = 'a1b2c3d4-0000-4000-8000-000000000002';
  const v2 = { version: 2, revision: 41, visitor: { penguinId: 107, username: 'bridgecheck', verifiedAt: at },
    projects: [{ id: project, name: 'App', sourcePath: '/src/app', commonDir: '/src/app/.git', createdAt: at, sourceAvailable: true,
      setup: { phase: 'ready', step: null, error: null, retryable: false, updatedAt: at }, activeWorkerId: workerId,
      game: { source: 'managed', status: 'ready', ownerId: 201, iglooId: 9, roomId: 2201, puffleId: 31, puffleName: 'Pebble', fixtureId: null, verifiedAt: at, requestedPuffleName: 'pebble', nameRejected: false } }],
    workers: [{ id: workerId, projectId: project, name: 'Pebble', sessionId: 'a1b2c3d4-0000-4000-8000-000000000003', established: true, status: 'offline',
      taskHistory: [{ id: 't', prompt: 'fix it', status: 'turn-ended' }], pid: null,
      workspace: { kind: 'worktree', path: '/wt/app', branch: `claude-penguin/${project}/${workerId}`, baseCommit: 'a'.repeat(40), repoCommonDir: '/src/app/.git', state: 'ready' } }] };
  const v3 = convertV2(structuredClone(v2), { at });
  assert.equal(v3.version, 3);
  assert.equal(v3.revision, 42);
  assert.deepEqual(v3.visitor, v2.visitor);
  assert.deepEqual(v3.adoptions, []);
  assert.deepEqual(v3.projects[0].game, { source: 'managed', status: 'ready', ownerId: 201, iglooId: 9, roomId: 2201, verifiedAt: at });
  assert.equal(Object.hasOwn(v3.projects[0], 'activeWorkerId'), false);
  assert.equal(v3.projects[0].setup.phase, 'ready');
  const [worker] = v3.workers;
  assert.deepEqual(worker.puffle, { puffleId: 31, typeId: 0, subtypeId: 0, name: 'Pebble', adoptionId: null });
  for (const key of ['id', 'sessionId', 'established', 'taskHistory', 'workspace']) assert.deepEqual(worker[key], v2.workers[0][key], key);
  assert.equal(worker.setup.phase, 'ready');
  // A reserved worktree from an interrupted v2 setup becomes a retryable worker setup.
  const pending = structuredClone(v2);
  pending.workers[0].workspace.state = 'reserved';
  pending.projects[0].setup.phase = 'failed';
  const converted = convertV2(pending, { at });
  assert.deepEqual([converted.workers[0].setup.phase, converted.workers[0].setup.retryable], ['failed', true]);
  assert.throws(() => convertV2({ version: 1, projects: [], workers: [] }), /Only a version 2 state/);
});

test('v2 migration refuses a live worker process and preserves the v2 bytes', t => {
  const dir = tempDir(t);
  const v2 = { version: 2, revision: 1, visitor: null, projects: [], workers: [{ id: 'w', pid: process.pid }] };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(v2));
  assert.throws(() => migrateStateDir(dir), /may still be running/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).version, 2);
  v2.workers = [];
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(v2));
  const result = migrateStateDir(dir, { at: '2026-11-06T00:00:00.000Z' });
  assert.deepEqual(JSON.parse(fs.readFileSync(result.backup, 'utf8')), v2);
  assert.equal(readState(dir).version, 3);
});
