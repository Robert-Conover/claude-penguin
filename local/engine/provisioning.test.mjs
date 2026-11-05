// Engine setup lifecycle with an injected fake provisioner: no Docker, game, or Claude needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createManager } from './manager.mjs';
import { ProvisionError } from './game.mjs';
import { SECRETS_FILE } from './game-secrets.mjs';
import { acquirePublication } from './publication.mjs';
import { migrateStateDir } from './state.mjs';
import { FakePty, fakeGame, legacyState, sandbox } from './testing.mjs';

async function engine(t, { game = fakeGame(), ...extra } = {}) {
  const s = sandbox(t, 'penguin-provision-');
  const stateDir = path.join(s.dir, 'state');
  const publicationDir = path.join(s.dir, 'native-igloos');
  const warnings = [];
  const e = { ...s, stateDir, publicationDir, game, warnings, manager: null };
  e.options = () => ({ stateDir, worktreeRoot: path.join(s.dir, 'worktrees'), gitEnv: s.gitEnv, hookBaseUrl: 'http://localhost:8081/engine/hooks',
    ptySpawn: () => new FakePty(), game, onWarning: message => warnings.push(message), ...extra,
    publisher: acquirePublication({ dir: publicationDir, stateDir }) });
  e.open = async () => { e.manager = await createManager(e.options()); return e.manager; };
  e.restart = async () => { await e.manager.close(); e.manager = null; return e.open(); };
  await e.open();
  s.cleanup(() => e.manager?.close());
  e.view = () => e.manager.snapshot();
  e.project = id => e.view().projects.find(project => project.id === id);
  e.published = () => JSON.parse(fs.readFileSync(path.join(publicationDir, 'published.json'), 'utf8'));
  e.secrets = () => JSON.parse(fs.readFileSync(path.join(stateDir, SECRETS_FILE), 'utf8'));
  e.saved = () => fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8');
  e.add = async (name, puffle) => {
    const project = await e.manager.registerProject({ path: s.repo(name), name: undefined });
    const worker = await e.manager.createWorker({ projectId: project.id, name: puffle });
    await e.manager.settled(project.id);
    return { project: e.project(project.id), worker: e.view().workers.find(item => item.id === worker.id) };
  };
  return e;
}

test('setup provisions a dedicated owner, adopts the puffle, verifies it, and only then reaches ready', async t => {
  const e = await engine(t);
  let secretsAtOwner;
  e.game.before.owner = () => { secretsAtOwner = e.secrets(); };
  const { project, worker } = await e.add('alpha-app', 'nOVA');
  assert.equal(project.setup.phase, 'ready');
  assert.deepEqual(project.game, { source: 'managed', status: 'ready', ownerId: 201, iglooId: 9, roomId: 2201, puffleId: 31, puffleName: 'Nova',
    fixtureId: null, verifiedAt: project.game.verifiedAt });
  assert.ok(project.game.verifiedAt);
  assert.equal(worker.name, 'Nova', 'the worker records the server-normalized adopted name');
  assert.deepEqual(e.view().visitor, { penguinId: 107, username: 'bridgecheck', verifiedAt: e.view().visitor.verifiedAt });
  assert.deepEqual(e.game.calls.map(([op]) => op), ['visitor', 'owner', 'igloo', 'verify']);
  // The marker and credentials were durable before the owner was created.
  const credentials = e.secrets().owners[project.id];
  assert.deepEqual(secretsAtOwner.owners[project.id], credentials);
  assert.match(credentials.username, /^cp[a-z0-9]{10}$/);
  assert.equal(e.game.calls[1][1].nickname, 'alpha-app', 'the project name becomes the owner nickname');
  assert.equal(fs.statSync(path.join(e.stateDir, SECRETS_FILE)).mode & 0o777, 0o600);
  for (const secret of [credentials.username, credentials.password, credentials.marker]) {
    assert.equal(e.saved().includes(secret), false, 'state.json holds no credentials or markers');
    assert.equal(JSON.stringify(e.view()).includes(secret), false, 'snapshots hold no credentials or markers');
    assert.equal(fs.readFileSync(path.join(e.publicationDir, 'published.json'), 'utf8').includes(secret), false);
  }
  assert.deepEqual(e.published(), { version: 1, visitorId: 107, igloos: [{ ownerId: 201, iglooId: 9 }] });
  for (const [op, args] of e.game.calls) if (op === 'igloo') assert.notEqual(args.username, 'bridgecheck', 'never authenticates as the visitor');
});

test('a rejected puffle name fails explicitly, accepts a correction, and never creates a second owner', async t => {
  const e = await engine(t);
  const { project } = await e.add('beta', 'Badword');
  assert.equal(project.setup.phase, 'failed');
  assert.equal(project.setup.correction, 'puffleName');
  assert.equal(project.setup.retryable, true);
  assert.equal(project.game.status, 'failed');
  assert.deepEqual(e.published().igloos, [], 'failed mappings are not published');
  await assert.rejects(e.manager.retrySetup({ projectId: project.id, puffleName: 'no digits 1' }), /1 to 12 letters/);
  await e.manager.retrySetup({ projectId: project.id, puffleName: 'comet' });
  const fixed = await e.manager.settled(project.id);
  assert.equal(fixed.setup.phase, 'ready');
  assert.equal(fixed.game.puffleName, 'Comet');
  assert.equal(e.game.db.owners.length, 1, 'the same marked owner was reused');
  await assert.rejects(e.manager.retrySetup({ projectId: project.id, puffleName: 'Other' }), /not waiting for a retry/);
});

