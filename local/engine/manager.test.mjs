import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createManager } from './manager.mjs';
import { migrateStateDir } from './state.mjs';
import { ProvisionError } from './game.mjs';
import { FakePty, checkoutFingerprint, fakeGame, legacyState, memoryPublisher, sandbox } from './testing.mjs';

async function engine(t, extra = {}) {
  const s = sandbox(t, 'penguin-manager-');
  const stateDir = path.join(s.dir, 'state');
  const worktreeRoot = path.join(s.dir, 'worktrees');
  const processes = [];
  const events = [];
  const game = extra.game === undefined ? fakeGame() : extra.game;
  const publisher = extra.publisher ?? memoryPublisher();
  const options = { stateDir, worktreeRoot, gitEnv: s.gitEnv, hookBaseUrl: 'http://localhost:8081/engine/hooks', onEvent: event => events.push(event),
    ptySpawn: (command, args, spawnOptions) => {
      const proc = new FakePty();
      processes.push({ proc, command, args, options: spawnOptions });
      return proc;
    }, ...extra, game, publisher };
  const e = { ...s, stateDir, worktreeRoot, processes, events, options, game, publisher, manager: null };
  e.manager = await createManager(options);
  s.cleanup(() => e.manager?.close());
  e.restart = async (more = {}) => { await e.manager.close(); e.manager = null; e.manager = await createManager({ ...options, ...more }); return e.manager; };
  e.view = () => e.manager.snapshot();
  e.worker = id => e.view().workers.find(worker => worker.id === id);
  e.projectView = id => e.view().projects.find(project => project.id === id);
  /** Register a disposable repository; its empty igloo is provisioned in the background. */
  e.register = async (name, files) => {
    const repo = s.repo(name, files);
    const project = await e.manager.registerProject({ path: repo });
    await e.manager.settled(project.id);
    return { repo, project: e.projectView(project.id) };
  };
  /** Adopt a puffle the way the game does: reserve, buy against the world server, report, settle. */
  e.purchase = async (projectId, { name = 'Atlas', typeId = 0, subtypeId = 0 } = {}) => {
    const adoption = await e.manager.reserveAdoption({ projectId, typeId, subtypeId, name });
    const reply = e.game.purchase(e.publisher.payload, { adoptionId: adoption.id, typeId, subtypeId, name });
    return { adoption, reply };
  };
  e.adopt = async (projectId, request = {}) => {
    const { adoption, reply } = await e.purchase(projectId, request);
    const reported = await e.manager.reportAdoption({ adoptionId: adoption.id, result: reply });
    await e.manager.settled(projectId);
    return { adoption: reported, reply, worker: e.worker(adoption.workerId) };
  };
  /** Register a disposable repository and adopt its first, ready puffle. */
  e.add = async (name, { files, puffle = 'Atlas', typeId, subtypeId } = {}) => {
    const { repo, project } = await e.register(name, files);
    const { worker } = await e.adopt(project.id, { name: puffle, typeId, subtypeId });
    return { repo, project: e.projectView(project.id), worker, target: { projectId: project.id, workerId: worker.id } };
  };
  /** Waits (bounded) for a condition driven by background work, such as a queued start. */
  e.until = async (check, label) => {
    for (let attempt = 0; attempt < 200; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail(`Timed out waiting: ${label}`);
  };
  e.processFor = workerId => processes.filter(item => item.options.env.CLAUDE_PENGUIN_WORKER_ID === workerId).at(-1);
  e.hook = (worker, type, fields = {}, token = e.processFor(worker.id).options.env.CLAUDE_PENGUIN_HOOK_TOKEN) => e.manager.hook({ workerId: worker.id, token,
    event: { hook_event_name: type, session_id: worker.sessionId, cwd: worker.workspace.path, ...fields } });
  e.started = async item => { await e.manager.start(item.target); await e.hook(item.worker, 'SessionStart', { source: 'startup' }); return e.processFor(item.worker.id).proc; };
  return e;
}

// ------------------------------------------------------------ identity and registration

test('multiple repositories get separate projects; symlinks, linked worktrees, and duplicates resolve to one', async t => {
  const e = await engine(t);
  const first = e.repo('one/app');
  const second = e.repo('two/app');
  const a = await e.manager.registerProject({ path: first });
  const b = await e.manager.registerProject({ path: second });
  assert.notEqual(a.id, b.id, 'equal basenames stay separate');
  assert.equal(a.name, 'app');
  const alias = path.join(e.dir, 'alias');
  fs.symlinkSync(first, alias);
  const linked = path.join(e.dir, 'linked');
  e.git(first, 'worktree', 'add', '-q', '-b', 'side', linked);
  assert.equal((await e.manager.registerProject({ path: alias })).id, a.id);
  assert.equal((await e.manager.registerProject({ path: linked })).id, a.id);
  const [x, y] = await Promise.all([e.manager.registerProject({ path: second }), e.manager.registerProject({ path: second })]);
  assert.equal(x.id, b.id);
  assert.equal(y.id, b.id);
  assert.equal(e.view().projects.length, 2);
  assert.equal(e.view().projects.find(project => project.id === a.id).sourcePath, first, 'the initially registered checkout is preserved');
  assert.equal(JSON.stringify(e.view()).includes('commonDir'), false, 'snapshots are allowlisted');
  await Promise.all([e.manager.settled(a.id), e.manager.settled(b.id)]);
});

test('project names are validated by the engine and the 32-project limit is enforced', async t => {
  const e = await engine(t, { game: null });
  for (const name of ['100%', 'A|B', 'a:b', ' padded', 'two  spaces', 'x'.repeat(31)]) {
    await assert.rejects(e.manager.registerProject({ path: e.repo(`bad-${randomUUID()}`), name }), /Project names/, name);
  }
  assert.equal(e.view().projects.length, 0, 'rejected names register nothing');
  assert.equal((await e.manager.registerProject({ path: e.repo('weird name!!'), name: undefined })).name, 'weird name');
  for (let index = 1; index < 32; index++) await e.manager.registerProject({ path: e.repo(`repo-${index}`) });
  assert.equal(e.view().projects.length, 32);
  await assert.rejects(e.manager.registerProject({ path: e.repo('one-too-many') }), /at most 32/);
  assert.equal((await e.manager.registerProject({ path: path.join(e.dir, 'repo-3') })).name, 'repo-3', 'existing projects still resolve at the limit');
});

test('registration creates an empty project igloo: an owner and a locked igloo, no puffle and no worker', async t => {
  const e = await engine(t);
  const { project } = await e.register('empty');
  assert.equal(project.setup.phase, 'ready');
  assert.deepEqual([project.game.source, project.game.status, project.game.ownerId, project.game.roomId], ['managed', 'ready', 201, 2201]);
  assert.deepEqual(project.capacity, { max: 10, puffles: 0, pending: 0 });
  assert.equal(project.adoptionBlocked, null);
  assert.equal(e.view().workers.length, 0);
  assert.equal(e.game.db.owners[0].pets.length, 0, 'nothing was adopted for the owner');
  assert.ok(!e.game.calls.some(([op]) => op === 'purchase'), 'the engine never purchases');
  assert.deepEqual(e.publisher.payload.igloos, [{ ownerId: 201, iglooId: 9 }]);
  assert.deepEqual(e.publisher.payload.adoptions, []);
  assert.equal(e.game.calls.find(([op]) => op === 'verify')[1][0].puffles.length, 0, 'an empty igloo verifies as empty');
  await assert.rejects(e.manager.createWorker({ projectId: project.id }), /Adopt a puffle at the Pet Shop/);
});

test('without provisioning a project waits at game-pending and cannot adopt', async t => {
  const e = await engine(t, { game: null });
  const project = await e.manager.registerProject({ path: e.repo('offline') });
  await e.manager.settled(project.id);
  assert.equal(e.projectView(project.id).setup.phase, 'game-pending');
  assert.match(e.projectView(project.id).adoptionBlocked, /provisioning is off/);
  await assert.rejects(e.manager.reserveAdoption({ projectId: project.id, typeId: 0, subtypeId: 0, name: 'Atlas' }), /provisioning is off/);
});

// ------------------------------------------------------------ adoption

test('adoption reserves, publishes, binds the receipt to a new worker, and sets up its own worktree', async t => {
  const e = await engine(t);
  const { project } = await e.register('adopt');
  const adoption = await e.manager.reserveAdoption({ projectId: project.id, typeId: 3, subtypeId: 0, name: 'moss' });
  assert.equal(adoption.state, 'reserved');
  assert.deepEqual(adoption.request, { typeId: 3, subtypeId: 0, name: 'moss', price: 400 });
  const saved = JSON.parse(fs.readFileSync(path.join(e.stateDir, 'state.json'), 'utf8'));
  assert.equal(saved.adoptions[0].workerId, adoption.workerId, 'the worker and adoption IDs are durable before the purchase');
  assert.deepEqual(e.publisher.payload.adoptions.map(item => [item.adoptionId, item.ownerId]), [[adoption.id, 201]]);
  assert.equal(e.view().workers.length, 0, 'no worker exists before the purchase');
  const reply = e.game.purchase(e.publisher.payload, { adoptionId: adoption.id, typeId: 3, subtypeId: 0, name: 'moss' });
  assert.equal(reply.ok, true);
  const reported = await e.manager.reportAdoption({ adoptionId: adoption.id, result: reply });
  assert.equal(reported.state, 'bound');
  await e.manager.settled(project.id);
  const worker = e.worker(adoption.workerId);
  assert.equal(worker.name, 'Moss', 'the server title-cases the name');
  assert.deepEqual([worker.puffle.puffleId, worker.puffle.typeId, worker.puffle.subtypeId, worker.puffle.color, worker.puffle.adoptionId], [reply.puffleId, 3, 0, 'green', adoption.id]);
  assert.equal(worker.workspace.state, 'ready');
  assert.equal(worker.workspace.branch, `claude-penguin/${project.id}/${worker.id}`);
  assert.equal(worker.status, 'offline');
  assert.deepEqual(e.publisher.payload.adoptions, [], 'a bound adoption leaves publication');
  assert.deepEqual(e.projectView(project.id).capacity, { max: 10, puffles: 1, pending: 0 });
  assert.equal(e.game.db.coins, 4600, 'exactly one debit');
});

test('the dog and cat cost 800; special puffles and invalid names are refused before any reservation', async t => {
  const e = await engine(t);
  const { project } = await e.register('variants');
  const dog = await e.adopt(project.id, { name: 'Rex', typeId: 0, subtypeId: 1006 });
  const cat = await e.adopt(project.id, { name: 'Tom', typeId: 8, subtypeId: 1007 });
  assert.deepEqual([dog.worker.puffle.color, cat.worker.puffle.color], ['blue-dog', 'orange-cat']);
  assert.equal(e.game.db.coins, 3400);
  for (const [typeId, subtypeId] of [[10, 0], [11, 0], [0, 1007], [0, 1000], [12, 0]]) {
    await assert.rejects(e.manager.reserveAdoption({ projectId: project.id, typeId, subtypeId, name: 'Shiny' }), /cannot join a project igloo/);
  }
  await assert.rejects(e.manager.reserveAdoption({ projectId: project.id, typeId: 0, subtypeId: 0, name: 'Two Words' }), /1 to 12 letters/);
  await assert.rejects(e.manager.reserveAdoption({ projectId: randomUUID(), typeId: 0, subtypeId: 0, name: 'Atlas' }), /Unknown project/);
  await assert.rejects(e.manager.reserveAdoption({ typeId: 0, subtypeId: 0, name: 'Atlas' }), /explicit project ID/);
  assert.equal(e.view().adoptions.length, 2);
});

test('one adoption is open at a time; refusals and cancellation withdraw it; duplicate names are allowed', async t => {
  const e = await engine(t);
  const one = await e.register('one');
  const two = await e.register('two');
  const first = await e.manager.reserveAdoption({ projectId: one.project.id, typeId: 0, subtypeId: 0, name: 'Atlas' });
  await assert.rejects(e.manager.reserveAdoption({ projectId: two.project.id, typeId: 0, subtypeId: 0, name: 'Atlas' }), /Another adoption is still open/);
  e.game.db.coins = 100;
  const refused = e.game.purchase(e.publisher.payload, { adoptionId: first.id, typeId: 0, subtypeId: 0, name: 'Atlas' });
  assert.deepEqual(refused, { ok: false, code: '401' });
  const withdrawn = await e.manager.reportAdoption({ adoptionId: first.id, result: refused });
  assert.deepEqual([withdrawn.state, withdrawn.code], ['withdrawn', '401']);
  assert.deepEqual(e.publisher.payload.adoptions, [], 'a withdrawn adoption is unpublished');
  e.game.db.coins = 5000;
  const second = await e.manager.reserveAdoption({ projectId: two.project.id, typeId: 0, subtypeId: 0, name: 'Atlas' });
  assert.equal(e.manager.cancelAdoption({ adoptionId: second.id }).state, 'withdrawn');
  const a = await e.adopt(one.project.id, { name: 'Atlas' });
  const b = await e.adopt(one.project.id, { name: 'Atlas' });
  assert.notEqual(a.worker.id, b.worker.id);
  assert.deepEqual([a.worker.name, b.worker.name], ['Atlas', 'Atlas'], 'names need not be unique; the game ID is the identity');
  assert.notEqual(a.worker.puffle.puffleId, b.worker.puffle.puffleId);
  assert.equal(e.game.db.coins, 4200);
});

test('the tenth adoption succeeds and the eleventh is refused before any charge', async t => {
  const e = await engine(t);
  const { project } = await e.register('full');
  for (let index = 0; index < 10; index++) await e.adopt(project.id, { name: 'Pup', typeId: index, subtypeId: 0 });
  assert.equal(e.view().workers.filter(worker => worker.projectId === project.id).length, 10);
  assert.match(e.projectView(project.id).adoptionBlocked, /already has 10 puffles/);
  const coins = e.game.db.coins;
  await assert.rejects(e.manager.reserveAdoption({ projectId: project.id, typeId: 0, subtypeId: 0, name: 'Eleven' }), /already has 10 puffles/);
  assert.equal(e.game.db.coins, coins, 'nothing was charged');
});

test('a lost response and an engine crash after the debit are both recovered from the receipt', async t => {
  const e = await engine(t);
  const { project } = await e.register('crash');
  // Lost response: the purchase completed, but the browser never reported it.
  const lost = await e.purchase(project.id, { name: 'Lost' });
  assert.equal(lost.reply.ok, true);
  const reconciled = await e.manager.reconcileAdoptions({ projectId: project.id });
  assert.deepEqual(reconciled.bound, [lost.adoption.workerId]);
  await e.manager.settled(project.id);
  assert.equal(e.worker(lost.adoption.workerId).puffle.puffleId, lost.reply.puffleId);
  // Crash after the debit and before binding: restart, then startup reconciliation binds it.
  const crashed = await e.purchase(project.id, { name: 'Crash' });
  await e.restart();
  assert.equal(e.view().adoptions.find(item => item.id === crashed.adoption.id).state, 'reserved');
  await e.manager.verifyGameMappings();
  await e.manager.settled(project.id);
  assert.equal(e.view().adoptions.find(item => item.id === crashed.adoption.id).state, 'bound');
  assert.equal(e.projectView(project.id).game.status, 'ready', 'the receipt-backed puffle verifies as recorded');
  assert.equal(e.game.db.coins, 4200, 'replays never charged twice');
  // Replaying the same adoption returns the stored receipt and binds nothing new.
  const replay = e.game.purchase({ adoptions: [{ adoptionId: crashed.adoption.id, ownerId: 201, expiresAt: 4e9 }] },
    { adoptionId: crashed.adoption.id, typeId: 0, subtypeId: 0, name: 'Crash' });
  assert.equal(replay.puffleId, crashed.reply.puffleId);
  assert.equal((await e.manager.reportAdoption({ adoptionId: crashed.adoption.id, result: replay })).state, 'bound');
  assert.equal(e.view().workers.length, 2);
});

test('a receipt always wins over a withdrawn or expired reservation', async t => {
  let clock = Date.now();
  const e = await engine(t, { clock: () => clock });
  const { project } = await e.register('late');
  const { adoption, reply } = await e.purchase(project.id, { name: 'Late' });
  await e.manager.reportAdoption({ adoptionId: adoption.id, result: { ok: false, code: 'failed' } });
  assert.equal(e.view().adoptions[0].state, 'withdrawn');
  clock += 60 * 60 * 1000;
  await e.manager.reconcileAdoptions();
  await e.manager.settled(project.id);
  assert.equal(e.view().adoptions[0].state, 'bound');
  assert.equal(e.worker(adoption.workerId).puffle.puffleId, reply.puffleId);
  // An expired reservation without a receipt is withdrawn and unpublished.
  const stale = await e.manager.reserveAdoption({ projectId: project.id, typeId: 1, subtypeId: 0, name: 'Stale' });
  clock += 11 * 60 * 1000;
  await e.manager.reconcileAdoptions();
  assert.equal(e.view().adoptions.find(item => item.id === stale.id).state, 'withdrawn');
  assert.equal((await e.manager.reserveAdoption({ projectId: project.id, typeId: 1, subtypeId: 0, name: 'Fresh' })).state, 'reserved', 'an expired reservation no longer blocks');
});

test('an expired adoption settles as not charged only after a receipt lookup past the margin', async t => {
  let clock = Date.now();
  const e = await engine(t, { clock: () => clock });
  const { project } = await e.register('settle');
  const record = id => e.view().adoptions.find(item => item.id === id);
  // Sent, but the purchase never reached the world server (for example, a dropped connection).
  const gone = await e.manager.reserveAdoption({ projectId: project.id, typeId: 0, subtypeId: 0, name: 'Gone' });
  const expiry = Date.parse(gone.expiresAt);
  clock = expiry + 60 * 1000;
  await e.manager.reconcileAdoptions({ projectId: project.id });
  assert.deepEqual([record(gone.id).state, record(gone.id).settled], ['withdrawn', false], 'inside the margin it stays uncertain');
  // A lookup that starts inside the margin does not settle, even if it finishes after it.
  const read = e.game.readReceipts;
  e.game.readReceipts = async ids => { clock = expiry + 3 * 60 * 1000; return read(ids); };
  clock = expiry + 119 * 1000;
  await e.manager.reconcileAdoptions({ projectId: project.id });
  e.game.readReceipts = read;
  assert.equal(record(gone.id).settled, false);
  const settled = (await e.manager.reconcileAdoptions({ projectId: project.id })).adoptions.find(item => item.id === gone.id);
  assert.deepEqual([settled.state, settled.code, settled.settled], ['withdrawn', 'not-charged', true]);
  assert.match(settled.error, /Nothing was charged/);
  await e.restart();
  await e.manager.verifyGameMappings();
  await e.manager.settled(project.id);
  assert.equal(record(gone.id).settled, true, 'the settlement persists');

  // The game reported a charge but no receipt exists: never settled as uncharged.
  const odd = await e.manager.reserveAdoption({ projectId: project.id, typeId: 0, subtypeId: 0, name: 'Odd' });
  await e.manager.reportAdoption({ adoptionId: odd.id, result: { ok: true, puffleId: 77 } });
  assert.equal(record(odd.id).state, 'charged');
  clock = Date.parse(odd.expiresAt) + 10 * 60 * 1000;
  await e.manager.reconcileAdoptions({ projectId: project.id });
  await e.manager.reconcileAdoptions({ projectId: project.id });
  assert.deepEqual([record(odd.id).state, record(odd.id).code, record(odd.id).settled], ['withdrawn', 'lost', false]);

  // A receipt still wins over a settled record.
  e.game.purchase({ adoptions: [{ adoptionId: gone.id, ownerId: gone.ownerId, expiresAt: 4e9 }] }, { adoptionId: gone.id, typeId: 0, subtypeId: 0, name: 'Gone' });
  await e.manager.reconcileAdoptions({ projectId: project.id });
  await e.manager.settled(project.id);
  assert.deepEqual([record(gone.id).state, record(gone.id).settled], ['bound', false]);
});

test('a receipt for another owner or visitor is a conflict and binds nothing', async t => {
  const e = await engine(t);
  const { project } = await e.register('conflict');
  const { adoption } = await e.purchase(project.id, { name: 'Odd' });
  e.game.db.receipts[0].ownerId = 999;
  await e.manager.reconcileAdoptions();
  assert.equal(e.view().adoptions[0].state, 'conflict');
  assert.equal(e.worker(adoption.workerId), undefined);
});

test('adoption is refused while the project holds the owner session, during setup, or for the legacy Atlas', async t => {
  const e = await engine(t);
  let release;
  e.game.before.igloo = () => new Promise(resolve => { release = resolve; });
  const project = await e.manager.registerProject({ path: e.repo('busy') });
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(e.manager.reserveAdoption({ projectId: project.id, typeId: 0, subtypeId: 0, name: 'Atlas' }), /busy with setup/);
  release();
  await e.manager.settled(project.id);
  delete e.game.before.igloo;
  assert.equal((await e.manager.reserveAdoption({ projectId: project.id, typeId: 0, subtypeId: 0, name: 'Atlas' })).state, 'reserved');
});

test('worktree setup failing after purchase keeps the paid puffle and retries that worker only', async t => {
  const e = await engine(t);
  // A partial clone fails during checkout (Git has already created the branch), then succeeds on retry.
  const upstream = e.repo('upstream', { 'big.txt': 'large\n' });
  const repo = path.join(e.dir, 'partial');
  e.git(e.dir, 'clone', '-q', '--filter=blob:none', '--no-checkout', `file://${upstream}`, repo);
  const project = await e.manager.registerProject({ path: repo });
  await e.manager.settled(project.id);
  const { worker } = await e.adopt(project.id, { name: 'Atlas' });
  assert.equal(worker.setup.phase, 'failed');
  assert.equal(worker.setup.retryable, true);
  assert.match(worker.setup.error, /promisor remote/);
  assert.equal(worker.status, 'setup');
  assert.equal(e.projectView(project.id).setup.phase, 'ready', 'the destination stays usable');
  assert.ok(worker.puffle.puffleId, 'the paid puffle stays bound');
  await assert.rejects(e.manager.start({ projectId: project.id, workerId: worker.id }), /setup is not complete/);
  const sibling = await e.adopt(project.id, { name: 'Comet' });
  assert.equal(sibling.worker.setup.phase, 'failed', 'a sibling fails on its own, independently');
  e.git(repo, 'fetch', '-q', 'origin');
  e.git(repo, 'cat-file', '-p', e.git(upstream, 'rev-parse', 'HEAD:big.txt').trim()); // The user fetches the object manually.
  await e.manager.retryWorker({ projectId: project.id, workerId: worker.id });
  await e.manager.settled(project.id);
  const ready = e.worker(worker.id);
  assert.equal(ready.workspace.state, 'ready');
  assert.equal(fs.readFileSync(path.join(ready.workspace.path, 'big.txt'), 'utf8'), 'large\n');
  assert.equal(e.worker(sibling.worker.id).setup.phase, 'failed', 'retry affects only that worker');
  await assert.rejects(e.manager.retryWorker({ projectId: project.id, workerId: worker.id }), /not waiting for a retry/);
});

test('control requires an explicit project and worker and never falls back to another one', async t => {
  const e = await engine(t);
  const one = await e.add('one');
  const two = await e.add('two', { puffle: 'Comet' });
  await assert.rejects(e.manager.start({ projectId: one.project.id }), /explicit worker ID/);
  await assert.rejects(e.manager.start({ projectId: one.project.id, workerId: two.worker.id }), /Unknown worker for this project/);
  await assert.rejects(e.manager.diff({ workerId: one.worker.id }), /explicit project ID/);
  await assert.rejects(e.manager.reportAdoption({ adoptionId: randomUUID(), result: { ok: true } }), /Unknown adoption/);
  await assert.rejects(e.manager.retryWorker({ projectId: two.project.id, workerId: one.worker.id }), /Unknown worker for this project/);
});

// ------------------------------------------------------------ worktrees

test('each puffle gets a locked worktree on its own branch while the source checkout is untouched', async t => {
  const e = await engine(t);
  const repo = e.repo('My Repo (copy)', { 'hello.txt': 'hello\n', '.gitignore': 'ignored.log\n' });
  fs.writeFileSync(path.join(repo, 'hello.txt'), 'staged edit\n');
  e.git(repo, 'add', 'hello.txt');
  fs.writeFileSync(path.join(repo, 'hello.txt'), 'unstaged edit\n');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'untracked\n');
  fs.writeFileSync(path.join(repo, 'ignored.log'), 'ignored\n');
  const before = checkoutFingerprint(e, repo);
  const project = await e.manager.registerProject({ path: repo });
  await e.manager.settled(project.id);
  const { worker } = await e.adopt(project.id);
  const second = (await e.adopt(project.id, { name: 'Comet' })).worker;
  assert.match(worker.setup.note, /uncommitted changes[^]*stay in the source checkout/);
  const leaf = path.join(fs.realpathSync.native(e.worktreeRoot), worker.id, 'My-Repo--copy-');
  assert.equal(worker.workspace.path, leaf);
  assert.equal(worker.workspace.branch, `claude-penguin/${project.id}/${worker.id}`);
  assert.notEqual(second.workspace.path, worker.workspace.path);
  assert.notEqual(second.workspace.branch, worker.workspace.branch);
  assert.equal(worker.workspace.baseCommit, before.head);
  assert.equal(worker.workspace.sourceDirtyAtCreation, true);
  assert.equal(fs.readFileSync(path.join(leaf, 'hello.txt'), 'utf8'), 'hello\n', 'the worktree starts from committed HEAD');
  for (const file of ['untracked.txt', 'ignored.log']) assert.equal(fs.existsSync(path.join(leaf, file)), false, `${file} is not copied`);
  assert.equal(fs.statSync(path.dirname(leaf)).mode & 0o777, 0o700);
  assert.match(e.git(repo, 'worktree', 'list', '--porcelain'), new RegExp(`locked Claude Penguin worker ${worker.id}`));
  assert.deepEqual(checkoutFingerprint(e, repo), before, 'source files, index, and HEAD are unchanged');
  assert.deepEqual(worker.inspection.warnings, []);
  assert.equal(e.git(repo, 'branch', '--list', 'claude-penguin/*').trim().split('\n').length, 2);
});

