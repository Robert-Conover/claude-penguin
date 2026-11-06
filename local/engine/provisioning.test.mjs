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
  /** Register a repository; its empty igloo is provisioned in the background. */
  e.add = async name => {
    const project = await e.manager.registerProject({ path: s.repo(name), name: undefined });
    await e.manager.settled(project.id);
    return { project: e.project(project.id) };
  };
  /** The visitor's purchase against the published reservation, reported back as the browser would. */
  e.adopt = async (projectId, name, typeId = 0, subtypeId = 0) => {
    const adoption = await e.manager.reserveAdoption({ projectId, typeId, subtypeId, name });
    const reply = e.game.purchase(e.published(), { adoptionId: adoption.id, typeId, subtypeId, name });
    const reported = await e.manager.reportAdoption({ adoptionId: adoption.id, result: reply });
    await e.manager.settled(projectId);
    return { adoption: reported, reply, worker: e.view().workers.find(item => item.id === adoption.workerId) };
  };
  return e;
}

test('setup provisions a dedicated owner and an empty locked igloo, verifies it, and only then reaches ready', async t => {
  const e = await engine(t);
  let secretsAtOwner;
  e.game.before.owner = () => { secretsAtOwner = e.secrets(); };
  const { project } = await e.add('alpha-app');
  assert.equal(project.setup.phase, 'ready');
  assert.deepEqual(project.game, { source: 'managed', status: 'ready', ownerId: 201, iglooId: 9, roomId: 2201, puffleId: null, puffleName: null,
    fixtureId: null, verifiedAt: project.game.verifiedAt });
  assert.ok(project.game.verifiedAt);
  assert.deepEqual(e.view().visitor, { penguinId: 107, username: 'bridgecheck', verifiedAt: e.view().visitor.verifiedAt });
  assert.deepEqual(e.game.calls.map(([op]) => op), ['visitor', 'owner', 'igloo', 'verify']);
  assert.deepEqual(e.game.calls[3][1][0].puffles, [], 'an empty igloo verifies as exactly empty');
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
  assert.deepEqual(e.published(), { version: 2, visitorId: 107, igloos: [{ ownerId: 201, iglooId: 9 }], adoptions: [] });
  for (const [op, args] of e.game.calls) if (op === 'igloo') assert.notEqual(args.username, 'bridgecheck', 'never authenticates as the visitor');
});

test('an adopted puffle joins the recorded set; verification then requires exactly that set', async t => {
  const e = await engine(t);
  const { project } = await e.add('beta');
  const reservation = await e.manager.reserveAdoption({ projectId: project.id, typeId: 0, subtypeId: 1006, name: 'rex' });
  assert.deepEqual(e.published().adoptions.map(item => [item.adoptionId, item.ownerId]), [[reservation.id, 201]], 'the reservation is published for the world server');
  await e.manager.cancelAdoption({ adoptionId: reservation.id });
  assert.deepEqual(e.published().adoptions, []);
  const { worker } = await e.adopt(project.id, 'rex', 0, 1006);
  assert.deepEqual([worker.name, worker.puffle.subtypeId], ['Rex', 1006]);
  assert.deepEqual((await e.manager.verifyGameMappings()), { checked: 1, repair: 0, visitorProblem: null });
  const verified = e.game.calls.filter(([op]) => op === 'verify').at(-1)[1][0];
  assert.deepEqual(verified.puffles, [{ puffleId: worker.puffle.puffleId, name: 'Rex', puffleType: 1006 }]);
  // A filtered name is refused by the game; nothing is charged and the reservation is withdrawn.
  const coins = e.game.db.coins;
  const refused = await e.adopt(project.id, 'Badword');
  assert.deepEqual([refused.reply.code, refused.adoption.state], ['441', 'withdrawn']);
  assert.equal(e.game.db.coins, coins);
  assert.equal(e.view().workers.length, 1);
});

