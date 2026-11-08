import path from 'node:path';
import { access, constants, mkdir } from 'node:fs/promises';
import { SERVICE_PORT_KEYS, serviceTable, urlsFor, MODES } from './config.mjs';
import { engineService } from './engine-service.mjs';
import { recoverEngineLocks } from './engine-lock.mjs';
import { httpJson } from './health.mjs';
import { acquireControllerLock, ControllerError, removeControllerRecord, writeControllerRecord } from './lock.mjs';
import { Orchestrator } from './orchestrator.mjs';
import { recoverOwners, resolveAmbiguous } from './owners.mjs';
import { findPortConflicts, freeBytes as diskFree } from './preflight.mjs';
import { effectiveConfig, estimateSteps, loadRelease, loadSetupState, runSetup, stepStatus } from './setup.mjs';

const isExec = async file => { try { await access(file, constants.X_OK); return true; } catch { return false; } };
const mb = bytes => Math.round(bytes / 1048576);
const describeVerdict = v => ({ name: v.name, pid: v.pid ?? null, pgid: v.pgid ?? null, reason: v.reason ?? 'The process did not stop.' });

export class Controller {
  constructor({ config, deps, emit = () => {}, log = () => {}, lockImpl = acquireControllerLock, orchestratorFactory = options => new Orchestrator(options), recoverImpl = recoverOwners, resolveImpl = resolveAmbiguous, portInUse, healthTimeoutMs = 60000, logCapBytes }) {
    Object.assign(this, { config, deps, rawEmit: emit, log, lockImpl, orchestratorFactory, recoverImpl, resolveImpl, portInUse, healthTimeoutMs, logCapBytes });
    this.state = 'needs-setup';
    this.mode = null;          // highest mode set up
    this.runningMode = null;   // mode of the running (or starting) services
    this.message = '';
    this.lock = null;
    this.lockError = null;
    this.op = null;
    this.opPromise = null;
    this.abort = null;
    this.orchestrator = null;
    this.engine = null;        // { token, git } while the engine service exists
    this.recovery = null;      // { ambiguous: [...], failed: [...] }
    this.closed = false;
  }

  emit(event) { try { this.rawEmit(event); } catch { /* output closed */ } }
  problem(code, message, detail = {}) { this.emit({ event: 'problem', code, message, detail }); this.log(`${code}: ${message}`); }
  setState(state, message = '') {
    this.state = state; this.message = message;
    const mode = this.runningMode ?? this.mode;
    this.emit({ event: 'state', state, mode: mode ?? null, urls: urlsFor(this.config, mode ?? 'explore'), message });
  }

  // ---- ownership -------------------------------------------------------------------------

  /** Takes the lock and recovers survivors. Safe to call repeatedly. Needs the supervisor binary. */
  async ensureOwnership() {
    if (this.lock) return;
    if (this.lockError) throw this.lockError;
    if (!(await isExec(this.config.paths.supervise))) throw new ControllerError('NO_SUPERVISOR', `The supervisor ${this.config.paths.supervise} is not built yet; run setup.`);
    try {
      this.lock = await this.lockImpl({ lockPath: this.config.paths.controllerLock, superviseBin: this.config.paths.supervise });
    } catch (failure) {
      if (failure.code === 'LOCKED') { this.lockError = failure; this.problem('LOCKED', failure.message); this.setState('error', failure.message); }
      throw failure;
    }
    await writeControllerRecord(this.config.paths.controllerJson, { layout: this.config.layout });
    const outcome = await this.recoverImpl(this.config.paths.owners, { onProblem: p => this.emit({ event: 'problem', ...p }) });
    if (outcome.ambiguous.length || outcome.failed.length) this.#enterRecovery(outcome);
  }

