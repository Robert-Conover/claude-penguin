// Native igloo publication: the world container's visitor-only adapter reads
// <dir>/published.json (mounted read-only as a directory). It contains only the
// visitor's game ID and verified owner/igloo IDs for ready mappings.
//
// One engine owns publication across all state directories. Ownership is an
// exclusive owner.lock in the publication directory. A stale lock fails closed
// and, like runtime.lock, is removed only explicitly after confirming the old
// engine stopped. After an unclean exit the last verified list stays in place
// until recovery and the next startup replace it; it does not mean agents run.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

export const PUBLICATION_FILE = 'published.json';
export const OWNER_LOCK = 'owner.lock';

function refuse(message) { return Object.assign(new Error(message), { statusCode: 409, code: 'PUBLICATION_OWNED' }); }
const positive = value => Number.isSafeInteger(value) && value > 0;

/** The publication payload for the owning engine's state. Only ready mappings are listed. */
export function publicationFor(state) {
  const visitorId = positive(state.visitor?.penguinId) ? state.visitor.penguinId : null;
  if (visitorId === null) return { version: 1, visitorId: null, igloos: [] };
  const seen = new Set([visitorId]);
  const igloos = [];
  for (const project of state.projects) {
    const game = project.game;
    if (game?.status !== 'ready' || !positive(game.ownerId) || !positive(game.iglooId) || seen.has(game.ownerId)) continue;
    seen.add(game.ownerId);
    igloos.push({ ownerId: game.ownerId, iglooId: game.iglooId });
  }
  return { version: 1, visitorId, igloos };
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

function writeAtomic(file, value, mode) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', mode);
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/**
 * Acquire publication ownership for one engine. Refuses while another engine
 * (any state directory) holds it, and refuses a stale owner lock rather than
 * deleting it.
 */
export function acquirePublication({ dir, stateDir, pid = process.pid }) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('An absolute native igloo publication directory is required.');
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const lockPath = path.join(dir, OWNER_LOCK);
  const file = path.join(dir, PUBLICATION_FILE);
  const nonce = randomBytes(16).toString('hex');
  try {
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ pid, nonce, stateDir, acquiredAt: new Date().toISOString() })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  } catch (failure) {
    if (failure.code !== 'EEXIST') throw failure;
    let previous;
    try { previous = JSON.parse(fs.readFileSync(lockPath, 'utf8')); }
    catch { throw refuse(`The native igloo publication lock is unreadable: ${lockPath}. Inspect it before removing it.`); }
    if (pidAlive(previous?.pid)) {
      throw refuse(`Another engine (PID ${previous.pid}, state ${previous.stateDir ?? 'unknown'}) owns native igloo publication in ${dir}. Stop it before starting this engine; publication is never shared or overwritten.`);
    }
    throw refuse(`A stale native igloo publication lock remains at ${lockPath} (state ${previous?.stateDir ?? 'unknown'}). Confirm that engine has stopped, then remove this lock explicitly before restarting. Its last published list may remain visible until then; that does not mean its agents are running.`);
  }
  let last = null;
  let released = false;
  const owned = () => {
    try { return JSON.parse(fs.readFileSync(lockPath, 'utf8')).nonce === nonce; } catch { return false; }
  };
  function write(payload) {
    if (released) throw new Error('Native igloo publication was released.');
    const text = JSON.stringify(payload);
    if (text === last) return false;
    if (!owned()) throw refuse(`This engine no longer owns ${lockPath}; it will not overwrite another engine's publication.`);
    // Readable by the world container through a read-only directory mount; it holds only game IDs.
    writeAtomic(file, payload, 0o644);
    last = text;
    return true;
  }
  return {
    dir, file, lockPath,
    update: payload => write(payload),
    /** Clean shutdown: publish an empty list, then release ownership. */
    close(visitorId = null) {
      if (released) return;
      try { if (owned()) write({ version: 1, visitorId: positive(visitorId) ? visitorId : null, igloos: [] }); }
      finally {
        released = true;
        if (owned()) fs.rmSync(lockPath);
      }
    },
  };
}
