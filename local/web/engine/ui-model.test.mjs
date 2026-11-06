import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget, targetForProject, controlsForWorker, animationForStatus, attentionCount, statusLabels, nextSnapshotRevision, terminalDimensions } from './ui-model.mjs';

const snapshot = { projects: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], workers: [{ id: 'w1', projectId: 'a', status: 'review', running: true },
  { id: 'w2', projectId: 'b', status: 'working', running: true }, { id: 'w3', projectId: 'b', status: 'idle', running: false }] };
test('explicit selection and project routing never reuse a worker from another project or pick one', () => {
  assert.equal(resolveTarget(snapshot, { projectId: 'b', workerId: 'w1' }), null);
  assert.equal(resolveTarget(snapshot, { projectId: 'removed', workerId: 'w1' }), null);
  assert.equal(resolveTarget(snapshot, { projectId: 'a', workerId: 'missing' }), null);
  assert.deepEqual(resolveTarget(snapshot, { projectId: 'b', workerId: 'w3' }).worker.id, 'w3', 'any of the project\'s puffles can be selected');
  assert.equal(targetForProject(snapshot, 'missing', 'w1'), null);
  assert.equal(targetForProject(snapshot, 'b'), null, 'a project with several puffles never picks one');
  assert.equal(targetForProject(snapshot, 'c'), null);
  assert.deepEqual(targetForProject(snapshot, 'b', 'w2'), { projectId: 'b', workerId: 'w2' });
  assert.deepEqual(targetForProject(snapshot, 'b', 'w3'), { projectId: 'b', workerId: 'w3' });
  assert.equal(targetForProject(snapshot, 'b', 'w1'), null, 'a named worker must belong to that project');
});
test('a queued start can be withdrawn but not started twice', () => {
  const queued = resolveTarget({ ...snapshot, workers: [{ id: 'w1', projectId: 'a', status: 'queued', running: false, queued: true, workspace: { state: 'ready' } }] }, { projectId: 'a', workerId: 'w1' });
  assert.deepEqual([controlsForWorker(true, queued, false).start, controlsForWorker(true, queued, false).stop], [false, true]);
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
