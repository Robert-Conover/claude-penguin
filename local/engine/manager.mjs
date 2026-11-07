import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import * as nodePty from '@lydell/node-pty';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { readState, writeState, writePrivateJson } from './state.mjs';
import { ProvisionError, VISITOR_USERNAME, VISITOR_USERNAMES } from './game.mjs';
import { generateUsername, newOwnerCredentials, readSecrets, writeSecrets } from './game-secrets.mjs';
import { publicationFor } from './publication.mjs';
import { assertGitVersion, assertReadPolicy, createGit, ensureEmptyHooksDir } from './git-policy.mjs';
import {
  MAX_PROJECTS, createWorktree, defaultProjectName, identifyRepository, inside, inspectWorkspace, prepareWorktreeRoot,
  projectNameProblem, reserveWorkspacePath, resolveWorktreeRoot, reviewWorkspace, shellQuote, sourceDirty,
  validateProjectName, validatePuffleName, workerBranch,
} from './workspace.mjs';
import { ADOPTION_CATALOG, MAX_PUFFLES_PER_IGLOO, catalogEntry, catalogForPuffleType } from '../web/engine/catalog.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMMIT = /^[a-f0-9]{40,64}$/;
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'];
const SCROLLBACK = 3000;
const MAX_INPUT = 64 * 1024;
const CWD_CACHE_MS = 5000;
const TOP_LEVEL_TIMEOUT_MS = 2000;
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
    if (remove.has(key) || /^(CLAUDE_CODE_SESSION|CLAUDE_CODE_CHILD|CLAUDE_CODE_MESSAGING|NEBULA_|AGENT_OFFICE_|CLAUDE_PENGUIN_|CP_ENGINE_)/.test(key)) delete env[key];
  }
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
}