test('transient failures and engine restarts retry against the same marked owner and adopted puffle', async t => {
  const e = await engine(t);
  e.game.fail.igloo = new ProvisionError('The game server is unavailable on port 9875. Start the game with ./local/start.', 'UNAVAILABLE');
  const { project } = await e.add('gamma');
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
  const { project } = await e.add('delta');
  assert.equal(project.setup.phase, 'ready');
  const usernames = e.game.calls.filter(([op]) => op === 'owner').map(([, args]) => args.username);
  assert.equal(usernames.length, 2);
  assert.notEqual(usernames[0], usernames[1]);
  assert.equal(e.secrets().owners[project.id].username, usernames[1]);
});

test('mismatched identities need repair, are never remapped, and leave publication', async t => {
  const e = await engine(t);
  const { project } = await e.add('epsilon');
  await e.adopt(project.id, 'Maple');
  assert.deepEqual(e.published().igloos, [{ ownerId: 201, iglooId: 9 }]);
  // The game database changed behind the engine: the marked owner now has an unrecorded puffle.
  e.game.db.owners[0].pets.push({ id: 99, name: 'Intruder', puffleType: 0, backyard: false });
  assert.deepEqual(await e.manager.verifyGameMappings(), { checked: 1, repair: 1, visitorProblem: null });
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

test('a changed visitor withdraws publication and is reported unverified until it verifies again; nothing is remapped', async t => {
  const e = await engine(t);
  const { project } = await e.add('zeta');
  const published = { version: 2, visitorId: 107, igloos: [{ ownerId: 201, iglooId: 9 }], adoptions: [] };
  // An unavailable stack keeps the last verified state.
  e.game.fail.visitor = new ProvisionError('The game stack is not running.', 'UNAVAILABLE');
  await assert.rejects(e.manager.verifyGameMappings(), /not running/);
  assert.equal(e.view().visitor.penguinId, 107);
  assert.deepEqual(e.published(), published);
  e.game.db.visitorId = 999;
  const result = await e.manager.verifyGameMappings();
  assert.match(result.visitorProblem, /not the recorded 107/);
  assert.deepEqual([result.checked, result.repair], [1, 0], 'owner mappings are still verified');
  assert.equal(e.view().visitor, null, 'the browser builds no mappings for an unverified visitor');
  assert.match(e.view().visitorProblem, /not the recorded 107/);
  assert.deepEqual(e.published(), { version: 2, visitorId: null, igloos: [], adoptions: [] }, 'publication is withdrawn');
  assert.equal(JSON.parse(e.saved()).visitor.penguinId, 107, 'the recorded visitor is never remapped');
  assert.equal(e.project(project.id).game.status, 'ready', 'project mappings do not move for a visitor problem');
  assert.deepEqual(e.game.calls.filter(([op]) => op === 'visitor').at(-1)[1], { penguinId: 107 }, 'the recorded visitor ID is sent so the service only verifies');
  e.game.fail.visitor = new ProvisionError('The game stack is not running.', 'UNAVAILABLE');
  await assert.rejects(e.manager.verifyGameMappings(), /not running/);
  assert.equal(e.view().visitor, null, 'an unavailable stack keeps the unverified state');
  e.game.db.visitorId = 107;
  assert.equal((await e.manager.verifyGameMappings()).visitorProblem, null);
  assert.equal(e.view().visitor.penguinId, 107);
  assert.equal(e.view().visitorProblem, null);
  assert.deepEqual(e.published(), published, 'publication returns once the visitor verifies');
});

test('a recorded visitor or owner that disappeared needs repair; retries never create a second account', async t => {
  const e = await engine(t);
  const { project } = await e.add('vanished');
  // The marked owner lost its marker (for example, a reset database or an edited email).
  e.game.db.owners[0].marker = 'changed';
  await e.manager.verifyGameMappings();
  assert.equal(e.project(project.id).game.status, 'repair');
  await e.manager.retrySetup({ projectId: project.id });
  let view = await e.manager.settled(project.id);
  assert.equal(view.game.status, 'repair');
  assert.equal(view.game.ownerId, 201);
  assert.match(view.setup.error, /recorded managed owner \(game ID 201\)[^]*Nothing was created or remapped/);
  assert.deepEqual(e.game.db.owners.map(owner => owner.ownerId), [201], 'no second owner account');
  assert.equal(e.game.calls.filter(([op]) => op === 'owner').at(-1)[1].ownerId, 201, 'the recorded owner ID is sent so the service only verifies');
  // The recorded visitor was deleted: it is reported, never recreated.
  e.game.db.visitorId = null;
  assert.match((await e.manager.verifyGameMappings()).visitorProblem, /visitor recorded as game ID 107[^]*Nothing was created/);
  assert.equal(e.game.db.visitorId, null, 'no replacement visitor was created');
  assert.equal(e.view().visitor, null);
  assert.deepEqual(e.published(), { version: 2, visitorId: null, igloos: [], adoptions: [] });
  await e.manager.retrySetup({ projectId: project.id });
  view = await e.manager.settled(project.id);
  assert.match(view.setup.error, /visitor recorded as game ID 107/);
  assert.equal(e.game.db.visitorId, null);
});

test('a project set up while provisioning was off becomes retryable once provisioning is configured', async t => {
  const e = await engine(t, { game: null });
  const { project } = await e.add('pending-app');
  assert.equal(project.setup.phase, 'game-pending');
  await e.manager.close();
  const game = fakeGame();
  e.manager = await createManager({ ...e.options(), game });
  let view = e.project(project.id);
  assert.deepEqual([view.setup.phase, view.setup.retryable, view.game], ['failed', true, null]);
  assert.match(view.setup.error, /provisioning was off when this project was set up\. Retry to provision its igloo/);
  assert.deepEqual(game.calls, [], 'nothing is provisioned automatically');
  await e.manager.retrySetup({ projectId: project.id });
  view = await e.manager.settled(project.id);
  assert.equal(view.setup.phase, 'ready');
  assert.equal(view.game.status, 'ready');
  assert.equal(e.view().workers.length, 0, 'still an empty igloo');
});

test('the legacy Atlas fixture mapping is published and needs no provisioning; clean shutdown empties the list', async t => {
  const e = await engine(t);
  const source = e.repo('legacy');
  await e.manager.close();
  fs.writeFileSync(path.join(e.stateDir, 'state.json'), JSON.stringify(legacyState(source, { baseCommit: e.git(source, 'rev-parse', 'HEAD').trim() })));
  migrateStateDir(e.stateDir);
  await e.open();
  assert.deepEqual(e.published(), { version: 2, visitorId: null, igloos: [], adoptions: [] }, 'nothing is published before the visitor is verified');
  let matches = true;
  e.game.verifyOwners = async ([mapping]) => {
    assert.deepEqual(mapping, { key: e.view().projects[0].id, fixtureId: 'bridge-alpha', ownerId: 105, iglooId: 4, puffleId: 4, puffleName: 'Atlas' });
    return [{ key: mapping.key, ok: matches, problems: matches ? [] : ['Layout changed.'] }];
  };
  matches = false;
  assert.equal((await e.manager.verifyGameMappings()).repair, 1);
  assert.deepEqual(e.published().igloos, []);
  matches = true;
  await e.manager.verifyGameMappings();
  assert.deepEqual(e.published(), { version: 2, visitorId: 107, igloos: [{ ownerId: 105, iglooId: 4 }], adoptions: [] });
  const project = e.view().projects[0];
  e.game.calls.length = 0;
  await e.manager.createWorker({ projectId: project.id });
  assert.equal((await e.manager.settled(project.id)).setup.phase, 'ready');
  assert.deepEqual(e.game.calls, [], 'a ready legacy mapping is not reprovisioned');
  await e.manager.close();
  e.manager = null;
  assert.deepEqual(e.published(), { version: 2, visitorId: 107, igloos: [], adoptions: [] });
  assert.equal(fs.existsSync(path.join(e.publicationDir, 'owner.lock')), false);
});

test('two projects get distinct owners; a second engine cannot take over publication', async t => {
  const e = await engine(t);
  const one = await e.add('one');
  const two = await e.add('two');
  assert.notEqual(one.project.game.ownerId, two.project.game.ownerId);
  assert.deepEqual(e.published().igloos.map(item => item.ownerId), [201, 202]);
  assert.throws(() => acquirePublication({ dir: e.publicationDir, stateDir: path.join(e.dir, 'other-state') }), /owns native igloo publication/);
  assert.deepEqual(e.published().igloos.map(item => item.ownerId), [201, 202]);
});
