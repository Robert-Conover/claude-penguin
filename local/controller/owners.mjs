import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { groupAlive, pidAlive, processIdentity, samePath, startSeconds } from './procinfo.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const recordPath = (dir, name) => path.join(dir, `${name}.json`);

export async function writeJsonAtomic(file, value, mode = 0o600) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(tmp, file);
}

export async function writeRecord(dir, record) { await writeJsonAtomic(recordPath(dir, record.name), record); }
export async function updateRecord(dir, name, patch) {
  const current = JSON.parse(await readFile(recordPath(dir, name), 'utf8'));
  const next = { ...current, ...patch };
  await writeJsonAtomic(recordPath(dir, name), next);
  return next;
}
export async function removeRecord(dir, name) {
  await rm(recordPath(dir, name), { force: true });
  await rm(`${recordPath(dir, name)}.child`, { force: true });
}

async function readSidecar(file) {
  try {
    const value = JSON.parse(await readFile(`${file}.child`, 'utf8'));
    return Number.isInteger(value.pid) && value.pid > 1 ? value : null;
  } catch { return null; }
}

export async function listRecords(dir) {
  let names;
  try { names = await readdir(dir); } catch (failure) { if (failure.code === 'ENOENT') return []; throw failure; }
  const out = [];
  for (const file of names.filter(n => n.endsWith('.json')).sort()) {
    const full = path.join(dir, file);
    const name = file.slice(0, -5);
    try { out.push({ name, file: full, record: JSON.parse(await readFile(full, 'utf8')), sidecar: await readSidecar(full) }); }
    catch { out.push({ name, file: full, record: null, sidecar: null, unreadable: true }); }
  }
  return out;
}

/**
 * Decide what a record refers to. Kinds:
 *   dead       nothing of ours is running (record can be dropped)
 *   survivor   PID, start time and executable all match: ours, safe to stop
 *   foreign    the PID is live but is a different process (PID reuse): not ours, leave it alone
 *   ambiguous  cannot tell (unreadable record, leader gone but group alive, ps failed): needs the user
 */
export async function classifyRecord(entry, { identity = processIdentity } = {}) {
  const { name, record, sidecar } = entry;
  if (!record || typeof record !== 'object') return { name, kind: 'ambiguous', reason: 'The ownership record is unreadable.', entry };
  const pid = Number.isInteger(record.pid) && record.pid > 1 ? record.pid : sidecar?.pid ?? null;
  const pgid = Number.isInteger(record.pgid) && record.pgid > 1 ? record.pgid : sidecar?.pgid ?? pid;
  const viaSidecar = !(Number.isInteger(record.pid) && record.pid > 1);
  const base = { name, pid, pgid, entry };
  if (!pid) {
    // Spawned (or about to be) but the program PID was never recorded.
    if (Number.isInteger(record.shimPid) && pidAlive(record.shimPid)) {
      const id = await identity(record.shimPid);
      if (id && record.shimStartTime && id.startTime === record.shimStartTime) return { ...base, kind: 'ambiguous', reason: 'The supervisor is still running but never reported its program.' };
    }
    return { ...base, kind: 'dead' };
  }
  if (!pidAlive(pid)) {
    if (pgid && groupAlive(pgid)) return { ...base, kind: 'ambiguous', reason: `The program (PID ${pid}) has exited but its process group ${pgid} still has members.` };
    return { ...base, kind: 'dead' };
  }
  const id = await identity(pid);
  if (!id) return { ...base, kind: 'ambiguous', reason: `PID ${pid} is running but its identity could not be read.` };
  const timeMatches = viaSidecar
    ? sidecar.startSec && startSeconds(id.startTime) !== null && Math.abs(startSeconds(id.startTime) - sidecar.startSec) <= 1
    : record.startTime === id.startTime;
  if (timeMatches && samePath(record.executable, id.executable)) return { ...base, kind: 'survivor', identity: id };
  return { ...base, kind: 'foreign', identity: id, reason: `PID ${pid} is now ${id.executable}, started ${id.startTime}; the record was for ${record.executable}.` };
}

