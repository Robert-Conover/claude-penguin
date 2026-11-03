import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget, targetForFixture, controlsForWorker, animationForStatus, attentionCount, statusLabels, nextSnapshotRevision, terminalDimensions } from './ui-model.mjs';

const snapshot = { projects: [{ id: 'a', fixtureId: 'bridge-alpha' }, { id: 'b', fixtureId: 'bridge-beta' }], workers: [{ id: 'w1', projectId: 'a', status: 'review', running: true }, { id: 'w2', projectId: 'b', status: 'working', running: true }] };
test('explicit selection and fixture routing never reuse a worker from another project', () => {
  assert.equal(resolveTarget(snapshot, { projectId: 'b', workerId: 'w1' }), null);
  assert.equal(resolveTarget(snapshot, { projectId: 'removed', workerId: 'w1' }), null);
  assert.equal(resolveTarget(snapshot, { projectId: 'a', workerId: 'missing' }), null);
  assert.equal(targetForFixture(snapshot, 'missing'), null);
  assert.deepEqual(targetForFixture(snapshot, 'bridge-beta'), { projectId: 'b', workerId: 'w2' });
  assert.equal(targetForFixture({ ...snapshot, workers: [...snapshot.workers, { id: 'w3', projectId: 'a' }] }, 'bridge-alpha'), null);
});
test('terminal and mutation controls require a fresh connection and terminal attachment', () => {
  const target = resolveTarget(snapshot, { projectId: 'a', workerId: 'w1' });
  assert.equal(controlsForWorker(false, target, true).input, false);
  assert.equal(controlsForWorker(true, target, false).submit, false);
  assert.equal(controlsForWorker(true, null, true).start, false);
  assert.equal(controlsForWorker(true, target, true).submit, true);
  assert.equal(controlsForWorker(true, { ...target, worker: { ...target.worker, status: 'needs-you' } }, true).submit, false);
  assert.equal(controlsForWorker(true, { ...target, worker: { ...target.worker, status: 'needs-you' } }, true).input, true);
});
test('turn-end is reviewable rather than completed and unsupported states do not animate', () => {
  assert.match(statusLabels.review, /turn ended/);
  assert.equal(animationForStatus('review'), 'ready');
  assert.equal(animationForStatus('idle'), null);
  assert.equal(animationForStatus('made-up'), null);
  assert.equal(attentionCount(snapshot), 1);
});
test('late HTTP snapshots cannot replace a newer hook event, while reconnect can restart the sequence', () => {
  assert.equal(nextSnapshotRevision(12, 13), 13);
  assert.equal(nextSnapshotRevision(13, 12), null);
  assert.equal(nextSnapshotRevision(13, 13), 13);
  assert.equal(nextSnapshotRevision(-1, 0), 0);
});
test('terminal fit stays within the host PTY limits on small and large panels', () => {
  assert.deepEqual(terminalDimensions({ cols: 20, rows: 6 }), { cols: 40, rows: 10 });
  assert.deepEqual(terminalDimensions({ cols: 500, rows: 150 }), { cols: 300, rows: 100 });
  assert.deepEqual(terminalDimensions({ cols: 120, rows: 32 }), { cols: 120, rows: 32 });
  assert.equal(terminalDimensions(undefined), null);
});
