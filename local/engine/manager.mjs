import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import * as nodePty from '@lydell/node-pty';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { readState, writeState, writePrivateJson } from './state.mjs';
import { assertGitVersion, assertReadPolicy, createGit, ensureEmptyHooksDir } from './git-policy.mjs';
import {
  MAX_PROJECTS, createWorktree, defaultProjectName, identifyRepository, inside, inspectWorkspace, prepareWorktreeRoot,
  projectNameProblem, reserveWorkspacePath, resolveWorktreeRoot, reviewWorkspace, shellQuote, sourceDirty, suggestPuffleName,
  validateProjectName, validatePuffleName, workerBranch,
} from './workspace.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMIT = /^[a-f0-9]{40,64}$/;
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'];
const SCROLLBACK = 3000;
const MAX_INPUT = 64 * 1024;
const CWD_CACHE_MS = 5000;
const INTERRUPT_ACTIVITY = 'Interrupt requested. Cancellation is not yet confirmed. Check the terminal; Escape may also dismiss a prompt.';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const copy = value => value === undefined ? undefined : structuredClone(value);

function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
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

function secretMatches(expected, supplied) {
  if (typeof expected !== 'string' || typeof supplied !== 'string') return false;
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

const positiveId = value => Number.isSafeInteger(value) && value > 0;
const absolute = value => typeof value === 'string' && path.isAbsolute(value);

function validateSaved(state) {
  const invalid = message => fail(`Saved agent state is invalid: ${message} Preserve it and repair it before restarting.`, 500);
  const projectIds = new Set();
  for (const project of state.projects) {
    if (!UUID.test(project.id) || projectIds.has(project.id)) invalid('a project identity is missing or duplicated.');
    projectIds.add(project.id);
    if (projectNameProblem(project.name)) invalid(`project ${project.id} has an invalid name.`);
    if (!absolute(project.sourcePath) || (project.commonDir !== null && !absolute(project.commonDir))) invalid(`project ${project.id} has an invalid repository path.`);
    if (project.game !== null && (typeof project.game !== 'object' || !['ownerId', 'iglooId', 'roomId', 'puffleId'].every(key => positiveId(project.game[key])))) invalid(`project ${project.id} has an invalid game mapping.`);
    if (project.activeWorkerId !== null && !UUID.test(project.activeWorkerId)) invalid(`project ${project.id} has an invalid worker reference.`);
    if (!project.setup || typeof project.setup !== 'object') invalid(`project ${project.id} has no setup record.`);
  }
  if (state.projects.length > MAX_PROJECTS) invalid(`more than ${MAX_PROJECTS} projects are registered.`);
  const workerIds = new Set();
  for (const worker of state.workers) {
    if (!UUID.test(worker.id) || workerIds.has(worker.id) || !UUID.test(worker.sessionId) || !projectIds.has(worker.projectId)) invalid('a worker identity is missing, duplicated, or unbound.');
    workerIds.add(worker.id);
    if (typeof worker.established !== 'boolean' || !Array.isArray(worker.taskHistory)) invalid(`worker ${worker.id} is incomplete.`);
    const workspace = worker.workspace;
    if (!workspace || !absolute(workspace.path) || !COMMIT.test(workspace.baseCommit ?? '')) invalid(`worker ${worker.id} has no valid workspace record.`);
    if (worker.archived) { if (typeof worker.archived !== 'object') invalid(`worker ${worker.id} has an invalid archive record.`); continue; }
    if (workspace.kind !== 'worktree' || typeof workspace.branch !== 'string' || !['reserved', 'ready'].includes(workspace.state)) invalid(`active worker ${worker.id} must use an engine worktree.`);
    try { validatePuffleName(worker.name); } catch { invalid(`worker ${worker.id} has an invalid puffle name.`); }
    if (worker.pid !== null && worker.pid !== undefined && !positiveId(worker.pid)) invalid(`worker ${worker.id} has an invalid process identity.`);
  }
  for (const project of state.projects) {
    const active = state.workers.filter(worker => worker.projectId === project.id && !worker.archived);
    if (active.length > 1) invalid(`project ${project.id} has more than one active puffle.`);
    if ((project.activeWorkerId ?? null) !== (active[0]?.id ?? null)) invalid(`project ${project.id} does not reference its active puffle.`);
  }
}

/**
 * Host-owned PTYs, one per active worker, remain alive while the browser,
 * panel, game room, or selected project changes. Each worker runs in its own
 * persistent engine worktree and never falls back to the source checkout.
 */
export async function createManager({ stateDir, onEvent = () => {}, claudePath = 'claude', ptySpawn = nodePty.spawn, hookBaseUrl,
  startupTimeoutMs = 12000, worktreeRoot = resolveWorktreeRoot(), gitEnv = {}, gitVersionText } = {}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) fail('An absolute private state directory is required.');
  const hookUrl = new URL(hookBaseUrl);
  if (hookUrl.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(hookUrl.hostname)) fail('Hooks must use a loopback HTTP address.');
  if (!absolute(worktreeRoot)) fail('The worktree root must be an absolute path.');
  const state = readState(stateDir);
  const hooksDir = ensureEmptyHooksDir(path.join(stateDir, 'git-empty-hooks'));
  const git = createGit({ hooksDir, env: gitEnv });
  assertGitVersion(gitVersionText ?? await git.text(stateDir, ['--version']));
  validateSaved(state);

  const runtimes = new Map();
  const projectLocks = new Map();
  let registration = Promise.resolve();
  let closing = false;
  const settingsPath = path.join(stateDir, 'claude-settings.json');
  const helper = fileURLToPath(new URL('./hook-client.mjs', import.meta.url));
  writePrivateJson(settingsPath, { hooks: Object.fromEntries(EVENTS.map(event => [event, [{ hooks: [{
    type: 'command', command: process.execPath, args: [helper], timeout: 3,
  }] }]])) });

  const startedAt = now();
  for (const project of state.projects) {
    project.sourceAvailable = fs.existsSync(project.sourcePath);
    if (project.sourceAvailable && project.commonDir === null) {
      // Legacy projects learn their repository identity once their source is reachable.
      try { project.commonDir = (await identifyRepository(git, project.sourcePath)).commonDir; } catch { /* Stay unresolved; registration then cannot deduplicate it. */ }
    }
    if (project.setup.phase === 'preparing') {
      project.setup = { ...project.setup, phase: 'failed', retryable: true, updatedAt: startedAt,
        error: 'Setup stopped when the engine stopped. Retry to reconcile the reserved worktree; nothing was removed.' };
    }
  }
  for (const worker of state.workers) {
    if (worker.archived) continue;
    worker.cols = Math.min(300, Math.max(40, Number.isSafeInteger(worker.cols) ? worker.cols : 120));
    worker.rows = Math.min(100, Math.max(10, Number.isSafeInteger(worker.rows) ? worker.rows : 32));
    worker.updatedAt = startedAt;
    worker.outsideWorkspace = null;
    for (const task of worker.taskHistory) if (!task.endedAt) { task.status = 'interrupted'; task.endedAt = startedAt; }
    if (worker.workspace.state !== 'ready') { worker.status = 'setup'; worker.activity = 'Worktree setup is incomplete.'; continue; }
    worker.status = 'offline';
    if (pidAlive(worker.pid)) worker.activity = 'A previous process may still be alive. Stop it manually before resuming; this engine will not kill or duplicate it.';
    else {
      worker.pid = null;
      worker.activity = worker.established ? 'Runtime restarted. Start to resume this exact conversation.' : 'Ready to start this named conversation.';
    }
  }

  // ------------------------------------------------------------ lookups

  function projectFor(id) {
    if (typeof id !== 'string' || !UUID.test(id)) fail('An explicit project ID is required.');
    const project = state.projects.find(item => item.id === id);
    if (!project) fail('Unknown project.', 404);
    return project;
  }
  function workerFor({ projectId, workerId } = {}) {
    projectFor(projectId);
    if (typeof workerId !== 'string' || !UUID.test(workerId)) fail('An explicit worker ID is required.');
    const worker = state.workers.find(item => item.id === workerId && item.projectId === projectId);
    if (!worker) fail('Unknown worker for this project.', 404);
    return worker;
  }
  function activeWorkerFor(target) {
    const worker = workerFor(target);
    if (worker.archived) fail('This puffle is archived and read-only. Its conversation stays in its original folder; create an isolated replacement to continue.', 409);
    if (worker.workspace.state !== 'ready') fail('This puffle\'s worktree setup is not complete. Retry setup first.', 409);
    return worker;
  }
  function assertOpen() { if (closing) fail('The local runtime is stopping.', 409); }

  // ------------------------------------------------------------ views (allowlisted)

  function projectView(project) {
    const game = project.game ? Object.fromEntries(['source', 'status', 'fixtureId', 'ownerId', 'iglooId', 'roomId', 'puffleId', 'puffleName']
      .map(key => [key, project.game[key] ?? null])) : null;
    const setup = Object.fromEntries(['phase', 'step', 'error', 'note', 'retryable', 'updatedAt'].map(key => [key, project.setup[key] ?? null]));
    return { id: project.id, name: project.name, sourcePath: project.sourcePath, sourceAvailable: fs.existsSync(project.sourcePath),
      createdAt: project.createdAt, legacy: Boolean(project.legacy), setup, game, activeWorkerId: project.activeWorkerId ?? null };
  }
  function workerView(worker) {
    const runtime = runtimes.get(worker.id);
    const workspace = Object.fromEntries(['kind', 'path', 'branch', 'baseCommit', 'state', 'sourceDirtyAtCreation'].map(key => [key, worker.workspace[key] ?? null]));
    return { ...Object.fromEntries(['id', 'projectId', 'name', 'sessionId', 'status', 'activity', 'established',
      'cols', 'rows', 'createdAt', 'updatedAt', 'taskHistory', 'lastError', 'exitCode', 'outsideWorkspace'].map(key => [key, copy(worker[key])])),
    workspace, inspection: worker.inspection ? copy(worker.inspection) : null,
    running: Boolean(runtime?.pty), recoveryBlocked: Boolean(!runtime?.pty && pidAlive(worker.pid)) };
  }
  function archivedView(worker) {
    return { id: worker.id, projectId: worker.projectId, name: worker.name, sessionId: worker.sessionId, established: worker.established,
      createdAt: worker.createdAt, taskHistory: copy(worker.taskHistory), archived: copy(worker.archived),
      originalPath: worker.workspace.path, baseCommit: worker.workspace.baseCommit, workspaceKind: worker.workspace.kind,
      resumeCommand: worker.established ? `cd ${shellQuote(worker.workspace.path)} && claude --resume ${worker.sessionId}` : null };
  }
  function snapshot() {
    return { revision: state.revision, limits: { maxProjects: MAX_PROJECTS }, worktreeRoot,
      projects: state.projects.map(projectView),
      workers: state.workers.filter(worker => !worker.archived).map(workerView),
      archivedWorkers: state.workers.filter(worker => worker.archived).map(archivedView) };
  }
  function notify(event) { try { onEvent(event); } catch { /* A disconnected UI must not stop the agent. */ } }
  function commit() {
    state.revision++;
    writeState(stateDir, state);
    notify({ type: 'snapshot', snapshot: snapshot() });
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
  function callbackFailure(worker, error) {
    worker.status = 'failed';
    worker.lastError = `Runtime state could not be recorded: ${error.message}`;
    worker.activity = worker.lastError;
    notify({ type: 'snapshot', snapshot: snapshot() });
  }
  function withProjectLock(projectId, operation) {
    const previous = projectLocks.get(projectId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    const tail = next.catch(() => {});
    projectLocks.set(projectId, tail);
    tail.then(() => { if (projectLocks.get(projectId) === tail) projectLocks.delete(projectId); });
    return next;
  }

  /** Workspace validation before start, resume, task submission, and review. */
  async function checkWorkspace(worker) {
    const project = projectFor(worker.projectId);
    if (!project.commonDir) fail('This project\'s repository identity is unavailable. Repair the source checkout first.', 409);
    const inspection = await inspectWorkspace(git, project, worker.workspace);
    worker.inspection = { repair: inspection.repair, warnings: inspection.warnings, checkedAt: now() };
    if (inspection.repair) {
      if (!runtimes.get(worker.id)?.pty) { worker.status = 'needs-repair'; worker.activity = `Needs repair: ${inspection.repair}`; }
      worker.updatedAt = now();
      commit();
      fail(`Needs repair: ${inspection.repair} Claude Penguin will not fall back to the source checkout.`, 409);
    }
    if (worker.status === 'needs-repair') { worker.status = 'offline'; worker.activity = 'Worktree validated. Start to continue.'; }
    return inspection;
  }

  // ------------------------------------------------------------ registration and setup

  async function registerProject({ path: input, name } = {}) {
    assertOpen();
    const operation = registration.then(async () => {
      assertOpen();
      const identity = await identifyRepository(git, input);
      const existing = state.projects.find(project => project.commonDir === identity.commonDir) ??
        state.projects.find(project => project.commonDir === null && project.sourcePath === identity.sourcePath);
      if (existing) {
        if (existing.commonDir === null) { existing.commonDir = identity.commonDir; existing.sourceAvailable = true; commit(); }
        return projectView(existing);
      }
      if (state.projects.length >= MAX_PROJECTS) fail(`Claude Penguin supports at most ${MAX_PROJECTS} registered projects.`, 409);
      const projectName = name === undefined || name === '' ? defaultProjectName(path.basename(identity.sourcePath)) : validateProjectName(name);
      const project = { id: randomUUID(), name: projectName, sourcePath: identity.sourcePath, commonDir: identity.commonDir, createdAt: now(),
        sourceAvailable: true, setup: { phase: 'registered', step: null, error: null, retryable: false, updatedAt: now() }, game: null, activeWorkerId: null };
      state.projects.push(project);
      commit();
      return projectView(project);
    });
    registration = operation.catch(() => {});
    return operation;
  }

  function setSetup(project, fields) {
    project.setup = { ...project.setup, ...fields, updatedAt: now() };
    commit();
  }

  async function runSetup(project, worker) {
    const workspace = worker.workspace;
    try {
      assertOpen();
      setSetup(project, { phase: 'preparing', step: 'Creating the worktree.', error: null, retryable: false });
      await createWorktree(git, { sourcePath: project.sourcePath, workspacePath: workspace.path, branch: workspace.branch,
        baseline: workspace.baseCommit, workerId: worker.id, onProgress: step => setSetup(project, { step }) });
      await assertReadPolicy(git, workspace.path, [workspace.baseCommit]);
      const inspection = await inspectWorkspace(git, project, workspace);
      if (inspection.repair) throw Object.assign(new Error(inspection.repair), { statusCode: 409 });
      workspace.state = 'ready';
      workspace.readyAt = now();
      worker.inspection = { repair: null, warnings: inspection.warnings, checkedAt: now() };
      worker.status = 'offline';
      worker.activity = 'Ready to start this named conversation.';
      worker.updatedAt = now();
      setSetup(project, { phase: project.game ? 'ready' : 'game-pending', step: project.game ? null : 'Worktree ready. Game provisioning is not part of this engine milestone.', error: null, retryable: false });
    } catch (error) {
      worker.status = 'setup';
      worker.activity = 'Worktree setup failed. Retry after resolving the problem.';
      worker.updatedAt = now();
      setSetup(project, { phase: 'failed', step: null, error: String(error.message).slice(0, 1000), retryable: true });
    }
  }

  async function createWorker({ projectId, name } = {}) {
    assertOpen();
    const project = projectFor(projectId);
    let created;
    await withProjectLock(project.id, async () => {
      assertOpen();
      if (project.activeWorkerId) fail('This project already has a puffle. Each project has one active puffle.', 409);
      project.sourceAvailable = fs.existsSync(project.sourcePath);
      if (!project.sourceAvailable) fail('The source checkout is unavailable. Restore it before creating a puffle.', 409);
      const fallback = project.game?.puffleName ?? suggestPuffleName(state.workers.map(worker => worker.name));
      const puffleName = validatePuffleName(name === undefined || name === '' ? fallback : name);
      const identity = await identifyRepository(git, project.sourcePath);
      project.commonDir ??= identity.commonDir; // A legacy project whose source returned after startup.
      if (identity.commonDir !== project.commonDir) fail('The source checkout now belongs to a different repository. Repair the project before continuing.', 409);
      const dirty = await sourceDirty(git, project.sourcePath);
      const root = await prepareWorktreeRoot(git, worktreeRoot);
      const id = randomUUID();
      const workspacePath = reserveWorkspacePath(root, id, project.sourcePath);
      const worker = { id, projectId: project.id, name: puffleName, sessionId: randomUUID(), established: false,
        status: 'setup', activity: 'Preparing the worktree.', cols: 120, rows: 32, createdAt: now(), updatedAt: now(), pid: null, taskHistory: [],
        outsideWorkspace: null, inspection: null, archived: null,
        workspace: { kind: 'worktree', path: workspacePath, branch: workerBranch(project.id, id), baseCommit: identity.head,
          repoCommonDir: project.commonDir, sourcePath: project.sourcePath, sourceDirtyAtCreation: dirty, state: 'reserved', reservedAt: now() } };
      // The reservation is durable before Git runs, so a retry reconciles only this exact path and branch.
      state.workers.push(worker);
      project.activeWorkerId = worker.id;
      project.setup = { phase: 'preparing', step: 'Reserved the worktree path and branch.', error: null, retryable: false, updatedAt: now(),
        note: dirty ? 'The source checkout has uncommitted changes. They stay in the source checkout; the worktree starts from its committed HEAD.' : null };
      commit();
      created = worker;
    });
    withProjectLock(project.id, () => runSetup(project, created));
    return workerView(created);
  }

  async function retrySetup({ projectId } = {}) {
    assertOpen();
    const project = projectFor(projectId);
    let worker;
    await withProjectLock(project.id, async () => {
      if (project.setup.phase !== 'failed') fail('Setup is not waiting for a retry.', 409);
      worker = state.workers.find(item => item.id === project.activeWorkerId);
      if (!worker || worker.workspace.state !== 'reserved') fail('No reserved worktree is waiting for setup.', 409);
    });
    withProjectLock(project.id, () => runSetup(project, worker));
    return projectView(project);
  }

  /** Resolves after queued setup or retry work for this project finishes. */
  async function settled(projectId) {
    while (projectLocks.has(projectId)) await projectLocks.get(projectId);
    return projectView(projectFor(projectId));
  }

  // ------------------------------------------------------------ terminal lifecycle

  async function start(target) {
    assertOpen();
    const worker = activeWorkerFor(target);
    if (runtimes.get(worker.id)?.pty) return workerView(worker);
    if (runtimes.get(worker.id)?.starting) fail('This worker is already starting.', 409);
    if (pidAlive(worker.pid)) fail('The saved process may still be alive. Stop it manually before resuming; refusing to duplicate the session.', 409);
    const previous = runtimes.get(worker.id);
    const runtime = { starting: true, token: randomBytes(32).toString('hex'), pty: null, stopping: false, fatal: null,
      started: false, lastNeedsYouAt: 0, promptId: null, terminalQueue: Promise.resolve(), cwdCache: new Map(),
      sequence: previous?.sequence ?? 0, renderedSequence: previous?.sequence ?? 0 };
    runtimes.set(worker.id, runtime);
    let term;
    try {
      await checkWorkspace(worker);
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
      worker.outsideWorkspace = null;
      update(worker, 'starting', worker.established ? 'Resuming the saved Claude conversation.' : 'Starting Claude Code.');
      const proc = ptySpawn(claudePath, args, { name: 'xterm-256color', cols: worker.cols, rows: worker.rows, cwd: worker.workspace.path,
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
        const failed = Boolean(runtime.fatal) || (!runtime.stopping && (exitCode !== 0 || !runtime.started));
        taskState(worker, failed ? 'failed' : 'interrupted');
        try {
          if (runtime.fatal) { worker.lastError = runtime.fatal; update(worker, 'failed', runtime.fatal); }
          else if (failed) {
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
      else {
        runtime.token = null;
        worker.pid = null;
        // Nothing spawned: keep the previous screen available for replay.
        if (!runtime.term && previous) runtimes.set(worker.id, previous);
      }
      if (worker.status !== 'needs-repair') {
        worker.lastError = `Unable to start Claude: ${error.message}`;
        update(worker, 'failed', worker.lastError);
      }
      throw error;
    }
  }

  async function submit({ text, ...target } = {}) {
    assertOpen();
    const worker = activeWorkerFor(target);
    const runtime = activeRuntime(worker);
    if (!runtime.started || !['idle', 'review', 'interrupted'].includes(worker.status)) fail('Use the live terminal to answer prompts, or wait until the current turn ends.', 409);
    if (runtime.submitting) fail('A task is already being submitted.', 409);
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > MAX_INPUT || /[\x00\x1b]/.test(text)) fail('Task text must be nonempty, at most 64 KiB, and contain no terminal escape sequences.');
    runtime.submitting = true;
    try {
      await checkWorkspace(worker);
      const proc = runtime.pty;
      if (!proc) fail('Claude exited before the task could be submitted.', 409);
      proc.write(`\x1b[200~${text.replace(/\r\n?/g, '\n')}\x1b[201~`);
      await pause(120);
      if (runtime.pty !== proc) fail('Claude exited before the task could be submitted.', 409);
      proc.write('\r');
    } finally { runtime.submitting = false; }
    return workerView(worker);
  }

  function input({ data, ...target } = {}) {
    assertOpen();
    const worker = activeWorkerFor(target);
    if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_INPUT) fail('Terminal input exceeds 64 KiB.');
    activeRuntime(worker).pty.write(data);
    return workerView(worker);
  }

  function resize({ cols, rows, ...target } = {}) {
    const worker = activeWorkerFor(target);
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
    const worker = activeWorkerFor(target);
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

  async function stopWorker(worker) {
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

  async function stop(target) { return stopWorker(activeWorkerFor(target)); }

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

  // ------------------------------------------------------------ hooks

  /** Canonical hook directories are cached briefly per run so stale results never become permanent. */
  function resolveCwd(runtime, cwd) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
    const cached = runtime.cwdCache.get(cwd);
    if (cached && Date.now() - cached.at < CWD_CACHE_MS) return cached.real;
    let real = null;
    try { real = fs.realpathSync.native(cwd); } catch { real = null; }
    if (runtime.cwdCache.size > 64) runtime.cwdCache.clear();
    runtime.cwdCache.set(cwd, { real, at: Date.now() });
    return real;
  }

  function stopForFatal(runtime, message) {
    runtime.fatal = message;
    runtime.stopping = true;
    runtime.pty.kill('SIGTERM');
  }

  async function hook({ workerId, token, event } = {}) {
    const worker = state.workers.find(item => item.id === workerId);
    const runtime = runtimes.get(workerId);
    if (!worker || worker.archived || !runtime?.pty || !secretMatches(runtime.token, token)) fail('Invalid hook session.', 401);
    if (!event || typeof event !== 'object' || !EVENTS.includes(event.hook_event_name)) fail('Hook event does not match this session.', 409);
    const type = event.hook_event_name;
    if (event.session_id !== worker.sessionId) {
      if (type === 'SessionStart') stopForFatal(runtime, 'Claude switched to another conversation, so the engine stopped this terminal. The puffle keeps its saved session; switching conversations in this terminal is unsupported.');
      fail('Claude changed session identity. The puffle retains its saved session; switching conversations in this terminal is unsupported.', 409);
    }
    const root = worker.workspace.path;
    const cwd = resolveCwd(runtime, event.cwd);
    let warningChanged = false;
    const initialStart = type === 'SessionStart' && event.source !== 'compact' && (['startup', 'resume'].includes(event.source) || !runtime.started);
    if (initialStart) {
      if (cwd !== root) {
        stopForFatal(runtime, `Claude reported starting in ${cwd ?? 'an unresolved directory'}, not the recorded worktree ${root}. The engine stopped this terminal.`);
        fail('Hook working directory does not match the recorded worktree.', 409);
      }
    } else {
      // Ongoing events stay visible even outside the workspace so permission
      // requests and attention are never silently suppressed.
      const outside = !cwd || !inside(root, cwd);
      const previous = worker.outsideWorkspace;
      worker.outsideWorkspace = outside ? { cwd: typeof event.cwd === 'string' ? event.cwd.slice(0, 1024) : null, resolved: Boolean(cwd), at: now() } : null;
      if (Boolean(previous) !== outside || (outside && previous?.cwd !== worker.outsideWorkspace.cwd)) { worker.updatedAt = now(); warningChanged = true; }
    }
    const revision = state.revision;
    const finish = result => { if (warningChanged && state.revision === revision) commit(); return { ...result, outsideWorkspace: Boolean(worker.outsideWorkspace) }; };
    if (event.agent_id) return finish({ accepted: true, ignored: true, status: worker.status });
    if (type !== 'SessionStart' && type !== 'UserPromptSubmit' && runtime.promptId && event.prompt_id && event.prompt_id !== runtime.promptId) return finish({ accepted: true, ignored: true, status: worker.status });
    switch (type) {
      case 'SessionStart':
        if (runtime.started && !initialStart) { update(worker, worker.status, event.source === 'compact' ? 'Claude compacted the current conversation.' : 'Claude reloaded the current conversation.'); break; }
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
    return finish({ accepted: true, status: worker.status });
  }

  // ------------------------------------------------------------ review

  async function diff(target) {
    const worker = activeWorkerFor(target);
    const project = projectFor(worker.projectId);
    const inspection = await checkWorkspace(worker);
    return reviewWorkspace(git, { sourcePath: project.sourcePath, workspace: worker.workspace, inspection });
  }

  async function close() {
    closing = true;
    for (const worker of state.workers) {
      if (runtimes.get(worker.id)?.pty) { try { await stopWorker(worker); } catch { /* Report through state; keep closing others. */ } }
      const runtime = runtimes.get(worker.id);
      clearTimeout(runtime?.startupTimer);
      await runtime?.terminalQueue;
      runtime?.term?.dispose();
    }
  }

  commit();
  return { registerProject, createWorker, retrySetup, settled, start, submit, input, resize, interrupt, stop, diff, snapshot, terminal, hook, close };
}
