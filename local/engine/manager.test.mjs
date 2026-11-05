import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createManager } from './manager.mjs';
import { migrateStateDir } from './state.mjs';
import { FakePty, checkoutFingerprint, legacyState, sandbox } from './testing.mjs';

async function engine(t, extra = {}) {
  const s = sandbox(t, 'penguin-manager-');
  const stateDir = path.join(s.dir, 'state');
  const worktreeRoot = path.join(s.dir, 'worktrees');
  const processes = [];
  const events = [];
  const options = { stateDir, worktreeRoot, gitEnv: s.gitEnv, hookBaseUrl: 'http://localhost:8081/engine/hooks', onEvent: event => events.push(event),
    ptySpawn: (command, args, spawnOptions) => {
      const proc = new FakePty();
      processes.push({ proc, command, args, options: spawnOptions });
      return proc;
    }, ...extra };
  const e = { ...s, stateDir, worktreeRoot, processes, events, options, manager: null };
  e.manager = await createManager(options);
  s.cleanup(() => e.manager?.close());
  e.restart = async (more = {}) => { await e.manager.close(); e.manager = null; e.manager = await createManager({ ...options, ...more }); return e.manager; };
  e.view = () => e.manager.snapshot();
  e.worker = id => e.view().workers.find(worker => worker.id === id);
  e.projectView = id => e.view().projects.find(project => project.id === id);
  /** Register a disposable repository and create its ready puffle. */
  e.add = async (name, { files, puffle } = {}) => {
    const repo = s.repo(name, files);
    const project = await e.manager.registerProject({ path: repo });
    const created = await e.manager.createWorker({ projectId: project.id, name: puffle });
    await e.manager.settled(project.id);
    const worker = e.worker(created.id);
    return { repo, project: e.projectView(project.id), worker, target: { projectId: project.id, workerId: worker.id } };
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
});

