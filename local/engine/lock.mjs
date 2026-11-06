import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { readFile, mkdir, open, rm } from 'node:fs/promises';

function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

/** One runtime owner per state directory. A stale lock fails closed and is removed only explicitly. */
export async function acquireLock(stateDir) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(stateDir, 'runtime.lock');
  const nonce = randomBytes(16).toString('hex');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(lockPath, 'wx', 0o600);
      await file.writeFile(JSON.stringify({ pid: process.pid, nonce }));
      await file.close();
      return async () => {
        const current = JSON.parse(await readFile(lockPath, 'utf8'));
        if (current.nonce === nonce) await rm(lockPath);
      };
    } catch (failure) {
      if (failure.code !== 'EEXIST') throw failure;
      let previous;
      try { previous = JSON.parse(await readFile(lockPath, 'utf8')); }
      catch { throw error(`Engine lock is unreadable: ${lockPath}. Inspect the previous runtime before removing it.`); }
      if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw error('Invalid engine lock; inspect it before restarting.');
      try { process.kill(previous.pid, 0); throw error(`An engine may already be running (PID ${previous.pid}).`); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      throw error(`A stale engine lock remains at ${lockPath}. Confirm the old runtime and its Claude processes have stopped, then remove this lock explicitly before restarting.`);
    }
  }
  throw error('Could not acquire the engine lock.');
}