function secretMatches(expected, supplied) {
  if (typeof expected !== 'string' || typeof supplied !== 'string') return false;
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

const positiveId = value => Number.isSafeInteger(value) && value > 0;
const GAME_SOURCES = ['managed', 'legacy-fixture'];
const GAME_STATUSES = ['provisioning', 'ready', 'failed', 'repair'];
// Project setup covers only the destination (owner and igloo). `needs-worker`
// is a migrated legacy-fixture project without an isolated worker yet.
const SETUP_PHASES = ['registered', 'needs-worker', 'preparing', 'game-pending', 'failed', 'ready'];
const WORKER_SETUP_PHASES = ['preparing', 'failed', 'ready'];
const ADOPTION_STATES = ['reserved', 'charged', 'bound', 'withdrawn', 'conflict'];
const OPEN_ADOPTIONS = ['reserved', 'charged'];
const SUBMITTABLE = ['idle', 'review', 'interrupted'];
const USERNAME_ATTEMPTS = 5;
const ADOPTION_TTL_MS = 10 * 60 * 1000;
// Houdini refuses a reservation once its expiry has passed (checked when the
// purchase transaction starts, on the game VM's clock). A receipt lookup that
// starts this long after expiry and finds nothing proves no charge can follow;
// the margin covers host/VM clock skew and a transaction still committing.
const SETTLE_MARGIN_MS = 2 * 60 * 1000;
const MAX_RECONCILED = 256;
const absolute = value => typeof value === 'string' && path.isAbsolute(value);
const record = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// A recorded identity the service could not find: repair it explicitly, never recreate it.
const REPAIR_CODES = ['MISMATCH', 'MISSING'];
// Server refusals of a p#cpadopt purchase (local/project_adoption.py) and their meaning.
const REFUSALS = {
  401: 'The visitor does not have enough coins.', 441: 'The game rejected that puffle name.',
  440: 'This igloo already has 10 puffles.', expired: 'The adoption expired before the purchase arrived.',
  'owner-online': 'The project owner was logged in; try again in a moment.', 'unknown-adoption': 'The game did not recognize this adoption.',
  'unknown-puffle': 'That puffle cannot join a project igloo.', conflict: 'This adoption ID was already used for a different puffle.',
  failed: 'The game could not complete the purchase. Nothing was charged.', cancelled: 'Adoption cancelled before purchase.',
  lost: 'The game did not confirm the purchase and no receipt was found.',
  'not-charged': 'The reservation expired without a purchase. Nothing was charged.',
};

export function sessionCaps(env = process.env) {
  const read = (key, fallback) => {
    if (env[key] === undefined || env[key] === '') return fallback;
    const value = Number(env[key]);
    if (!Number.isSafeInteger(value) || value < 1 || value > 32) throw new Error(`${key} must be an integer from 1 to 32.`);
    return value;
  };
  return { perIgloo: read('CP_ENGINE_SESSIONS_PER_IGLOO', 3), total: read('CP_ENGINE_SESSIONS', 6) };
}

function validPuffle(puffle) {
  return record(puffle) && positiveId(puffle.puffleId) && typeof puffle.name === 'string' && puffle.name.length > 0 && puffle.name.length <= 16 &&
    Number.isSafeInteger(puffle.typeId) && Number.isSafeInteger(puffle.subtypeId) && (puffle.adoptionId === null || UUID.test(puffle.adoptionId ?? ''));
}

function validateSaved(state, visitorUsername) {
  const invalid = message => fail(`Saved agent state is invalid: ${message} Preserve it and repair it before restarting.`, 500);
  const projectIds = new Set();
  const commonDirs = new Set();
  for (const project of state.projects) {
    if (!record(project)) invalid('a project record is not an object.');
    if (!UUID.test(project.id) || projectIds.has(project.id)) invalid('a project identity is missing or duplicated.');
    projectIds.add(project.id);
    if (projectNameProblem(project.name)) invalid(`project ${project.id} has an invalid name.`);
    if (!absolute(project.sourcePath) || (project.commonDir !== null && !absolute(project.commonDir))) invalid(`project ${project.id} has an invalid repository path.`);
    if (project.commonDir !== null && commonDirs.has(project.commonDir)) invalid(`project ${project.id} and another project share one repository.`);
    commonDirs.add(project.commonDir);
    if (Object.hasOwn(project, 'activeWorkerId')) invalid(`project ${project.id} still uses the version 2 single-puffle shape.`);
    if (project.game !== null) {
      const game = project.game;
      if (!record(game) || !GAME_SOURCES.includes(game.source) || !GAME_STATUSES.includes(game.status)) invalid(`project ${project.id} has an invalid game mapping.`);
      const ids = game.source === 'legacy-fixture' ? ['ownerId', 'iglooId', 'roomId', 'puffleId'] : ['ownerId', 'iglooId', 'roomId'];
      // A ready or legacy mapping is complete; a managed mapping in progress may lack IDs it has not reached yet.
      const complete = game.status === 'ready' || game.source === 'legacy-fixture';
      if (!ids.every(key => positiveId(game[key]) || (!complete && (game[key] ?? null) === null))) invalid(`project ${project.id} has an invalid game mapping.`);
      if (positiveId(game.ownerId) && positiveId(game.roomId) && game.roomId !== game.ownerId + 2000) invalid(`project ${project.id} has an invalid igloo room address.`);
    }
    if (!record(project.setup) || !SETUP_PHASES.includes(project.setup.phase)) invalid(`project ${project.id} has an unknown setup phase.`);
  }
  if (state.projects.length > MAX_PROJECTS) invalid(`more than ${MAX_PROJECTS} projects are registered.`);
  const workerIds = new Set();
  const sessionIds = new Set();
  const worktrees = new Set();
  const puffleIds = new Set();
  for (const worker of state.workers) {
    if (!record(worker)) invalid('a worker record is not an object.');
    if (!UUID.test(worker.id) || workerIds.has(worker.id) || !UUID.test(worker.sessionId) || !projectIds.has(worker.projectId)) invalid('a worker identity is missing, duplicated, or unbound.');
    workerIds.add(worker.id);
    if (sessionIds.has(worker.sessionId.toLowerCase())) invalid(`worker ${worker.id} and another worker share one Claude session.`);
    sessionIds.add(worker.sessionId.toLowerCase());
    if (typeof worker.established !== 'boolean' || !Array.isArray(worker.taskHistory) || !worker.taskHistory.every(record)) invalid(`worker ${worker.id} is incomplete.`);
    if (worker.puffle !== null && worker.puffle !== undefined) {
      if (!validPuffle(worker.puffle)) invalid(`worker ${worker.id} has an invalid puffle binding.`);
      if (puffleIds.has(worker.puffle.puffleId)) invalid(`worker ${worker.id} and another worker share one puffle.`);
      puffleIds.add(worker.puffle.puffleId);
    }
    const workspace = worker.workspace;
    if (worker.archived) {
      if (typeof worker.archived !== 'object') invalid(`worker ${worker.id} has an invalid archive record.`);
      if (!record(workspace) || !absolute(workspace.path) || !COMMIT.test(workspace.baseCommit ?? '')) invalid(`worker ${worker.id} has no valid workspace record.`);
      continue;
    }
    // A paid puffle whose worktree could not be reserved yet keeps a null workspace and a retryable setup.
    if (workspace !== null) {
      if (!record(workspace) || !absolute(workspace.path) || !COMMIT.test(workspace.baseCommit ?? '')) invalid(`worker ${worker.id} has no valid workspace record.`);
      if (workspace.kind !== 'worktree' || typeof workspace.branch !== 'string' || !['reserved', 'ready'].includes(workspace.state)) invalid(`active worker ${worker.id} must use an engine worktree.`);
      if (worktrees.has(workspace.path)) invalid(`worker ${worker.id} and another active worker share one worktree.`);
      worktrees.add(workspace.path);
      const commonDir = state.projects.find(project => project.id === worker.projectId).commonDir;
      if (commonDir !== null && workspace.repoCommonDir !== commonDir) invalid(`worker ${worker.id} records a different repository than its project.`);
    }
    if (!record(worker.setup) || !WORKER_SETUP_PHASES.includes(worker.setup.phase)) invalid(`worker ${worker.id} has no valid setup record.`);
    try { validatePuffleName(worker.name); } catch { invalid(`worker ${worker.id} has an invalid puffle name.`); }
    if (worker.pid !== null && worker.pid !== undefined && !positiveId(worker.pid)) invalid(`worker ${worker.id} has an invalid process identity.`);
  }
  for (const project of state.projects) {
    const active = state.workers.filter(worker => worker.projectId === project.id && !worker.archived);
    if (active.length > MAX_PUFFLES_PER_IGLOO) invalid(`project ${project.id} has more than ${MAX_PUFFLES_PER_IGLOO} active puffles.`);
    if (project.game?.source === 'legacy-fixture' && active.length > 1) invalid(`legacy project ${project.id} has more than one active puffle.`);
  }
  const adoptionIds = new Set();
  for (const adoption of state.adoptions) {
    if (!record(adoption) || !LOWER_UUID.test(adoption.id ?? '') || adoptionIds.has(adoption.id) || !projectIds.has(adoption.projectId) ||
        !UUID.test(adoption.workerId ?? '') || !ADOPTION_STATES.includes(adoption.state) || !positiveId(adoption.ownerId) || !positiveId(adoption.visitorId)) {
      invalid('an adoption record is missing, duplicated, or unbound.');
    }
    adoptionIds.add(adoption.id);
    if (adoption.state === 'bound' && !state.workers.some(worker => worker.id === adoption.workerId && worker.puffle?.adoptionId === adoption.id)) {
      invalid(`bound adoption ${adoption.id} has no matching worker.`);
    }
  }
  const visitor = state.visitor;
  if (visitor !== null && (typeof visitor !== 'object' || !positiveId(visitor.penguinId) || !VISITOR_USERNAMES.includes(visitor.username))) invalid('the visitor record is invalid.');
  if (visitor && visitor.username !== visitorUsername) {
    fail(`This state directory belongs to the ${visitor.username} visitor, but the engine is configured for ${visitorUsername}. Use the matching CP_ENGINE_VISITOR or a different CP_ENGINE_STATE_DIR; nothing was changed.`, 500);
  }
  const owners = new Set(visitor ? [visitor.penguinId] : []);
  for (const project of state.projects) {
    const ownerId = project.game?.ownerId;
    if (!positiveId(ownerId)) continue;
    if (owners.has(ownerId)) invalid(`project ${project.id} shares its game owner with the visitor or another project.`);
    owners.add(ownerId);
  }
}

/**
 * Host-owned PTYs, one per active worker, remain alive while the browser,
 * panel, game room, or selected project changes. Each project igloo holds up
 * to ten adopted puffles; each puffle is a worker with its own persistent
 * Claude session and engine worktree, and never falls back to the source
 * checkout. Live sessions are capped per igloo and overall; starts beyond a
 * cap queue visibly and run when a slot frees.
 */
export async function createManager({ stateDir, onEvent = () => {}, claudePath = 'claude', ptySpawn = nodePty.spawn, hookBaseUrl,
  startupTimeoutMs = 12000, worktreeRoot = resolveWorktreeRoot(), gitEnv = {}, gitVersionText,
  game = null, publisher = null, onWarning = () => {}, caps = { perIgloo: 3, total: 6 }, clock = () => Date.now() } = {}) {
  // `game` is the injectable provisioner (createGameProvisioner in game.mjs, or a
  // test fake). Without it, setup stops at game-pending. `publisher` is the
  // native igloo publication owned by this engine (publication.mjs).
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) fail('An absolute private state directory is required.');
  const hookUrl = new URL(hookBaseUrl);
  if (hookUrl.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(hookUrl.hostname)) fail('Hooks must use a loopback HTTP address.');
  if (!absolute(worktreeRoot)) fail('The worktree root must be an absolute path.');
  if (!positiveId(caps?.perIgloo) || !positiveId(caps?.total)) fail('Session caps must be positive integers.');
  const visitorUsername = game?.visitorUsername ?? VISITOR_USERNAME;
  const state = readState(stateDir);
  const hooksDir = ensureEmptyHooksDir(path.join(stateDir, 'git-empty-hooks'));
  const git = createGit({ hooksDir, env: gitEnv });
  assertGitVersion(gitVersionText ?? await git.text(stateDir, ['--version']));
  validateSaved(state, visitorUsername);

  const runtimes = new Map();
  const projectLocks = new Map();
  const startQueue = [];
  let registration = Promise.resolve();
  let closing = false;
  const settingsPath = path.join(stateDir, 'claude-settings.json');
  const helper = fileURLToPath(new URL('./hook-client.mjs', import.meta.url));
  writePrivateJson(settingsPath, { hooks: Object.fromEntries(EVENTS.map(event => [event, [{ hooks: [{
    type: 'command', command: process.execPath, args: [helper], timeout: 3,
  }] }]])) });

  /**
   * A legacy project (no recorded repository identity) binds only to a
   * repository that still contains its archived puffles' baseline commits, so
   * an unrelated repository at the old path never inherits its history or game
   * mapping. Returns the reason it cannot bind, or null.
   */
  async function legacyIdentityProblem(project, identity) {
    if (state.projects.some(other => other !== project && other.commonDir === identity.commonDir)) return `The repository at ${identity.sourcePath} is already registered as another project.`;
    for (const worker of state.workers) {
      if (worker.projectId !== project.id || !worker.archived) continue;
      const found = await git.raw(identity.sourcePath, ['cat-file', '-e', `${worker.workspace.baseCommit}^{commit}`], { allowExit: [0, 1, 128] });
      if (found.code !== 0) {
        return `The repository at ${identity.sourcePath} does not contain the archived puffle ${worker.name}'s history (baseline ${worker.workspace.baseCommit.slice(0, 12)}), so it was not bound to this legacy project. Restore the original repository at that path; nothing was changed.`;
      }
    }
    return null;
  }

  const startedAt = now();
  for (const project of state.projects) {
    project.sourceAvailable = fs.existsSync(project.sourcePath);
    if (project.sourceAvailable && project.commonDir === null) {
      // Legacy projects learn their repository identity once their own source is reachable.
      try {
        const identity = await identifyRepository(git, project.sourcePath);
        if (!await legacyIdentityProblem(project, identity)) project.commonDir = identity.commonDir;
      } catch { /* Stay unresolved; registration then cannot deduplicate it. */ }
    }
    if (project.game?.source === 'managed' && project.game.status === 'provisioning') project.game.status = 'failed';
    if (project.setup.phase === 'preparing') {
      project.setup = { ...project.setup, phase: 'failed', retryable: true, updatedAt: startedAt,
        error: 'Setup stopped when the engine stopped. Retry to reconcile the owner and igloo; nothing was removed.' };
    }
    if (game && project.setup.phase === 'game-pending') {
      // Provisioning is configured now; the existing Retry path provisions it. Nothing is provisioned automatically.
      project.setup = { ...project.setup, phase: 'failed', step: null, retryable: true, correction: null, updatedAt: startedAt,
        error: 'Game provisioning was off when this project was set up. Retry to provision its igloo.' };
    }
  }
  for (const worker of state.workers) {
    if (worker.archived) continue;
    worker.cols = Math.min(300, Math.max(40, Number.isSafeInteger(worker.cols) ? worker.cols : 120));
    worker.rows = Math.min(100, Math.max(10, Number.isSafeInteger(worker.rows) ? worker.rows : 32));
    worker.updatedAt = startedAt;
    worker.outsideWorkspace = null;
    worker.queued = false;
    for (const task of worker.taskHistory) if (!task.endedAt) { task.status = 'interrupted'; task.endedAt = startedAt; }
    if (worker.setup.phase === 'preparing') {
      worker.setup = { ...worker.setup, phase: 'failed', step: null, retryable: true, updatedAt: startedAt,
        error: 'Worktree setup stopped when the engine stopped. Retry to reconcile the reserved worktree; nothing was removed.' };
    }
    if (worker.workspace?.state !== 'ready') { worker.status = 'setup'; worker.activity = 'Worktree setup is incomplete. Retry its setup.'; continue; }
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
    if (worker.workspace?.state !== 'ready') fail('This puffle\'s worktree setup is not complete. Retry its setup first.', 409);
    return worker;
  }
  function adoptionFor(id) {
    if (typeof id !== 'string' || !LOWER_UUID.test(id)) fail('An explicit adoption ID is required.');
    const adoption = state.adoptions.find(item => item.id === id);
    if (!adoption) fail('Unknown adoption.', 404);
    return adoption;
  }
  const activeWorkers = projectId => state.workers.filter(worker => worker.projectId === projectId && !worker.archived);
  function assertOpen() { if (closing) fail('The local runtime is stopping.', 409); }
  const expired = adoption => Date.parse(adoption.expiresAt) <= clock();
  const openAdoptions = projectId => state.adoptions.filter(item => item.projectId === projectId && OPEN_ADOPTIONS.includes(item.state) && !(item.state === 'reserved' && expired(item)));
  /** Puffles in the igloo plus purchases in flight. */
  const occupancy = project => activeWorkers(project.id).filter(worker => worker.puffle).length + openAdoptions(project.id).length;

  // ------------------------------------------------------------ views (allowlisted)

  /** Why the visitor cannot adopt into this project right now, or null. */
  function adoptionBlocked(project) {
    if (project.game?.source === 'legacy-fixture') return 'The migrated Atlas shares the Bridge Alpha owner with the bridge lab, so adoption into this igloo stays off.';
    if (!game) return 'Game provisioning is off for this engine.';
    if (!state.visitor || visitorProblem) return 'The island visitor has not been verified yet.';
    if (project.game?.status !== 'ready' || project.setup.phase !== 'ready') return 'This igloo is still being set up.';
    if (occupancy(project) >= MAX_PUFFLES_PER_IGLOO) return `This igloo already has ${MAX_PUFFLES_PER_IGLOO} puffles.`;
    return null;
  }
  function projectView(project) {
    // Allowlisted: game usernames, passwords, and ownership markers never leave the host engine.
    const mapping = project.game ? Object.fromEntries(['source', 'status', 'ownerId', 'iglooId', 'roomId', 'puffleId', 'puffleName', 'fixtureId', 'verifiedAt']
      .map(key => [key, project.game[key] ?? null])) : null;
    const setup = Object.fromEntries(['phase', 'step', 'error', 'note', 'retryable', 'correction', 'updatedAt'].map(key => [key, project.setup[key] ?? null]));
    const puffles = activeWorkers(project.id).filter(worker => worker.puffle).length;
    return { id: project.id, name: project.name, sourcePath: project.sourcePath, sourceAvailable: fs.existsSync(project.sourcePath),
      createdAt: project.createdAt, legacy: Boolean(project.legacy), setup, game: mapping,
      capacity: { max: MAX_PUFFLES_PER_IGLOO, puffles, pending: openAdoptions(project.id).length },
      adoptionBlocked: adoptionBlocked(project), busy: projectLocks.has(project.id) };
  }
  function workerView(worker) {
    const runtime = runtimes.get(worker.id);
    const workspace = worker.workspace ? Object.fromEntries(['kind', 'path', 'branch', 'baseCommit', 'state', 'sourceDirtyAtCreation'].map(key => [key, worker.workspace[key] ?? null])) : null;
    const setup = Object.fromEntries(['phase', 'step', 'error', 'note', 'retryable', 'updatedAt'].map(key => [key, worker.setup?.[key] ?? null]));
    const puffle = worker.puffle ? { ...worker.puffle, color: catalogForPuffleType(worker.puffle.subtypeId || worker.puffle.typeId)?.color ?? 'blue' } : null;
    return { ...Object.fromEntries(['id', 'projectId', 'name', 'sessionId', 'status', 'activity', 'established',
      'cols', 'rows', 'createdAt', 'updatedAt', 'taskHistory', 'lastError', 'exitCode', 'outsideWorkspace'].map(key => [key, copy(worker[key])])),
    workspace, setup, puffle, queued: Boolean(worker.queued), inspection: worker.inspection ? copy(worker.inspection) : null,
    running: Boolean(runtime?.pty), recoveryBlocked: Boolean(!runtime?.pty && pidAlive(worker.pid)) };
  }
  function archivedView(worker) {
    return { id: worker.id, projectId: worker.projectId, name: worker.name, sessionId: worker.sessionId, established: worker.established,
      createdAt: worker.createdAt, taskHistory: copy(worker.taskHistory), archived: copy(worker.archived),
      originalPath: worker.workspace.path, baseCommit: worker.workspace.baseCommit, workspaceKind: worker.workspace.kind,
      resumeCommand: worker.established ? `cd ${shellQuote(worker.workspace.path)} && claude --resume ${worker.sessionId}` : null };
  }
  function adoptionView(adoption) {
    return { ...Object.fromEntries(['id', 'projectId', 'workerId', 'ownerId', 'state', 'error', 'code', 'createdAt', 'updatedAt', 'expiresAt'].map(key => [key, adoption[key] ?? null])),
      request: copy(adoption.request), receipt: adoption.receipt ? copy(adoption.receipt) : null, expired: adoption.state === 'reserved' && expired(adoption),
      // Final: a receipt lookup after expiry plus the margin found nothing, so this ID can never be charged.
      settled: adoption.state === 'withdrawn' && !adoption.receipt && typeof adoption.settledAt === 'string' };
  }
  function snapshot() {
    // A visitor that failed this run's verification is reported unverified, so the browser builds no mappings for it.
    const visitor = state.visitor && !visitorProblem ? { penguinId: state.visitor.penguinId, username: state.visitor.username, verifiedAt: state.visitor.verifiedAt ?? null } : null;
    return { revision: state.revision, worktreeRoot, visitor, visitorProblem, visitorUsername,
      limits: { maxProjects: MAX_PROJECTS, maxPuffles: MAX_PUFFLES_PER_IGLOO, sessionsPerIgloo: caps.perIgloo, sessions: caps.total },
      catalog: ADOPTION_CATALOG,
      projects: state.projects.map(projectView),
      workers: state.workers.filter(worker => !worker.archived).map(workerView),
      archivedWorkers: state.workers.filter(worker => worker.archived).map(archivedView),
      adoptions: state.adoptions.slice(-50).map(adoptionView) };
  }
  function notify(event) { try { onEvent(event); } catch { /* A disconnected UI must not stop the agent. */ } }
  let publicationProblem = null;
  let publisherClosed = false;
  let visitorProblem = null; // Set when this run's visitor verification failed; cleared when it verifies again.
  const withdrawnPublication = { version: 2, visitorId: null, igloos: [], adoptions: [] };
  /** Rewrites the native igloo publication when ready mappings, reservations, or the visitor change. */
  function publish() {
    if (!publisher || publisherClosed) return;
    try { publisher.update(visitorProblem ? withdrawnPublication : publicationFor(state, clock())); publicationProblem = null; }
    catch (error) {
      if (publicationProblem !== error.message) { publicationProblem = error.message; onWarning(`Native igloo publication failed: ${error.message}`); }
    }
  }
  function commit() {
    state.revision++;
    writeState(stateDir, state);
    publish();
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

  // ------------------------------------------------------------ registration and destination setup

  /**
   * Registration creates an empty project igloo: a dedicated owner and a
   * locked igloo, with no puffle. Puffles are adopted at the Pet Shop.
   */
  async function registerProject({ path: input, name } = {}) {
    assertOpen();
    const operation = registration.then(async () => {
      assertOpen();
      const identity = await identifyRepository(git, input);
      const existing = state.projects.find(project => project.commonDir === identity.commonDir) ??
        state.projects.find(project => project.commonDir === null && project.sourcePath === identity.sourcePath);
      if (existing) {
        // An unrelated repository at a legacy project's old path stays unbound; createWorker explains why.
        if (existing.commonDir === null && !await legacyIdentityProblem(existing, identity)) { existing.commonDir = identity.commonDir; existing.sourceAvailable = true; commit(); }
        return { project: existing, created: false };
      }
      if (state.projects.length >= MAX_PROJECTS) fail(`Claude Penguin supports at most ${MAX_PROJECTS} registered projects.`, 409);
      const projectName = name === undefined || name === '' ? defaultProjectName(path.basename(identity.sourcePath)) : validateProjectName(name);
      const project = { id: randomUUID(), name: projectName, sourcePath: identity.sourcePath, commonDir: identity.commonDir, createdAt: now(),
        sourceAvailable: true, setup: { phase: 'registered', step: null, error: null, retryable: false, updatedAt: now() }, game: null };
      state.projects.push(project);
      commit();
      return { project, created: true };
    });
    registration = operation.catch(() => {});
    const { project, created } = await operation;
    if (created) withProjectLock(project.id, () => runSetup(project));
    return projectView(project);
  }

  function setSetup(project, fields) {
    project.setup = { ...project.setup, ...fields, updatedAt: now() };
    commit();
  }
  function setWorkerSetup(worker, fields) {
    worker.setup = { ...worker.setup, ...fields, updatedAt: now() };
    worker.updatedAt = now();
    commit();
  }

  /** Destination setup: owner and igloo. It reaches `ready` only once the mapping verifies. */
  async function runSetup(project) {
    if (project.game?.source === 'legacy-fixture') return;
    if (!game) {
      setSetup(project, { phase: 'game-pending', step: 'Game provisioning is not configured for this engine.', error: null, retryable: false, correction: null });
      return;
    }
    try {
      assertOpen();
      await provisionGame(project);
      setSetup(project, { phase: 'ready', step: null, error: null, retryable: false, correction: null });
    } catch (error) {
      if (closing && !(error instanceof ProvisionError)) return;
      const message = String(error.message).slice(0, 1000);
      if (project.game?.source === 'managed') project.game.status = REPAIR_CODES.includes(error.code) ? 'repair' : 'failed';
      setSetup(project, { phase: 'failed', step: null, error: message, retryable: true, correction: null });
    }
  }

  // ------------------------------------------------------------ game provisioning

  let visitorRun = null;
  let visitorVerified = false;
  /**
   * Verify or create only the marked fixture visitor; the engine never logs in
   * as it. A recorded visitor is only verified, never recreated. A visitor
   * that fails verification (not an unavailable stack) is reported unverified
   * and publication is withdrawn until it verifies again; it is never remapped.
   */
  function ensureVisitor({ force = false } = {}) {
    if (!game) return Promise.reject(new ProvisionError('Game provisioning is not configured for this engine.', 'UNAVAILABLE'));
    if (visitorVerified && !force && state.visitor) return Promise.resolve(state.visitor);
    visitorRun ??= (async () => {
      const recorded = state.visitor?.penguinId ?? null;
      try {
        let visitor;
        try { visitor = await game.ensureVisitor({ penguinId: recorded }); }
        catch (error) {
          if (error.code !== 'MISSING') throw error;
          throw new ProvisionError(`The ${visitorUsername} visitor recorded as game ID ${recorded} is missing from the game database: ${String(error.message).slice(0, 300)} Nothing was created; restore that account or repair the visitor record explicitly.`, 'MISSING');
        }
        if (!positiveId(visitor?.penguinId) || visitor.username !== visitorUsername) throw new ProvisionError('The provisioner returned an unexpected visitor identity.', 'MISMATCH');
        if (recorded !== null && recorded !== visitor.penguinId) {
          throw new ProvisionError(`The ${visitorUsername} visitor now has game ID ${visitor.penguinId}, not the recorded ${recorded}. Refusing to remap it; repair the visitor record explicitly.`, 'MISMATCH');
        }
        if (state.projects.some(project => project.game?.ownerId === visitor.penguinId)) throw new ProvisionError('The visitor account is also a project owner.', 'MISMATCH');
        assertOpen();
        state.visitor = { penguinId: visitor.penguinId, username: visitor.username, verifiedAt: now() };
        visitorVerified = true;
        visitorProblem = null;
        commit();
        return state.visitor;
      } catch (error) {
        if (REPAIR_CODES.includes(error.code) && !closing) {
          visitorVerified = false;
          visitorProblem = String(error.message).slice(0, 600);
          try { commit(); } catch { /* The verification failure below is what the caller reports. */ }
        }
        throw error;
      }
    })().finally(() => { visitorRun = null; });
    return visitorRun;
  }

  function saveCredentials(projectId, credentials) {
    const secrets = readSecrets(stateDir);
    secrets.owners[projectId] = credentials;
    writeSecrets(stateDir, secrets);
  }

  /** The recorded puffle set of a managed project, as the verifier expects it. */
  function recordedPuffles(project) {
    return state.workers.filter(worker => worker.projectId === project.id && worker.puffle)
      .map(worker => ({ puffleId: worker.puffle.puffleId, name: worker.puffle.name, puffleType: worker.puffle.subtypeId || worker.puffle.typeId }));
  }

  /** Provision or reconcile one project's dedicated owner and locked, empty-or-recorded igloo. */
  async function provisionGame(project) {
    const step = text => setSetup(project, { phase: 'preparing', step: text, error: null, retryable: false, correction: null });
    const mismatch = message => new ProvisionError(message, 'MISMATCH');
    step('Checking the island visitor.');
    await ensureVisitor();
    assertOpen();
    if (project.game && project.game.source !== 'managed') throw mismatch('This legacy fixture mapping is not ready and is never reprovisioned automatically.');
    let credentials = readSecrets(stateDir).owners[project.id];
    if (!credentials) {
      if (project.game?.ownerId) throw mismatch('This project\'s managed-owner credentials are missing from game-secrets.json. Restore that file; a second owner will not be created.');
      // The marker and credentials are durable before anything is created.
      credentials = newOwnerCredentials(now());
      saveCredentials(project.id, credentials);
    }
    if (!project.game) project.game = { source: 'managed', status: 'provisioning', ownerId: null, iglooId: null, roomId: null, verifiedAt: null };
    else project.game.status = 'provisioning';
    const mapping = project.game;
    step('Preparing the project owner penguin.');

    let owner;
    for (let attempt = 1; ; attempt++) {
      try {
        // With a recorded owner ID the service only verifies that owner and never creates another.
        owner = await game.ensureOwner({ marker: credentials.marker, username: credentials.username, password: credentials.password, nickname: project.name,
          ownerId: mapping.ownerId ?? null });
        break;
      } catch (error) {
        if (error.code === 'MISSING') {
          throw new ProvisionError(`The recorded managed owner (game ID ${mapping.ownerId}) is missing from the game database: ${String(error.message).slice(0, 300)} Nothing was created or remapped; restore that account or repair the mapping explicitly, then retry.`, 'MISSING');
        }
        if (error.code !== 'USERNAME_TAKEN') throw error;
        if (mapping.ownerId) throw mismatch('The managed owner\'s username now belongs to another account. Nothing was changed; repair the game mapping explicitly.');
        if (attempt >= USERNAME_ATTEMPTS) throw new ProvisionError('Could not find an unused managed-owner username.');
        credentials = { ...credentials, username: generateUsername() };
        saveCredentials(project.id, credentials);
      }
    }
    assertOpen();
    if (!positiveId(owner?.ownerId)) throw new ProvisionError('The provisioner returned an invalid owner ID.');
    if (mapping.ownerId && mapping.ownerId !== owner.ownerId) throw mismatch(`The managed owner is now game ID ${owner.ownerId}, not the recorded ${mapping.ownerId}. Nothing was remapped; repair the game mapping explicitly.`);
    if (owner.ownerId === state.visitor?.penguinId || state.projects.some(other => other !== project && other.game?.ownerId === owner.ownerId)) throw mismatch('The managed owner is already mapped to the visitor or another project.');
    mapping.ownerId = owner.ownerId;
    step('Preparing the project igloo.');

    const igloo = await game.prepareIgloo({ username: credentials.username, password: credentials.password, ownerId: mapping.ownerId,
      recorded: { iglooId: mapping.iglooId } });
    assertOpen();
    if (!positiveId(igloo?.iglooId) || !positiveId(igloo?.roomId)) throw new ProvisionError('The game session returned an incomplete igloo mapping.');
    if (igloo.roomId !== mapping.ownerId + 2000) throw mismatch('The game entered a room that does not belong to the managed owner.');
    if (mapping.iglooId !== null && mapping.iglooId !== igloo.iglooId) throw mismatch('The managed igloo no longer matches the recorded mapping. Nothing was remapped; repair it explicitly.');
    Object.assign(mapping, { iglooId: igloo.iglooId, roomId: igloo.roomId });
    // Paid puffles always win: bind any completed purchase before verifying the recorded set.
    if (state.adoptions.some(item => item.projectId === project.id && item.state !== 'bound')) {
      step('Checking adoption receipts.');
      await reconcileReceipts(state.adoptions.filter(item => item.projectId === project.id && item.state !== 'bound'));
    }
    step('Verifying the owner, igloo, room, and puffles.');
    const [result] = await game.verifyOwners([{ key: project.id, marker: credentials.marker, username: credentials.username,
      ownerId: mapping.ownerId, iglooId: mapping.iglooId, puffles: recordedPuffles(project) }]);
    assertOpen();
    if (!result?.ok || result.key !== project.id) throw mismatch(`The game mapping did not verify: ${(result?.problems ?? ['no result']).join(' ')}`);
    mapping.status = 'ready';
    mapping.verifiedAt = now();
  }

  /**
   * Re-verify the visitor and every ready mapping (one batched provisioning
   * run), after reconciling every unfinished adoption against its receipt. A
   * mismatch marks the mapping for repair and removes it from publication; a
   * visitor that fails verification withdraws the whole publication (see
   * ensureVisitor) while owner mappings are still checked. An unavailable
   * stack leaves the last verified state.
   */
  async function verifyGameMappings() {
    if (!game) return { checked: 0, repair: 0, visitorProblem: null };
    assertOpen();
    try { await ensureVisitor({ force: true }); }
    catch (error) { if (!REPAIR_CODES.includes(error.code)) throw error; }
    await reconcileAdoptions();
    const secrets = readSecrets(stateDir);
    const ready = state.projects.filter(project => project.game?.status === 'ready' || (project.game?.source === 'legacy-fixture' && project.game.status === 'repair'));
    const markRepair = (project, message) => withProjectLock(project.id, async () => {
      if (!['ready', 'repair'].includes(project.game?.status)) return;
      project.game.status = 'repair';
      setSetup(project, { phase: 'failed', step: null, error: message, retryable: project.game.source === 'managed', correction: null });
    });
    let repair = 0;
    const checks = [];
    for (const project of ready) {
      const { ownerId, iglooId, puffleId, puffleName, fixtureId } = project.game;
      if (project.game.source === 'legacy-fixture') {
        const expected = { ownerId, iglooId, puffleId, puffleName };
        checks.push({ project, expected, mapping: { key: project.id, fixtureId, ...expected } });
        continue;
      }
      const credentials = secrets.owners[project.id];
      if (!credentials) { repair++; await markRepair(project, "This project's managed-owner credentials are missing from game-secrets.json. Restore that file."); continue; }
      const puffles = recordedPuffles(project);
      checks.push({ project, expected: { ownerId, iglooId, puffles: JSON.stringify(puffles) },
        mapping: { key: project.id, marker: credentials.marker, username: credentials.username, ownerId, iglooId, puffles } });
    }
    const results = await game.verifyOwners(checks.map(check => check.mapping));
    assertOpen();
    for (const check of checks) {
      const result = results.find(item => item.key === check.project.id);
      const unchanged = () => Object.entries(check.expected).every(([key, value]) =>
        key === 'puffles' ? JSON.stringify(recordedPuffles(check.project)) === value : check.project.game?.[key] === value);
      if (result?.ok) {
        await withProjectLock(check.project.id, async () => {
          if (!unchanged()) return;
          const project = check.project;
          if (project.game.source === 'legacy-fixture' && project.game.status === 'repair') {
            project.game.status = 'ready';
            const worker = activeWorkers(project.id)[0];
            setSetup(project, { phase: worker ? 'ready' : 'needs-worker', error: null, retryable: false });
          }
          if (project.game.status === 'ready') { project.game.verifiedAt = now(); commit(); }
        });
      } else {
        repair++;
        if (unchanged()) await markRepair(check.project, `The game mapping no longer verifies: ${(result?.problems ?? ['no result']).join(' ')}`);
      }
    }
    return { checked: ready.length, repair, visitorProblem };
  }

  // ------------------------------------------------------------ adoption

  /**
   * Reserve one adoption for a ready project with room for another puffle.
   * The adoption and worker IDs are durable and published before the browser
   * sends the purchase. One outstanding adoption per visitor; refused while
   * the engine holds the project lock (for example an owner game session).
   */
  async function reserveAdoption({ projectId, typeId, subtypeId, name } = {}) {
    assertOpen();
    const project = projectFor(projectId);
    if (projectLocks.has(project.id)) fail('This igloo is busy with setup or another adoption. Try again in a moment.', 409);
    const entry = catalogEntry(typeId, subtypeId);
    if (!entry) fail('That puffle cannot join a project igloo. Choose one of the ten colors, the Blue Dog or the Orange Cat.');
    const puffleName = validatePuffleName(name);
    return withProjectLock(project.id, async () => {
      assertOpen();
      const blocked = adoptionBlocked(project);
      if (blocked) fail(blocked, 409);
      const outstanding = state.adoptions.find(item => OPEN_ADOPTIONS.includes(item.state) && !(item.state === 'reserved' && expired(item)));
      if (outstanding) fail(outstanding.state === 'charged'
        ? 'A purchase is still being confirmed. Wait for it, or check it from Your Igloos.'
        : 'Another adoption is still open. Finish or close it first.', 409);
      const at = now();
      const adoption = { id: randomUUID(), projectId: project.id, workerId: randomUUID(), visitorId: state.visitor.penguinId, ownerId: project.game.ownerId,
        state: 'reserved', request: { typeId: entry.typeId, subtypeId: entry.subtypeId, name: puffleName, price: entry.price },
        receipt: null, error: null, createdAt: at, updatedAt: at, expiresAt: new Date(clock() + ADOPTION_TTL_MS).toISOString() };
      state.adoptions.push(adoption);
      commit();
      return adoptionView(adoption);
    });
  }

  function setAdoption(adoption, fields) {
    Object.assign(adoption, fields, { updatedAt: now() });
    commit();
  }

  /** Bind a confirmed receipt: the paid puffle becomes a worker with its own session; worktree setup follows. */
  function bind(adoption, receipt) {
    const project = projectFor(adoption.projectId);
    const entry = catalogForPuffleType(receipt.puffleType);
    let worker = state.workers.find(item => item.id === adoption.workerId);
    if (!worker) {
      if (state.workers.some(item => item.puffle?.puffleId === receipt.puffleId)) {
        setAdoption(adoption, { state: 'conflict', error: `Puffle ${receipt.puffleId} is already bound to another worker.` });
        return null;
      }
      let name = receipt.name;
      try { validatePuffleName(name); } catch { name = 'Puffle'; }
      worker = { id: adoption.workerId, projectId: project.id, name, sessionId: randomUUID(), established: false,
        status: 'setup', activity: 'Preparing the worktree.', cols: 120, rows: 32, createdAt: now(), updatedAt: now(), pid: null, taskHistory: [],
        outsideWorkspace: null, inspection: null, archived: null, queued: false,
        puffle: { puffleId: receipt.puffleId, typeId: entry.typeId, subtypeId: entry.subtypeId, name: receipt.name, adoptionId: adoption.id },
        workspace: null, setup: { phase: 'preparing', step: 'Waiting to reserve the worktree.', error: null, retryable: false, updatedAt: now() } };
      state.workers.push(worker);
    }
    setAdoption(adoption, { state: 'bound', error: null, receipt: { puffleId: receipt.puffleId, puffleType: receipt.puffleType, name: receipt.name,
      cost: receipt.cost, coinsAfter: receipt.coinsAfter, createdAt: receipt.createdAt } });
    withProjectLock(project.id, () => runWorkerSetup(project, worker));
    return worker;
  }

  /** Confirm receipts for these adoptions through the provisioning service. A receipt always wins. */
  async function reconcileReceipts(adoptions) {
    if (!game || !adoptions.length) return [];
    // Taken before the lookup: only a lookup that started after the margin can settle an adoption.
    const lookupAt = clock();
    const receipts = await game.readReceipts(adoptions.map(item => item.id));
    assertOpen();
    const bound = [];
    for (const adoption of adoptions) {
      if (adoption.state === 'bound') continue;
      const receipt = receipts.find(item => item.adoptionId === adoption.id);
      if (receipt) {
        if (receipt.visitorId !== adoption.visitorId || receipt.ownerId !== adoption.ownerId || !catalogForPuffleType(receipt.puffleType)) {
          setAdoption(adoption, { state: 'conflict', error: 'The stored receipt does not match this reservation. Nothing was bound; inspect it explicitly.' });
          continue;
        }
        const worker = bind(adoption, receipt);
        if (worker) bound.push(worker.id);
      } else if (!adoption.settledAt && adoption.state !== 'charged' && adoption.code !== 'lost'
          && lookupAt >= Date.parse(adoption.expiresAt) + SETTLE_MARGIN_MS) {
        // The server refuses this ID from now on. A receipt found later still wins above. A purchase the
        // game reported as charged is never settled as uncharged: its missing receipt needs inspection.
        setAdoption(adoption, { state: 'withdrawn', error: REFUSALS['not-charged'], code: 'not-charged', settledAt: new Date(lookupAt).toISOString() });
      } else if (adoption.state === 'reserved' && expired(adoption)) {
        setAdoption(adoption, { state: 'withdrawn', error: REFUSALS.expired });
      } else if (adoption.state === 'charged') {
        // The browser saw a purchase that has no receipt (yet): keep it open until it expires, then withdraw it.
        if (expired(adoption)) setAdoption(adoption, { state: 'withdrawn', error: REFUSALS.lost, code: 'lost' });
      }
    }
    return bound;
  }

  /** At startup and on Retry: reconcile every reserved, charged or withdrawn adoption in one run. */
  async function reconcileAdoptions({ projectId } = {}) {
    if (!game) return { bound: [] };
    if (projectId !== undefined) projectFor(projectId);
    const unfinished = state.adoptions.filter(item => ['reserved', 'charged', 'withdrawn'].includes(item.state) && (projectId === undefined || item.projectId === projectId))
      .slice(-MAX_RECONCILED);
    return { bound: await reconcileReceipts(unfinished), adoptions: state.adoptions.slice(-50).map(adoptionView) };
  }

  /**
   * The browser relays the game's reply to p#cpadopt. Success marks the
   * adoption charged, then the engine confirms the receipt itself before
   * binding. A refusal withdraws the reservation (a later receipt still wins).
   */
  async function reportAdoption({ adoptionId, result } = {}) {
    assertOpen();
    const adoption = adoptionFor(adoptionId);
    if (!record(result) || typeof result.ok !== 'boolean') fail('A purchase result is required.');
    if (adoption.state === 'bound') return adoptionView(adoption);
    if (!result.ok) {
      const code = typeof result.code === 'string' && Object.hasOwn(REFUSALS, result.code) ? result.code : 'failed';
      if (adoption.state === 'reserved') setAdoption(adoption, { state: 'withdrawn', error: REFUSALS[code], code });
      return adoptionView(adoption);
    }
    if (['reserved', 'withdrawn'].includes(adoption.state)) setAdoption(adoption, { state: 'charged', error: null });
    try { await withProjectLock(adoption.projectId, () => reconcileReceipts([adoption])); }
    catch (error) {
      setAdoption(adoption, { error: `The purchase is recorded; confirming its receipt failed (${String(error.message).slice(0, 200)}). Retry from Your Igloos.` });
    }
    return adoptionView(adoption);
  }

  /** The visitor closed adoption before buying. A charged purchase cannot be cancelled. */
  function cancelAdoption({ adoptionId } = {}) {
    const adoption = adoptionFor(adoptionId);
    if (adoption.state === 'reserved') setAdoption(adoption, { state: 'withdrawn', error: REFUSALS.cancelled, code: 'cancelled' });
    return adoptionView(adoption);
  }

  // ------------------------------------------------------------ worker setup

  async function reserveWorkspace(project, worker) {
    project.sourceAvailable = fs.existsSync(project.sourcePath);
    if (!project.sourceAvailable) fail('The source checkout is unavailable. Restore it, then retry this puffle\'s setup.', 409);
    const identity = await identifyRepository(git, project.sourcePath);
    if (project.commonDir === null) {
      const problem = await legacyIdentityProblem(project, identity);
      if (problem) fail(problem, 409);
      project.commonDir = identity.commonDir;
    }
    if (identity.commonDir !== project.commonDir) fail('The source checkout now belongs to a different repository. Repair the project before continuing.', 409);
    const dirty = await sourceDirty(git, project.sourcePath);
    const root = await prepareWorktreeRoot(git, worktreeRoot);
    // The reservation is durable before Git runs, so a retry reconciles only this exact path and branch.
    worker.workspace = { kind: 'worktree', path: reserveWorkspacePath(root, worker.id, project.sourcePath), branch: workerBranch(project.id, worker.id),
      baseCommit: identity.head, repoCommonDir: project.commonDir, sourcePath: project.sourcePath, sourceDirtyAtCreation: dirty, state: 'reserved', reservedAt: now() };
    setWorkerSetup(worker, { step: 'Reserved the worktree path and branch.',
      ...(dirty ? { note: 'The source checkout has uncommitted changes. They stay in the source checkout; the worktree starts from its committed HEAD.' } : {}) });
  }

  async function prepareWorkspace(project, worker) {
    const workspace = worker.workspace;
    setWorkerSetup(worker, { phase: 'preparing', step: 'Creating the worktree.', error: null, retryable: false });
    await createWorktree(git, { sourcePath: project.sourcePath, workspacePath: workspace.path, branch: workspace.branch,
      baseline: workspace.baseCommit, workerId: worker.id, onProgress: step => setWorkerSetup(worker, { step }) });
    await assertReadPolicy(git, workspace.path, [workspace.baseCommit]);
    const inspection = await inspectWorkspace(git, project, workspace);
    if (inspection.repair) throw Object.assign(new Error(inspection.repair), { statusCode: 409 });
    workspace.state = 'ready';
    workspace.readyAt = now();
    worker.inspection = { repair: null, warnings: inspection.warnings, checkedAt: now() };
    worker.status = 'offline';
    worker.activity = 'Ready to start this named conversation.';
    setWorkerSetup(worker, { phase: 'ready', step: null, error: null, retryable: false });
  }

  /** One worker's worktree setup. A failure affects only that worker; the paid puffle stays. */
  async function runWorkerSetup(project, worker) {
    try {
      assertOpen();
      if (!worker.workspace) await reserveWorkspace(project, worker);
      if (worker.workspace.state !== 'ready') await prepareWorkspace(project, worker);
    } catch (error) {
      if (closing) return;
      worker.status = 'setup';
      worker.activity = 'Worktree setup failed. Retry after resolving the problem.';
      setWorkerSetup(worker, { phase: 'failed', step: null, error: String(error.message).slice(0, 1000), retryable: true });
    }
  }

  /**
   * Legacy only: create the one isolated worker for a migrated legacy-fixture
   * project, bound to its fixture puffle. Managed projects get workers only by
   * adoption.
   */
  async function createWorker({ projectId } = {}) {
    assertOpen();
    const project = projectFor(projectId);
    let created;
    await withProjectLock(project.id, async () => {
      assertOpen();
      if (project.game?.source !== 'legacy-fixture') fail('Adopt a puffle at the Pet Shop to add it to this igloo.', 409);
      if (activeWorkers(project.id).length) fail('This legacy igloo already has its isolated puffle.', 409);
      if (project.game.status !== 'ready') fail('The legacy fixture mapping is not verified. Restore it and restart the engine.', 409);
      project.sourceAvailable = fs.existsSync(project.sourcePath);
      if (!project.sourceAvailable) fail('The source checkout is unavailable. Restore it before creating a puffle.', 409);
      const identity = await identifyRepository(git, project.sourcePath);
      if (project.commonDir === null) {
        // A legacy project whose source returned after startup.
        const problem = await legacyIdentityProblem(project, identity);
        if (problem) fail(problem, 409);
        project.commonDir = identity.commonDir;
      }
      if (identity.commonDir !== project.commonDir) fail('The source checkout now belongs to a different repository. Repair the project before continuing.', 409);
      const id = randomUUID();
      const worker = { id, projectId: project.id, name: validatePuffleName(project.game.puffleName), sessionId: randomUUID(), established: false,
        status: 'setup', activity: 'Preparing the worktree.', cols: 120, rows: 32, createdAt: now(), updatedAt: now(), pid: null, taskHistory: [],
        outsideWorkspace: null, inspection: null, archived: null, queued: false,
        puffle: { puffleId: project.game.puffleId, typeId: 0, subtypeId: 0, name: project.game.puffleName, adoptionId: null },
        workspace: null, setup: { phase: 'preparing', step: 'Reserving the worktree.', error: null, retryable: false, updatedAt: now() } };
      state.workers.push(worker);
      project.setup = { ...project.setup, phase: 'ready', error: null, retryable: false, updatedAt: now() };
      commit();
      created = worker;
    });
    withProjectLock(project.id, () => runWorkerSetup(project, created));
    return workerView(created);
  }

  /** Explicit retry of a project's destination setup. */
  async function retrySetup({ projectId } = {}) {
    assertOpen();
    const project = projectFor(projectId);
    await withProjectLock(project.id, async () => {
      if (project.setup.phase !== 'failed') fail('Setup is not waiting for a retry.', 409);
      if (project.game?.source === 'legacy-fixture') fail('Restore the legacy fixture in the game database and restart the engine to verify it.', 409);
    });
    withProjectLock(project.id, () => runSetup(project));
    return projectView(project);
  }

  /** Explicit retry of one worker's worktree setup. */
  async function retryWorker(target = {}) {
    assertOpen();
    const worker = workerFor(target);
    const project = projectFor(worker.projectId);
    if (worker.archived) fail('Archived puffles are read-only.', 409);
    if (worker.setup.phase !== 'failed') fail('This puffle\'s setup is not waiting for a retry.', 409);
    withProjectLock(project.id, () => runWorkerSetup(project, worker));
    return workerView(worker);
  }

  /** Resolves after queued setup or adoption work for this project finishes. */
  async function settled(projectId) {
    while (projectLocks.has(projectId)) await projectLocks.get(projectId);
    return projectView(projectFor(projectId));
  }

  // ------------------------------------------------------------ session caps

  const live = runtime => Boolean(runtime?.pty || runtime?.starting);
  function liveCounts(projectId) {
    let project = 0, total = 0;
    for (const [workerId, runtime] of runtimes) {
      if (!live(runtime)) continue;
      total++;
      if (state.workers.find(item => item.id === workerId)?.projectId === projectId) project++;
    }
    return { project, total };
  }
  const hasSlot = worker => { const counts = liveCounts(worker.projectId); return counts.project < caps.perIgloo && counts.total < caps.total; };
  function queueActivity(worker) {
    const counts = liveCounts(worker.projectId);
    const position = startQueue.indexOf(worker.id) + 1;
    return `Queued (${position} in line). ${counts.project} of ${caps.perIgloo} sessions in this igloo and ${counts.total} of ${caps.total} overall are running; it starts when a slot frees.`;
  }
  /** Start queued workers, in order, while slots are free. Never stops a working session to make room. */
  function drainQueue() {
    if (closing) return;
    for (const workerId of [...startQueue]) {
      const worker = state.workers.find(item => item.id === workerId);
      if (!worker || worker.archived || !worker.queued) { startQueue.splice(startQueue.indexOf(workerId), 1); continue; }
      if (!hasSlot(worker)) continue;
      startQueue.splice(startQueue.indexOf(workerId), 1);
      worker.queued = false;
      launch(worker).catch(() => { /* launch records the failure on the worker. */ });
    }
    for (const workerId of startQueue) {
      const worker = state.workers.find(item => item.id === workerId);
      if (worker?.queued) { worker.activity = queueActivity(worker); }
    }
  }

  // ------------------------------------------------------------ terminal lifecycle

  async function start(target) {
    assertOpen();
    const worker = activeWorkerFor(target);
    if (runtimes.get(worker.id)?.pty) return workerView(worker);
    if (runtimes.get(worker.id)?.starting) fail('This worker is already starting.', 409);
    if (worker.queued) return workerView(worker);
    if (pidAlive(worker.pid)) fail('The saved process may still be alive. Stop it manually before resuming; refusing to duplicate the session.', 409);
    if (!hasSlot(worker)) {
      worker.queued = true;
      startQueue.push(worker.id);
      update(worker, 'queued', queueActivity(worker));
      return workerView(worker);
    }
    return launch(worker);
  }

  async function launch(worker) {
    const previous = runtimes.get(worker.id);
    const runtime = { starting: true, token: randomBytes(32).toString('hex'), pty: null, stopping: false, fatal: null,
      started: false, lastNeedsYouAt: 0, promptId: null, terminalQueue: Promise.resolve(), cwdCache: new Map(), topCache: new Map(),
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
        drainQueue();
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
        else if (!runtime.term) runtimes.delete(worker.id);
      }
      if (worker.status !== 'needs-repair') {
        worker.lastError = `Unable to start Claude: ${error.message}`;
        update(worker, 'failed', worker.lastError);
      }
      drainQueue();
      throw error;
    }
  }

  async function submit({ text, ...target } = {}) {
    assertOpen();
    const worker = activeWorkerFor(target);
    const runtime = activeRuntime(worker);
    // The turn can change while the workspace is inspected and during the paste
    // pause (a prompt typed in the terminal, or an unconfirmed interrupt), so
    // readiness is checked again before each write.
    const ready = () => runtimes.get(worker.id) === runtime && runtime.started && SUBMITTABLE.includes(worker.status);
    if (!runtime.started || !SUBMITTABLE.includes(worker.status)) fail('Use the live terminal to answer prompts, or wait until the current turn ends.', 409);
    if (runtime.submitting) fail('A task is already being submitted.', 409);
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > MAX_INPUT || /[\x00\x1b]/.test(text)) fail('Task text must be nonempty, at most 64 KiB, and contain no terminal escape sequences.');
    runtime.submitting = true;
    try {
      await checkWorkspace(worker);
      const proc = runtime.pty;
      if (!proc) fail('Claude exited before the task could be submitted.', 409);
      if (!ready()) fail('Claude started another turn or needs attention while the task was being checked. Nothing was sent; use the live terminal or wait until the turn ends.', 409);
      proc.write(`\x1b[200~${text.replace(/\r\n?/g, '\n')}\x1b[201~`);
      await pause(120);
      if (runtime.pty !== proc) fail('Claude exited before the task could be submitted.', 409);
      if (!ready()) fail('The task text was pasted into the terminal but not submitted, because Claude started another turn or needs attention. Review or clear it in the live terminal.', 409);
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
    if (worker.queued) {
      worker.queued = false;
      startQueue.splice(startQueue.indexOf(worker.id), 1);
      update(worker, 'offline', 'Removed from the start queue.');
      drainQueue();
      return workerView(worker);
    }
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

  /**
   * Whether a resolved directory inside the worktree belongs to a nested
   * repository (its canonical Git top level is not the worktree). Returns the
   * cached answer, or undefined while one bounded lookup runs in the
   * background, so hook handling never waits for Git; `onNested` runs if the
   * lookup finds one. A failed lookup keeps the containment-only result.
   */
  function nestedRepository(runtime, root, real, onNested) {
    const cached = runtime.topCache.get(real);
    if (cached && Date.now() - cached.at < CWD_CACHE_MS) return cached.nested;
    if (runtime.topCache.size > 64) runtime.topCache.clear();
    const entry = { nested: undefined, at: Date.now() };
    runtime.topCache.set(real, entry);
    git.line(real, ['rev-parse', '--path-format=absolute', '--show-toplevel'], { timeout: TOP_LEVEL_TIMEOUT_MS })
      .then(top => fs.realpathSync.native(top) !== root)
      .catch(() => false)
      .then(nested => {
        Object.assign(entry, { nested, at: Date.now() });
        if (nested && runtime.topCache.get(real) === entry) onNested();
      });
    return undefined;
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
    runtime.lastCwd = cwd;
    let warningChanged = false;
    const initialStart = type === 'SessionStart' && event.source !== 'compact' && (['startup', 'resume'].includes(event.source) || !runtime.started);
    if (initialStart) {
      if (cwd !== root) {
        stopForFatal(runtime, `Claude reported starting in ${cwd ?? 'an unresolved directory'}, not the recorded worktree ${root}. The engine stopped this terminal.`);
        fail('Hook working directory does not match the recorded worktree.', 409);
      }
    } else {
      // Ongoing events stay visible even outside the workspace so permission
      // requests and attention are never silently suppressed. A folder inside
      // the worktree whose Git top level is a nested repository also warns.
      const warning = nested => ({ cwd: typeof event.cwd === 'string' ? event.cwd.slice(0, 1024) : null, resolved: Boolean(cwd),
        ...(nested ? { nestedRepository: true } : {}), at: now() });
      const contained = Boolean(cwd) && inside(root, cwd);
      const nested = contained && cwd !== root && nestedRepository(runtime, root, cwd, () => {
        if (closing || runtimes.get(worker.id) !== runtime || !runtime.pty || runtime.lastCwd !== cwd || worker.outsideWorkspace) return;
        worker.outsideWorkspace = warning(true);
        worker.updatedAt = now();
        try { commit(); } catch (error) { callbackFailure(worker, error); }
      }) === true;
      const outside = !contained || nested;
      const previous = worker.outsideWorkspace;
      worker.outsideWorkspace = outside ? warning(nested) : null;
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
    startQueue.length = 0;
    for (const worker of state.workers) {
      if (worker.queued) worker.queued = false;
      if (runtimes.get(worker.id)?.pty) { try { await stopWorker(worker); } catch { /* Report through state; keep closing others. */ } }
      const runtime = runtimes.get(worker.id);
      clearTimeout(runtime?.startupTimer);
      await runtime?.terminalQueue;
      runtime?.term?.dispose();
    }
    clearInterval(expiryTimer);
    game?.close?.();
    // Clean shutdown empties the published list before releasing ownership.
    publisherClosed = true;
    try { publisher?.close(visitorProblem ? null : state.visitor?.penguinId ?? null); }
    catch (error) { onWarning(`Native igloo publication could not be cleared: ${error.message}`); }
  }

  // Withdraw reservations that expired without a purchase report, and drop them from publication.
  const expiryTimer = setInterval(() => {
    if (closing) return;
    const stale = state.adoptions.filter(item => item.state === 'reserved' && expired(item));
    if (!stale.length) return;
    for (const item of stale) Object.assign(item, { state: 'withdrawn', error: REFUSALS.expired, updatedAt: now() });
    try { commit(); } catch (error) { onWarning(`Could not record expired adoptions: ${error.message}`); }
  }, 30000);
  expiryTimer.unref?.();

  commit();
  return { registerProject, createWorker, retrySetup, retryWorker, settled, start, submit, input, resize, interrupt, stop, diff, snapshot, terminal, hook, close,
    ensureVisitor, verifyGameMappings, reserveAdoption, reportAdoption, cancelAdoption, reconcileAdoptions };
}