test('an overridden worktree root may contain spaces; roots inside Git fail that worker\'s setup', async t => {
  const e = await engine(t);
  const spaced = path.join(e.dir, 'Parent Folder', 'Penguin Worktrees');
  await e.restart({ worktreeRoot: spaced });
  const { worker } = await e.add('spaced');
  assert.ok(worker.workspace.path.startsWith(fs.realpathSync.native(spaced) + path.sep));
  assert.ok(fs.existsSync(path.join(worker.workspace.path, 'hello.txt')));
  const host = e.repo('host');
  await e.restart({ worktreeRoot: path.join(host, 'worktrees') });
  const { project } = await e.register('inside');
  const refused = (await e.adopt(project.id, { name: 'Nova' })).worker;
  assert.equal(refused.setup.phase, 'failed');
  assert.match(refused.setup.error, /inside a Git repository/);
  assert.equal(refused.workspace, null, 'nothing is reserved after a refused root');
  assert.equal(e.worker(worker.id).workspace.path, worker.workspace.path, 'changing the root affects future workers only');
});

test('a custom Git filter fails the worker\'s setup before anything is reserved', async t => {
  const e = await engine(t);
  const filtered = e.repo('filtered', { '.gitattributes': '*.txt filter=custom\n', 'a.txt': 'a\n' });
  e.git(filtered, 'config', 'filter.custom.clean', 'cat');
  const project = await e.manager.registerProject({ path: filtered });
  await e.manager.settled(project.id);
  const { worker } = await e.adopt(project.id);
  assert.match(worker.setup.error, /Unsupported Git filter command/);
  assert.equal(worker.workspace, null);
});