  #enterRecovery({ ambiguous, failed }) {
    this.recovery = { ambiguous: ambiguous.map(describeVerdict), failed: failed.map(describeVerdict) };
    const names = [...this.recovery.ambiguous, ...this.recovery.failed].map(r => r.name).join(', ');
    this.problem('SURVIVOR', `Processes from an earlier run could not be identified or stopped safely: ${names}.`, { recovery: this.recovery });
    this.setState('recovery', `Could not safely identify processes from an earlier run (${names}). Choose to stop them or ignore them.`);
  }

  async init() {
    const state = await loadSetupState(this.config);
    this.mode = state.mode;
    try { await this.ensureOwnership(); } catch (failure) { if (!['NO_SUPERVISOR', 'LOCKED'].includes(failure.code)) throw failure; }
    if (this.state !== 'recovery' && this.state !== 'error') await this.#settleIdle();
  }

  async #isSetupComplete(mode) {
    if (!mode) return false;
    try {
      const release = await loadRelease(this.config);
      const state = await loadSetupState(this.config);
      const result = await stepStatus({ config: this.config, release, deps: this.deps, state, mode });
      return Object.values(result).every(Boolean);
    } catch { return false; }
  }

  async #settleIdle() {
    const state = await loadSetupState(this.config);
    this.mode = state.mode;
    this.setState((await this.#isSetupComplete(state.mode)) ? 'stopped' : 'needs-setup');
  }

  // ---- operations ------------------------------------------------------------------------

  #begin(op) {
    if (this.closed) throw new ControllerError('SHUTTING_DOWN', 'The controller is shutting down.');
    if (this.lockError) throw this.lockError;
    if (this.op) throw new ControllerError('BUSY', `Another operation is in progress (${this.op}).`);
    this.op = op;
    this.abort = new AbortController();
    let finish;
    this.opPromise = new Promise(resolve => { finish = resolve; });
    return () => { this.op = null; this.abort = null; finish(); };
  }

  async #waitIdleOp() { while (this.op) await this.opPromise.catch(() => {}); }

  #checkMode(mode) {
    if (!MODES.includes(mode)) throw new ControllerError('INVALID_MODE', `mode must be one of ${MODES.join(', ')}.`);
    return mode;
  }

  async preflight(requested) {
    const mode = this.#checkMode(requested ?? this.mode ?? 'explore');
    const release = await loadRelease(this.config);
    const setupState = await loadSetupState(this.config);
    const config = effectiveConfig(this.config, setupState);
    const status = await stepStatus({ config, release, deps: this.deps, state: setupState, mode });
    const pending = Object.entries(status).filter(([, ok]) => !ok).map(([id]) => id);
    const { downloadBytes, requiredBytes } = estimateSteps({ release, pending, config });
    const free = await diskFree(this.config.data);
    const problems = [];
    if (requiredBytes !== null && free < requiredBytes) problems.push({ code: 'DISK_SPACE', message: `About ${mb(requiredBytes)} MB of free space is needed; ${mb(free)} MB is available.`, detail: { freeBytes: free, requiredBytes } });
    if (pending.includes('media') && this.config.layout === 'app' && !release.media && !this.config.externalMediaDir) problems.push({ code: 'DOWNLOAD', message: 'No media source is configured (release.json has no media and CP_MEDIA_DIR is not set).', detail: {} });
    if (pending.includes('claude') && !release.claude?.version) problems.push({ code: 'DOWNLOAD', message: 'No Claude Code version is pinned in release.json yet.', detail: {} });
    const ownPorts = new Set((this.orchestrator?.names() ?? []).map(name => this.config.ports[SERVICE_PORT_KEYS[name]]));
    const leftovers = new Set([...(this.recovery?.ambiguous ?? []), ...(this.recovery?.failed ?? [])].map(r => r.name));
    const portConflicts = (await findPortConflicts(serviceTable(this.config, mode), { ownPorts, inUse: this.portInUse })).map(c => (leftovers.has(c.service) ? { ...c, ours: true } : c));
    for (const c of portConflicts) problems.push({ code: 'PORT_IN_USE', message: `Port ${c.port} (${c.service}) is already in use${c.ours ? ' by a process left from an earlier run' : ' by another program'}. Nothing was changed.`, detail: c });
    for (const p of problems) this.problem(p.code, p.message, p.detail);
    return { downloadBytes, requiredBytes, freeBytes: free, portConflicts, problems };
  }

  async setup(requested) {
    const mode = this.#checkMode(requested);
    if (this.state === 'recovery') throw new ControllerError('RECOVERY_REQUIRED', 'Resolve the earlier run first (recover).');
    if (this.state === 'running' || this.state === 'starting') throw new ControllerError('BUSY', 'Stop the game before running setup.');
    const done = this.#begin('setup');
    this.setState('setting-up', `Setting up (${mode})`);
    try {
      const pre = await this.#setupPreflight(mode);
      const blocking = pre.problems.find(p => p.code === 'DISK_SPACE' || p.code === 'DOWNLOAD');
      if (blocking) throw new ControllerError(blocking.code, blocking.message, blocking.detail);
      const result = await runSetup({ config: this.config, mode, deps: this.deps, emit: e => this.emit(e), signal: this.abort.signal, ensureOwnership: () => this.ensureOwnership() });
      this.mode = result.mode;
      if (this.state !== 'recovery') this.setState('stopped', 'Setup complete.');
      return { mode: result.mode, ran: result.ran, skipped: result.skipped };
    } catch (failure) {
      if (failure.code === 'CANCELLED') this.problem('CANCELLED', 'Setup was cancelled; run setup again to resume.');
      else this.problem(['DOWNLOAD', 'DISK_SPACE', 'VERIFY', 'RUNTIMES_MISSING', 'LOCKED'].includes(failure.code) ? failure.code : 'SETUP_FAILED', failure.message, failure.detail ?? {});
      if (this.state !== 'recovery' && !this.lockError) await this.#settleIdle().catch(() => this.setState('needs-setup'));
      throw failure;
    } finally { done(); }
  }

  /** Disk and media-source problems only; ports are checked by start. Does not emit problem events itself (setup emits the blocking one). */
  async #setupPreflight(mode) {
    const saved = this.problem;
    this.problem = () => {};
    try { return await this.preflight(mode); } finally { this.problem = saved; }
  }

  async start(requested) {
    if (this.state === 'running') return this.#startResult();
    if (this.orchestrator) await this.stop(); // error state: clean up before starting again
    await this.ensureOwnership();
    if (this.state === 'recovery') throw new ControllerError('RECOVERY_REQUIRED', 'Resolve the earlier run first (recover).');
    const done = this.#begin('start');
    try {
      const setupState = await loadSetupState(this.config);
      const mode = this.#checkMode(requested ?? setupState.mode ?? 'explore');
      const release = await loadRelease(this.config);
      const status = await stepStatus({ config: this.config, release, deps: this.deps, state: setupState, mode });
      const missing = Object.entries(status).filter(([, ok]) => !ok).map(([id]) => id);
      if (!setupState.mode || (mode === 'code' && setupState.mode !== 'code') || missing.length) {
        this.setState('needs-setup', `Setup is incomplete${missing.length ? ` (${missing.join(', ')})` : ''}.`);
        throw new ControllerError('NEEDS_SETUP', `Setup is not complete for ${mode} mode${missing.length ? `: ${missing.join(', ')}` : ''}.`, { missing });
      }
      this.runningMode = mode;
      this.setState('starting', `Starting (${mode})`);
      const conflicts = await findPortConflicts(serviceTable(this.config, mode), { inUse: this.portInUse });
      if (conflicts.length) {
        for (const c of conflicts) this.problem('PORT_IN_USE', `Port ${c.port} (${c.service}) is already in use by another program. Nothing was changed.`, c);
        throw new ControllerError('PORT_IN_USE', `Port ${conflicts.map(c => c.port).join(', ')} already in use.`, { portConflicts: conflicts });
      }
      const config = effectiveConfig(this.config, setupState);
      for (const dir of [config.paths.engineState, config.paths.worktrees, config.paths.claudeConfig, config.paths.logs, config.paths.owners]) await mkdir(dir, { recursive: true, mode: 0o700 });
      const native = await this.deps.native();
      const services = native.nativeServices({ ...config, mode });
      this.engine = null;
      if (mode === 'code') {
        const claude = setupState.steps.claude;
        const { verifyClaude } = await this.deps.claude();
        try { await verifyClaude({ path: claude.path, version: claude.version, configDir: this.config.paths.claudeConfig }); }
        catch (failure) { throw new ControllerError('VERIFY', `Claude Code did not verify: ${failure.message}`); }
        // A crashed engine leaves its runtime lock; remove it only when ownership is certain.
        const engineLock = await recoverEngineLocks({ stateDir: config.paths.engineState, publicationDir: config.paths.nativeIgloos, journalFile: path.join(config.paths.journal, 'engine.json') });
        if (engineLock.action === 'removed') this.log(`Removed the locks left by stopped engine PID ${engineLock.pid}: ${engineLock.removed.join(', ')}.`);
        if (engineLock.action === 'keep') throw new ControllerError('ENGINE_LOCK', `${engineLock.reason} Check, then remove ${engineLock.lockPath} before starting.`, { lockPath: engineLock.lockPath });
        this.engine = await engineService({ config, deps: this.deps, claudePath: claude.path, token: this.deps.randomToken?.() });
        services.push(this.engine.def);
      }
      this.orchestrator = this.orchestratorFactory({
        superviseBin: this.config.paths.supervise, ownersDir: this.config.paths.owners, journalDir: this.config.paths.journal, emit: e => this.emit(e), log: this.log, logCapBytes: this.logCapBytes,
        onFailure: (name, info) => this.#serviceFailed(name, info),
      });
      await this.orchestrator.start(services, { signal: this.abort.signal, healthTimeoutMs: this.healthTimeoutMs });
      this.setState('running', `Running (${mode})`);
      return this.#startResult();
    } catch (failure) {
      this.engine = null;
      this.orchestrator = null; // Orchestrator.start already stopped whatever it had started
      this.runningMode = null;
      if (failure.code === 'CANCELLED') await this.#settleIdle().catch(() => {});
      else if (failure.code !== 'NEEDS_SETUP') {
        if (failure.code !== 'PORT_IN_USE') this.problem(failure.code === 'VERIFY' ? 'VERIFY' : 'SERVICE_FAILED', failure.message, failure.detail ?? {});
        this.setState('error', failure.message);
      }
      throw failure;
    } finally { done(); }
  }

  #startResult() { return { state: this.state, mode: this.runningMode, urls: urlsFor(this.config, this.runningMode) }; }

  #serviceFailed(name, info) {
    this.problem('SERVICE_FAILED', `${name} stopped unexpectedly${info.code != null ? ` (exit ${info.code})` : ''}. It is not restarted automatically; stop and start again once the cause is fixed.`, { name, ...info });
    if (this.state === 'running') this.setState('error', `${name} stopped unexpectedly.`);
  }

  async stop() {
    if (this.op) { this.abort?.abort(); await this.#waitIdleOp(); }
    if (this.state === 'recovery') throw new ControllerError('RECOVERY_REQUIRED', 'Resolve the earlier run first (recover).');
    const done = this.#begin('stop');
    try {
      if (!this.orchestrator) {
        if (!['stopped', 'needs-setup'].includes(this.state)) await this.#settleIdle();
        return { state: this.state };
      }
      this.setState('stopping', 'Stopping services');
      const failed = await this.orchestrator.stopAll();
      this.orchestrator = null;
      this.engine = null;
      this.runningMode = null;
      if (failed.length) {
        this.problem('SURVIVOR', `These services did not confirm they stopped: ${failed.join(', ')}.`, { failed });
        this.#enterRecovery({ ambiguous: [], failed: failed.map(name => ({ name, reason: 'Did not confirm it stopped.' })) });
        return { state: 'recovery', failed };
      }
      await this.#settleIdle();
      return { state: this.state };
    } finally { done(); }
  }

  async cancel() {
    if (!this.op || this.op === 'stop') return { cancelled: false };
    this.abort.abort();
    return { cancelled: true, operation: this.op };
  }

  async recover(action) {
    if (!['stop-survivors', 'ignore'].includes(action)) throw new ControllerError('BAD_REQUEST', 'action must be stop-survivors or ignore.');
    await this.ensureOwnership();
    if (this.state !== 'recovery') throw new ControllerError('NOT_IN_RECOVERY', 'There is nothing to recover.');
    const done = this.#begin('recover');
    try {
      const outcome = await this.resolveImpl(this.config.paths.owners, action);
      if (outcome.failed.length) {
        this.#enterRecovery({ ambiguous: [], failed: outcome.failed.map(name => ({ name, reason: 'Did not stop.' })) });
        throw new ControllerError('SURVIVOR', `Could not stop: ${outcome.failed.join(', ')}.`, outcome);
      }
      this.recovery = null;
      await this.#settleIdle();
      return { state: this.state, ...outcome };
    } finally { done(); }
  }

  // ---- status ----------------------------------------------------------------------------

  async status() {
    const setupState = await loadSetupState(this.config);
    const config = effectiveConfig(this.config, setupState);
    const mode = this.runningMode ?? this.mode ?? setupState.mode;
    const release = await loadRelease(this.config).catch(() => ({}));
    const complete = setupState.mode ? await this.#isSetupComplete(setupState.mode) : false;
    const running = new Map((this.orchestrator?.snapshot() ?? []).map(s => [s.name, s]));
    const services = serviceTable(this.config, 'code').map(({ name, port }) => running.get(name) ?? { name, state: 'stopped', pid: null, port });
    const engineStatus = this.engine && running.get('engine')?.state === 'healthy'
      ? await httpJson(`http://127.0.0.1:${this.config.ports.engine}/engine/control/status`, { headers: { authorization: `Bearer ${this.engine.token}` } }) : null;
    const pendingMap = setupState.mode ? await stepStatus({ config, release, deps: this.deps, state: setupState, mode: setupState.mode }).catch(() => ({})) : {};
    const pending = Object.entries(pendingMap).filter(([, ok]) => !ok).map(([id]) => id);
    const claudeStep = setupState.steps.claude;
    return {
      state: this.state, mode: mode ?? null, setupComplete: complete, message: this.message,
      ports: { ...this.config.ports }, urls: urlsFor(this.config, mode ?? 'explore'), services,
      sessions: { running: 0, ...(engineStatus?.sessions ?? {}) },
      claude: engineStatus?.claude ?? (claudeStep ? { path: claudeStep.path, version: claudeStep.version } : null),
      signIn: engineStatus?.signIn ?? null,
      git: engineStatus?.git ?? (this.engine ? this.engine.git : null),
      disk: { freeBytes: await diskFree(this.config.data), requiredBytes: estimateSteps({ release, pending, config }).requiredBytes },
      ...(this.recovery ? { recovery: this.recovery } : {}),
    };
  }

  // ---- shutdown --------------------------------------------------------------------------

  /** Graceful stop of everything, then release the lock. Idempotent. */
  shutdown() {
    this.shutdownPromise ??= (async () => {
      this.abort?.abort();
      await this.#waitIdleOp();
      this.closed = true;
      if (this.orchestrator) {
        this.setState('stopping', 'Shutting down');
        const failed = await this.orchestrator.stopAll().catch(failure => { this.log(`shutdown: ${failure.message}`); return []; });
        if (failed.length) this.log(`shutdown: did not confirm ${failed.join(', ')} stopped; their ownership records remain for the next launch`);
        this.orchestrator = null;
      }
      if (this.lock) {
        removeControllerRecord(this.config.paths.controllerJson);
        this.lock.release();
        this.lock = null;
      }
      if (!this.lockError) this.emit({ event: 'state', state: 'stopped', mode: this.mode ?? null, urls: urlsFor(this.config, this.mode ?? 'explore'), message: 'Controller exited.' });
    })();
    return this.shutdownPromise;
  }
}
