import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFixtures, projectAtSnapshot, projectForClick, waitForArrival } from './model.mjs';

const manifest = () => ({ version: 1, kind: 'game-bridge-fixture', visitor: { username: 'bridgecheck', penguinId: 107 }, projects: [
  { projectId: 'bridge-alpha', name: 'Alpha', ownerId: 105, iglooId: 4, roomId: 2105, puffleId: 4, puffleName: 'Atlas' },
  { projectId: 'bridge-beta', name: 'Beta', ownerId: 106, iglooId: 5, roomId: 2106, puffleId: 5, puffleName: 'Comet' },
] });
const snapshot = () => ({ ok: true, configured: true, playerId: 107, ownerId: 105, roomId: 2105, puffles: [{ id: 4 }] });
const click = () => ({ type: 'puffle-click', projectId: 'bridge-alpha', ownerId: 105, puffleId: 4 });

test('manifest keeps project, owner, layout and puffle identities separate and excludes private fields', () => {
  const input = manifest();
  input.projects[0].repoPath = '/private/repo';
  input.visitor.password = 'private';
  const fixtures = validateFixtures(input);
  assert.equal(fixtures.projects[0].repoPath, undefined);
  assert.equal(fixtures.visitor.password, undefined);
  for (const key of ['ownerId', 'iglooId', 'puffleId', 'projectId']) {
    const duplicate = manifest();
    duplicate.projects[1][key] = duplicate.projects[0][key];
    assert.throws(() => validateFixtures(duplicate));
  }
  const wrongRoom = manifest(); wrongRoom.projects[0].roomId = 4;
  assert.throws(() => validateFixtures(wrongRoom));
});

test('puffle clicks require the exact fixture session, current owner, room, project and rendered puffle', () => {
  const fixtures = validateFixtures(manifest());
  assert.equal(projectForClick(fixtures, snapshot(), click()).projectId, 'bridge-alpha');
  for (const mismatch of [{ playerId: 103 }, { roomId: 100 }, { ownerId: 106 }, { configured: false }, { ok: false }, { puffles: [] }]) {
    assert.equal(projectForClick(fixtures, { ...snapshot(), ...mismatch }, click()), null);
  }
  for (const mismatch of [{ projectId: 'bridge-beta' }, { ownerId: 106 }, { puffleId: 5 }, { type: 'ready' }]) {
    assert.equal(projectForClick(fixtures, snapshot(), { ...click(), ...mismatch }), null);
  }
  assert.equal(projectAtSnapshot(fixtures, null), null);
  assert.equal(projectForClick(null, snapshot(), click()), null);
});

test('arrival waits through loading, stale rooms and absent puffle assets, and rejects lost sessions', async () => {
  const fixtures = validateFixtures(manifest());
  const loading = Object.assign(new Error('room-not-ready'), { code: 'room-not-ready' });
  const queue = [loading, { ...snapshot(), roomId: 100 }, { ...snapshot(), puffles: [] }, snapshot()];
  let time = 0;
  const clock = { now: () => time, pause: async ms => { time += ms; } };
  const read = () => { const next = queue.shift(); if (next instanceof Error) throw next; return next; };
  assert.equal((await waitForArrival(read, fixtures, fixtures.projects[0], clock)).roomId, 2105);
  assert.equal(time, 1000);
  await assert.rejects(waitForArrival(() => { throw new Error('visitor-mismatch'); }, fixtures, fixtures.projects[0], clock), /visitor-mismatch/);
  await assert.rejects(waitForArrival(() => ({ ...snapshot(), playerId: 103 }), fixtures, fixtures.projects[0], { ...clock, timeout: 500 }), /Travel did not confirm/);
});
