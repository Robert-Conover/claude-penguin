import { spawn } from 'node:child_process';
import { access, constants, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { ControllerError } from './lock.mjs';
import { writeJsonAtomic } from './owners.mjs';

const exists = async file => { try { await access(file); return true; } catch { return false; } };
const isDir = async dir => { try { return (await stat(dir)).isDirectory(); } catch { return false; } };
const isExec = async file => { try { await access(file, constants.X_OK); return true; } catch { return false; } };

export const STEP_TASK = Object.freeze({ runtimes: 'runtime', database: 'database', media: 'media', extensions: 'extensions', claude: 'claude' });
const STEP_ORDER = ['runtimes', 'database', 'media', 'extensions', 'claude'];
export const stepsForMode = mode => STEP_ORDER.filter(id => id !== 'claude' || mode === 'code');

export async function loadRelease(config) {
  try { return JSON.parse(await readFile(config.paths.release, 'utf8')); }
  catch (failure) { throw new ControllerError('RELEASE_MISSING', `Could not read ${config.paths.release}: ${failure.message}`); }
}

export async function loadSetupState(config) {
  try {
    const value = JSON.parse(await readFile(config.paths.setup, 'utf8'));
    return { version: 1, mode: null, steps: {}, ...value };
  } catch { return { version: 1, mode: null, steps: {} }; }
}
export const saveSetupState = (config, state) => writeJsonAtomic(config.paths.setup, state, 0o600);

/** The config with the media and client-bridge roots setup actually produced. */
export function effectiveConfig(config, state) {
  const out = { ...config };
  if (state.steps.media?.root) out.mediaRoot = state.steps.media.root;
  if (state.steps.extensions?.root) out.clientBridgeRoot = state.steps.extensions.root;
  return out;
}

const hasMedia = async root => (await isDir(path.join(root, 'play'))) && (await isDir(path.join(root, 'media')));

/** Checkout: its vanilla-media/. App: CP_MEDIA_DIR when set (a developer override), else the release's pinned download. */
function mediaTarget(config, release) {
  if (config.layout === 'launch') return { kind: 'checkout', root: config.mediaRoot };
  if (config.externalMediaDir) return { kind: 'external', root: config.externalMediaDir };
  if (release.media) return { kind: 'install', manifest: release.media, root: path.join(config.paths.media, 'current') };
  return { kind: 'none' };
}

/** Each step: check() says whether it is already satisfied (cheap), run() does the work. */
function buildSteps(ctx) {
  const { config, release, deps, state } = ctx;
  return {
    runtimes: {
      label: 'Checking the bundled runtimes',
      async check() { return (await exists(config.paths.runtimesManifest)) && (await isExec(config.paths.supervise)); },
      async run() {
        if (!(await exists(config.paths.runtimesManifest)) || (config.layout === 'app' && !(await isExec(config.paths.supervise)))) {
          const hint = config.layout === 'launch' ? 'Run local/native/build-runtimes.sh to download and build them.' : 'Reinstall the app.';
          throw new ControllerError('RUNTIMES_MISSING', `The runtimes are missing (${config.paths.runtimesManifest}). ${hint}`);
        }
        if (!(await isExec(config.paths.supervise))) {
          ctx.emitProgress('runtimes', 'Building the process supervisor (cp-supervise)', 0, 1);
          await runBuild(path.join(config.resources, 'local', 'controller', 'build-supervise.sh'), { CP_SUPERVISE_OUT: config.paths.supervise });
        }
        if (!(await isExec(config.paths.supervise))) throw new ControllerError('RUNTIMES_MISSING', `The supervisor ${config.paths.supervise} is missing.`);
      },
    },
    database: {
      label: 'Preparing the game database',
      async check() { return state.steps.database?.ok === true && (await exists(path.join(config.paths.secrets, 'db.json'))); },
      async run({ signal }) {
        const { prepareData } = await deps.native();
        await prepareData(effectiveConfig(config, state), { onProgress: p => ctx.forward('database', 'Preparing the game database', p), signal });
        state.steps.database = { ok: true };
      },
    },
    media: {
      label: 'Preparing the game media',
      async check() {
        const target = mediaTarget(config, release);
        if (target.kind === 'none') return false;
        if (target.kind === 'install' && state.steps.media?.version !== release.media.version) return false;
        if (target.kind !== 'install' && state.steps.media?.root !== target.root) return false; // record where the media lives
        return hasMedia(target.root);
      },
      async run({ signal }) {
        const target = mediaTarget(config, release);
        if (target.kind === 'checkout') {
          if (!(await hasMedia(target.root))) throw new ControllerError('DOWNLOAD', 'The game media is missing from this checkout. Run: git submodule update --init vanilla-media', { path: target.root });
          state.steps.media = { ok: true, root: target.root, source: 'checkout' };
        } else if (target.kind === 'external') {
          if (!(await hasMedia(target.root))) throw new ControllerError('DOWNLOAD', `CP_MEDIA_DIR (${target.root}) must hold play/ and media/.`, { path: target.root });
          state.steps.media = { ok: true, root: target.root, source: 'CP_MEDIA_DIR' };
        } else if (target.kind === 'install') {
          const { installMedia } = await deps.media();
          // A source: "git" release is fetched with the bundled Git, never the user's.
          await installMedia({ manifest: target.manifest, root: config.data, git: config.paths.bundledGit, onProgress: p => ctx.forward('media', 'Downloading the game media', p), signal });
          if (!(await hasMedia(target.root))) throw new ControllerError('VERIFY', `The media install did not produce ${target.root}.`);
          state.steps.media = { ok: true, root: target.root, version: target.manifest.version, source: 'download' };
        } else {
          throw new ControllerError('DOWNLOAD', 'No media source is configured: set CP_MEDIA_DIR to a directory holding play/ and media/, or wait for a release that names the media download.');
        }
      },
    },
    extensions: {
      label: 'Building the in-game extensions',
      async check() {
        const step = state.steps.extensions;
        if (!step?.ok) return false;
        if (step.fallback) return exists(path.join(step.root, 'engine.swf'));
        if (step.patchset !== release.patchset) return false;
        // Every installed file is checked against the patches, so a damaged one sends setup back to rebuild it.
        let patcher = null;
        try { patcher = await deps.patcher(); } catch { /* not available: fall back to presence */ }
        if (!patcher?.verifyInstalledPatchSet || !(await isDir(config.paths.patches))) return exists(path.join(step.root, 'engine.swf'));
        try { return (await patcher.verifyInstalledPatchSet({ patches: config.paths.patches, dir: step.root })).ok; }
        catch { return false; }
      },
      async run({ signal }) {
        const media = state.steps.media?.root ?? mediaTarget(config, release).root;
        const out = config.paths.clientBridge;
        let patcher = null, why = null;
        if (!(await isDir(config.paths.patches))) why = `no patches directory at ${config.paths.patches}`;
        else {
          try { patcher = await deps.patcher(); } catch (failure) { if (failure.code !== 'MODULE_MISSING') throw failure; why = failure.message; }
        }
        if (patcher) {
          await patcher.installPatchSet({ media, patches: config.paths.patches, out, patchset: release.patchset, onProgress: p => ctx.forward('extensions', 'Building the in-game extensions', p), signal });
          state.steps.extensions = { ok: true, root: path.join(out, 'current'), patchset: release.patchset };
          return;
        }
        if (config.layout === 'launch' && (await exists(path.join(config.paths.launchBridgeBuild, 'engine.swf')))) {
          ctx.emitProgress('extensions', `Patches are not available (${why}); using the existing build in .local/client-bridge`, 1, 1);
          state.steps.extensions = { ok: true, root: config.paths.launchBridgeBuild, fallback: true, reason: why };
          return;
        }
        throw new ControllerError('EXTENSIONS_MISSING', `The in-game extensions cannot be built: ${why}.`);
      },
    },
    claude: {
      label: 'Installing Claude Code',
      async check() {
        const step = state.steps.claude;
        return Boolean(step?.ok && release.claude?.version && step.version === release.claude.version && (await exists(step.path)));
      },
      async run({ signal }) {
        const version = release.claude?.version;
        if (!version) throw new ControllerError('DOWNLOAD', 'No Claude Code version is pinned in release.json yet.');
        const { installClaude, verifyClaude } = await deps.claude();
        const installed = await installClaude({ version, root: config.paths.claude, onProgress: p => ctx.forward('claude', 'Downloading Claude Code', p), signal });
        ctx.emitProgress('claude', 'Verifying Claude Code', 0, 1);
        // The app's own Claude configuration; never ~/.claude.
        await mkdir(config.paths.claudeConfig, { recursive: true, mode: 0o700 });
        await verifyClaude({ path: installed.path, version, configDir: config.paths.claudeConfig });
        state.steps.claude = { ok: true, path: installed.path, version, sha256: installed.sha256 };
      },
    },
  };
}

function runBuild(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', [script], { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', c => { stderr += c; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new ControllerError('RUNTIMES_MISSING', `Building the supervisor failed: ${stderr.trim() || `exit ${code}`}`)));
  });
}