function signalNumber(name) { return { SIGTERM: 'SIGTERM', SIGINT: 'SIGINT', SIGQUIT: 'SIGQUIT', SIGHUP: 'SIGHUP' }[name] ?? 'SIGTERM'; }

async function waitGone(pid, pgid, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!pidAlive(pid) && !groupAlive(pgid)) return true;
    await sleep(40);
  }
  return !pidAlive(pid) && !groupAlive(pgid);
}

/** Stop a process group: stop signal to the group, bounded wait, SIGKILL, confirm. Returns true when gone. */
export async function stopGroup({ pid, pgid, stopSignal = 'SIGTERM', graceMs = 5000 }) {
  const group = pgid && pgid > 1 ? pgid : pid;
  try { process.kill(-group, signalNumber(stopSignal)); } catch { try { process.kill(pid, signalNumber(stopSignal)); } catch { /* already gone */ } }
  if (await waitGone(pid, group, Math.min(graceMs, 30000))) return true;
  try { process.kill(-group, 'SIGKILL'); } catch { /* gone */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  return waitGone(pid, group, 5000);
}

/**
 * Examine every ownership record. Survivors are stopped; dead and foreign records are dropped.
 * Returns { stopped: [...], foreign: [...], ambiguous: [...], failed: [...] }.
 */
export async function recoverOwners(dir, { identity, onProblem = () => {}, stop = stopGroup } = {}) {
  const result = { stopped: [], foreign: [], ambiguous: [], failed: [], dropped: [] };
  for (const entry of await listRecords(dir)) {
    const verdict = await classifyRecord(entry, { identity });
    const detail = { name: verdict.name, pid: verdict.pid, pgid: verdict.pgid };
    if (verdict.kind === 'dead') { await removeRecord(dir, entry.name); result.dropped.push(verdict.name); continue; }
    if (verdict.kind === 'foreign') {
      await removeRecord(dir, entry.name);
      result.foreign.push(verdict);
      onProblem({ code: 'SURVIVOR', message: `Left alone: ${verdict.reason} It is not a ${entry.name} this app started.`, detail: { ...detail, outcome: 'not-ours' } });
      continue;
    }
    if (verdict.kind === 'ambiguous') { result.ambiguous.push(verdict); continue; }
    // Re-verify immediately before signalling so a PID that was recycled meanwhile is never hit.
    const again = await classifyRecord(entry, { identity });
    if (again.kind !== 'survivor') { result.ambiguous.push({ ...again, kind: 'ambiguous', reason: again.reason ?? 'The process changed while it was being checked.' }); continue; }
    onProblem({ code: 'SURVIVOR', message: `A ${entry.name} process (PID ${verdict.pid}) from an earlier run was still running; stopping it.`, detail: { ...detail, outcome: 'stopping' } });
    const gone = await stop({ pid: verdict.pid, pgid: verdict.pgid, stopSignal: entry.record.stopSignal, graceMs: entry.record.graceMs });
    if (gone) { await removeRecord(dir, entry.name); result.stopped.push(verdict.name); }
    else { result.failed.push(verdict); }
  }
  return result;
}

/** User-confirmed handling of ambiguous records. */
export async function resolveAmbiguous(dir, action, { stop = stopGroup, identity } = {}) {
  const outcome = { stopped: [], ignored: [], failed: [] };
  for (const entry of await listRecords(dir)) {
    const verdict = await classifyRecord(entry, { identity });
    if (verdict.kind === 'dead' || verdict.kind === 'foreign') { await removeRecord(dir, entry.name); continue; }
    if (action === 'stop-survivors' && verdict.pgid && (pidAlive(verdict.pid) || groupAlive(verdict.pgid))) {
      const gone = await stop({ pid: verdict.pid, pgid: verdict.pgid, stopSignal: entry.record?.stopSignal, graceMs: entry.record?.graceMs });
      if (gone) { await removeRecord(dir, entry.name); outcome.stopped.push(verdict.name); } else outcome.failed.push(verdict.name);
    } else {
      await removeRecord(dir, entry.name);
      outcome.ignored.push(verdict.name);
    }
  }
  return outcome;
}
