import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFixtures, projectAtSnapshot, projectForClick, puffleForClick, waitForArrival, agentMappings, mappingKey, flashConfiguration,
  freshSnapshot, selectionForClick, roomAnimations, activeMappingsFor, needsConfiguration, puffleForSlot, MAX_PUFFLES } from './model.mjs';
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
  assert.deepEqual(fixtures.projects[0].puffles.map(item => [item.puffleId, item.name, item.workerId]), [[4, 'Atlas', null]]);
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
  for (const mismatch of [{ projectId: 'bridge-beta' }, { ownerId: 106 }, { puffleId: 5 }, { type: 'ready' }, { slot: 999 }]) {
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

// ------------------------------------------------------------ agent mode

const room = (generation, extra = {}) => ({ ok: true, version: 5, configured: true, generation, playerId: 107, ownerId: 105, roomId: 2105, puffles: [{ id: 4 }, { id: 9 }], ...extra });
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

test('each ready mapping lists its bound puffles by project UUID, with stable slots and no private engine fields', () => {
  const mappings = agentMappings(engineSnapshot());
  assert.deepEqual(mappings.projects.map(item => item.projectId), [PROJECT_A, PROJECT_B], 'provisioning mapping is excluded');
  assert.deepEqual(Object.keys(mappings.projects[0]).sort(), ['iglooId', 'name', 'ownerId', 'projectId', 'puffles', 'roomId']);
  const [atlas, pebble] = mappings.projects[0].puffles;
  assert.deepEqual([atlas.puffleId, atlas.name, atlas.workerId, pebble.puffleId, pebble.color], [4, 'Atlas', 'worker-a', 9, 'green']);
  assert.notEqual(atlas.slot, pebble.slot, 'each puffle has its own draft slot');
  assert.deepEqual(agentMappings(engineSnapshot()).projects[0].puffles.map(item => item.slot), [atlas.slot, pebble.slot], 'slots are stable');
  const flash = flashConfiguration(mappings);
  assert.deepEqual(flash, { visitorId: 107, projects: [
    { projectId: PROJECT_A, ownerId: 105, puffles: [{ puffleId: 4, slot: atlas.slot }, { puffleId: 9, slot: pebble.slot }] },
    { projectId: PROJECT_B, ownerId: 106, puffles: [{ puffleId: 5, slot: mappings.projects[1].puffles[0].slot }] }] });
  assert.doesNotMatch(JSON.stringify(flash), PRIVATE, 'Flash never receives worker or session identities');
  assert.deepEqual(puffleForSlot(mappings, PROJECT_A, pebble.slot).puffle.workerId, 'worker-a2');
  assert.equal(puffleForSlot(mappings, PROJECT_B, pebble.slot), null, 'a slot belongs to one project');
  for (const status of ['provisioning', 'failed', 'repair']) {
    const data = engineSnapshot({ projects: ['a'] });
    data.projects[0].game.status = status;
    assert.deepEqual(agentMappings(data).projects, []);
  }
  const empty = engineSnapshot({ projects: ['a'] });
  empty.workers = [];
  assert.deepEqual(agentMappings(empty).projects[0].puffles, [], 'an empty project igloo is still a destination');
});

test('a legacy fixture puffle without an isolated worker is shown, unbound', () => {
  const data = engineSnapshot({ projects: ['b'] });
  data.workers = [];
  const [project] = agentMappings(data).projects;
  assert.deepEqual(project.puffles.map(item => [item.puffleId, item.name, item.workerId]), [[5, 'Comet', null]]);
});

test('invalid or ambiguous mappings are excluded rather than resolved to the first project', () => {
  const duplicate = engineSnapshot({ projects: ['a', 'b'] });
  duplicate.projects[1].game.ownerId = 105;
  duplicate.projects[1].game.roomId = 2105;
  const result = agentMappings(duplicate);
  assert.deepEqual(result.projects, []);
  assert.deepEqual(result.rejected.map(item => item.reason), ['duplicate-game-identity', 'duplicate-game-identity']);
  const sharedPuffle = engineSnapshot({ projects: ['a', 'b'] });
  sharedPuffle.workers.find(item => item.id === 'worker-b').puffle.puffleId = 9;
  assert.deepEqual(agentMappings(sharedPuffle).projects, [], 'one puffle claimed by two projects excludes both');
  for (const change of [
    data => { data.projects[0].id = 'bridge-alpha'; },
    data => { data.projects[0].game.roomId = 4; },
    data => { data.projects[0].game.ownerId = 107; data.projects[0].game.roomId = 2107; },
    data => { data.workers[0].puffle.puffleId = 1_000_000_000; },
    data => { data.workers[0].name = ''; },
    data => { for (let index = 0; index < MAX_PUFFLES; index++) data.workers.push({ ...data.workers[0], id: `extra-${index}`, puffle: { ...data.workers[0].puffle, puffleId: 500 + index } }); },
  ]) {
    const data = engineSnapshot({ projects: ['a', 'b'] });
    change(data);
    const mapped = agentMappings(data);
    assert.deepEqual(mapped.projects.map(item => item.projectId), [PROJECT_B]);
    assert.equal(mapped.rejected.length, 1);
  }
});

test('adding a project or a puffle without reload makes old controls stale until the overlay confirms the new generation', () => {
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
  // A reconnect that delivers identical mappings is not a change; a new adopted puffle is.
  assert.equal(mappingKey(agentMappings(structuredClone(engine))), key);
  const adopted = structuredClone(engine);
  adopted.workers.push({ ...adopted.workers[0], id: 'worker-new', name: 'Moss', puffle: { ...adopted.workers[0].puffle, puffleId: 12 } });
  assert.notEqual(mappingKey(agentMappings(adopted)), key, 'an adopted puffle reconfigures the overlay');
  const renamed = structuredClone(engine);
  renamed.projects[0].name = 'Renamed';
  assert.notEqual(mappingKey(agentMappings(renamed)), key, 'display changes reconfigure too');
});

test('clicks route by project UUID, current room, and puffle to exactly that puffle\'s worker', () => {
  const engine = engineSnapshot();
  const mappings = agentMappings(engine);
  const select = (game, event, data = engine) => selectionForClick(mappings, game, 3, event, data);
  assert.deepEqual(select(room(3), agentClick(3)), { projectId: PROJECT_A, workerId: 'worker-a' });
  assert.deepEqual(select(room(3), agentClick(3, { puffleId: 9 })), { projectId: PROJECT_A, workerId: 'worker-a2' }, 'a second puffle selects its own worker');
  for (const mismatch of [{ projectId: PROJECT_B }, { ownerId: 106 }, { puffleId: 5 }, { type: 'ready' }, { generation: undefined }]) {
    assert.equal(select(room(3), agentClick(3, mismatch)), null);
  }
  for (const mismatch of [{ playerId: 103 }, { ownerId: 106, roomId: 2106 }, { puffles: [] }, { ok: false }, { generation: 2 }]) {
    assert.equal(select(room(3, mismatch), agentClick(3)), null);
  }
  assert.equal(select(room(3, { puffles: [{ id: 9 }] }), agentClick(3)), null, 'an unrendered puffle is not clickable');
  // Another worker is never substituted.
  const missing = structuredClone(engine);
  missing.workers = missing.workers.filter(item => item.id !== 'worker-a');
  assert.equal(select(room(3), agentClick(3), missing), null, 'the mapped worker is gone');
  const rebound = structuredClone(engine);
  rebound.workers.find(item => item.id === 'worker-a').puffle.puffleId = 77;
  assert.equal(select(room(3), agentClick(3), rebound), null, 'engine binding changed after configuration');
  const unready = structuredClone(engine);
  unready.projects[0].game.status = 'repair';
  assert.equal(select(room(3), agentClick(3), unready), null);
  assert.equal(freshSnapshot(mappings, room(3), undefined), false);
});

test('each puffle in the current room animates from its own worker state', () => {
  const engine = engineSnapshot();
  const mappings = agentMappings(engine);
  const cues = game => roomAnimations(mappings, game, engine).map(cue => [cue.puffleId, cue.cue]);
  assert.deepEqual(cues(room(3)), [[4, 'working'], [9, 'ready']]);
  assert.deepEqual(cues(room(3, { puffles: [{ id: 9 }] })), [[9, 'ready']], 'unrendered puffles do not animate');
  assert.deepEqual(roomAnimations(mappings, room(3, { ownerId: 106, roomId: 2106, puffles: [{ id: 5 }] }), engine).map(cue => cue.cue), ['needs-you']);
  assert.deepEqual(roomAnimations(mappings, room(3, { ownerId: 0, roomId: 100, puffles: [] }), engine), [], 'Town animates nothing');
  assert.deepEqual(roomAnimations(mappings, room(3, { ownerId: 108, roomId: 2108, puffles: [{ id: 6 }] }), engine), [], 'unmapped project');
  const idle = structuredClone(engine);
  idle.workers[0].status = 'idle';
  assert.deepEqual(roomAnimations(mappings, room(3), idle).map(cue => cue.puffleId), [9], 'a sibling\'s state never animates this puffle');
  assert.notEqual(roomAnimations(mappings, room(3), engine)[0].identity, roomAnimations(mappings, room(4), engine)[0].identity, 'reconfiguration replays');
});

test('travel aborts when the mapping changes, and can wait for one new puffle to render', async () => {
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
  const queue = [room(3, { puffles: [{ id: 4 }] }), room(3)];
  assert.equal((await waitForArrival(() => queue.shift(), mappings, target, { ...clock, generation: 3, puffleId: 9 })).puffles.length, 2, 'waits for the adopted puffle');
  const empty = { ...target, puffles: [] };
  assert.equal((await waitForArrival(() => room(3, { puffles: [] }), mappings, empty, { ...clock, generation: 3 })).roomId, 2105, 'an empty igloo is reached by its room');
});

test('the bridge lab keeps its fixture manifest and simulated identities', () => {
  const fixtures = validateFixtures(manifest());
  const config = flashConfiguration(fixtures);
  assert.deepEqual(config.projects.map(item => [item.projectId, item.ownerId, item.puffles.map(puffle => puffle.puffleId)]),
    [['bridge-alpha', 105, [4]], ['bridge-beta', 106, [5]]]);
  assert.equal(mappingKey(fixtures), mappingKey(validateFixtures(manifest())));
  const one = manifest(); one.projects.pop();
  assert.throws(() => validateFixtures(one), 'the lab still requires exactly its two fixtures');
  assert.equal(agentMappings(manifest()), null, 'a fixture manifest carries no verified agent visitor');
  assert.equal(puffleForClick(fixtures, snapshot(), click()).puffle.name, 'Atlas');
});

test('mappings use the overlay ID bounds, so one out-of-range project is hidden alone', () => {
  const data = engineSnapshot({ projects: ['a', 'b'] });
  Object.assign(data.projects[1].game, { ownerId: 1_000_000_000, roomId: 1_000_002_000 });
  const mappings = agentMappings(data);
  assert.deepEqual(mappings.projects.map(project => project.projectId), [PROJECT_A]);
  assert.deepEqual(mappings.rejected, [{ projectId: PROJECT_B, reason: 'invalid-mapping' }]);
  const nearLimit = engineSnapshot({ projects: ['a'] });
  Object.assign(nearLimit.projects[0].game, { ownerId: 999_999_000, roomId: 1_000_001_000 });
  assert.equal(agentMappings(nearLimit).projects.length, 0);
  const edge = engineSnapshot({ projects: ['a'] });
  Object.assign(edge.projects[0].game, { ownerId: 999_997_999, roomId: 999_999_999, iglooId: 1_000_000_000 });
  edge.workers[0].puffle.puffleId = 999_999_999;
  assert.equal(agentMappings(edge).projects.length, 1, 'the largest IDs the overlay accepts; layouts stay in the browser');
  const visitor = engineSnapshot();
  visitor.visitor.penguinId = 1_000_000_000;
  assert.equal(agentMappings(visitor), null);
  const fixture = manifest();
  fixture.projects[1].puffleId = 1_000_000_000;
  assert.throws(() => validateFixtures(fixture));
});

test('Flash configuration refuses more mappings than the overlay accepts instead of truncating them', () => {
  const ready = count => ({ ...engineSnapshot({ projects: [] }), projects: Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, name: `Project ${index}`,
    game: { status: 'ready', ownerId: 200 + index, iglooId: 500 + index, roomId: 2200 + index } })) });
  assert.equal(flashConfiguration(agentMappings(ready(32))).projects.length, 32);
  assert.throws(() => flashConfiguration(agentMappings(ready(33))), { code: 'too-many-projects', message: /33 project igloos.*at most 32/ });
});