test('an engine stop after Git finished but before state recorded it reconciles on retry', async t => {
  const e = await engine(t);
  const { repo, project } = await e.register('interrupted');
  const { worker: created } = await e.adopt(project.id);
  await e.manager.close();
  // Simulate a crash mid-setup: the reservation is durable and Git completed out of band.
  const file = path.join(e.stateDir, 'state.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const record = saved.workers.find(worker => worker.id === created.id);
  record.workspace.state = 'reserved';
  record.setup.phase = 'preparing';
  fs.writeFileSync(file, JSON.stringify(saved));
  e.manager = await createManager(e.options);
  const view = e.worker(created.id);
  assert.equal(view.setup.phase, 'failed');
  assert.match(view.setup.error, /Retry to reconcile/);
  await e.manager.retryWorker({ projectId: project.id, workerId: created.id });
  await e.manager.settled(project.id);
  assert.equal(e.worker(created.id).workspace.state, 'ready');
  assert.equal(e.git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 2, 'the existing worktree was adopted, not duplicated');
  assert.equal(e.view().workers.length, 1);
});

// ------------------------------------------------------------ session caps

test('live sessions are capped per igloo and overall; extra starts queue visibly and run when a slot frees', async t => {
  const e = await engine(t, { caps: { perIgloo: 2, total: 3 } });
  const { project } = await e.register('busy-igloo');
  const items = [];
  for (const name of ['Atlas', 'Comet', 'Nova']) {
    const { worker } = await e.adopt(project.id, { name });
    items.push({ worker, target: { projectId: project.id, workerId: worker.id } });
  }
  const other = await e.add('other', { puffle: 'Pixel' });
  const third = await e.add('third', { puffle: 'Echo' });
  await e.started(items[0]);
  await e.started(items[1]);
  const queued = await e.manager.start(items[2].target);
  assert.deepEqual([queued.status, queued.queued, queued.running], ['queued', true, false]);
  assert.match(queued.activity, /2 of 2 sessions in this igloo/);
  assert.equal(e.processes.length, 2, 'nothing spawned beyond the igloo cap');
  await e.started(other);
  const globallyQueued = await e.manager.start(third.target);
  assert.equal(globallyQueued.status, 'queued', 'the overall cap also queues');
  // Stopping one session in the busy igloo starts its queued sibling, never the other igloo's.
  await e.manager.stop(items[0].target);
  await e.until(() => e.worker(items[2].worker.id).running, 'the queued sibling started when a slot freed');
  assert.equal(e.worker(third.worker.id).queued, true);
  assert.equal(e.worker(items[1].worker.id).running, true, 'the engine never stops a working session to make room');
  // A queued start can be withdrawn.
  assert.equal((await e.manager.stop(third.target)).queued, false);
  await e.manager.stop(other.target);
  assert.equal(e.worker(third.worker.id).running, false, 'a withdrawn start stays withdrawn');
});

// ------------------------------------------------------------ workspace validation

test('hard workspace failures block start, submission, and review without falling back to the source', async t => {
  const e = await engine(t);
  const item = await e.add('fragile');
  const proc = await e.started(item);
  // A missing folder while running blocks submission.
  const moved = `${item.worker.workspace.path}-moved`;
  fs.renameSync(item.worker.workspace.path, moved);
  await assert.rejects(e.manager.submit({ ...item.target, text: 'work' }), /Needs repair: The worktree folder is missing/);
  assert.equal(proc.writes.length, 0, 'nothing is typed into Claude after a failed validation');
  await assert.rejects(e.manager.diff(item.target), /Needs repair/);
  await e.manager.stop(item.target);
  await assert.rejects(e.manager.start(item.target), /Needs repair/);
  assert.equal(e.worker(item.worker.id).status, 'needs-repair');
  assert.equal(e.processes.length, 1, 'no process starts in the source checkout');
  fs.renameSync(moved, item.worker.workspace.path);
  await e.manager.start(item.target);
  assert.equal(e.processes.at(-1).options.cwd, item.worker.workspace.path);

  const other = await e.add('replaced');
  const workspace = other.worker.workspace.path;
  e.git(other.repo, 'worktree', 'unlock', workspace);
  e.git(other.repo, 'worktree', 'remove', workspace);
  e.git(e.dir, 'clone', '-q', other.repo, workspace);
  await assert.rejects(e.manager.start(other.target), /different repository/);

  const pruned = await e.add('pruned');
  e.git(pruned.repo, 'worktree', 'unlock', pruned.worker.workspace.path);
  fs.renameSync(path.join(pruned.repo, '.git', 'worktrees'), path.join(pruned.repo, '.git', 'worktrees-gone'));
  await assert.rejects(e.manager.start(pruned.target), /Needs repair/);

  const baseline = await e.add('baseline');
  await e.manager.close();
  const file = path.join(e.stateDir, 'state.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.workers.find(worker => worker.id === baseline.worker.id).workspace.baseCommit = 'f'.repeat(40);
  fs.writeFileSync(file, JSON.stringify(saved));
  e.manager = await createManager(e.options);
  await assert.rejects(e.manager.start(baseline.target), /baseline commit ffffffffffff is unavailable/);
});

test('branch, detached, unlocked, and unrelated-history warnings permit operation; review keeps the baseline', async t => {
  const e = await engine(t);
  const item = await e.add('warnings');
  const cwd = item.worker.workspace.path;
  fs.writeFileSync(path.join(cwd, 'hello.txt'), 'agent change\n');
  e.git(cwd, 'commit', '-qam', 'agent work');
  let review = await e.manager.diff(item.target);
  assert.equal(review.commitsSinceBaseline, 1);
  assert.equal(review.mergeBase, item.worker.workspace.baseCommit);
  assert.equal(review.sharedHistory, true);
  assert.equal(review.worktreePath, cwd);
  assert.equal(review.sourcePath, item.repo);
  assert.equal(review.expectedBranch, item.worker.workspace.branch);
  assert.match(review.diff, /\+agent change/);
  e.git(cwd, 'switch', '-q', '-c', 'renamed');
  e.git(item.repo, 'worktree', 'unlock', cwd);
  review = await e.manager.diff(item.target);
  assert.deepEqual(review.warnings.map(warning => warning.code).sort(), ['branch', 'unlocked']);
  assert.equal(review.branch, 'renamed');
  e.git(cwd, 'switch', '-q', '--detach');
  assert.ok((await e.manager.diff(item.target)).warnings.some(warning => warning.code === 'detached'));
  e.git(cwd, 'switch', '-q', '--orphan', 'unrelated');
  fs.writeFileSync(path.join(cwd, 'other.txt'), 'other\n');
  e.git(cwd, 'add', 'other.txt');
  e.git(cwd, 'commit', '-qm', 'unrelated root');
  review = await e.manager.diff(item.target);
  assert.equal(review.sharedHistory, false);
  assert.equal(review.mergeBase, null);
  assert.ok(review.warnings.some(warning => warning.code === 'history'));
  assert.match(review.diff, /-hello/, 'the comparison is still against the immutable baseline');
  await e.manager.start(item.target);
  assert.equal(e.worker(item.worker.id).running, true, 'warnings do not block start');
});

test('review includes committed and uncommitted work, bounded untracked previews, and never follows symlinks', async t => {
  const e = await engine(t);
  const item = await e.add('review');
  const cwd = item.worker.workspace.path;
  fs.writeFileSync(path.join(cwd, 'hello.txt'), 'committed change\n');
  e.git(cwd, 'commit', '-qam', 'agent change');
  fs.writeFileSync(path.join(cwd, 'hello.txt'), 'final change\n');
  fs.writeFileSync(path.join(cwd, 'new.txt'), 'new text\n');
  fs.writeFileSync(path.join(e.dir, 'private.txt'), 'private sentinel');
  fs.symlinkSync(path.join(e.dir, 'private.txt'), path.join(cwd, 'escape.txt'));
  const changes = await e.manager.diff(item.target);
  assert.match(changes.diff, /-hello/);
  assert.match(changes.diff, /\+final change/);
  assert.equal(changes.dirty, true);
  assert.equal(changes.untracked.find(file => file.path === 'new.txt').content, 'new text\n');
  assert.ok(changes.untracked.find(file => file.path === 'escape.txt').skipped);
  assert.equal(JSON.stringify(changes).includes('private sentinel'), false);
  assert.equal(fs.readFileSync(path.join(item.repo, 'hello.txt'), 'utf8'), 'hello\n', 'review reads the worktree, not the source');
});

// ------------------------------------------------------------ PTYs and hooks

test('independent PTYs per project route input, terminals, and hooks to exact workers', async t => {
  const e = await engine(t);
  const one = await e.add('one');
  const two = await e.add('two', { puffle: 'Comet' });
  const a = await e.started(one);
  const b = await e.started(two);
  assert.notEqual(a, b);
  assert.equal(e.processFor(one.worker.id).options.cwd, one.worker.workspace.path);
  assert.equal(e.processFor(two.worker.id).options.cwd, two.worker.workspace.path);
  assert.deepEqual(e.processFor(one.worker.id).args.slice(-4), ['--session-id', one.worker.sessionId, '--name', 'Atlas']);
  e.manager.input({ ...one.target, data: 'for one' });
  e.manager.input({ ...two.target, data: 'for two' });
  assert.deepEqual(a.writes, ['for one']);
  assert.deepEqual(b.writes, ['for two']);
  a.data('alpha screen\r\n');
  b.data('beta screen\r\n');
  assert.match((await e.manager.terminal(one.target)).data, /alpha screen/);
  assert.doesNotMatch((await e.manager.terminal(one.target)).data, /beta/);
  // Reconnecting or starting again never spawns a duplicate process.
  await e.manager.start(one.target);
  await e.manager.terminal(one.target);
  assert.equal(e.processes.length, 2);
  // A token from one worker cannot drive another worker's state.
  const tokenA = e.processFor(one.worker.id).options.env.CLAUDE_PENGUIN_HOOK_TOKEN;
  await assert.rejects(e.hook(two.worker, 'UserPromptSubmit', {}, tokenA), /Invalid hook/);
  await assert.rejects(e.hook(one.worker, 'UserPromptSubmit', {}, 'wrong-token'), /Invalid hook/);
  await assert.rejects(e.hook(one.worker, 'UserPromptSubmit', { session_id: two.worker.sessionId }), /changed session/);
  await e.hook(one.worker, 'UserPromptSubmit', { prompt: 'Work one', prompt_id: 'p1' });
  assert.equal(e.worker(one.worker.id).status, 'working');
  assert.equal(e.worker(two.worker.id).status, 'idle');
  await e.manager.stop(one.target);
  assert.equal(e.worker(two.worker.id).running, true, 'stopping one worker leaves the other running');
});

test('startup or resume outside the recorded worktree stops the owned PTY', async t => {
  for (const source of ['startup', 'resume']) {
    const e = await engine(t);
    const item = await e.add('elsewhere');
    await e.manager.start(item.target);
    const proc = e.processFor(item.worker.id).proc;
    await assert.rejects(e.hook(item.worker, 'SessionStart', { source, cwd: item.repo }), /does not match the recorded worktree/);
    assert.deepEqual(proc.kills, ['SIGTERM']);
    await new Promise(resolve => setImmediate(resolve));
    const worker = e.worker(item.worker.id);
    assert.equal(worker.status, 'failed');
    assert.match(worker.lastError, /not the recorded worktree/);
    assert.equal(worker.established, false);
    assert.equal(worker.sessionId, item.worker.sessionId);
  }
});

test('cd into a subfolder then compaction is ongoing; outside-workspace events stay visible with a warning', async t => {
  const e = await engine(t);
  const item = await e.add('subdir', { files: { 'src/main.txt': 'x\n' } });
  await e.started(item);
  const src = path.join(item.worker.workspace.path, 'src');
  await e.hook(item.worker, 'UserPromptSubmit', { prompt: 'go', prompt_id: 'p1', cwd: src });
  await e.hook(item.worker, 'SessionStart', { source: 'compact', cwd: src });
  assert.equal(e.processFor(item.worker.id).proc.kills.length, 0);
  assert.equal(e.worker(item.worker.id).outsideWorkspace, null);
  assert.match(e.worker(item.worker.id).activity, /compacted/);
  // A nested repository inside the worktree is outside its Git top level, so it warns once the lookup resolves.
  const nested = path.join(item.worker.workspace.path, 'vendor', 'other');
  fs.mkdirSync(nested, { recursive: true });
  e.git(nested, 'init', '-q');
  await e.hook(item.worker, 'PreToolUse', { tool_name: 'Bash', prompt_id: 'p1', cwd: nested });
  assert.equal(e.worker(item.worker.id).status, 'working', 'the lookup never delays status handling');
  for (let waited = 0; !e.worker(item.worker.id).outsideWorkspace && waited < 5000; waited += 5) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual([e.worker(item.worker.id).outsideWorkspace?.cwd, e.worker(item.worker.id).outsideWorkspace?.nestedRepository], [nested, true]);
  assert.equal((await e.hook(item.worker, 'PostToolUse', { tool_name: 'Bash', prompt_id: 'p1', cwd: nested })).outsideWorkspace, true, 'the cached top level applies immediately');
  await e.hook(item.worker, 'PostToolUse', { tool_name: 'Bash', prompt_id: 'p1', cwd: src });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(e.worker(item.worker.id).outsideWorkspace, null, 'an ordinary subfolder of the worktree does not warn');
  const result = await e.hook(item.worker, 'PermissionRequest', { tool_name: 'Bash', prompt_id: 'p1', cwd: item.repo });
  assert.equal(result.outsideWorkspace, true);
  let worker = e.worker(item.worker.id);
  assert.equal(worker.status, 'needs-you', 'attention is not suppressed outside the workspace');
  assert.equal(worker.outsideWorkspace.cwd, item.repo);
  assert.equal(worker.outsideWorkspace.resolved, true);
  await e.hook(item.worker, 'PostToolUse', { tool_name: 'Bash', prompt_id: 'p1', cwd: path.join(e.dir, 'no-such-dir') });
  worker = e.worker(item.worker.id);
  assert.equal(worker.status, 'working');
  assert.equal(worker.outsideWorkspace.resolved, false, 'unresolved directories are flagged, not ignored');
  const revision = e.view().revision;
  await e.hook(item.worker, 'Notification', { notification_type: 'idle_prompt', cwd: src });
  assert.ok(e.view().revision > revision, 'clearing the warning is published even without a status change');
  assert.equal(e.worker(item.worker.id).outsideWorkspace, null);
  await e.hook(item.worker, 'Stop', { prompt_id: 'p1', cwd: item.repo });
  worker = e.worker(item.worker.id);
  assert.equal(worker.status, 'review');
  assert.equal(worker.outsideWorkspace.cwd, item.repo);
});

test('hooks prove working, permission, and turn-ended state; a turn end is not verified success', async t => {
  const e = await engine(t);
  const item = await e.add('states');
  await e.manager.start(item.target);
  const revisionBefore = e.view().revision;
  await e.hook(item.worker, 'SessionStart', { source: 'startup' });
  assert.ok(e.view().revision > revisionBefore);
  assert.equal(e.worker(item.worker.id).status, 'idle');
  await e.hook(item.worker, 'UserPromptSubmit', { prompt: 'Fix hello', prompt_id: 'turn-1' });
  await e.hook(item.worker, 'PreToolUse', { tool_name: 'AskUserQuestion', prompt_id: 'turn-1' });
  assert.equal(e.worker(item.worker.id).status, 'needs-you');
  e.manager.input({ ...item.target, data: '1\r' });
  await e.hook(item.worker, 'PostToolUse', { tool_name: 'AskUserQuestion', prompt_id: 'turn-1' });
  assert.equal(e.worker(item.worker.id).status, 'working');
  await e.hook(item.worker, 'PermissionRequest', { tool_name: 'Bash', prompt_id: 'turn-1' });
  assert.equal(e.worker(item.worker.id).status, 'needs-you');
  await e.hook(item.worker, 'PostToolUseFailure', { tool_name: 'Bash', prompt_id: 'turn-1' });
  assert.equal(e.worker(item.worker.id).status, 'working');
  await e.hook(item.worker, 'Stop', { prompt_id: 'turn-1' });
  const result = e.worker(item.worker.id);
  assert.equal(result.status, 'review');
  assert.equal(result.taskHistory[0].status, 'turn-ended');
  assert.match(result.activity, /completion has not been verified/);
  await e.hook(item.worker, 'StopFailure', { agent_id: 'child-agent', error: 'rate_limit' });
  assert.equal(e.worker(item.worker.id).status, 'review');
  await e.hook(item.worker, 'StopFailure', { error: 'rate_limit' });
  assert.equal(e.worker(item.worker.id).status, 'failed');
});

test('session-switch hooks stop the owned terminal and preserve the puffle conversation identity', async t => {
  const e = await engine(t);
  const item = await e.add('switch');
  const proc = await e.started(item);
  await assert.rejects(e.hook(item.worker, 'SessionStart', { source: 'clear', session_id: randomUUID() }), /switching conversations/);
  assert.deepEqual(proc.kills, ['SIGTERM']);
  assert.equal(e.worker(item.worker.id).sessionId, item.worker.sessionId);
});

test('missing startup hook requests attention and output alone never means working', async t => {
  const e = await engine(t, { startupTimeoutMs: 5 });
  const item = await e.add('trust');
  await e.manager.start(item.target);
  e.processFor(item.worker.id).proc.data('Do you trust the files in this folder?');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(e.worker(item.worker.id).status, 'needs-you');
  assert.equal(e.worker(item.worker.id).established, false);
});

// ------------------------------------------------------------ interruption regressions (PR #5)

test('terminal replay includes output once with a sequence and interrupt needs an actual idle marker', async t => {
  const e = await engine(t);
  const item = await e.add('replay');
  const proc = await e.started(item);
  await e.hook(item.worker, 'UserPromptSubmit', { prompt: 'Work' });
  proc.data('first line\r\n');
  proc.data('\x1b]9;4;0\x07');
  let screen = await e.manager.terminal(item.target);
  assert.match(screen.data, /first line/);
  assert.equal(screen.sequence, 2);
  assert.equal(e.worker(item.worker.id).status, 'working', 'unsolicited idle is not completion');
  proc.data('\x1b]9;4;0\x07');
  e.manager.interrupt(item.target);
  assert.equal(proc.writes.at(-1), '\x1b');
  await e.manager.terminal(item.target);
  assert.equal(e.worker(item.worker.id).status, 'needs-you', 'idle queued before Escape cannot confirm its effect');
  assert.match(e.worker(item.worker.id).activity, /Cancellation is not yet confirmed/);
  proc.data('\x1b]9;4;0\x07');
  screen = await e.manager.terminal(item.target);
  assert.equal(screen.sequence, 4);
  assert.equal(e.worker(item.worker.id).status, 'interrupted');
  await e.manager.submit({ ...item.target, text: 'Try a smaller change' });
  assert.deepEqual(proc.writes.slice(-2), ['\x1b[200~Try a smaller change\x1b[201~', '\r']);
  const streamed = e.events.filter(event => event.type === 'terminal' && event.workerId === item.worker.id);
  assert.deepEqual(streamed.map(event => event.sequence), [1, 2, 3, 4]);
  e.manager.resize({ ...item.target, cols: 90, rows: 24 });
  assert.deepEqual(proc.size, { cols: 90, rows: 24 });
});

test('interrupt without an idle marker requests attention until an authenticated new prompt starts', async t => {
  const e = await engine(t);
  const item = await e.add('unconfirmed');
  const proc = await e.started(item);
  await e.hook(item.worker, 'UserPromptSubmit', { prompt: 'Original task', prompt_id: 'turn-1' });
  e.manager.interrupt(item.target);
  proc.data('Interrupted.\r\n> Original task');
  await e.manager.terminal(item.target);
  let worker = e.worker(item.worker.id);
  assert.equal(worker.status, 'needs-you', 'text alone cannot prove the turn stopped');
  assert.equal(worker.taskHistory[0].endedAt, undefined);
  await assert.rejects(e.manager.submit({ ...item.target, text: 'Unsafe second task' }), /live terminal/);
  for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
    await e.hook(item.worker, event, { tool_name: 'Bash', prompt_id: 'turn-1' });
    worker = e.worker(item.worker.id);
    assert.equal(worker.status, 'needs-you', `${event} cannot silently clear pending cancellation`);
    assert.match(worker.activity, /Cancellation is not yet confirmed/);
  }
  e.manager.input({ ...item.target, data: 'Retry from the terminal\r' });
  assert.equal(e.worker(item.worker.id).status, 'needs-you', 'input alone is not a lifecycle event');
  await e.hook(item.worker, 'UserPromptSubmit', { prompt: 'Retry from the terminal', prompt_id: 'turn-2' });
  proc.data('\x1b]9;4;0\x07');
  await e.manager.terminal(item.target);
  worker = e.worker(item.worker.id);
  assert.equal(worker.status, 'working', 'a late idle marker cannot interrupt the new task');
  assert.equal(worker.taskHistory[0].status, 'interrupted');
  assert.equal(worker.taskHistory[1].status, 'working');
});

test('a pending interrupt cannot overwrite a subsequent terminal lifecycle event', async t => {
  for (const [event, fields, expected] of [['Stop', {}, 'review'], ['StopFailure', { error: 'rate_limit' }, 'failed'], ['SessionEnd', { reason: 'clear' }, 'interrupted']]) {
    const e = await engine(t);
    const item = await e.add('race');
    const proc = await e.started(item);
    await e.hook(item.worker, 'UserPromptSubmit', { prompt: 'Work', prompt_id: 'turn-1' });
    e.manager.interrupt(item.target);
    await e.hook(item.worker, event, fields);
    const worker = e.worker(item.worker.id);
    const revision = e.view().revision;
    assert.equal(worker.status, expected);
    proc.data('\x1b]9;4;0\x07');
    await e.manager.terminal(item.target);
    assert.deepEqual(e.worker(item.worker.id), worker, `${event} must survive a late idle marker`);
    assert.equal(e.view().revision, revision);
  }
});

test('interrupt racing an already ended turn preserves readiness and does not send Escape', async t => {
  for (const status of ['idle', 'review', 'interrupted', 'failed']) {
    const e = await engine(t);
    const item = await e.add('ended');
    const proc = await e.started(item);
    if (status !== 'idle') await e.hook(item.worker, 'UserPromptSubmit', { prompt: 'Work' });
    if (status === 'review') await e.hook(item.worker, 'Stop');
    if (status === 'failed') await e.hook(item.worker, 'StopFailure', { error: 'rate_limit' });
    if (status === 'interrupted') {
      e.manager.interrupt(item.target);
      proc.data('\x1b]9;4;0\x07');
      await e.manager.terminal(item.target);
    }
    const before = e.view();
    const writes = proc.writes.length;
    assert.equal(e.manager.interrupt(item.target).status, status);
    assert.equal(proc.writes.length, writes);
    assert.deepEqual(e.view(), before);
    if (status !== 'failed') {
      await e.manager.submit({ ...item.target, text: 'Next task' });
      assert.deepEqual(proc.writes.slice(-2), ['\x1b[200~Next task\x1b[201~', '\r']);
    }
  }
});

test('card submission re-checks the turn after workspace inspection and before pressing Enter', async t => {
  const e = await engine(t);
  const item = await e.add('submit-race');
  const proc = await e.started(item);
  // A prompt typed in the terminal starts a turn while the card's workspace inspection runs.
  const typed = e.manager.submit({ ...item.target, text: 'card task' });
  await e.hook(item.worker, 'UserPromptSubmit', { prompt: 'typed in terminal', prompt_id: 'p1' });
  await assert.rejects(typed, error => error.statusCode === 409 && /Nothing was sent/.test(error.message));
  assert.deepEqual(proc.writes, [], 'nothing is pasted into a running turn');
  // An unconfirmed interrupt during inspection also keeps card submission disabled (PR #5).
  await e.hook(item.worker, 'Stop', { prompt_id: 'p1' });
  const interrupted = e.manager.submit({ ...item.target, text: 'card task 2' });
  await e.hook(item.worker, 'UserPromptSubmit', { prompt: 'typed again', prompt_id: 'p2' });
  e.manager.interrupt(item.target);
  await assert.rejects(interrupted, /Nothing was sent/);
  assert.deepEqual(proc.writes, ['\x1b']);
  assert.equal(e.worker(item.worker.id).status, 'needs-you');
  // A turn that starts after the paste but before Enter leaves the text unsubmitted.
  await e.hook(item.worker, 'Stop', { prompt_id: 'p2' });
  const pasted = e.manager.submit({ ...item.target, text: 'card task 3' });
  for (let waited = 0; proc.writes.length < 2 && waited < 5000; waited += 5) await new Promise(resolve => setTimeout(resolve, 5));
  await e.hook(item.worker, 'UserPromptSubmit', { prompt: 'typed once more', prompt_id: 'p3' });
  await assert.rejects(pasted, error => error.statusCode === 409 && /pasted into the terminal but not submitted/.test(error.message));
  assert.deepEqual(proc.writes.slice(1), ['\x1b[200~card task 3\x1b[201~'], 'Enter is never sent into a running turn');
});

// ------------------------------------------------------------ restart and recovery

test('runtime restart resumes each exact established session and a failed resume never replaces it', async t => {
  const e = await engine(t);
  const one = await e.add('one');
  const two = await e.add('two', { puffle: 'Comet' });
  await e.started(one);
  await e.started(two);
  const oldToken = e.processFor(one.worker.id).options.env.CLAUDE_PENGUIN_HOOK_TOKEN;
  await e.restart();
  assert.deepEqual(e.view().workers.map(worker => worker.sessionId).sort(), [one.worker.sessionId, two.worker.sessionId].sort());
  await e.manager.start(one.target);
  assert.deepEqual(e.processFor(one.worker.id).args.slice(-2), ['--resume', one.worker.sessionId]);
  assert.equal(e.processFor(one.worker.id).options.cwd, one.worker.workspace.path);
  await assert.rejects(e.manager.hook({ workerId: one.worker.id, token: oldToken, event: {} }), /Invalid hook/);
  e.processFor(one.worker.id).proc.exit(1);
  assert.equal(e.worker(one.worker.id).status, 'failed');
  assert.equal(e.worker(one.worker.id).sessionId, one.worker.sessionId);
  assert.equal(e.processes.length, 3);
});

test('an alive saved PID blocks restart without killing an unowned process', async t => {
  const e = await engine(t);
  const item = await e.add('pid');
  await e.manager.close();
  const file = path.join(e.stateDir, 'state.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.workers[0].pid = process.pid;
  fs.writeFileSync(file, JSON.stringify(saved));
  e.manager = await createManager(e.options);
  assert.equal(e.worker(item.worker.id).recoveryBlocked, true);
  await assert.rejects(e.manager.start(item.target), /saved process may still be alive/);
  await assert.rejects(e.manager.stop(item.target), /earlier runtime/);
  assert.equal(e.processes.length, 0);
});


test('saved state with inconsistent identities or records is refused before anything starts', async t => {
  const e = await engine(t);
  const one = await e.add('one');
  await e.adopt(one.project.id, { name: 'Twin' });
  await e.add('two', { puffle: 'Comet' });
  await e.manager.close();
  e.manager = null;
  const file = path.join(e.stateDir, 'state.json');
  const good = fs.readFileSync(file, 'utf8');
  const game = ownerId => ({ source: 'managed', status: 'ready', ownerId, iglooId: 9, roomId: ownerId + 2000, verifiedAt: null });
  const cases = [
    ['duplicate project IDs', s => { s.projects[1].id = s.projects[0].id; }, /project identity is missing or duplicated/],
    ['duplicate worker IDs', s => { s.workers[1].id = s.workers[0].id; }, /worker identity is missing, duplicated/],
    ['a version 2 project shape', s => { s.projects[0].activeWorkerId = null; }, /version 2 single-puffle shape/],
    ['an igloo room that is not the owner\'s', s => { s.projects[0].game = { ...game(s.projects[0].game.ownerId), roomId: 2999 }; }, /invalid igloo room address/],
    ['a project owner that is the visitor', s => { s.visitor = { penguinId: s.projects[0].game.ownerId, username: 'bridgecheck' }; }, /shares its game owner/],
    ['two projects with one repository', s => { s.projects[1].commonDir = s.projects[0].commonDir; }, /share one repository/],
    ['two workers with one Claude session', s => { s.workers[1].sessionId = s.workers[0].sessionId; }, /share one Claude session/],
    ['two workers with one puffle', s => { s.workers[1].puffle.puffleId = s.workers[0].puffle.puffleId; }, /share one puffle/],
    ['an invalid puffle binding', s => { s.workers[0].puffle.puffleId = 0; }, /invalid puffle binding/],
    ['two active puffles with one worktree', s => { s.workers[1].workspace.path = s.workers[0].workspace.path; }, /share one worktree/],
    ['a worktree from another repository', s => { s.workers[0].workspace.repoCommonDir = '/elsewhere/.git'; }, /different repository than its project/],
    ['more than ten puffles in one igloo', s => {
      for (let index = 0; index < 10; index++) s.workers.push({ ...structuredClone(s.workers[0]), id: randomUUID(), sessionId: randomUUID(), puffle: { ...s.workers[0].puffle, puffleId: 900 + index },
        workspace: { ...s.workers[0].workspace, path: `/tmp/extra-${index}` } });
    }, /more than 10 active puffles/],
    ['a bound adoption without its worker', s => { s.adoptions[0].workerId = randomUUID(); }, /bound adoption .* has no matching worker/],
    ['an unbound adoption record', s => { s.adoptions[0].projectId = randomUUID(); }, /adoption record is missing, duplicated, or unbound/],
    ['a worker without a setup record', s => { delete s.workers[0].setup; }, /no valid setup record/],
    ['a null project entry', s => { s.projects.push(null); }, /project record is not an object/],
    ['a null worker entry', s => { s.workers.push(null); }, /worker record is not an object/],
    ['a null task entry', s => { s.workers[0].taskHistory.push(null); }, /is incomplete/],
    ['an unknown setup phase', s => { s.projects[0].setup.phase = 'banana'; }, /unknown setup phase/],
  ];
  for (const [label, mutate, pattern] of cases) {
    const saved = JSON.parse(good);
    mutate(saved);
    fs.writeFileSync(file, JSON.stringify(saved));
    await assert.rejects(createManager(e.options), error => error.statusCode === 500 && /^Saved agent state is invalid: /.test(error.message) && pattern.test(error.message), label);
  }
  for (const phase of ['registered', 'needs-worker', 'preparing', 'game-pending', 'failed', 'ready']) {
    const saved = JSON.parse(good);
    saved.projects[0].setup.phase = phase;
    fs.writeFileSync(file, JSON.stringify(saved));
    await (await createManager(e.options)).close();
  }
  const otherVisitor = JSON.parse(good);
  otherVisitor.visitor.username = 'adoptcheck';
  fs.writeFileSync(file, JSON.stringify(otherVisitor));
  await assert.rejects(createManager(e.options), /belongs to the adoptcheck visitor/, 'a state directory stays with its visitor');
  fs.writeFileSync(file, good);
  e.manager = await createManager(e.options);
});

// ------------------------------------------------------------ migration

test('a migrated Atlas is archived read-only; an isolated replacement reuses only the game mapping; adoption stays off', async t => {
  const e = await engine(t);
  const source = e.repo('legacy');
  await e.manager.close();
  fs.writeFileSync(path.join(e.stateDir, 'state.json'), JSON.stringify(legacyState(source, { baseCommit: e.git(source, 'rev-parse', 'HEAD').trim() })));
  await assert.rejects(createManager(e.options), /migrate it explicitly/, 'the engine never migrates implicitly');
  const migrated = migrateStateDir(e.stateDir);
  assert.equal(migrated.backups.length, 2, 'v1 and v2 bytes are each preserved');
  e.manager = await createManager(e.options);
  const [archived] = e.view().archivedWorkers;
  const target = { projectId: archived.projectId, workerId: archived.id };
  assert.equal(e.view().workers.length, 0);
  assert.equal(archived.originalPath, source);
  assert.equal(archived.resumeCommand, `cd '${source}' && claude --resume ${archived.sessionId}`);
  for (const action of ['start', 'stop', 'diff', 'interrupt']) await assert.rejects(async () => e.manager[action](target), /archived and read-only/, action);
  assert.throws(() => e.manager.input({ ...target, data: 'x' }), /archived/);
  await assert.rejects(e.manager.hook({ workerId: archived.id, token: 'anything', event: {} }), /Invalid hook/);
  const project = e.view().projects[0];
  assert.deepEqual([project.game.source, project.game.ownerId, project.game.iglooId, project.game.roomId, project.game.puffleId], ['legacy-fixture', 105, 4, 2105, 4]);
  assert.match(project.adoptionBlocked, /Bridge Alpha owner/);
  await assert.rejects(e.manager.reserveAdoption({ projectId: project.id, typeId: 0, subtypeId: 0, name: 'Comet' }), /Bridge Alpha owner/);
  assert.equal((await e.manager.registerProject({ path: source })).id, project.id, 'the legacy repository deduplicates after migration');
  const replacement = await e.manager.createWorker({ projectId: project.id });
  assert.equal(replacement.name, 'Atlas');
  assert.deepEqual([replacement.puffle.puffleId, replacement.puffle.adoptionId], [4, null]);
  assert.notEqual(replacement.sessionId, archived.sessionId, 'the replacement starts a new Claude conversation');
  await e.manager.settled(project.id);
  assert.equal(e.projectView(project.id).setup.phase, 'ready');
  assert.equal(e.worker(replacement.id).workspace.state, 'ready');
  assert.equal(e.projectView(project.id).game.puffleId, 4, 'the preserved mapping is unchanged');
  assert.equal(e.view().archivedWorkers.length, 1);
  await assert.rejects(e.manager.createWorker({ projectId: project.id }), /already has its isolated puffle/);
});

test('migration with a missing source keeps readable history and blocks new puffles', async t => {
  const e = await engine(t);
  const original = e.repo('original-history');
  const sourcePath = path.join(e.dir, 'deleted-source');
  await e.manager.close();
  fs.writeFileSync(path.join(e.stateDir, 'state.json'), JSON.stringify(legacyState(sourcePath, { baseCommit: e.git(original, 'rev-parse', 'HEAD').trim() })));
  migrateStateDir(e.stateDir);
  e.manager = await createManager(e.options);
  const project = e.view().projects[0];
  assert.equal(project.sourceAvailable, false);
  assert.equal(e.view().archivedWorkers[0].taskHistory.length, 2);
  await assert.rejects(e.manager.createWorker({ projectId: project.id }), /source checkout is unavailable/);
  // An unrelated repository at the old path never inherits the legacy project or its game mapping.
  e.repo('deleted-source', { 'other.txt': 'unrelated\n' });
  assert.equal((await e.manager.registerProject({ path: sourcePath })).id, project.id, 'the old path still names the legacy project');
  const unrelated = error => error.statusCode === 409 && /does not contain the archived puffle Atlas's history \(baseline [0-9a-f]{12}\)/.test(error.message);
  await assert.rejects(e.manager.createWorker({ projectId: project.id }), unrelated);
  await e.restart();
  await assert.rejects(e.manager.createWorker({ projectId: project.id }), unrelated, 'startup does not adopt it either');
  assert.equal(e.view().workers.length, 0);
  // The original repository, restored at that path, rejoins its legacy project.
  fs.rmSync(sourcePath, { recursive: true, force: true });
  e.git(e.dir, 'clone', '-q', original, sourcePath);
  assert.equal((await e.manager.registerProject({ path: sourcePath })).id, project.id, 'a restored source rejoins its legacy project');
  assert.equal(e.projectView(project.id).sourceAvailable, true);
  await e.manager.createWorker({ projectId: project.id });
  assert.equal((await e.manager.settled(project.id)).setup.phase, 'ready');
});

test('identities and secrets stay out of snapshots and state; hook settings stay observational', async t => {
  const e = await engine(t);
  const item = await e.add('secrets');
  await e.manager.start(item.target);
  const token = e.processFor(item.worker.id).options.env.CLAUDE_PENGUIN_HOOK_TOKEN;
  assert.equal(JSON.stringify(e.view()).includes(token), false);
  assert.equal(fs.readFileSync(path.join(e.stateDir, 'state.json'), 'utf8').includes(token), false);
  assert.equal(fs.statSync(path.join(e.stateDir, 'state.json')).mode & 0o777, 0o600);
  const settings = JSON.parse(fs.readFileSync(path.join(e.stateDir, 'claude-settings.json'), 'utf8'));
  assert.equal(settings.hooks.SessionStart[0].hooks[0].type, 'command');
  assert.ok(Array.isArray(settings.hooks.SessionStart[0].hooks[0].args));
  assert.ok(e.processFor(item.worker.id).args.includes('manual'));
  assert.equal(e.view().limits.maxProjects, 32);
});

test('an unsupported Git version is refused at startup with upgrade guidance', async t => {
  const s = sandbox(t);
  await assert.rejects(createManager({ stateDir: path.join(s.dir, 'state'), worktreeRoot: path.join(s.dir, 'w'), hookBaseUrl: 'http://localhost:8081/engine/hooks', gitVersionText: 'git version 2.39.5 (Apple Git-154)' }), /requires Git 2\.48 or newer/);
});
