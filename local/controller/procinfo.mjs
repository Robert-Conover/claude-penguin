import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';

function ps(args) {
  return new Promise(resolve => {
    execFile('/bin/ps', args, { timeout: 5000, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } }, (failure, stdout) => resolve(failure ? null : stdout.replace(/\n$/, '')));
  });
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (failure) { return failure.code === 'EPERM'; }
}

export function groupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try { process.kill(-pgid, 0); return true; } catch (failure) { return failure.code === 'EPERM'; }
}

/** `ps -o lstart=` string (second precision), or null when the process does not exist. */
export async function processStartTime(pid) {
  const out = await ps(['-o', 'lstart=', '-p', String(pid)]);
  return out?.trim() || null;
}

let pidPathHelper = null;
/** Use `cp-supervise pidpath` (proc_pidpath) for executables; set once the shim is known. */
export function usePidPathHelper(file) { pidPathHelper = file || null; }

function pidPath(pid) {
  return new Promise(resolve => {
    execFile(pidPathHelper, ['pidpath', String(pid)], { timeout: 5000, env: {} }, (failure, stdout) => resolve(failure ? null : stdout.trim() || null));
  });
}

/**
 * The executable's path, or null. With the shim available this is the kernel's record
 * (proc_pidpath); `ps -o comm=` reads argv, which some programs (Valkey) rewrite.
 */
export async function processExecutable(pid) {
  if (pidPathHelper) {
    const exact = await pidPath(pid);
    if (exact) return exact;
  }
  const out = await ps(['-o', 'comm=', '-p', String(pid)]);
  return out?.trim() || null;
}

export async function processIdentity(pid) {
  const [startTime, executable] = await Promise.all([processStartTime(pid), processExecutable(pid)]);
  return startTime && executable ? { startTime, executable } : null;
}

export function samePath(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

export function startSeconds(lstart) {
  const ms = Date.parse(lstart);
  return Number.isNaN(ms) ? null : Math.round(ms / 1000);
}