// The installers report short phase names; the setup screen shows these instead.
const PHASE_LABELS = Object.freeze({
  media: {
    space: 'Checking free space', trees: 'Finding the game media', download: 'Downloading the game media',
    extract: 'Unpacking the game media', checkout: 'Unpacking the game media', verify: 'Checking the game media', activate: 'Finishing the game media',
  },
  claude: { manifest: 'Checking the Claude Code release', download: 'Downloading Claude Code', verify: 'Verifying Claude Code', install: 'Installing Claude Code' },
});

export function makeContext({ config, release, deps, state, emit }) {
  const ctx = { config, release, deps, state };
  ctx.emitProgress = (step, label, done, total) => emit({ event: 'progress', task: STEP_TASK[step], label, done, total });
  ctx.forward = (step, label, p = {}) => emit({
    event: 'progress', task: STEP_TASK[step], label: (p.label && PHASE_LABELS[step]?.[p.label]) ?? p.label ?? label,
    done: p.done ?? p.bytes ?? p.completed ?? 0, total: p.total ?? null,
  });
  return ctx;
}

export async function stepStatus({ config, release, deps, state, mode }) {
  const ctx = makeContext({ config, release, deps, state, emit: () => {} });
  const steps = buildSteps(ctx);
  const result = {};
  for (const id of stepsForMode(mode)) result[id] = await steps[id].check();
  return result;
}

