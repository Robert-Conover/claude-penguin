import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultProjectName, projectNameProblem, shellQuote } from './workspace.mjs';

export const STATE_VERSION = 3;
export const LEGACY_STATE_VERSION = 1;
export const V2_STATE_VERSION = 2;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMIT = /^[a-f0-9]{40,64}$/;

export const emptyState = () => ({ version: STATE_VERSION, revision: 0, visitor: null, projects: [], workers: [], adoptions: [] });

function refuse(message, code) { return Object.assign(new Error(message), { code }); }

/** State is private host data. Never recover a corrupt identity by silently replacing it. */
export function readState(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, 'state.json');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return emptyState(); throw error; }
  let state;
  try { state = JSON.parse(raw); } catch { throw refuse('Agent state is invalid JSON; preserve it and repair it before restarting.', 'STATE_INVALID'); }
  if (state?.version === LEGACY_STATE_VERSION || state?.version === V2_STATE_VERSION) {
    const format = state.version === LEGACY_STATE_VERSION ? 'the single-project format (version 1)' : 'the one-puffle-per-project format (version 2)';
    throw refuse(`Agent state in ${stateDir} uses ${format}. Stop the old engine and its Claude processes, then migrate it explicitly with \`node local/engine/migrate.mjs --state-dir ${shellQuote(stateDir)}\`; the engine does not migrate saved sessions implicitly.`, state.version === LEGACY_STATE_VERSION ? 'STATE_V1' : 'STATE_V2');
  }
  if (state?.version !== STATE_VERSION || !Array.isArray(state.projects) || !Array.isArray(state.workers) || !Array.isArray(state.adoptions)) throw refuse('Unsupported agent state; refusing to replace saved sessions.', 'STATE_UNSUPPORTED');
  state.revision ??= 0;
  state.visitor ??= null;
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) throw refuse('Saved agent revision is invalid.', 'STATE_INVALID');
  return state;
}

