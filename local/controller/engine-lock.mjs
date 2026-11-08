import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { groupAlive, pidAlive, processIdentity } from './procinfo.mjs';

/**
 * The engine keeps `runtime.lock` in its state directory and, by design, never removes
 * a stale one itself (local/engine/lock.mjs). After an engine crash the controller may
 * remove it, but only once ownership is established (plan: "establish process ownership
 * before recovering locks"):
 *   - the lock names the PID of an engine this controller launched (journal/engine.json);
 *   - that process is gone (or its PID now belongs to a process with another start time);
 *   - and its process group is empty. (Claude's terminals have sessions of their own; in the app each runs
 *     through `cp-supervise guard`, which stops it when the engine dies.)
 * Anything else keeps the lock and reports why; nothing is removed on a PID alone.
 */
export async function recoverEngineLock({ stateDir, journalFile, lockPath = path.join(stateDir, 'runtime.lock'), identity = processIdentity, alive = pidAlive, group = groupAlive }) {
  let lock;
  try { lock = JSON.parse(await readFile(lockPath, 'utf8')); }
  catch (failure) { return failure.code === 'ENOENT' ? { action: 'none' } : { action: 'keep', reason: 'The engine lock is unreadable.', lockPath }; }
  let journal;
  try { journal = JSON.parse(await readFile(journalFile, 'utf8')); }
  catch { return { action: 'keep', reason: 'No record shows this app started the engine that holds the lock.', lockPath }; }
  // The publication lock also names the state directory it belongs to.
  if (lock?.stateDir !== undefined && path.resolve(String(lock.stateDir)) !== path.resolve(stateDir)) return { action: 'keep', reason: `The lock at ${lockPath} belongs to another engine state directory (${lock.stateDir}).`, lockPath };
  if (!Number.isSafeInteger(lock?.pid) || lock.pid !== journal?.pid) return { action: 'keep', reason: `The engine lock names PID ${lock?.pid}, not the engine this app last started.`, lockPath };
  if (alive(lock.pid)) {
    const now = await identity(lock.pid);
    if (!now || !journal.startTime || now.startTime === journal.startTime) return { action: 'keep', reason: `The engine (PID ${lock.pid}) is still running.`, lockPath };
  }
  if (Number.isSafeInteger(journal.pgid) && journal.pgid > 1 && group(journal.pgid)) {
    return { action: 'keep', reason: `Processes from the old engine's group (${journal.pgid}) are still running.`, lockPath };
  }
  await rm(lockPath, { force: true });
  return { action: 'removed', lockPath, pid: lock.pid };
}

/**
 * Both locks a crashed engine can leave: its runtime lock and the native igloo
 * publication lock (local/engine/publication.mjs). Each follows recoverEngineLock's rules.
 */
export async function recoverEngineLocks({ stateDir, publicationDir, journalFile, ...deps }) {
  const results = [];
  for (const lockPath of [path.join(stateDir, 'runtime.lock'), path.join(publicationDir, 'owner.lock')]) {
    results.push(await recoverEngineLock({ stateDir, journalFile, lockPath, ...deps }));
  }
  const kept = results.find(result => result.action === 'keep');
  return kept ?? { action: results.some(r => r.action === 'removed') ? 'removed' : 'none', removed: results.filter(r => r.action === 'removed').map(r => r.lockPath), pid: results.find(r => r.pid)?.pid };
}