/** Download/space needed by the steps that are not yet satisfied. null where a size is unknown. */
export function estimateSteps({ release, pending, config }) {
  let download = 0, required = 0;
  const add = (d, r) => { download = download === null || d === null ? null : download + d; required = required === null || r === null ? null : required + r; };
  for (const id of pending) {
    if (id === 'media' && config.layout === 'app' && !config.externalMediaDir && release.media) add(release.media.size ?? null, release.media.size != null && release.media.installedSize != null ? release.media.size + release.media.installedSize : null);
    else if (id === 'claude') {
      const c = release.claude ?? {};
      add(c.size ?? null, c.installedSize ?? (c.size != null ? c.size * 2 : null));
    }
  }
  return { downloadBytes: download, requiredBytes: required };
}

/**
 * Runs the missing steps for `mode`. Resumable: satisfied steps are skipped, state is saved after each step.
 */
export async function runSetup({ config, mode, deps, emit, signal, ensureOwnership = async () => {} }) {
  const release = await loadRelease(config);
  const state = await loadSetupState(config);
  const ctx = makeContext({ config, release, deps, state, emit });
  const steps = buildSteps(ctx);
  const ids = stepsForMode(mode);
  const ran = [], skipped = [];
  for (const [index, id] of ids.entries()) {
    if (signal?.aborted) throw new ControllerError('CANCELLED', 'Setup cancelled.');
    const step = steps[id];
    if (await step.check()) { skipped.push(id); ctx.emitProgress(id, `${step.label}: already done`, index + 1, ids.length); if (id === 'runtimes') await ensureOwnership(); continue; }
    ctx.emitProgress(id, step.label, 0, 1);
    try { await step.run({ signal }); }
    catch (failure) {
      // The installers stop with their own ABORTED error; a cancel is a cancel, whatever the step reports.
      if (signal?.aborted) throw new ControllerError('CANCELLED', 'Setup cancelled.');
      throw failure;
    }
    ran.push(id);
    if (id === 'runtimes') await ensureOwnership();
    await saveSetupState(config, state);
    ctx.emitProgress(id, `${step.label}: done`, 1, 1);
  }
  if (!state.mode || (state.mode === 'explore' && mode === 'code')) state.mode = mode;
  await saveSetupState(config, state);
  return { mode: state.mode, ran, skipped, state };
}
