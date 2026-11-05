import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFixtures, projectAtSnapshot, projectForClick, waitForArrival, agentMappings, mappingKey, flashConfiguration,
  freshSnapshot, selectionForClick, roomAnimation, activeMappingsFor, needsConfiguration } from './model.mjs';
import { engineSnapshot, PROJECT_A, PROJECT_B, PRIVATE } from './testing.mjs';

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

// ------------------------------------------------------------ agent mode (Stage 2)

const room = (generation, extra = {}) => ({ ok: true, version: 2, configured: true, generation, playerId: 107, ownerId: 105, roomId: 2105, puffles: [{ id: 4 }], ...extra });
const agentClick = (generation, extra = {}) => ({ type: 'puffle-click', projectId: PROJECT_A, ownerId: 105, puffleId: 4, generation, ...extra });

test('agent mappings need a verified visitor, allow an empty neighborhood, and ignore the fixture manifest', () => {
  assert.equal(agentMappings(engineSnapshot({ visitor: false })), null);
  assert.equal(agentMappings({ ...engineSnapshot(), visitor: { penguinId: 107, username: 'bridgecheck' } }), null, 'unverified visitor');
  assert.equal(agentMappings(undefined), null);
  const empty = agentMappings(engineSnapshot({ projects: [] }));
  assert.deepEqual(empty.projects, []);
  assert.deepEqual(empty.visitor, { username: 'bridgecheck', penguinId: 107 });
  assert.deepEqual(flashConfiguration(empty), { visitorId: 107, projects: [] });
  assert.notEqual(mappingKey(empty), '', 'an empty neighborhood is still a configuration');
  assert.equal(mappingKey(null), '');
});

test('only ready mappings are used, identified by project UUID, with no private engine fields', () => {
  const mappings = agentMappings(engineSnapshot());
  assert.deepEqual(mappings.projects.map(item => item.projectId), [PROJECT_A, PROJECT_B], 'provisioning mapping is excluded');
  assert.deepEqual(Object.keys(mappings.projects[0]).sort(), ['iglooId', 'name', 'ownerId', 'projectId', 'puffleId', 'puffleName', 'roomId']);
  assert.doesNotMatch(JSON.stringify(mappings), PRIVATE);
  const flash = flashConfiguration(mappings);
  assert.deepEqual(flash, { visitorId: 107, projects: [
    { projectId: PROJECT_A, ownerId: 105, puffleId: 4 }, { projectId: PROJECT_B, ownerId: 106, puffleId: 5 }] });
  for (const status of ['provisioning', 'failed', 'repair']) {
    const data = engineSnapshot({ projects: ['a'] });
    data.projects[0].game.status = status;
    assert.deepEqual(agentMappings(data).projects, []);
  }
});

test('invalid or ambiguous mappings are excluded rather than resolved to the first project', () => {
  const duplicate = engineSnapshot({ projects: ['a', 'b'] });
  duplicate.projects[1].game.ownerId = 105;
  duplicate.projects[1].game.roomId = 2105;
  const result = agentMappings(duplicate);
  assert.deepEqual(result.projects, []);
  assert.deepEqual(result.rejected.map(item => item.reason), ['duplicate-game-identity', 'duplicate-game-identity']);
  for (const change of [
    project => { project.id = 'bridge-alpha'; },
    project => { project.game.roomId = 4; },
    project => { project.game.ownerId = 107; project.game.roomId = 2107; },
    project => { project.game.puffleId = 4.5; },
    project => { project.game.puffleName = ''; },
  ]) {
    const data = engineSnapshot({ projects: ['a', 'b'] });
    change(data.projects[0]);
    const mapped = agentMappings(data);
    assert.deepEqual(mapped.projects.map(item => item.projectId), [PROJECT_B]);
    assert.equal(mapped.rejected.length, 1);
  }
});

test('adding a project without reload makes old controls stale until the overlay confirms the new generation', () => {
  const before = agentMappings(engineSnapshot({ projects: [] }));
  const configured = { key: mappingKey(before), generation: 1, mappings: before };
  assert.equal(needsConfiguration(mappingKey(before), configured, room(1, { ownerId: 0, roomId: 100, puffles: [] })), false);
  const engine = engineSnapshot({ projects: ['a'] });
  const after = agentMappings(engine);
  const key = mappingKey(after);
  assert.notEqual(key, configured.key);
  assert.equal(activeMappingsFor(key, configured), null, 'stale configuration routes nothing');
  assert.equal(needsConfiguration(key, configured, room(1)), true);
  assert.equal(selectionForClick(activeMappingsFor(key, configured), room(1), 1, agentClick(1), engine), null);
  const next = { key, generation: 2, mappings: after };
  assert.equal(needsConfiguration(key, next, room(2)), false);
  assert.equal(needsConfiguration(key, next, room(1)), true, 'an overlay that was reset is reconfigured');
  assert.equal(needsConfiguration(key, next, room(2, { configured: false })), true);
  // Old-generation snapshots and clicks stay rejected after reconfiguration.
  assert.equal(selectionForClick(activeMappingsFor(key, next), room(1), 2, agentClick(2), engine), null);
  assert.equal(selectionForClick(activeMappingsFor(key, next), room(2), 2, agentClick(1), engine), null);
  assert.deepEqual(selectionForClick(activeMappingsFor(key, next), room(2), 2, agentClick(2), engine), { projectId: PROJECT_A, workerId: 'worker-a' });
  // A reconnect that delivers identical mappings is not a change.
  assert.equal(mappingKey(agentMappings(structuredClone(engine))), key);
  const renamed = structuredClone(engine);
  renamed.projects[0].name = 'Renamed';
  assert.notEqual(mappingKey(agentMappings(renamed)), key, 'display changes reconfigure too');
});