test('project names are validated by the engine and the 32-project limit is enforced', async t => {
  const e = await engine(t);
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

test('creation requires an explicit project and never falls back to another project or worker', async t => {
  const e = await engine(t);
  const one = await e.add('one');
  const two = await e.add('two', { puffle: 'Comet' });
  await assert.rejects(e.manager.createWorker({ name: 'Nova' }), /explicit project ID/);
  await assert.rejects(e.manager.createWorker({ projectId: randomUUID() }), /Unknown project/);
  await assert.rejects(e.manager.createWorker({ projectId: one.project.id, name: 'Second' }), /already has a puffle/);
  await assert.rejects(e.manager.start({ projectId: one.project.id }), /explicit worker ID/);
  await assert.rejects(e.manager.start({ projectId: one.project.id, workerId: two.worker.id }), /Unknown worker for this project/);
  await assert.rejects(e.manager.diff({ workerId: one.worker.id }), /explicit project ID/);
  assert.equal(one.worker.name, 'Atlas', 'the first puffle defaults to Atlas');
  const three = e.repo('three');
  const project = await e.manager.registerProject({ path: three });
  const suggested = await e.manager.createWorker({ projectId: project.id });
  assert.equal(suggested.name, 'Nova', 'later defaults avoid used names');
  await assert.rejects(e.manager.createWorker({ projectId: (await e.manager.registerProject({ path: e.repo('four') })).id, name: 'Not Valid' }), /1 to 12 letters/);
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
  const created = await e.manager.createWorker({ projectId: project.id });
  assert.equal(created.workspace.state, 'reserved', 'the reservation is visible before Git runs');
  const settled = await e.manager.settled(project.id);
  assert.equal(settled.setup.phase, 'game-pending');
  assert.match(e.projectView(project.id).setup.note, /uncommitted changes[^]*stay in the source checkout/);
  const worker = e.worker(created.id);
  const leaf = path.join(fs.realpathSync.native(e.worktreeRoot), worker.id, 'My-Repo--copy-');
  assert.equal(worker.workspace.path, leaf);
  assert.equal(worker.workspace.branch, `claude-penguin/${project.id}/${worker.id}`);
  assert.equal(worker.workspace.baseCommit, before.head);
  assert.equal(worker.workspace.sourceDirtyAtCreation, true);
  assert.equal(fs.readFileSync(path.join(leaf, 'hello.txt'), 'utf8'), 'hello\n', 'the worktree starts from committed HEAD');
  for (const file of ['untracked.txt', 'ignored.log']) assert.equal(fs.existsSync(path.join(leaf, file)), false, `${file} is not copied`);
  assert.equal(fs.statSync(path.dirname(leaf)).mode & 0o777, 0o700);
  assert.match(e.git(repo, 'worktree', 'list', '--porcelain'), new RegExp(`locked Claude Penguin worker ${worker.id}`));
  assert.deepEqual(checkoutFingerprint(e, repo), before, 'source files, index, and HEAD are unchanged');
  assert.deepEqual(worker.inspection.warnings, []);
});

test('an overridden worktree root may contain spaces; roots inside Git are refused during setup', async t => {
  const e = await engine(t);
  const spaced = path.join(e.dir, 'Parent Folder', 'Penguin Worktrees');
  await e.restart({ worktreeRoot: spaced });
  const { worker } = await e.add('spaced');
  assert.ok(worker.workspace.path.startsWith(fs.realpathSync.native(spaced) + path.sep));
  assert.ok(fs.existsSync(path.join(worker.workspace.path, 'hello.txt')));
  const host = e.repo('host');
  await e.restart({ worktreeRoot: path.join(host, 'worktrees') });
  const project = await e.manager.registerProject({ path: e.repo('inside') });
  await assert.rejects(e.manager.createWorker({ projectId: project.id }), /inside a Git repository/);
  assert.equal(e.projectView(project.id).activeWorkerId, null, 'nothing is reserved after a refused root');
  assert.equal(e.view().workers.find(item => item.id === worker.id).workspace.path, worker.workspace.path, 'changing the root affects future workers only');
});

test('setup failures persist, retry reconciles the same reservation, and nothing is duplicated', async t => {
  const e = await engine(t);
  // A custom filter is refused before anything is reserved, because even source status reads could run it.
  const filtered = e.repo('filtered', { '.gitattributes': '*.txt filter=custom\n', 'a.txt': 'a\n' });
  e.git(filtered, 'config', 'filter.custom.clean', 'cat');
  const refused = await e.manager.registerProject({ path: filtered });
  await assert.rejects(e.manager.createWorker({ projectId: refused.id }), /Unsupported Git filter command/);
  assert.equal(e.projectView(refused.id).activeWorkerId, null);

  // A partial clone fails during checkout (Git has already created the branch), then succeeds on retry.
  const upstream = e.repo('upstream', { 'big.txt': 'large\n' });
  const repo = path.join(e.dir, 'partial');
  e.git(e.dir, 'clone', '-q', '--filter=blob:none', '--no-checkout', `file://${upstream}`, repo);
  const project = await e.manager.registerProject({ path: repo });
  const created = await e.manager.createWorker({ projectId: project.id });
  let view = await e.manager.settled(project.id);
  assert.equal(view.setup.phase, 'failed');
  assert.equal(view.setup.retryable, true);
  assert.match(view.setup.error, /promisor remote/);
  assert.equal(e.worker(created.id).status, 'setup');
  await assert.rejects(e.manager.start({ projectId: project.id, workerId: created.id }), /setup is not complete/);
  await assert.rejects(e.manager.createWorker({ projectId: project.id }), /already has a puffle/);
  e.git(repo, 'fetch', '-q', 'origin');
  e.git(repo, 'cat-file', '-p', e.git(upstream, 'rev-parse', 'HEAD:big.txt').trim()); // The user fetches the object manually.
  await e.manager.retrySetup({ projectId: project.id });
  view = await e.manager.settled(project.id);
  assert.equal(view.setup.phase, 'game-pending');
  const worker = e.worker(created.id);
  assert.equal(worker.workspace.state, 'ready');
  assert.equal(fs.readFileSync(path.join(worker.workspace.path, 'big.txt'), 'utf8'), 'large\n');
  assert.equal(e.git(repo, 'branch', '--list', 'claude-penguin/*').trim().split('\n').length, 1);
  assert.equal(e.git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 2);
  await assert.rejects(e.manager.retrySetup({ projectId: project.id }), /not waiting for a retry/);
});

test('an engine stop after Git finished but before state recorded it reconciles on retry', async t => {
  const e = await engine(t);
  const repo = e.repo('interrupted');
  const project = await e.manager.registerProject({ path: repo });
  const created = await e.manager.createWorker({ projectId: project.id });
  // Simulate a crash: the reservation is durable, the engine stops, and Git completed out of band.
  await e.manager.close();
  const saved = JSON.parse(fs.readFileSync(path.join(e.stateDir, 'state.json'), 'utf8'));
  const reserved = saved.workers.find(worker => worker.id === created.id).workspace;
  saved.projects[0].setup.phase = 'preparing';
  fs.writeFileSync(path.join(e.stateDir, 'state.json'), JSON.stringify(saved));
  if (!fs.existsSync(reserved.path)) e.git(repo, 'worktree', 'add', '-q', '--lock', '-b', reserved.branch, reserved.path, reserved.baseCommit);
  e.manager = await createManager(e.options);
  let view = e.projectView(project.id);
  assert.equal(view.setup.phase, 'failed');
  assert.match(view.setup.error, /Retry to reconcile/);
  await e.manager.retrySetup({ projectId: project.id });
  view = await e.manager.settled(project.id);
  assert.equal(view.setup.phase, 'game-pending');
  assert.equal(e.worker(created.id).workspace.state, 'ready');
  assert.equal(e.git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 2, 'the existing worktree was adopted, not duplicated');
  assert.equal(e.view().workers.length, 1);
});

test('concurrent setup for one project yields one puffle; different projects set up concurrently', async t => {
  const e = await engine(t);
  const one = await e.manager.registerProject({ path: e.repo('one') });
  const two = await e.manager.registerProject({ path: e.repo('two') });
  const results = await Promise.allSettled([
    e.manager.createWorker({ projectId: one.id, name: 'Atlas' }), e.manager.createWorker({ projectId: one.id, name: 'Comet' }),
    e.manager.createWorker({ projectId: two.id, name: 'Nova' }),
  ]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.match(results[1].reason.message, /already has a puffle/);
  await Promise.all([e.manager.settled(one.id), e.manager.settled(two.id)]);
  assert.deepEqual(e.view().workers.map(worker => [worker.name, worker.workspace.state]).sort(), [['Atlas', 'ready'], ['Nova', 'ready']]);
  assert.equal(e.git(path.join(e.dir, 'one'), 'branch', '--list', 'claude-penguin/*').trim().split('\n').length, 1);
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

// ------------------------------------------------------------ migration

test('a migrated Atlas is archived read-only; an isolated replacement reuses only the game mapping', async t => {
  const e = await engine(t);
  const source = e.repo('legacy');
  await e.manager.close();
  fs.writeFileSync(path.join(e.stateDir, 'state.json'), JSON.stringify(legacyState(source)));
  await assert.rejects(createManager(e.options), /migrate it explicitly/, 'the engine never migrates implicitly');
  migrateStateDir(e.stateDir);
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
  assert.equal((await e.manager.registerProject({ path: source })).id, project.id, 'the legacy repository deduplicates after migration');
  const replacement = await e.manager.createWorker({ projectId: project.id });
  assert.equal(replacement.name, 'Atlas');
  assert.notEqual(replacement.sessionId, archived.sessionId, 'the replacement starts a new Claude conversation');
  await e.manager.settled(project.id);
  assert.equal(e.projectView(project.id).setup.phase, 'ready');
  assert.equal(e.projectView(project.id).game.puffleId, 4, 'the preserved mapping is unchanged');
  assert.equal(e.view().archivedWorkers.length, 1);
});

test('migration with a missing source keeps readable history and blocks new puffles', async t => {
  const e = await engine(t);
  await e.manager.close();
  fs.writeFileSync(path.join(e.stateDir, 'state.json'), JSON.stringify(legacyState(path.join(e.dir, 'deleted-source'))));
  migrateStateDir(e.stateDir);
  e.manager = await createManager(e.options);
  const project = e.view().projects[0];
  assert.equal(project.sourceAvailable, false);
  assert.equal(e.view().archivedWorkers[0].taskHistory.length, 2);
  await assert.rejects(e.manager.createWorker({ projectId: project.id }), /source checkout is unavailable/);
  const restored = e.repo('deleted-source');
  assert.equal((await e.manager.registerProject({ path: restored })).id, project.id, 'a restored source rejoins its legacy project');
  assert.equal(e.projectView(project.id).sourceAvailable, true);
  await e.manager.createWorker({ projectId: project.id });
  assert.equal((await e.manager.settled(project.id)).setup.phase, 'ready');
});