export function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function writeState(stateDir, state) {
  writePrivateJson(path.join(stateDir, 'state.json'), state);
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

/**
 * Convert one v1 project/worker into v2. The old direct-checkout worker is
 * archived with its identities, history, path, and baseline; its game mapping
 * is preserved as a ready legacy-fixture mapping. Nothing is relocated.
 */
export function convertV1(v1, { at = new Date().toISOString(), sourceExists = file => fs.existsSync(file) } = {}) {
  if (v1?.version !== LEGACY_STATE_VERSION || !Array.isArray(v1.projects) || !Array.isArray(v1.workers) || v1.projects.length > 1 || v1.workers.length > 1) {
    throw refuse('Only a version 1 state with at most one project and one worker can be migrated.', 'STATE_UNSUPPORTED');
  }
  const projects = v1.projects.map(old => {
    if (!UUID.test(old.id) || typeof old.path !== 'string' || !path.isAbsolute(old.path)) throw refuse('The saved v1 project identity is invalid; it was not migrated.', 'STATE_INVALID');
    const game = ['ownerId', 'iglooId', 'roomId', 'puffleId'].every(key => Number.isSafeInteger(old[key]) && old[key] > 0)
      ? { source: 'legacy-fixture', status: 'ready', fixtureId: old.fixtureId ?? null, ownerId: old.ownerId, iglooId: old.iglooId, roomId: old.roomId, puffleId: old.puffleId,
        puffleName: v1.workers.find(worker => worker.projectId === old.id)?.name ?? null, verifiedAt: null }
      : null;
    const name = typeof old.name === 'string' && !projectNameProblem(old.name) ? old.name : defaultProjectName(old.name ?? path.basename(old.path));
    return {
      id: old.id, name, sourcePath: old.path, commonDir: null, createdAt: old.createdAt ?? at,
      sourceAvailable: sourceExists(old.path), legacy: { migratedAt: at, fromVersion: 1, ...(name !== old.name ? { originalName: old.name } : {}) },
      setup: { phase: game ? 'needs-worker' : 'registered', step: null, error: null, updatedAt: at },
      game, activeWorkerId: null,
    };
  });
  const workers = v1.workers.map(old => {
    if (!UUID.test(old.id) || !UUID.test(old.sessionId) || !projects.some(project => project.id === old.projectId) || !COMMIT.test(old.baseCommit ?? '')) {
      throw refuse('The saved v1 worker identity is invalid; it was not migrated.', 'STATE_INVALID');
    }
    if (pidAlive(old.pid)) throw refuse(`The v1 worker process (PID ${old.pid}) may still be running. Stop it before migrating.`, 'STATE_BUSY');
    const project = projects.find(item => item.id === old.projectId);
    const tasks = (Array.isArray(old.taskHistory) ? old.taskHistory : []).map(task => task.endedAt ? task : { ...task, status: 'interrupted', endedAt: at });
    return {
      id: old.id, projectId: old.projectId, name: old.name, sessionId: old.sessionId, established: Boolean(old.established),
      status: 'archived', activity: 'Archived from the direct-checkout milestone. This conversation stays in its original folder.',
      cols: old.cols ?? 120, rows: old.rows ?? 32, createdAt: old.createdAt ?? at, updatedAt: at, pid: null, taskHistory: tasks,
      lastError: old.lastError, exitCode: old.exitCode,
      workspace: { kind: 'direct-checkout', path: project.sourcePath, baseCommit: old.baseCommit, sourceDirtyAtCreation: Boolean(old.dirtyAtStart) },
      archived: { at, reason: 'Migrated from the direct-checkout milestone. Execution is disabled; create an isolated replacement to continue in a worktree.' },
    };
  });
  return { version: V2_STATE_VERSION, revision: (Number.isSafeInteger(v1.revision) ? v1.revision : 0) + 1, visitor: null, projects, workers };
}

/**
 * Convert a v2 state (at most one active puffle per project) into v3 (up to
 * ten adopted puffles per project). The project's single blue puffle becomes
 * its active worker's `puffle` binding; `activeWorkerId` is removed. Project
 * setup now covers only the destination (owner and igloo); each worker keeps
 * its own worktree setup. Archived workers and legacy-fixture mappings are
 * preserved as they are. Identities, sessions, worktrees, branches and task
 * history are copied unchanged.
 */
export function convertV2(v2, { at = new Date().toISOString() } = {}) {
  if (v2?.version !== V2_STATE_VERSION || !Array.isArray(v2.projects) || !Array.isArray(v2.workers)) {
    throw refuse('Only a version 2 state can be migrated to version 3.', 'STATE_UNSUPPORTED');
  }
  const bindings = new Map();
  const projects = v2.projects.map(old => {
    if (!UUID.test(old?.id ?? '')) throw refuse('A saved v2 project identity is invalid; it was not migrated.', 'STATE_INVALID');
    const { activeWorkerId, ...project } = structuredClone(old);
    const game = project.game;
    if (game && game.source !== 'legacy-fixture') {
      // The managed puffle moves to its worker; the destination keeps only owner and igloo.
      if (activeWorkerId && Number.isSafeInteger(game.puffleId) && game.puffleId > 0) {
        bindings.set(activeWorkerId, { puffleId: game.puffleId, typeId: 0, subtypeId: 0, name: game.puffleName ?? null, adoptionId: null });
      }
      project.game = Object.fromEntries(['source', 'status', 'ownerId', 'iglooId', 'roomId', 'verifiedAt'].map(key => [key, game[key] ?? null]));
    } else if (game && activeWorkerId) {
      bindings.set(activeWorkerId, { puffleId: game.puffleId, typeId: 0, subtypeId: 0, name: game.puffleName ?? null, adoptionId: null });
    }
    const phase = project.setup?.phase;
    const gameReady = project.game?.status === 'ready';
    const setupPhase = phase === 'needs-worker' ? 'needs-worker' : gameReady ? 'ready' : phase === 'game-pending' ? 'game-pending'
      : project.game ? 'failed' : phase === 'failed' ? 'failed' : 'registered';
    project.setup = { ...project.setup, phase: setupPhase, step: null, correction: null, updatedAt: at,
      ...(setupPhase === 'failed' && !project.setup?.error ? { error: 'Setup did not finish before migration. Retry to reconcile it.', retryable: true } : {}),
      ...(setupPhase === 'ready' ? { error: null, retryable: false } : {}) };
    return project;
  });
  const workers = v2.workers.map(old => {
    const worker = structuredClone(old);
    if (worker.archived) return { ...worker, puffle: worker.puffle ?? null };
    const ready = worker.workspace?.state === 'ready';
    const binding = bindings.get(worker.id) ?? null;
    if (binding && binding.name === null) binding.name = worker.name;
    return { ...worker, puffle: binding, queued: false,
      setup: { phase: ready ? 'ready' : 'failed', step: null, updatedAt: at,
        error: ready ? null : 'Worktree setup did not finish before migration. Retry to reconcile the reserved worktree.', retryable: !ready } };
  });
  return { version: STATE_VERSION, revision: (Number.isSafeInteger(v2.revision) ? v2.revision : 0) + 1,
    visitor: v2.visitor ?? null, projects, workers, adoptions: [] };
}

function backupOnce(stateDir, original, fromVersion, at) {
  const backup = path.join(stateDir, `state.v${fromVersion}-backup-${at.replace(/[:.]/g, '-')}.json`);
  const fd = fs.openSync(backup, 'wx', 0o600);
  try { fs.writeFileSync(fd, original); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (!fs.readFileSync(backup).equals(original)) throw refuse(`The v${fromVersion} backup could not be verified; state.json was left unchanged.`, 'STATE_BACKUP');
  return backup;
}

/**
 * Migrate a stopped state directory in place, one version at a time
 * (v1 -> v2 -> v3). The caller must already own the runtime lock. Before each
 * step the exact current bytes are preserved in a 0600 backup that is never
 * overwritten, then state.json is replaced atomically.
 */
export function migrateStateDir(stateDir, { at = new Date().toISOString(), sourceExists } = {}) {
  const file = path.join(stateDir, 'state.json');
  const backups = [];
  for (;;) {
    const original = fs.readFileSync(file);
    let state;
    try { state = JSON.parse(original.toString('utf8')); } catch { throw refuse('Agent state is invalid JSON; it was not migrated.', 'STATE_INVALID'); }
    if (state?.version === STATE_VERSION) return { migrated: backups.length > 0, backup: backups[0] ?? null, backups, state };
    if (state?.version === LEGACY_STATE_VERSION) {
      const next = convertV1(state, { at, sourceExists });
      backups.push(backupOnce(stateDir, original, 1, at));
      writeState(stateDir, next);
    } else if (state?.version === V2_STATE_VERSION) {
      for (const worker of state.workers ?? []) {
        if (pidAlive(worker?.pid)) throw refuse(`A saved worker process (PID ${worker.pid}) may still be running. Stop it before migrating.`, 'STATE_BUSY');
      }
      const next = convertV2(state, { at });
      backups.push(backupOnce(stateDir, original, 2, at));
      writeState(stateDir, next);
    } else throw refuse('Unsupported agent state; it was not migrated.', 'STATE_UNSUPPORTED');
  }
}
