import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createManager } from './manager.mjs';

const fixtures = { version: 1, kind: 'game-bridge-fixture', visitor: { username: 'bridgecheck', penguinId: 107 }, projects: [
  { projectId: 'bridge-alpha', name: 'Alpha', puffleName: 'Atlas', ownerId: 105, iglooId: 4, roomId: 2105, puffleId: 4 },
  { projectId: 'bridge-beta', name: 'Beta', puffleName: 'Comet', ownerId: 106, iglooId: 5, roomId: 2106, puffleId: 5 },
] };

class FakePty {
  pid = 99999999;
  writes = [];
  kills = [];
  onData(callback) { this.dataCallback = callback; }
  onExit(callback) { this.exitCallback = callback; }
  write(data) { this.writes.push(data); }
  resize(cols, rows) { this.size = { cols, rows }; }
  data(data) { this.dataCallback(data); }
  exit(exitCode = 0) { this.exitCallback({ exitCode }); }
  kill(signal) { this.kills.push(signal); queueMicrotask(() => this.exit()); }
}

async function setup(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'penguin-manager-'));
  const repo = path.join(dir, 'repo');
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'dev');
  fs.writeFileSync(path.join(repo, 'hello.txt'), 'hello\n');
  git('add', 'hello.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  const processes = [];
  const events = [];
  const options = { stateDir, fixtures, hookBaseUrl: 'http://localhost:8081/engine/hooks', onEvent: event => events.push(event),
    ptySpawn: (command, args, options) => {
      const proc = new FakePty();
      processes.push({ proc, command, args, options });
      return proc;
    }, ...extra };
  let manager = await createManager(options);
  t.after(async () => { await manager.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const project = await manager.registerProject({ path: repo, fixtureId: 'bridge-alpha' });
  const worker = await manager.createWorker({ projectId: project.id, name: 'Atlas' });
  const target = { projectId: project.id, workerId: worker.id };
  function hook(type, fields = {}, token = processes.at(-1).options.env.CLAUDE_PENGUIN_HOOK_TOKEN) {
    return manager.hook({ workerId: worker.id, token,
      event: { hook_event_name: type, session_id: worker.sessionId, cwd: fs.realpathSync(repo), ...fields } });
  }
  return { dir, repo, stateDir, git, manager, project, worker, target, hook, events, processes, options,
    restart: async () => { await manager.close(); manager = await createManager(options); return manager; } };
}

test('project and puffle identity stays explicit, canonical, private, and limited to one worker', async t => {
  const s = await setup(t);
  const alias = path.join(s.dir, 'alias');
  fs.symlinkSync(s.repo, alias);
  assert.equal((await s.manager.registerProject({ path: alias })).id, s.project.id);
  await assert.rejects(s.manager.createWorker({ projectId: s.project.id }), /one worker/);
  await assert.rejects(s.manager.registerProject({ path: s.repo, fixtureId: 'bridge-beta' }), /bridge-alpha/);
  assert.throws(() => s.manager.input({ projectId: randomUUID(), workerId: s.worker.id, data: 'x' }), /Unknown project/);
  assert.notEqual(s.project.id, s.project.fixtureId);
  assert.equal(s.project.puffleId, 4);
  await s.manager.start(s.target);
  const token = s.processes[0].options.env.CLAUDE_PENGUIN_HOOK_TOKEN;
  assert.equal(JSON.stringify(s.manager.snapshot()).includes(token), false);
  assert.equal(fs.readFileSync(path.join(s.stateDir, 'state.json'), 'utf8').includes(token), false);
  const settings = JSON.parse(fs.readFileSync(path.join(s.stateDir, 'claude-settings.json'), 'utf8'));
  assert.equal(settings.hooks.SessionStart[0].hooks[0].type, 'command');
  assert.ok(Array.isArray(settings.hooks.SessionStart[0].hooks[0].args));
});

test('hooks prove working/permission/turn-ended state and reject other runs, sessions and projects', async t => {
  const s = await setup(t);
  await s.manager.start(s.target);
  const revisionBefore = s.manager.snapshot().revision;
  await s.hook('SessionStart', { source: 'startup' });
  assert.ok(s.manager.snapshot().revision > revisionBefore);
  assert.equal(s.manager.snapshot().workers[0].status, 'idle');
  await assert.rejects(s.hook('UserPromptSubmit', {}, 'wrong-token'), /Invalid hook/);
  await assert.rejects(s.hook('UserPromptSubmit', { session_id: randomUUID() }), /changed session/);
  await assert.rejects(s.hook('UserPromptSubmit', { cwd: s.dir }), /does not match/);
  await s.hook('UserPromptSubmit', { prompt: 'Fix hello', prompt_id: 'turn-1' });
  await s.hook('PreToolUse', { tool_name: 'AskUserQuestion', prompt_id: 'turn-1' });
  assert.equal(s.manager.snapshot().workers[0].status, 'needs-you');
  s.manager.input({ ...s.target, data: '1\r' });
  await s.hook('PostToolUse', { tool_name: 'AskUserQuestion', prompt_id: 'turn-1' });
  assert.equal(s.manager.snapshot().workers[0].status, 'working');
  await s.hook('PermissionRequest', { tool_name: 'Bash', prompt_id: 'turn-1' });
  assert.equal(s.manager.snapshot().workers[0].status, 'needs-you');
  await s.hook('PostToolUseFailure', { tool_name: 'Bash', prompt_id: 'turn-1' });
  assert.equal(s.manager.snapshot().workers[0].status, 'working');
  await s.hook('Stop', { prompt_id: 'turn-1' });
  const result = s.manager.snapshot().workers[0];
  assert.equal(result.status, 'review');
  assert.equal(result.taskHistory[0].status, 'turn-ended');
  assert.match(result.activity, /completion has not been verified/);
  await s.hook('StopFailure', { agent_id: 'child-agent', error: 'rate_limit' });
  assert.equal(s.manager.snapshot().workers[0].status, 'review');
  await s.hook('StopFailure', { error: 'rate_limit' });
  assert.equal(s.manager.snapshot().workers[0].status, 'failed');
});

test('terminal replay includes output once with a sequence and interrupt needs actual idle marker', async t => {
  const s = await setup(t);
  await s.manager.start(s.target);
  await s.hook('SessionStart', { source: 'startup' });
  await s.hook('UserPromptSubmit', { prompt: 'Work' });
  const proc = s.processes[0].proc;
  proc.data('first line\r\n');
  proc.data('\x1b]9;4;0\x07');
  let screen = await s.manager.terminal(s.target);
  assert.match(screen.data, /first line/);
  assert.equal(screen.sequence, 2);
  assert.equal(s.manager.snapshot().workers[0].status, 'working', 'unsolicited idle is not completion');
  proc.data('\x1b]9;4;0\x07');
  s.manager.interrupt(s.target);
  assert.equal(proc.writes.at(-1), '\x1b');
  await s.manager.terminal(s.target);
  assert.equal(s.manager.snapshot().workers[0].status, 'needs-you', 'idle queued before Escape cannot confirm its effect');
  assert.match(s.manager.snapshot().workers[0].activity, /Cancellation is not yet confirmed/, 'sending escape alone does not prove interruption');
  proc.data('\x1b]9;4;0\x07');
  screen = await s.manager.terminal(s.target);
  assert.equal(screen.sequence, 4);
  assert.equal(s.manager.snapshot().workers[0].status, 'interrupted');
  await s.manager.submit({ ...s.target, text: 'Try a smaller change' });
  assert.deepEqual(proc.writes.slice(-2), ['\x1b[200~Try a smaller change\x1b[201~', '\r']);
  const streamed = s.events.filter(event => event.type === 'terminal');
  assert.deepEqual(streamed.map(event => event.sequence), [1, 2, 3, 4]);
  s.manager.resize({ ...s.target, cols: 90, rows: 24 });
  assert.deepEqual(proc.size, { cols: 90, rows: 24 });
});

test('interrupt without an idle marker requests attention until an authenticated new prompt starts', async t => {
  const s = await setup(t);
  await s.manager.start(s.target);
  await s.hook('SessionStart', { source: 'startup' });
  await s.hook('UserPromptSubmit', { prompt: 'Original task', prompt_id: 'turn-1' });
  const proc = s.processes[0].proc;
  s.manager.interrupt(s.target);
  proc.data('Interrupted.\r\n> Original task');
  await s.manager.terminal(s.target);
  let worker = s.manager.snapshot().workers[0];
  assert.equal(worker.status, 'needs-you', 'text alone cannot prove the turn stopped');
  assert.match(worker.activity, /Cancellation is not yet confirmed/);
  assert.equal(worker.taskHistory[0].endedAt, undefined);
  await assert.rejects(s.manager.submit({ ...s.target, text: 'Unsafe second task' }), /live terminal/);
  for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
    await s.hook(event, { tool_name: 'Bash', prompt_id: 'turn-1' });
    worker = s.manager.snapshot().workers[0];
    assert.equal(worker.status, 'needs-you', `${event} cannot silently clear pending cancellation`);
    assert.match(worker.activity, /Cancellation is not yet confirmed/);
    assert.equal(worker.taskHistory[0].endedAt, undefined);
  }
  s.manager.input({ ...s.target, data: 'Retry from the terminal\r' });
  assert.equal(s.manager.snapshot().workers[0].status, 'needs-you', 'input alone is not a lifecycle event');
  await s.hook('UserPromptSubmit', { prompt: 'Retry from the terminal', prompt_id: 'turn-2' });
  proc.data('\x1b]9;4;0\x07');
  await s.manager.terminal(s.target);
  worker = s.manager.snapshot().workers[0];
  assert.equal(worker.status, 'working', 'a late idle marker cannot interrupt the new task');
  assert.equal(worker.taskHistory[0].status, 'interrupted');
  assert.equal(worker.taskHistory[1].status, 'working');
});

test('a pending interrupt cannot overwrite a subsequent terminal lifecycle event', async t => {
  for (const [event, fields, expected] of [
    ['Stop', {}, 'review'],
    ['StopFailure', { error: 'rate_limit' }, 'failed'],
    ['SessionEnd', { reason: 'clear' }, 'interrupted'],
  ]) {
    const s = await setup(t);
    await s.manager.start(s.target);
    await s.hook('SessionStart', { source: 'startup' });
    await s.hook('UserPromptSubmit', { prompt: 'Work', prompt_id: 'turn-1' });
    s.manager.interrupt(s.target);
    await s.hook(event, fields);
    const worker = s.manager.snapshot().workers[0];
    const revision = s.manager.snapshot().revision;
    assert.equal(worker.status, expected);
    s.processes[0].proc.data('\x1b]9;4;0\x07');
    await s.manager.terminal(s.target);
    assert.deepEqual(s.manager.snapshot().workers[0], worker, `${event} must survive a late idle marker`);
    assert.equal(s.manager.snapshot().revision, revision);
  }
});

test('interrupt racing an already ended turn preserves readiness and does not send Escape', async t => {
  for (const status of ['idle', 'review', 'interrupted', 'failed']) {
    const s = await setup(t);
    await s.manager.start(s.target);
    await s.hook('SessionStart', { source: 'startup' });
    const proc = s.processes[0].proc;
    if (status !== 'idle') await s.hook('UserPromptSubmit', { prompt: 'Work' });
    if (status === 'review') await s.hook('Stop');
    if (status === 'failed') await s.hook('StopFailure', { error: 'rate_limit' });
    if (status === 'interrupted') {
      s.manager.interrupt(s.target);
      proc.data('\x1b]9;4;0\x07');
      await s.manager.terminal(s.target);
    }
    const before = s.manager.snapshot();
    const writes = proc.writes.length;
    assert.equal(s.manager.interrupt(s.target).status, status);
    assert.equal(proc.writes.length, writes);
    assert.deepEqual(s.manager.snapshot(), before);
    if (status !== 'failed') {
      await s.manager.submit({ ...s.target, text: 'Next task' });
      assert.deepEqual(proc.writes.slice(-2), ['\x1b[200~Next task\x1b[201~', '\r']);
    }
  }
});

test('runtime restart resumes exact established session and failed resume never creates a replacement', async t => {
  const s = await setup(t);
  await s.manager.start(s.target);
  assert.deepEqual(s.processes[0].args.slice(-4), ['--session-id', s.worker.sessionId, '--name', 'Atlas']);
  assert.ok(s.processes[0].args.includes('manual'));
  await s.hook('SessionStart', { source: 'startup' });
  const oldToken = s.processes[0].options.env.CLAUDE_PENGUIN_HOOK_TOKEN;
  const restored = await s.restart();
  assert.equal(restored.snapshot().workers[0].sessionId, s.worker.sessionId);
  await restored.start(s.target);
  assert.deepEqual(s.processes[1].args.slice(-2), ['--resume', s.worker.sessionId]);
  await assert.rejects(restored.hook({ workerId: s.worker.id, token: oldToken, event: {} }), /Invalid hook/);
  s.processes[1].proc.exit(1);
  assert.equal(restored.snapshot().workers[0].status, 'failed');
  assert.equal(s.processes.length, 2);
  assert.equal(restored.snapshot().workers[0].sessionId, s.worker.sessionId);
});

test('an alive saved PID blocks restart without killing an unowned process', async t => {
  const s = await setup(t);
  await s.manager.close();
  const file = path.join(s.stateDir, 'state.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.workers[0].pid = process.pid;
  fs.writeFileSync(file, JSON.stringify(saved));
  const other = await createManager(s.options);
  t.after(() => other.close());
  assert.equal(other.snapshot().workers[0].recoveryBlocked, true);
  await assert.rejects(other.start(s.target), /saved process may still be alive/);
  await assert.rejects(other.stop(s.target), /earlier runtime/);
  assert.equal(s.processes.length, 0);
});

test('session-switch hooks stop owned terminal and preserve puffle conversation identity', async t => {
  const s = await setup(t);
  await s.manager.start(s.target);
  await s.hook('SessionStart', { source: 'startup' });
  await assert.rejects(s.hook('SessionStart', { source: 'clear', session_id: randomUUID() }), /switching conversations/);
  assert.deepEqual(s.processes[0].proc.kills, ['SIGTERM']);
  assert.equal(s.manager.snapshot().workers[0].sessionId, s.worker.sessionId);
});

test('missing startup hook requests attention and output alone never means working', async t => {
  const s = await setup(t, { startupTimeoutMs: 5 });
  await s.manager.start(s.target);
  s.processes[0].proc.data('Please trust this directory.');
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(s.manager.snapshot().workers[0].status, 'needs-you');
  assert.equal(s.manager.snapshot().workers[0].established, false);
});

test('diff includes committed and uncommitted work without following untracked symlinks', async t => {
  const s = await setup(t);
  fs.writeFileSync(path.join(s.repo, 'hello.txt'), 'committed change\n');
  s.git('add', 'hello.txt');
  s.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'agent change');
  fs.writeFileSync(path.join(s.repo, 'hello.txt'), 'final change\n');
  fs.writeFileSync(path.join(s.repo, 'new.txt'), 'new text\n');
  fs.writeFileSync(path.join(s.dir, 'private.txt'), 'private sentinel');
  fs.symlinkSync(path.join(s.dir, 'private.txt'), path.join(s.repo, 'escape.txt'));
  const changes = await s.manager.diff(s.target);
  assert.match(changes.diff, /-hello/);
  assert.match(changes.diff, /\+final change/);
  assert.equal(changes.untracked.find(file => file.path === 'new.txt').content, 'new text\n');
  assert.ok(changes.untracked.find(file => file.path === 'escape.txt').skipped);
  assert.equal(JSON.stringify(changes).includes('private sentinel'), false);
});
