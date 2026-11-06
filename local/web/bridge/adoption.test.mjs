import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdoption } from './adoption.mjs';

const ID = '0b6f8a52-5f1e-4f53-9d0e-4b8e8b7e2a11';
const project = (id, name, extra = {}) => ({ id, name, capacity: { max: 10, puffles: 2, pending: 0 }, adoptionBlocked: null, ...extra });
const engine = (extra = {}) => ({ connected: true, snapshot: { visitor: { penguinId: 107 }, projects: [project('p1', 'Zeta App'), project('p2', 'Alpha App'),
  project('p3', 'Legacy', { adoptionBlocked: 'The migrated Atlas shares the Bridge Alpha owner.' })] }, ...extra });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function harness({ engineState = engine(), respond = {} } = {}) {
  const requests = [], sent = [], trips = [], timers = [];
  const adoption = createAdoption({
    getEngine: () => engineState,
    request: async (name, values) => {
      requests.push([name, values]);
      if (respond[name]) return respond[name](values);
      if (name === 'adopt') return { id: ID, ownerId: 201 };
      return {};
    },
    overlay: (name, ...args) => { sent.push([name, ...args]); return { ok: true }; },
    travel: async (projectId, options) => { trips.push([projectId, options]); },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  });
  return { adoption, requests, sent, trips, timers };
}

test('the picker lists every igloo with its capacity and why adoption is off', () => {
  const { adoption } = harness();
  const session = adoption.session();
  assert.deepEqual(session.destinations.map(item => [item.name, item.available]), [['Alpha App', true], ['Legacy', false], ['Zeta App', true]]);
  assert.equal(session.destinations[0].capacity, 10);
  assert.equal(adoption.choose('p3').ok, false);
  assert.match(adoption.choose('p3').message, /Bridge Alpha/);
  assert.equal(adoption.choose('missing').ok, false);
  assert.equal(adoption.choose('p1').ok, true);
  assert.equal(adoption.session().chosen, 'p1');
  assert.match(harness({ engineState: engine({ connected: false }) }).adoption.session().message, /offline/);
});

test('a purchase reserves, sends p#cpadopt once, and reports the receipt to the engine', async () => {
  const { adoption, requests, sent } = harness();
  assert.equal(adoption.buy(0, 0, 'Pebble').ok, false, 'a destination comes first');
  adoption.choose('p2');
  assert.equal(adoption.buy(0, 1006, 'Rex').ok, true);
  assert.equal(adoption.buy(0, 1006, 'Rex').ok, false, 'pressing buy twice sends nothing more');
  await tick();
  assert.deepEqual(requests[0], ['adopt', { projectId: 'p2', typeId: 0, subtypeId: 1006, name: 'Rex' }]);
  assert.deepEqual(sent, [['cpBridgeAdopt', ID, 0, 'Rex', 1006]]);
  assert.equal(adoption.status().state, 'pending');
  adoption.onReply({ type: 'adoption-result', ok: true, adoptionId: 'another', puffleId: 9 });
  assert.equal(adoption.status().state, 'pending', 'a reply for another adoption is ignored');
  adoption.onReply({ type: 'adoption-result', ok: true, adoptionId: ID, puffleId: 41, typeId: 0, subtypeId: 1006, name: 'Rex', coins: 4200, cost: 800, createdAt: 1800000000 });
  assert.deepEqual(adoption.status().receipt, { puffleId: 41, typeId: 0, subtypeId: 1006, name: 'Rex', coins: 4200, cost: 800, createdAt: 1800000000 });
  assert.equal(adoption.status().destination, 'Alpha App');
  await tick();
  assert.deepEqual(requests.at(-1), ['adoptionResult', { adoptionId: ID, result: { ok: true, puffleId: 41, typeId: 0, subtypeId: 1006, name: 'Rex', coins: 4200, cost: 800, createdAt: 1800000000 } }]);
});

test('a refusal is shown with the game\'s reason and withdrawn at the engine', async () => {
  const { adoption, requests } = harness();
  adoption.choose('p1');
  adoption.buy(3, 0, 'Moss');
  await tick();
  adoption.onReply({ type: 'adoption-result', ok: false, adoptionId: ID, code: '401' });
  assert.deepEqual([adoption.status().state, adoption.status().code], ['failed', '401']);
  assert.match(adoption.status().message, /more coins/);
  await tick();
  assert.deepEqual(requests.at(-1), ['adoptionResult', { adoptionId: ID, result: { ok: false, code: '401' } }]);
  assert.equal(adoption.buy(3, 0, 'Moss').ok, true, 'a failed purchase can be tried again');
});

test('invalid requests and engine refusals never reach the game', async () => {
  const refusing = harness({ respond: { adopt: () => { throw new Error('This igloo already has 10 puffles.'); } } });
  refusing.adoption.choose('p1');
  for (const [type, subtype, name] of [[10, 0, 'Rainbow'], [0, 1007, 'Cat'], [0, 0, 'Two Words'], [0, 0, '']]) {
    assert.equal(refusing.adoption.buy(type, subtype, name).ok, false);
  }
  refusing.adoption.buy(0, 0, 'Atlas');
  await tick();
  assert.deepEqual(refusing.sent, []);
  assert.match(refusing.adoption.status().message, /already has 10 puffles/);
});

test('a lost reply is resolved by the engine\'s receipt check, never by guessing', async () => {
  const found = harness({ respond: { reconcile: () => ({ adoptions: [{ id: ID, state: 'bound', receipt: { puffleId: 41, name: 'Atlas', coinsAfter: 4600, cost: 400, createdAt: 1 } }] }) } });
  found.adoption.choose('p1');
  found.adoption.buy(0, 0, 'Atlas');
  await tick();
  assert.equal(found.timers[0].ms, 20000);
  found.timers[0].fn();
  await tick();
  assert.deepEqual([found.adoption.status().state, found.adoption.status().receipt.puffleId], ['done', 41]);
  const missing = harness({ respond: { reconcile: () => ({ adoptions: [{ id: ID, state: 'charged' }] }) } });
  missing.adoption.choose('p1');
  missing.adoption.buy(0, 0, 'Atlas');
  await tick();
  missing.timers[0].fn();
  await tick();
  assert.deepEqual([missing.adoption.status().state, missing.adoption.status().code], ['failed', 'lost']);
  assert.deepEqual(missing.requests.at(-1), ['cancelAdoption', { adoptionId: ID }], 'the stale reservation stops blocking new adoptions');
});

test('closing before buying cancels the reservation; finishing travels to the new puffle after the module closes', async () => {
  const early = harness();
  early.adoption.choose('p1');
  early.adoption.buy(0, 0, 'Atlas');
  early.adoption.closed();
  await tick();
  assert.deepEqual(early.requests.map(([name]) => name), ['adopt', 'cancelAdoption'], 'a reservation without a purchase is withdrawn');
  assert.deepEqual(early.sent, []);
  const done = harness();
  done.adoption.choose('p1');
  done.adoption.buy(0, 0, 'Atlas');
  await tick();
  done.adoption.onReply({ type: 'adoption-result', ok: true, adoptionId: ID, puffleId: 41, typeId: 0, subtypeId: 0, name: 'Atlas', coins: 4600, cost: 400, createdAt: 1 });
  assert.equal(done.adoption.finish().ok, true);
  done.adoption.closed();
  const travel = done.timers.find(timer => timer.ms === 800);
  await travel.fn();
  assert.deepEqual(done.trips, [['p1', { force: true, puffleId: 41 }]]);
  assert.equal(done.adoption.status().state, 'idle');
  assert.equal(done.adoption.session().chosen, '');
});
