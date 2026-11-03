import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as nodePty from '@lydell/node-pty';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { validateFixtures } from '../web/bridge/model.mjs';
import { readState, writeState, writePrivateJson } from './state.mjs';

const execFileAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'];
const SCROLLBACK = 3000;
const MAX_INPUT = 64 * 1024;
const MAX_DIFF = 200000;
const MAX_UNTRACKED = 20;
const MAX_FILE = 32000;
const INTERRUPT_ACTIVITY = 'Interrupt requested. Cancellation is not yet confirmed. Check the terminal; Escape may also dismiss a prompt.';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const copy = value => structuredClone(value);

function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function label(value, fallback) {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'string' || !result.trim() || result.length > 80 || /[\x00-\x1f\x7f]/.test(result)) fail('Names must contain 1 to 80 printable characters.');
  return result.trim();
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function childEnvironment() {
  const env = { ...process.env };
  const remove = new Set(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_EXECPATH',
    'CLAUDE_PID', 'CLAUDE_EFFORT', 'NO_COLOR', 'FORCE_COLOR', 'VSCODE_INJECTION', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION']);
  for (const key of Object.keys(env)) {
    if (remove.has(key) || /^(CLAUDE_CODE_SESSION|CLAUDE_CODE_CHILD|CLAUDE_CODE_MESSAGING|NEBULA_|AGENT_OFFICE_|CLAUDE_PENGUIN_)/.test(key)) delete env[key];
  }
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
}

async function git(cwd, args, maxBuffer = 1024 * 1024) {
  return (await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer, timeout: 15000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } })).stdout;
}

async function repoPath(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) fail('Repository path must be absolute.');
  const real = fs.realpathSync(input);
  const root = (await git(real, ['rev-parse', '--show-toplevel'])).trim();
  return fs.realpathSync(root);
}

