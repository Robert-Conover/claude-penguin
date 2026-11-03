import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeMenuState, allowedNativeAction } from './native-menu.mjs';

const fixtures = { visitor: { penguinId: 107 }, projects: [{ projectId: 'bridge-alpha' }, { projectId: 'bridge-beta' }] };
const game = { ok: true, configured: true, playerId: 107 };
const state = { connected: true, token: 'private-browser-token', snapshot: {
  projects: [{ id: 'project-uuid', fixtureId: 'bridge-alpha', name: 'My Igloo', path: '/private/repository' }],
  workers: [{ id: 'worker-uuid', projectId: 'project-uuid', sessionId: 'private-session', name: 'Atlas',
    running: true, established: true, status: 'idle', activity: 'Private terminal detail', taskHistory: [{ prompt: 'private task' }] }],
} };

test('native card projection omits runtime identity, credentials, terminal details and host paths', () => {
  const menu = nativeMenuState(state);
  assert.equal(menu.fixtureId, 'bridge-alpha');
  assert.equal(menu.canSubmit, true);
  assert.equal(menu.canStart, false);
  assert.doesNotMatch(JSON.stringify(menu), /private|uuid|token|sessionId|taskHistory/i);
  assert.equal(nativeMenuState({ ...state, connected: false }).canSubmit, false);
  const missing = structuredClone(state);
  missing.snapshot.projects = [];
  assert.equal(nativeMenuState(missing).canSubmit, false);
});

test('native actions require the fixture visitor, explicit matching project and current execution state', () => {
  const action = { type: 'agent-menu-action', fixtureId: 'bridge-alpha', action: 'submit', text: 'A task' };
  assert.equal(allowedNativeAction(fixtures, game, state, action), true);
  assert.equal(allowedNativeAction(fixtures, { ...game, playerId: 103 }, state, action), false);
  assert.equal(allowedNativeAction(fixtures, { ...game, ok: false }, state, action), false);
  assert.equal(allowedNativeAction(fixtures, game, state, { ...action, fixtureId: 'bridge-beta' }), false);
  assert.equal(allowedNativeAction(fixtures, game, { ...state, connected: false }, action), false);
  assert.equal(allowedNativeAction(fixtures, game, state, { ...action, action: 'start' }), false);
  assert.equal(allowedNativeAction(fixtures, game, state, { ...action, text: '' }), false);
  assert.equal(allowedNativeAction(fixtures, game, state, { ...action, action: 'terminal' }), true);
});
