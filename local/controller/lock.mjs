import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { processIdentity, samePath, pidAlive } from './procinfo.mjs';
import { writeJsonAtomic } from './owners.mjs';

export class ControllerError extends Error {
  constructor(code, message, detail) { super(message); this.code = code; this.detail = detail; }
}

/**
 * Takes the environment's single-controller lock. The lock is flock(2) on a descriptor this
 * process keeps open for its whole life; `cp-supervise lock 3` does the flock on the shared
 * open file description. Process death closes the descriptor and releases the lock.
 */
export async function acquireControllerLock({ lockPath, superviseBin }) {
  mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const fd = openSync(lockPath, 'a+', 0o600);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(superviseBin, ['lock', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd], env: {} });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', exitCode => resolve({ exitCode, stderr }));
  }).catch(failure => { closeSync(fd); throw new ControllerError('NO_SUPERVISOR', `Could not run ${superviseBin}: ${failure.message}`); });
  if (code.exitCode === 0) return { fd, release: () => { try { closeSync(fd); } catch { /* closed */ } } };
  closeSync(fd);
  if (code.exitCode === 75) throw new ControllerError('LOCKED', `Another controller already owns this environment (${lockPath}).`);
  throw new ControllerError('NO_SUPERVISOR', `The lock helper failed (exit ${code.exitCode}): ${code.stderr.trim()}`);
}

/** data/controller.json lets `./launch stop` find the controller. */
export async function writeControllerRecord(file, extra = {}) {
  const identity = await processIdentity(process.pid);
  await writeJsonAtomic(file, { pid: process.pid, startTime: identity?.startTime ?? null, executable: identity?.executable ?? process.execPath, argv: process.argv.slice(1), startedAt: new Date().toISOString(), ...extra });
}

export function removeControllerRecord(file) {
  try {
    const current = JSON.parse(readFileSync(file, 'utf8'));
    if (current.pid === process.pid) rmSync(file, { force: true });
  } catch { /* already gone */ }
}

export function readControllerRecord(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** The controller recorded in controller.json, if that exact process (PID, start time, executable) is still running. */
export async function runningController(file) {
  const record = readControllerRecord(file);
  if (!record || !Number.isInteger(record.pid) || !pidAlive(record.pid)) return null;
  const identity = await processIdentity(record.pid);
  if (!identity || identity.startTime !== record.startTime || !samePath(identity.executable, record.executable)) return null;
  return record;
}