function secretMatches(expected, supplied) {
  if (typeof expected !== 'string' || typeof supplied !== 'string') return false;
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A host-owned PTY remains alive when the browser, panel, or game room changes. */
export async function createManager({ stateDir, fixtures, onEvent = () => {}, claudePath = 'claude',
  ptySpawn = nodePty.spawn, hookBaseUrl, startupTimeoutMs = 12000 } = {}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) fail('An absolute private state directory is required.');
  const fixtureManifest = validateFixtures(fixtures);
  const fixture = fixtureManifest.projects.find(item => item.projectId === 'bridge-alpha');
  if (!fixture) fail('The bridge-alpha verification fixture is required.');
  const hookUrl = new URL(hookBaseUrl);
  if (hookUrl.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(hookUrl.hostname)) fail('Hooks must use a loopback HTTP address.');
  const state = readState(stateDir);
  const runtimes = new Map();
  let closing = false;
  let registrationPending = false;
  const settingsPath = path.join(stateDir, 'claude-settings.json');
  const helper = fileURLToPath(new URL('./hook-client.mjs', import.meta.url));
  writePrivateJson(settingsPath, { hooks: Object.fromEntries(EVENTS.map(event => [event, [{ hooks: [{
    type: 'command', command: process.execPath, args: [helper], timeout: 3,
  }] }]])) });

  for (const project of state.projects) {
    if (!UUID.test(project.id) || project.fixtureId !== fixture.projectId || typeof project.path !== 'string' || !path.isAbsolute(project.path)) fail('Saved project identity is invalid.');
    for (const field of ['ownerId', 'iglooId', 'roomId', 'puffleId']) {
      if (project[field] !== fixture[field]) fail('Saved project fixture changed; repair the mapping explicitly before starting agents.');
    }
    label(project.name);
  }
  for (const worker of state.workers) {
    if (!UUID.test(worker.id) || !UUID.test(worker.sessionId) || !state.projects.some(project => project.id === worker.projectId) ||
        typeof worker.established !== 'boolean' || !Array.isArray(worker.taskHistory) || !/^[a-f0-9]{40,64}$/.test(worker.baseCommit)) fail('Saved worker identity is invalid.');
    label(worker.name);
    if (worker.pid !== null && worker.pid !== undefined && (!Number.isSafeInteger(worker.pid) || worker.pid <= 0)) fail('Saved worker process identity is invalid.');
    worker.cols = Math.min(300, Math.max(40, Number.isSafeInteger(worker.cols) ? worker.cols : 120));
    worker.rows = Math.min(100, Math.max(10, Number.isSafeInteger(worker.rows) ? worker.rows : 32));
    worker.status = 'offline';
    worker.updatedAt = now();
    for (const task of worker.taskHistory) {
      if (!task.endedAt) { task.status = 'interrupted'; task.endedAt = worker.updatedAt; }
    }
    if (pidAlive(worker.pid)) {
      worker.activity = 'A previous process may still be alive. Stop it manually before resuming; this engine will not kill or duplicate it.';
    } else {
      worker.pid = null;
      worker.activity = worker.established ? 'Runtime restarted. Start to resume this exact conversation.' : 'Ready to start this named conversation.';
    }
  }

  function projectFor(id) {
    const project = state.projects.find(item => item.id === id);
    if (!project) fail('Unknown project.', 404);
    return project;
  }
  function workerFor({ projectId, workerId } = {}) {
    projectFor(projectId);
    const worker = state.workers.find(item => item.id === workerId && item.projectId === projectId);
    if (!worker) fail('Unknown worker for this project.', 404);
    return worker;
  }
  function assertOpen() { if (closing) fail('The local runtime is stopping.', 409); }
  function projectView(project) {
    return Object.fromEntries(['id', 'name', 'path', 'fixtureId', 'ownerId', 'iglooId', 'roomId', 'puffleId', 'createdAt'].map(key => [key, project[key]]));
  }
  function workerView(worker) {
    return { ...Object.fromEntries(['id', 'projectId', 'name', 'sessionId', 'status', 'activity', 'established',
      'cols', 'rows', 'createdAt', 'updatedAt', 'taskHistory', 'lastError', 'exitCode', 'baseCommit', 'dirtyAtStart'].map(key => [key, copy(worker[key])])),
    running: Boolean(runtimes.get(worker.id)?.pty), recoveryBlocked: Boolean(!runtimes.get(worker.id)?.pty && pidAlive(worker.pid)) };
  }
  function snapshot() { return { revision: state.revision, projects: state.projects.map(projectView), workers: state.workers.map(workerView) }; }
  function notify(event) { try { onEvent(event); } catch { /* A disconnected UI must not stop the agent. */ } }
  function commit() {
    state.revision++;
    writeState(stateDir, state);
    notify({ type: 'snapshot', ...snapshot() });
  }
  function update(worker, status, activity) {
    worker.status = status;
    worker.activity = activity;
    worker.updatedAt = now();
    commit();
  }
  function taskState(worker, status) {
    const task = worker.taskHistory.at(-1);
    if (task && !task.endedAt) { task.status = status; task.endedAt = now(); }
  }
  function activeRuntime(worker) {
    const runtime = runtimes.get(worker.id);
    if (!runtime?.pty) fail('Start this worker before using its terminal.', 409);
    return runtime;
  }
  async function ensureRepo(project) {
    if (await repoPath(project.path) !== project.path) fail('The repository path now identifies another project. Repair the mapping before continuing.', 409);
  }
  function callbackFailure(worker, error) {
    worker.status = 'failed';
    worker.lastError = `Runtime state could not be recorded: ${error.message}`;
    worker.activity = worker.lastError;
    notify({ type: 'snapshot', ...snapshot() });
  }

  async function registerProject({ path: input, name, fixtureId = 'bridge-alpha' } = {}) {
    assertOpen();
    if (registrationPending) fail('A project registration is already in progress.', 409);
    if (fixtureId !== fixture.projectId) fail('This milestone supports only the bridge-alpha fixture.');
    registrationPending = true;
    try {
      const canonical = await repoPath(input);
      if (state.projects.length) {
        const existing = state.projects[0];
        if (existing.path === canonical && existing.fixtureId === fixtureId) return projectView(existing);
        fail('This milestone supports one repository. The existing project will not be replaced.', 409);
      }
      const project = { id: randomUUID(), name: label(name, path.basename(canonical)), path: canonical, fixtureId, createdAt: now(),
        ...Object.fromEntries(['ownerId', 'iglooId', 'roomId', 'puffleId'].map(key => [key, fixture[key]])) };
      state.projects.push(project);
      commit();
      return projectView(project);
    } finally { registrationPending = false; }
  }

  let workerPending = false;
  async function createWorker({ projectId, name } = {}) {
    assertOpen();
    const project = projectFor(projectId);
    if (workerPending || state.workers.length) fail('This milestone supports one worker. Resume the existing worker.', 409);
    workerPending = true;
    try {
      await ensureRepo(project);
      const baseCommit = (await git(project.path, ['rev-parse', '--verify', 'HEAD'])).trim();
      const dirtyAtStart = Boolean((await git(project.path, ['status', '--porcelain=v1', '--untracked-files=normal'])).trim());
      const worker = { id: randomUUID(), projectId, name: label(name, fixture.puffleName), sessionId: randomUUID(),
        status: 'offline', activity: 'Ready to start this named conversation.', established: false,
        cols: 120, rows: 32, createdAt: now(), updatedAt: now(), pid: null, taskHistory: [], baseCommit, dirtyAtStart };
      state.workers.push(worker);
      commit();
      return workerView(worker);
    } finally { workerPending = false; }
  }

  async function start(target) {
    assertOpen();
    const worker = workerFor(target);
    if (runtimes.get(worker.id)?.pty) return workerView(worker);
    if (runtimes.get(worker.id)?.starting) fail('This worker is already starting.', 409);
    if (pidAlive(worker.pid)) fail('The saved process may still be alive. Stop it manually before resuming; refusing to duplicate the session.', 409);
    const previous = runtimes.get(worker.id);
    const runtime = { starting: true, token: randomBytes(32).toString('hex'), pty: null, stopping: false,
      started: false, lastNeedsYouAt: 0, promptId: null, terminalQueue: Promise.resolve(),
      sequence: previous?.sequence ?? 0, renderedSequence: previous?.sequence ?? 0 };
    runtimes.set(worker.id, runtime);
    let term;
    try {
      const project = projectFor(worker.projectId);
      await ensureRepo(project);
      assertOpen();
      previous?.term?.dispose();
      term = new headless.Terminal({ cols: worker.cols, rows: worker.rows, scrollback: SCROLLBACK, allowProposedApi: true });
      const serializer = new serialize.SerializeAddon();
      term.loadAddon(serializer);
      Object.assign(runtime, { term, serializer });
      term.parser.registerOscHandler(9, data => {
        // Some Claude versions emit an idle progress marker after Escape, which
        // has no Stop hook. Without it, retain explicit unconfirmed attention.
        if (runtime.interruptPending && runtime.parsingSequence > runtime.interruptAfterSequence && /^4;0(?:;|$)/.test(data) && runtime.pty) {
          runtime.interruptPending = false;
          taskState(worker, 'interrupted');
          try { update(worker, 'interrupted', 'Interrupt requested; terminal returned to input.'); }
          catch (error) { callbackFailure(worker, error); }
        }
        return true;
      });
      const args = ['--permission-mode', 'manual', '--settings', settingsPath,
        ...(worker.established ? ['--resume', worker.sessionId] : ['--session-id', worker.sessionId, '--name', worker.name])];
      worker.lastError = undefined;
      worker.exitCode = undefined;
      update(worker, 'starting', worker.established ? 'Resuming the saved Claude conversation.' : 'Starting Claude Code.');
      const proc = ptySpawn(claudePath, args, { name: 'xterm-256color', cols: worker.cols, rows: worker.rows, cwd: project.path,
        env: { ...childEnvironment(), CLAUDE_PENGUIN_HOOK_URL: hookUrl.href,
          CLAUDE_PENGUIN_WORKER_ID: worker.id, CLAUDE_PENGUIN_HOOK_TOKEN: runtime.token } });
      if (!Number.isSafeInteger(proc.pid) || proc.pid <= 0) { proc.kill(); throw new Error('The terminal did not provide a valid process ID.'); }
      runtime.pty = proc;
      runtime.starting = false;
      worker.pid = proc.pid;
      runtime.exited = new Promise(resolve => { runtime.resolveExit = resolve; });
      proc.onData(data => {
        if (runtime.pty !== proc) return;
        const sequence = ++runtime.sequence;
        runtime.terminalQueue = runtime.terminalQueue.then(() => new Promise(resolve => {
          runtime.parsingSequence = sequence;
          term.write(data, () => { runtime.renderedSequence = sequence; resolve(); });
        }));
        notify({ type: 'terminal', projectId: worker.projectId, workerId: worker.id, data, sequence });
      });
      proc.onExit(({ exitCode, signal }) => {
        if (runtime.pty !== proc) return;
        clearTimeout(runtime.startupTimer);
        runtime.pty = null;
        runtime.token = null;
        worker.pid = null;
        worker.exitCode = exitCode;
        const failed = !runtime.stopping && (exitCode !== 0 || !runtime.started);
        taskState(worker, failed ? 'failed' : 'interrupted');
        try {
          if (failed) {
            worker.lastError = `Claude exited ${signal ? `after signal ${signal}` : `with code ${exitCode}`}${runtime.started ? '.' : ' before confirming the session. The saved session was not replaced.'}`;
            update(worker, 'failed', worker.lastError);
          } else update(worker, runtime.stopping ? 'interrupted' : 'offline', runtime.stopping ? 'Claude process stopped. Start to resume the saved conversation.' : 'Claude process exited. Start to resume the saved conversation.');
        } catch (error) { callbackFailure(worker, error); }
        runtime.resolveExit();
      });
      runtime.startupTimer = setTimeout(() => {
        if (runtime.pty !== proc || runtime.started) return;
        try { update(worker, 'needs-you', 'Open the terminal to handle a trust, login, or setup prompt.'); }
        catch (error) { callbackFailure(worker, error); }
      }, startupTimeoutMs);
      runtime.startupTimer.unref?.();
      commit();
      return workerView(worker);
    } catch (error) {
      runtime.starting = false;
      if (runtime.pty) { runtime.stopping = true; runtime.pty.kill(); }
      else { runtime.token = null; worker.pid = null; }
      worker.lastError = `Unable to start Claude: ${error.message}`;
      update(worker, 'failed', worker.lastError);
      throw error;
    }
  }

  async function submit({ text, ...target } = {}) {
    assertOpen();
    const worker = workerFor(target);
    const runtime = activeRuntime(worker);
    if (!runtime.started || !['idle', 'review', 'interrupted'].includes(worker.status)) fail('Use the live terminal to answer prompts, or wait until the current turn ends.', 409);
    if (runtime.submitting) fail('A task is already being submitted.', 409);
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > MAX_INPUT || /[\x00\x1b]/.test(text)) fail('Task text must be nonempty, at most 64 KiB, and contain no terminal escape sequences.');
    const proc = runtime.pty;
    runtime.submitting = true;
    try {
      proc.write(`\x1b[200~${text.replace(/\r\n?/g, '\n')}\x1b[201~`);
      await pause(120);
      if (runtime.pty !== proc) fail('Claude exited before the task could be submitted.', 409);
      proc.write('\r');
    } finally { runtime.submitting = false; }
    return workerView(worker);
  }

  function input({ data, ...target } = {}) {
    assertOpen();
    const worker = workerFor(target);
    if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_INPUT) fail('Terminal input exceeds 64 KiB.');
    activeRuntime(worker).pty.write(data);
    return workerView(worker);
  }

  function resize({ cols, rows, ...target } = {}) {
    const worker = workerFor(target);
    if (!Number.isSafeInteger(cols) || cols < 40 || cols > 300 || !Number.isSafeInteger(rows) || rows < 10 || rows > 100) fail('Terminal size must be 40–300 columns and 10–100 rows.');
    worker.cols = cols;
    worker.rows = rows;
    const runtime = runtimes.get(worker.id);
    runtime?.term?.resize(cols, rows);
    runtime?.pty?.resize(cols, rows);
    commit();
    return workerView(worker);
  }

  function interrupt(target) {
    const worker = workerFor(target);
    const runtime = activeRuntime(worker);
    // A click racing a completed turn must not replace confirmed readiness or
    // failure with an unresolved cancellation, or send Escape into idle input.
    if (['idle', 'review', 'interrupted', 'failed'].includes(worker.status)) return workerView(worker);
    runtime.interruptPending = true;
    runtime.interruptAfterSequence = runtime.sequence;
    runtime.pty.write('\x1b');
    // Escape is context-sensitive. Do not claim execution stopped without a real lifecycle signal.
    update(worker, 'needs-you', INTERRUPT_ACTIVITY);
    return workerView(worker);
  }

  async function stop(target) {
    const worker = workerFor(target);
    const runtime = runtimes.get(worker.id);
    if (!runtime?.pty) {
      if (pidAlive(worker.pid)) fail('This process belongs to an earlier runtime. Stop it manually; its identity cannot be verified safely.', 409);
      return workerView(worker);
    }
    const proc = runtime.pty;
    runtime.stopping = true;
    proc.kill('SIGTERM');
    await Promise.race([runtime.exited, pause(1500)]);
    if (runtime.pty === proc) {
      proc.kill('SIGKILL');
      await Promise.race([runtime.exited, pause(1000)]);
    }
    if (runtime.pty === proc) fail('The terminal has not confirmed process exit. No second session will be started.', 409);
    return workerView(worker);
  }

  async function terminal(target) {
    const worker = workerFor(target);
    const runtime = runtimes.get(worker.id);
    if (!runtime?.term) return { data: '', cols: worker.cols, rows: worker.rows, sequence: 0 };
    // Serialize between writes in the same queue; subsequent streamed frames have
    // a strictly greater sequence, so reconnect cannot replay them twice.
    const result = runtime.terminalQueue.then(() => ({ data: runtime.serializer.serialize({ scrollback: SCROLLBACK }),
      cols: worker.cols, rows: worker.rows, sequence: runtime.renderedSequence }));
    runtime.terminalQueue = result.then(() => {});
    return result;
  }

  async function hook({ workerId, token, event } = {}) {
    const worker = state.workers.find(item => item.id === workerId);
    const runtime = runtimes.get(workerId);
    if (!worker || !runtime?.pty || !secretMatches(runtime.token, token)) fail('Invalid hook session.', 401);
    if (!event || typeof event !== 'object' || !EVENTS.includes(event.hook_event_name)) fail('Hook event does not match this session.', 409);
    if (event.session_id !== worker.sessionId) {
      if (event.hook_event_name === 'SessionStart') {
        runtime.stopping = true;
        runtime.pty.kill('SIGTERM');
      }
      fail('Claude changed session identity. The puffle retains its saved session; switching conversations in this terminal is unsupported.', 409);
    }
    let cwd;
    try { cwd = fs.realpathSync(event.cwd); } catch { fail('Hook working directory is invalid.', 409); }
    if (cwd !== projectFor(worker.projectId).path) fail('Hook working directory does not match the registered project.', 409);
    if (event.agent_id) return { accepted: true, ignored: true, status: worker.status };
    const type = event.hook_event_name;
    if (type !== 'SessionStart' && type !== 'UserPromptSubmit' && runtime.promptId && event.prompt_id && event.prompt_id !== runtime.promptId) return { accepted: true, ignored: true, status: worker.status };
    switch (type) {
      case 'SessionStart':
        if (runtime.started && event.source === 'compact') { update(worker, worker.status, 'Claude compacted the current conversation.'); break; }
        runtime.interruptPending = false;
        runtime.started = true;
        clearTimeout(runtime.startupTimer);
        worker.established = true;
        update(worker, 'idle', event.source === 'resume' ? 'Saved conversation resumed.' : 'Claude is ready for instructions.');
        break;
      case 'UserPromptSubmit': {
        runtime.interruptPending = false;
        runtime.promptId = typeof event.prompt_id === 'string' ? event.prompt_id : null;
        const prompt = typeof event.prompt === 'string' ? event.prompt.slice(0, 2000) : '(Submitted in terminal)';
        taskState(worker, 'interrupted');
        worker.taskHistory.push({ id: randomUUID(), prompt, startedAt: now(), status: 'working' });
        worker.taskHistory = worker.taskHistory.slice(-50);
        worker.lastError = undefined;
        update(worker, 'working', 'Claude is working on your instruction.');
        break;
      }
      case 'PreToolUse':
        if (runtime.interruptPending) { update(worker, 'needs-you', INTERRUPT_ACTIVITY); break; }
        if (event.tool_name === 'AskUserQuestion') { runtime.lastNeedsYouAt = Date.now(); update(worker, 'needs-you', 'Claude has a question. Answer in the terminal.'); }
        else update(worker, 'working', `Using ${String(event.tool_name ?? 'a tool').slice(0, 80)}.`);
        break;
      case 'PermissionRequest':
        runtime.lastNeedsYouAt = Date.now();
        update(worker, 'needs-you', `Permission requested for ${String(event.tool_name ?? 'a tool').slice(0, 80)}. Answer in the terminal.`);
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
        if (runtime.interruptPending) { update(worker, 'needs-you', INTERRUPT_ACTIVITY); break; }
        update(worker, 'working', type === 'PostToolUseFailure' ? 'A tool reported a failure; Claude may recover or ask for help.' : 'Claude is working.');
        break;
      case 'Notification':
        if (event.notification_type === 'permission_prompt' && ['working', 'needs-you'].includes(worker.status) && Date.now() - runtime.lastNeedsYouAt > 5000) update(worker, 'needs-you', 'Claude needs a permission response in the terminal.');
        break;
      case 'Stop':
        runtime.interruptPending = false;
        taskState(worker, 'turn-ended');
        update(worker, 'review', 'Claude’s turn ended. Review the response and changes; completion has not been verified.');
        break;
      case 'StopFailure':
        runtime.interruptPending = false;
        taskState(worker, 'failed');
        worker.lastError = `Claude reported ${String(event.error ?? 'an API failure').slice(0, 120)}. Check the terminal.`;
        update(worker, 'failed', worker.lastError);
        break;
      case 'SessionEnd':
        // /clear and /resume can end a conversation without terminating the PTY.
        runtime.interruptPending = false;
        taskState(worker, 'interrupted');
        update(worker, 'interrupted', `Claude ended this session (${String(event.reason ?? 'unknown').slice(0, 60)}). The puffle remains bound to its saved session.`);
        break;
    }
    return { accepted: true, status: worker.status };
  }

  async function diff(target) {
    const worker = workerFor(target);
    const project = projectFor(worker.projectId);
    await ensureRepo(project);
    let diffText, truncated = false;
    try { diffText = await git(project.path, ['diff', '--no-ext-diff', '--no-textconv', worker.baseCommit, '--']); }
    catch (error) {
      if (error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw error;
      diffText = error.stdout ?? ''; truncated = true;
    }
    if (diffText.length > MAX_DIFF) { diffText = diffText.slice(0, MAX_DIFF); truncated = true; }
    const status = await git(project.path, ['status', '--porcelain=v1', '--untracked-files=normal']);
    const names = (await git(project.path, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
    const untracked = [];
    for (const name of names.slice(0, MAX_UNTRACKED)) {
      const full = path.resolve(project.path, name);
      const item = { path: name };
      untracked.push(item);
      try {
        const stats = fs.lstatSync(full);
        const relative = path.relative(project.path, fs.realpathSync(full));
        if (!stats.isFile() || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) { item.skipped = 'Not a regular file inside this repository.'; continue; }
        item.size = stats.size;
        // Read a bounded prefix, even when an untracked file is very large.
        const fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const opened = fs.fstatSync(fd);
          if (!opened.isFile() || opened.dev !== stats.dev || opened.ino !== stats.ino) { item.skipped = 'File changed while opening it; request changes again.'; continue; }
          const bytes = Buffer.alloc(Math.min(stats.size, MAX_FILE));
          const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
          const prefix = bytes.subarray(0, length);
          if (prefix.includes(0)) item.skipped = 'Binary file.';
          else item.content = prefix.toString('utf8');
          item.truncated = stats.size > MAX_FILE;
        } finally { fs.closeSync(fd); }
      } catch (error) { item.skipped = `Unavailable: ${error.code ?? 'read error'}`; }
    }
    return { diff: diffText, status: status.slice(0, MAX_DIFF), untracked, baseCommit: worker.baseCommit,
      dirtyAtStart: worker.dirtyAtStart, truncated: truncated || status.length > MAX_DIFF || names.length > MAX_UNTRACKED };
  }

  async function close() {
    closing = true;
    for (const worker of state.workers) {
      if (runtimes.get(worker.id)?.pty) await stop({ projectId: worker.projectId, workerId: worker.id });
      const runtime = runtimes.get(worker.id);
      clearTimeout(runtime?.startupTimer);
      await runtime?.terminalQueue;
      runtime?.term?.dispose();
    }
  }

  commit();
  return { registerProject, createWorker, start, submit, input, resize, interrupt, stop, diff, snapshot, terminal, hook, close };
}
