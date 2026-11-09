import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recoverEngineLock, recoverEngineLocks } from './engine-lock.mjs';

function fixture({ lockPid = 4242, journal = { pid: 4242, pgid: 4242, startTime: 'T0' } } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cp-englock-'));
  const stateDir = path.join(dir, 'engine');
  const journalFile = path.join(dir, 'journal-engine.json');
  return { dir, stateDir, journalFile, lockPid, journal };
}

async function setup(opts) {
  const f = fixture(opts);
  const fs = await import('node:fs');
  fs.mkdirSync(f.stateDir, { recursive: true });
  if (f.lockPid !== null) writeFileSync(path.join(f.stateDir, 'runtime.lock'), JSON.stringify({ pid: f.lockPid, nonce: 'n' }));
  if (f.journal) writeFileSync(f.journalFile, JSON.stringify(f.journal));
  return f;
}

const dead = () => false;
const noGroup = () => false;

test('no lock: nothing to do', async () => {
  const f = await setup({ lockPid: null });
  assert.equal((await recoverEngineLock({ ...f, alive: dead, group: noGroup })).action, 'none');
});

test('removes the lock of an engine this app started once it and its group are gone', async () => {
  const f = await setup();
  const out = await recoverEngineLock({ ...f, alive: dead, group: noGroup });
  assert.equal(out.action, 'removed');
  assert.equal(existsSync(path.join(f.stateDir, 'runtime.lock')), false);
});

test('keeps the lock without a journal, for another PID, while alive, or while its group lives', async () => {
  const cases = [
    [{ journal: null }, { alive: dead, group: noGroup }, /No record/],
    [{ journal: { pid: 1, pgid: 1, startTime: 'T0' } }, { alive: dead, group: noGroup }, /not the engine/],
    [{}, { alive: () => true, group: noGroup, identity: async () => ({ startTime: 'T0' }) }, /still running/],
    [{}, { alive: dead, group: () => true }, /group/],
  ];
  for (const [opts, deps, reason] of cases) {
    const f = await setup(opts);
    const out = await recoverEngineLock({ ...f, ...deps });
    assert.equal(out.action, 'keep');
    assert.match(out.reason, reason);
    assert.equal(existsSync(path.join(f.stateDir, 'runtime.lock')), true);
  }
});

test('a reused PID (different start time) does not keep a dead engine locked', async () => {
  const f = await setup();
  const out = await recoverEngineLock({ ...f, alive: () => true, group: noGroup, identity: async () => ({ startTime: 'T9' }) });
  assert.equal(out.action, 'removed');
});

test('both locks: removed together, and a lock from another state directory is kept', async () => {
  const fs = await import('node:fs');
  const f = await setup();
  const publicationDir = path.join(f.dir, 'native-igloos');
  fs.mkdirSync(publicationDir);
  writeFileSync(path.join(publicationDir, 'owner.lock'), JSON.stringify({ pid: 4242, nonce: 'n', stateDir: f.stateDir }));
  const out = await recoverEngineLocks({ stateDir: f.stateDir, publicationDir, journalFile: f.journalFile, alive: dead, group: noGroup });
  assert.equal(out.action, 'removed');
  assert.equal(out.removed.length, 2);
  const g = await setup();
  const other = path.join(g.dir, 'native-igloos');
  fs.mkdirSync(other);
  writeFileSync(path.join(other, 'owner.lock'), JSON.stringify({ pid: 4242, nonce: 'n', stateDir: '/elsewhere/engine' }));
  const kept = await recoverEngineLocks({ stateDir: g.stateDir, publicationDir: other, journalFile: g.journalFile, alive: dead, group: noGroup });
  assert.equal(kept.action, 'keep');
  assert.match(kept.reason, /another engine state directory/);
  assert.equal(fs.existsSync(path.join(other, 'owner.lock')), true);
});