test('clicks route by project UUID and current room to that project\'s active worker only', () => {
  const engine = engineSnapshot();
  const mappings = agentMappings(engine);
  const select = (game, event, data = engine) => selectionForClick(mappings, game, 3, event, data);
  assert.deepEqual(select(room(3), agentClick(3)), { projectId: PROJECT_A, workerId: 'worker-a' });
  for (const mismatch of [{ projectId: PROJECT_B }, { ownerId: 106 }, { puffleId: 5 }, { type: 'ready' }, { generation: undefined }]) {
    assert.equal(select(room(3), agentClick(3, mismatch)), null);
  }
  for (const mismatch of [{ playerId: 103 }, { ownerId: 106, roomId: 2106 }, { puffles: [] }, { ok: false }, { generation: 2 }]) {
    assert.equal(select(room(3, mismatch), agentClick(3)), null);
  }
  // Another project's worker is never substituted.
  const missing = structuredClone(engine);
  missing.workers = missing.workers.filter(item => item.id !== 'worker-a');
  assert.deepEqual(select(room(3), agentClick(3), missing), { projectId: PROJECT_A, workerId: null });
  const archived = structuredClone(engine);
  archived.projects[0].activeWorkerId = null;
  assert.deepEqual(select(room(3), agentClick(3), archived), { projectId: PROJECT_A, workerId: null });
  const foreign = structuredClone(engine);
  foreign.projects[0].activeWorkerId = 'worker-b';
  assert.deepEqual(select(room(3), agentClick(3), foreign), { projectId: PROJECT_A, workerId: null });
  const moved = structuredClone(engine);
  moved.projects[0].game.puffleId = 9;
  assert.equal(select(room(3), agentClick(3), moved), null, 'engine mapping changed after configuration');
  assert.equal(freshSnapshot(mappings, room(3), undefined), false);
});

test('animation is scoped to the mapped puffle in the current room and its own worker state', () => {
  const engine = engineSnapshot();
  const mappings = agentMappings(engine);
  assert.deepEqual({ ...roomAnimation(mappings, room(3), engine), identity: undefined }, { puffleId: 4, cue: 'working', identity: undefined });
  assert.equal(roomAnimation(mappings, room(3, { ownerId: 106, roomId: 2106, puffles: [{ id: 5 }] }), engine).cue, 'needs-you');
  assert.equal(roomAnimation(mappings, room(3, { ownerId: 0, roomId: 100, puffles: [] }), engine), null, 'Town animates nothing');
  assert.equal(roomAnimation(mappings, room(3, { puffles: [{ id: 5 }] }), engine), null, 'unrendered mapped puffle');
  assert.equal(roomAnimation(mappings, room(3, { ownerId: 108, roomId: 2108, puffles: [{ id: 6 }] }), engine), null, 'unmapped project');
  const idle = structuredClone(engine);
  idle.workers[0].status = 'idle';
  assert.equal(roomAnimation(mappings, room(3), idle), null, 'another worker needing attention does not animate this puffle');
  const review = structuredClone(engine);
  review.workers[0].status = 'review';
  assert.equal(roomAnimation(mappings, room(3), review).cue, 'ready');
  assert.notEqual(roomAnimation(mappings, room(3), engine).identity, roomAnimation(mappings, room(4), engine).identity, 'reconfiguration replays');
});

test('travel aborts when the mapping generation or browser mappings change before arrival', async () => {
  const mappings = agentMappings(engineSnapshot());
  let time = 0;
  const clock = { now: () => time, pause: async ms => { time += ms; } };
  const target = mappings.projects[0];
  assert.equal((await waitForArrival(() => room(3), mappings, target, { ...clock, generation: 3 })).roomId, 2105);
  await assert.rejects(waitForArrival(() => room(4), mappings, target, { ...clock, generation: 3 }), error => error.code === 'mapping-changed');
  let current = true;
  const read = () => { current = false; return room(3, { roomId: 100, ownerId: 0 }); };
  await assert.rejects(waitForArrival(read, mappings, target, { ...clock, generation: 3, current: () => current }), error => error.code === 'mapping-changed');
  assert.equal((await waitForArrival(() => room(3, { ownerId: 0, roomId: 100, puffles: [] }), mappings, null, { ...clock, generation: 3 })).roomId, 100, 'Town in an empty neighborhood');
});

test('the bridge lab keeps its fixture manifest and simulated identities', () => {
  const fixtures = validateFixtures(manifest());
  assert.deepEqual(flashConfiguration(fixtures), { visitorId: 107, projects: [
    { projectId: 'bridge-alpha', ownerId: 105, puffleId: 4 }, { projectId: 'bridge-beta', ownerId: 106, puffleId: 5 }] });
  assert.equal(mappingKey(fixtures), mappingKey(validateFixtures(manifest())));
  const one = manifest(); one.projects.pop();
  assert.throws(() => validateFixtures(one), 'the lab still requires exactly its two fixtures');
  assert.equal(agentMappings(manifest()), null, 'a fixture manifest carries no verified agent visitor');
  assert.equal(projectForClick(fixtures, snapshot(), click()).projectId, 'bridge-alpha');
});
