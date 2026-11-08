import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ControllerError } from './lock.mjs';
import { closeLog, DEFAULT_LOG_CAP_BYTES, openLog, rotateIfNeeded } from './logs.mjs';
import { updateRecord, removeRecord, writeJsonAtomic, writeRecord } from './owners.mjs';
import { processIdentity } from './procinfo.mjs';
import { waitHealthy } from './health.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const STOP_MARGIN_MS = 4000;

export function validateServices(services) {
  const names = new Set(services.map(s => s.name));
  if (names.size !== services.length) throw new ControllerError('BAD_SERVICES', 'Duplicate service names.');
  for (const svc of services) {
    for (const dep of svc.after ?? []) if (!names.has(dep)) throw new ControllerError('BAD_SERVICES', `${svc.name} waits for unknown service ${dep}.`);
    if (!svc.command?.[0] || !path.isAbsolute(svc.command[0])) throw new ControllerError('BAD_SERVICES', `${svc.name} needs an absolute program path.`);
    if (!svc.env || typeof svc.env !== 'object') throw new ControllerError('BAD_SERVICES', `${svc.name} needs an explicit environment.`);
  }
  const state = new Map();
  const visit = name => {
    if (state.get(name) === 2) return;
    if (state.get(name) === 1) throw new ControllerError('BAD_SERVICES', `Dependency cycle at ${name}.`);
    state.set(name, 1);
    for (const dep of services.find(s => s.name === name).after ?? []) visit(dep);
    state.set(name, 2);
  };
  services.forEach(s => visit(s.name));
}

/**
 * Starts services in dependency order through cp-supervise, health-checks them, and stops them in
 * reverse order. There is no restart policy: a service that exits is reported once through
 * `onFailure` and stays down until the user stops and starts again.
 */
export class Orchestrator {
  constructor({ superviseBin, ownersDir, journalDir = null, ownerPid = process.pid, emit = () => {}, onFailure = () => {}, logCapBytes = DEFAULT_LOG_CAP_BYTES, log = () => {}, spawnImpl = spawn }) {
    Object.assign(this, { superviseBin, ownersDir, journalDir, ownerPid, emit, onFailure, logCapBytes, log, spawnImpl });
    this.running = new Map();
    this.rotator = null;
  }

  names() { return [...this.running.keys()]; }
  snapshot() { return [...this.running.values()].map(r => ({ name: r.def.name, state: r.state, pid: r.programPid ?? null, port: r.def.port ?? null })); }
  get(name) { return this.running.get(name); }

  async start(services, { signal, healthTimeoutMs = 60000 } = {}) {
    validateServices(services);
    const ready = new Map();
    for (const def of services) {
      ready.set(def.name, (async () => {
        await Promise.all((def.after ?? []).map(dep => ready.get(dep)));
        if (signal?.aborted) throw new ControllerError('CANCELLED', 'Start cancelled.');
        await this.#startOne(def, { signal, healthTimeoutMs });
      })());
      ready.get(def.name).catch(() => {});
    }
    const results = await Promise.allSettled([...ready.values()]);
    const failure = results.find(r => r.status === 'rejected');
    if (failure) {
      await this.stopAll();
      throw failure.reason;
    }
    this.#startRotator(services);
  }

