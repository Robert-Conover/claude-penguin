import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeMenuState, allowedNativeAction, nativeMenuFields, resolveSelection, attentionTotal } from './native-menu.mjs';
import { agentMappings } from './model.mjs';
import { engineSnapshot, PROJECT_A, PROJECT_B, PRIVATE } from './testing.mjs';

const data = () => {
  const snapshot = engineSnapshot();
  snapshot.workers[0].status = 'idle';
  return snapshot;
};
const state = (snapshot = data()) => ({ connected: true, token: 'private-browser-token', snapshot });
const mappings = agentMappings(data());
const target = { projectId: PROJECT_A, workerId: 'worker-a' };
const game = { ok: true, version: 2, configured: true, generation: 4, playerId: 107, ownerId: 0, roomId: 100, puffles: [] };
const context = (extra = {}) => ({ mappings, game, generation: 4, engineState: state(), target, ...extra });
const action = (extra = {}) => ({ type: 'agent-menu-action', projectId: PROJECT_A, action: 'submit', text: 'A task', generation: 4, ...extra });

test('native card payload is an allowlist of display fields and the project UUID', () => {
  const menu = nativeMenuState(state(), mappings, target);
  assert.deepEqual(Object.keys(menu), [...nativeMenuFields]);
  assert.equal(menu.projectId, PROJECT_A);
  assert.equal(menu.name, 'Atlas');
  assert.equal(menu.projectName, 'Atlas Repo');
  assert.equal(menu.canSubmit, true);
  assert.equal(menu.canStart, false);
  assert.doesNotMatch(JSON.stringify(menu), PRIVATE);
  for (const value of Object.values(menu)) assert.ok(['string', 'number', 'boolean'].includes(typeof value));
  assert.equal(nativeMenuState({ ...state(), connected: false }, mappings, target).canSubmit, false);
});

test('the card shows only the explicit selection; nothing selected means the project list', () => {
  const none = nativeMenuState(state(), mappings, null);
  assert.equal(none.projectId, '');
  assert.equal(none.canStart || none.canSubmit || none.running, false);
  assert.equal(resolveSelection(data(), mappings, { projectId: PROJECT_A, workerId: 'worker-b' }), null, 'another project\'s worker');
  assert.equal(resolveSelection(data(), mappings, { projectId: PROJECT_A, workerId: null }), null);
  const replaced = data();
  replaced.projects[0].activeWorkerId = 'worker-new';
  assert.equal(resolveSelection(replaced, mappings, target), null, 'a selection does not follow a replaced worker');
  assert.equal(resolveSelection(data(), { ...mappings, projects: [] }, target), null, 'unmapped in the overlay');
  const unready = data();
  unready.projects[0].game.status = 'repair';
  assert.equal(resolveSelection(unready, mappings, target), null);
  const setup = data();
  setup.workers[0].running = false;
  setup.workers[0].workspace.state = 'pending';
  assert.equal(nativeMenuState(state(setup), mappings, target).canStart, false, 'unfinished worktree cannot start');
});

test('attention is aggregated across every active worker, whichever puffle is selected', () => {
  const snapshot = data();
  snapshot.workers[1].status = 'needs-you';
  snapshot.workers[2].status = 'failed';
  assert.equal(attentionTotal(snapshot), 2);
  assert.equal(nativeMenuState(state(snapshot), mappings, target).attention, 2);
  assert.equal(nativeMenuState(state(snapshot), mappings, null).attention, 2);
});

test('native actions require the verified visitor, current generation, and the explicit selection', () => {
  assert.equal(allowedNativeAction(context(), action()), true);
  assert.equal(allowedNativeAction(context({ game: { ...game, playerId: 103 } }), action()), false);
  assert.equal(allowedNativeAction(context({ game: { ...game, ok: false } }), action()), false);
  assert.equal(allowedNativeAction(context({ mappings: null }), action()), false, 'stale mappings route nothing');
  assert.equal(allowedNativeAction(context(), action({ projectId: PROJECT_B })), false);
  assert.equal(allowedNativeAction(context(), action({ generation: 3 })), false, 'card rendered before reconfiguration');
  assert.equal(allowedNativeAction(context({ game: { ...game, generation: 3 } }), action()), false, 'snapshot older than configuration');
  assert.equal(allowedNativeAction(context({ target: null }), action()), false);
  assert.equal(allowedNativeAction(context({ engineState: { ...state(), connected: false } }), action()), false);
  assert.equal(allowedNativeAction(context(), action({ action: 'start' })), false);
  assert.equal(allowedNativeAction(context(), action({ text: '' })), false);
  assert.equal(allowedNativeAction(context(), action({ action: 'terminal' })), true);
  assert.equal(allowedNativeAction(context({ target: null }), action({ action: 'work', projectId: undefined })), true, 'Work opens the list');
  assert.equal(allowedNativeAction(context({ game: { ...game, generation: 3 } }), action({ action: 'igloos' })), true);
  const pending = data();
  pending.workers[0].status = 'needs-you';
  pending.workers[0].activity = 'Private interruption detail';
  const menu = nativeMenuState(state(pending), mappings, target);
  assert.equal(menu.canSubmit, false);
  assert.doesNotMatch(menu.activity, /private|permission|question/i);
  assert.equal(allowedNativeAction(context({ engineState: state(pending) }), action()), false);
  assert.equal(allowedNativeAction(context({ engineState: state(pending) }), action({ action: 'terminal' })), true);
});
