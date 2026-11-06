import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeMenuState, allowedNativeAction, nativeMenuFields, rosterFields, alertFields, resolveSelection, attentionTotal, selectionForSlot } from './native-menu.mjs';
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
const slot = workerId => mappings.projects.flatMap(project => project.puffles).find(puffle => puffle.workerId === workerId).slot;
const game = { ok: true, version: 5, configured: true, generation: 4, playerId: 107, ownerId: 0, roomId: 100, puffles: [] };
const context = (extra = {}) => ({ mappings, game, generation: 4, engineState: state(), target, ...extra });
const action = (extra = {}) => ({ type: 'agent-menu-action', projectId: PROJECT_A, action: 'submit', text: 'A task', draftSlot: slot('worker-a'), generation: 4, ...extra });

test('native card payload is an allowlist of display fields, the project UUID, and draft slots', () => {
  const menu = nativeMenuState(state(), mappings, target);
  assert.deepEqual(Object.keys(menu), [...nativeMenuFields]);
  assert.equal(menu.projectId, PROJECT_A);
  assert.equal(menu.name, 'Atlas');
  assert.equal(menu.projectName, 'Atlas Repo');
  assert.equal(menu.draftSlot, slot('worker-a'));
  assert.equal(menu.canSubmit, true);
  assert.equal(menu.canStart, false);
  assert.doesNotMatch(JSON.stringify(menu), PRIVATE);
  for (const [key, value] of Object.entries(menu)) {
    if (['roster', 'alerts'].includes(key)) assert.ok(Array.isArray(value));
    else assert.ok(['string', 'number', 'boolean'].includes(typeof value), key);
  }
  assert.equal(nativeMenuState({ ...state(), connected: false }, mappings, target).canSubmit, false);
});

test('the roster lists every puffle in the igloo with color, status and current task; the selection is marked', () => {
  const menu = nativeMenuState(state(), mappings, target);
  assert.deepEqual(menu.roster.map(row => Object.keys(row)), [[...rosterFields], [...rosterFields]]);
  assert.deepEqual(menu.roster.map(row => [row.name, row.color, row.status, row.task, row.selected]),
    [['Atlas', 'blue', 'Ready', 'Fix the login bug', true], ['Pebble', 'green', 'Ready for review', 'Fix the login bug', false]]);
  const other = nativeMenuState(state(), mappings, { projectId: PROJECT_A, workerId: 'worker-a2' });
  assert.deepEqual(other.roster.map(row => row.selected), [false, true], 'selecting a sibling keeps the same roster');
  assert.notEqual(other.draftSlot, nativeMenuState(state(), mappings, target).draftSlot, 'each puffle keeps its own draft slot');
});

test('the card shows only the explicit selection; nothing selected means the project list', () => {
  const none = nativeMenuState(state(), mappings, null);
  assert.equal(none.projectId, '');
  assert.equal(none.canStart || none.canSubmit || none.running, false);
  assert.equal(resolveSelection(data(), mappings, { projectId: PROJECT_A, workerId: 'worker-b' }), null, 'another project\'s worker');
  assert.equal(resolveSelection(data(), mappings, { projectId: PROJECT_A, workerId: null }), null);
  const gone = data();
  gone.workers = gone.workers.filter(item => item.id !== 'worker-a');
  assert.equal(resolveSelection(gone, mappings, target), null, 'a selection does not follow a removed worker');
  assert.equal(resolveSelection(data(), { ...mappings, projects: [] }, target), null, 'unmapped in the overlay');
  const unready = data();
  unready.projects[0].game.status = 'repair';
  assert.equal(resolveSelection(unready, mappings, target), null);
  const setup = data();
  setup.workers[0].running = false;
  setup.workers[0].workspace.state = 'reserved';
  assert.equal(nativeMenuState(state(setup), mappings, target).canStart, false, 'unfinished worktree cannot start');
  const queued = data();
  Object.assign(queued.workers[0], { running: false, queued: true, status: 'queued' });
  const menu = nativeMenuState(state(queued), mappings, target);
  assert.deepEqual([menu.status, menu.canStart, menu.running], ['queued', false, false]);
});

test('attention is aggregated across every active worker and listed as the actual puffles that need you', () => {
  const snapshot = data();
  snapshot.workers.find(item => item.id === 'worker-b').status = 'needs-you';
  snapshot.workers.find(item => item.id === 'worker-a2').status = 'failed';
  // Pending Repo's worker (review) counts too, but only mapped puffles become rows.
  assert.equal(attentionTotal(snapshot), 3);
  const menu = nativeMenuState(state(snapshot), mappings, target);
  assert.equal(menu.attention, 3);
  assert.equal(nativeMenuState(state(snapshot), mappings, null).attention, 3);
  assert.deepEqual(menu.alerts.map(row => Object.keys(row)), [[...alertFields], [...alertFields]]);
  assert.deepEqual(menu.alerts.map(row => [row.projectId, row.name, row.status]), [[PROJECT_A, 'Pebble', 'Needs recovery'], [PROJECT_B, 'Comet', 'Needs you']]);
  assert.deepEqual(menu.alerts.map(row => row.color), ['green', 'blue'], 'each row shows its own puffle color');
  assert.doesNotMatch(JSON.stringify(menu.alerts), PRIVATE);
  const setupFailed = data();
  setupFailed.workers[0].setup = { phase: 'failed' };
  assert.deepEqual(nativeMenuState(state(setupFailed), mappings, null).alerts.map(row => [row.name, row.status]).slice(0, 1), [['Atlas', 'Setup failed']]);
});

test('roster and attention rows select exactly their mapped puffle', () => {
  assert.deepEqual(selectionForSlot(data(), mappings, PROJECT_A, slot('worker-a2')), { projectId: PROJECT_A, workerId: 'worker-a2' });
  assert.equal(selectionForSlot(data(), mappings, PROJECT_B, slot('worker-a2')), null, 'a slot never crosses projects');
  assert.equal(selectionForSlot(data(), mappings, PROJECT_A, 9999), null);
  const select = (extra = {}) => ({ type: 'agent-menu-action', action: 'select', projectId: PROJECT_A, draftSlot: slot('worker-a2'), generation: 4, ...extra });
  assert.equal(allowedNativeAction(context({ target: null }), select()), true);
  assert.equal(allowedNativeAction(context(), select({ generation: 3 })), false);
  assert.equal(allowedNativeAction(context(), select({ projectId: PROJECT_B })), false);
});

test('native actions require the verified visitor, current generation, and the explicit selection', () => {
  assert.equal(allowedNativeAction(context(), action()), true);
  assert.equal(allowedNativeAction(context({ game: { ...game, playerId: 103 } }), action()), false);
  assert.equal(allowedNativeAction(context({ game: { ...game, ok: false } }), action()), false);
  assert.equal(allowedNativeAction(context({ mappings: null }), action()), false, 'stale mappings route nothing');
  assert.equal(allowedNativeAction(context(), action({ projectId: PROJECT_B })), false);
  assert.equal(allowedNativeAction(context(), action({ draftSlot: slot('worker-a2') })), false, 'a sibling\'s slot is not this card');
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