  #startRotator() {
    clearInterval(this.rotator);
    this.rotator = setInterval(() => { for (const r of this.running.values()) rotateIfNeeded(r.logFile, this.logCapBytes); }, 5000);
    this.rotator.unref();
  }

  async #startOne(def, { signal, healthTimeoutMs }) {
    const entry = { def, state: 'starting', child: null, programPid: null, pgid: null, stopping: false, exited: null, logFile: null };
    this.running.set(def.name, entry);
    this.emit({ event: 'service', name: def.name, state: 'starting' });
    const { file, fd } = openLog(def.logDir, def.name);
    entry.logFile = file;
    const stop = def.stop ?? { signal: 'SIGTERM', graceMs: 5000 };
    entry.stop = stop;
    const record = { name: def.name, pid: null, pgid: null, startTime: null, executable: def.command[0], argv: def.command, controllerPid: this.ownerPid, createdAt: new Date().toISOString(), stopSignal: stop.signal, graceMs: stop.graceMs, shimPid: null };
    mkdirSync(this.ownersDir, { recursive: true, mode: 0o700 });
    await removeRecord(this.ownersDir, def.name);
    await writeRecord(this.ownersDir, record); // before the process exists
    const recordFile = path.join(this.ownersDir, `${def.name}.json`);
    const args = ['--owner-pid', String(this.ownerPid), '--record', recordFile, '--stop-signal', stop.signal, '--grace-ms', String(stop.graceMs), ...(def.cwd ? ['--cwd', def.cwd] : []), '--', ...def.command];
    let child;
    try {
      child = this.spawnImpl(this.superviseBin, args, { env: def.env, stdio: ['ignore', fd, fd], detached: true });
    } finally { closeLog(fd); }
    entry.child = child;
    entry.exitPromise = new Promise(resolve => {
      child.once('error', failure => { entry.spawnError = failure; });
      child.once('exit', (code, sig) => {
        entry.exited = { code, signal: sig };
        const wasHealthy = entry.state === 'healthy';
        entry.state = 'exited';
        // A shim that exited normally has confirmed its group is gone. A shim killed by a signal may have left
        // its program running, so its record stays for the next controller to evaluate.
        // Awaited before the exit resolves, so a controller shutting down never leaves a stale record behind.
        const removed = code !== null ? removeRecord(this.ownersDir, def.name).catch(() => {}) : Promise.resolve();
        this.emit({ event: 'service', name: def.name, state: 'exited', pid: entry.programPid ?? undefined, code: code ?? (sig ? 128 : null) });
        if (!entry.stopping && wasHealthy) {
          this.onFailure(def.name, { code, signal: sig, reason: 'exited' });
        }
        removed.then(resolve);
      });
    });
    entry.exitPromise.catch(() => {});
    if (!child.pid) { await entry.exitPromise.catch(() => {}); throw new ControllerError('SERVICE_FAILED', `Could not start ${def.name}: ${entry.spawnError?.message ?? 'spawn failed'}`, { name: def.name }); }
    const shimIdentity = await processIdentity(child.pid);
    await updateRecord(this.ownersDir, def.name, { shimPid: child.pid, shimStartTime: shimIdentity?.startTime ?? null }).catch(() => {});

    // The shim reports the program's PID in <record>.child as soon as it forks.
    const sidecar = await this.#waitSidecar(recordFile, entry);
    if (!sidecar) throw new ControllerError('SERVICE_FAILED', `${def.name} did not start (exit ${entry.exited?.code ?? 'unknown'}). See ${file}.`, { name: def.name, code: entry.exited?.code ?? null, log: file });
    entry.programPid = sidecar.pid;
    entry.pgid = sidecar.pgid;
    const identity = await processIdentity(sidecar.pid);
    await updateRecord(this.ownersDir, def.name, { pid: sidecar.pid, pgid: sidecar.pgid, startTime: identity?.startTime ?? null, executable: identity?.executable ?? def.command[0] }).catch(() => {});
    if (this.journalDir) await writeJsonAtomic(path.join(this.journalDir, `${def.name}.json`), { pid: sidecar.pid, pgid: sidecar.pgid, startTime: identity?.startTime ?? null, executable: identity?.executable ?? def.command[0], at: new Date().toISOString() }).catch(() => {});

    const health = await waitHealthy(def.health, { timeoutMs: healthTimeoutMs, signal, alive: () => entry.state !== 'exited' });
    if (!health.ok) {
      const why = health.reason === 'exited' ? `${def.name} exited during startup (code ${entry.exited?.code ?? 'unknown'}).` : `${def.name} was not healthy within ${Math.round((def.health.timeoutMs ?? healthTimeoutMs) / 1000)} s.`;
      throw new ControllerError('SERVICE_FAILED', `${why} See ${file}.`, { name: def.name, reason: health.reason === 'exited' ? 'exited' : 'health-timeout', log: file });
    }
    if (def.ready) {
      try { await def.ready(); }
      catch (failure) { throw new ControllerError('SERVICE_FAILED', `${def.name} started but its setup step failed: ${failure.message}`, { name: def.name, reason: 'ready-hook' }); }
    }
    if (entry.state === 'exited') throw new ControllerError('SERVICE_FAILED', `${def.name} exited during startup.`, { name: def.name, reason: 'exited' });
    entry.state = 'healthy';
    this.emit({ event: 'service', name: def.name, state: 'healthy', pid: entry.programPid });
  }

  async #waitSidecar(recordFile, entry) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const value = JSON.parse(await readFile(`${recordFile}.child`, 'utf8'));
        if (Number.isInteger(value.pid)) return value;
      } catch { /* not yet */ }
      if (entry.exited) return null;
      await sleep(15);
    }
    return null;
  }

  async #stopOne(entry) {
    const { def } = entry;
    if (entry.state === 'exited') return true;
    entry.stopping = true;
    entry.state = 'stopping';
    this.emit({ event: 'service', name: def.name, state: 'stopping', pid: entry.programPid ?? undefined });
    const shim = entry.child.pid;
    try { process.kill(shim, 'SIGUSR1'); } catch { /* shim already gone */ }
    const bound = (entry.stop.graceMs ?? 5000) + STOP_MARGIN_MS;
    const exited = await Promise.race([entry.exitPromise.then(() => true), sleep(bound).then(() => false)]);
    if (exited) return true;
    // The shim did not finish in time: take the group down ourselves.
    this.log(`${def.name}: shim did not exit within ${bound} ms; killing its process group`);
    if (entry.pgid) try { process.kill(-entry.pgid, 'SIGKILL'); } catch { /* gone */ }
    try { process.kill(shim, 'SIGKILL'); } catch { /* gone */ }
    return Promise.race([entry.exitPromise.then(() => true), sleep(4000).then(() => false)]);
  }

  /** Reverse dependency order, bounded per step; services in the same step stop concurrently. Returns names that did not stop. */
  async stopAll() {
    clearInterval(this.rotator);
    const failed = [];
    while (this.running.size) {
      const remaining = [...this.running.values()];
      const needed = new Set(remaining.flatMap(r => r.def.after ?? []));
      let batch = remaining.filter(r => !needed.has(r.def.name));
      if (!batch.length) batch = remaining; // cannot happen for a validated graph
      await Promise.all(batch.map(async entry => {
        const ok = await this.#stopOne(entry);
        if (ok) this.running.delete(entry.def.name);
        else { failed.push(entry.def.name); this.running.delete(entry.def.name); }
      }));
    }
    return failed;
  }
}