test('transient failures and engine restarts retry against the same marked owner and adopted puffle', async t => {
  const e = await engine(t);
  e.game.fail.igloo = new ProvisionError('The game server is unavailable on port 9875. Start the game with ./local/start.', 'UNAVAILABLE');
  const { project } = await e.add('gamma', 'Pixel');
  assert.equal(project.setup.phase, 'failed');
  assert.equal(project.game.status, 'failed');
  assert.equal(project.game.ownerId, 201, 'progress is persisted');
  assert.equal(project.setup.correction, null);
  const credentials = e.secrets().owners[project.id];

  // The engine stops mid-provisioning; startup marks it failed and retryable.
  e.game.before.igloo = () => new Promise(() => {});
  await e.manager.retrySetup({ projectId: project.id });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(e.project(project.id).game.status, 'provisioning');
  await e.manager.close();
  e.manager = null;
  e.game.before.igloo = null;
  await e.open();
  assert.equal(e.project(project.id).setup.phase, 'failed');
  assert.equal(e.project(project.id).game.status, 'failed');
  await e.manager.retrySetup({ projectId: project.id });
  const ready = await e.manager.settled(project.id);
  assert.equal(ready.setup.phase, 'ready');
  assert.deepEqual(e.secrets().owners[project.id], credentials, 'credentials are never regenerated on retry');
  assert.equal(e.game.db.owners.length, 1);
  const owners = e.game.calls.filter(([op]) => op === 'owner').map(([, args]) => args.marker);
  assert.ok(owners.length >= 2 && owners.every(marker => marker === credentials.marker));
});

test('username collisions regenerate and persist a new username before retrying', async t => {
  const e = await engine(t);
  e.game.before.owner = args => { if (e.game.calls.filter(([op]) => op === 'owner').length === 1) e.game.db.taken.add(args.username); };
  const { project } = await e.add('delta', 'Echo');
  assert.equal(project.setup.phase, 'ready');
  const usernames = e.game.calls.filter(([op]) => op === 'owner').map(([, args]) => args.username);
  assert.equal(usernames.length, 2);
  assert.notEqual(usernames[0], usernames[1]);
  assert.equal(e.secrets().owners[project.id].username, usernames[1]);
});

test('mismatched identities need repair, are never remapped, and leave publication', async t => {
  const e = await engine(t);
  const { project } = await e.add('epsilon', 'Maple');
  assert.deepEqual(e.published().igloos, [{ ownerId: 201, iglooId: 9 }]);
  // The game database changed behind the engine: the marked owner now has another puffle.
  e.game.db.owners[0].pets.push({ id: 99, name: 'Intruder' });
  assert.deepEqual(await e.manager.verifyGameMappings(), { checked: 1, repair: 1 });
  let view = e.project(project.id);
  assert.equal(view.game.status, 'repair');
  assert.equal(view.setup.phase, 'failed');
  assert.match(view.setup.error, /no longer verifies/);
  assert.deepEqual(e.published().igloos, [], 'repair mappings are not published');
  e.game.db.owners[0].pets.pop();
  e.game.db.owners[0].ownerId = 555; // A different penguin answers for the same marker.
  await e.manager.retrySetup({ projectId: project.id });
  view = await e.manager.settled(project.id);
  assert.equal(view.game.status, 'repair');
  assert.equal(view.game.ownerId, 201, 'the recorded owner is never replaced');
  assert.match(view.setup.error, /not the recorded 201/);
});

test('a changed visitor identity fails explicitly; other projects still publish only verified owners', async t => {
  const e = await engine(t);
  await e.add('zeta', 'Orbit');
  e.game.db.visitorId = 999;
  await assert.rejects(e.manager.verifyGameMappings(), /not the recorded 107/);
  assert.equal(e.view().visitor.penguinId, 107);
  assert.deepEqual(e.published(), { version: 1, visitorId: 107, igloos: [{ ownerId: 201, iglooId: 9 }] });
});

test('the legacy Atlas fixture mapping is published and needs no provisioning; clean shutdown empties the list', async t => {
  const e = await engine(t);
  const source = e.repo('legacy');
  await e.manager.close();
  fs.writeFileSync(path.join(e.stateDir, 'state.json'), JSON.stringify(legacyState(source)));
  migrateStateDir(e.stateDir);
  await e.open();
  assert.deepEqual(e.published(), { version: 1, visitorId: null, igloos: [] }, 'nothing is published before the visitor is verified');
  await e.manager.verifyGameMappings();
  assert.deepEqual(e.published(), { version: 1, visitorId: 107, igloos: [{ ownerId: 105, iglooId: 4 }] });
  const project = e.view().projects[0];
  e.game.calls.length = 0;
  await e.manager.createWorker({ projectId: project.id });
  assert.equal((await e.manager.settled(project.id)).setup.phase, 'ready');
  assert.deepEqual(e.game.calls, [], 'a ready legacy mapping is not reprovisioned');
  await e.manager.close();
  e.manager = null;
  assert.deepEqual(e.published(), { version: 1, visitorId: 107, igloos: [] });
  assert.equal(fs.existsSync(path.join(e.publicationDir, 'owner.lock')), false);
});

test('two projects get distinct owners; a second engine cannot take over publication', async t => {
  const e = await engine(t);
  const one = await e.add('one', 'Atlas');
  const two = await e.add('two', 'Atlas');
  assert.notEqual(one.project.game.ownerId, two.project.game.ownerId);
  assert.deepEqual(e.published().igloos.map(item => item.ownerId), [201, 202]);
  assert.throws(() => acquirePublication({ dir: e.publicationDir, stateDir: path.join(e.dir, 'other-state') }), /owns native igloo publication/);
  assert.deepEqual(e.published().igloos.map(item => item.ownerId), [201, 202]);
});
