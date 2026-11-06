// Offline Git execution for engine-owned operations. Every call uses an
// argument array, a sanitized environment, bounded output, and a timeout.
// Repository hooks (including config-defined hooks), fsmonitor, lazy fetching,
// transports, aliases, and unsupported filter commands must never run on the
// engine's behalf.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const MIN_GIT_VERSION = Object.freeze([2, 48, 0]);
export const TIMEOUTS = Object.freeze({ quick: 15000, status: 60000, diff: 60000, attributes: 120000, worktree: 600000 });
const MIB = 1024 * 1024;
const KILL_GRACE_MS = 2000;
// Per-protocol settings override protocol.allow, so each is pinned on the command line too.
const TRANSPORTS = ['file', 'git', 'ssh', 'http', 'https', 'ext', 'ftp', 'ftps'];
// Config-defined hooks run even with an empty core.hooksPath, and attr.tree
// makes checkout read attributes from a tree other than the inspected baseline.
const REFUSED_CONFIG = '^(hook\\.|attr\\.tree$)';
const CONDITIONAL_SENSITIVE_CONFIG = '^(hook\\.|attr\\.tree$|filter\\.|core\\.attributesfile$)';

// Each command leads its own process group so a timeout or engine exit also
// stops the children it spawns (the checkout behind `git worktree add`).
const liveGroups = new Set();
let exitHookInstalled = false;
function signalGroup(pid, signal) { try { process.kill(-pid, signal); } catch { /* The group has already exited. */ } }
function trackGroup(pid) {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // SIGTERM lets Git remove its lock files and a half-created worktree on the way out.
    process.on('exit', () => { for (const group of liveGroups) signalGroup(group, 'SIGTERM'); });
  }
  liveGroups.add(pid);
}

// The standard Git LFS driver values written by `git lfs install`, with and
// without `--skip-smudge`. Any other command is a custom filter.
const LFS_COMMANDS = Object.freeze({
  clean: ['git-lfs clean -- %f'],
  smudge: ['git-lfs smudge -- %f', 'git-lfs smudge --skip -- %f'],
  process: ['git-lfs filter-process', 'git-lfs filter-process --skip'],
});
const FILTER_COMMANDS = ['clean', 'smudge', 'process'];

export class GitError extends Error {
  constructor(message, { code, stderr, statusCode = 409, kind = 'git' } = {}) {
    super(message);
    this.exitCode = code;
    this.stderr = stderr;
    this.statusCode = statusCode;
    this.kind = kind;
  }
}

export class PolicyError extends Error {
  constructor(message) { super(message); this.statusCode = 409; this.kind = 'policy'; }
}

export function parseGitVersion(text) {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

export function gitVersionSupported(version) {
  if (!version) return false;
  for (let index = 0; index < 3; index++) {
    if (version[index] !== MIN_GIT_VERSION[index]) return version[index] > MIN_GIT_VERSION[index];
  }
  return true;
}

export function assertGitVersion(text) {
  const version = parseGitVersion(text);
  if (!gitVersionSupported(version)) {
    throw new PolicyError(`Claude Penguin requires Git ${MIN_GIT_VERSION.slice(0, 2).join('.')} or newer to disable lazy fetching and inspect baseline attributes safely. Found ${version ? version.join('.') : `an unrecognized version (${String(text).trim().slice(0, 80)})`}. Upgrade Git (for example, \`brew install git\`), then restart the engine.`);
  }
  return version;
}

// No GIT_* variable is inherited: location, configuration (GIT_CONFIG,
// GIT_CONFIG_PARAMETERS), attribute (GIT_ATTR_SOURCE), and protocol
// (GIT_ALLOW_PROTOCOL) variables would each bypass part of this policy.
// Callers pass any Git variables they need explicitly.
function sanitizedEnvironment(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  return { ...env, ...extra, GIT_NO_LAZY_FETCH: '1', GIT_LFS_SKIP_SMUDGE: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_PAGER: 'cat', GIT_EDITOR: 'false' };
}

/** A private hooks directory that must stay empty; core.hooksPath points here. */
export function ensureEmptyHooksDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = fs.lstatSync(dir);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new PolicyError(`The engine hook directory is not a private directory: ${dir}`);
  fs.chmodSync(dir, 0o700);
  if (fs.readdirSync(dir).length) throw new PolicyError(`The engine's empty hook directory contains files: ${dir}. Remove them; repository hooks must not run for engine-owned Git operations.`);
  return fs.realpathSync(dir);
}

export function createGit({ hooksDir, env: extraEnv = {}, binary = 'git' } = {}) {
  if (typeof hooksDir !== 'string' || !path.isAbsolute(hooksDir)) throw new Error('An absolute empty hooks directory is required.');
  const env = sanitizedEnvironment(extraEnv);
  const policyArgs = ['-c', `core.hooksPath=${hooksDir}`, '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false',
    '-c', 'protocol.allow=never', ...TRANSPORTS.flatMap(name => ['-c', `protocol.${name}.allow=never`]),
    '-c', 'core.sshCommand=false', '-c', 'credential.helper='];

  /**
   * Run `file` in its own process group with the sanitized environment (plus
   * per-call `env`). Returns { stdout: Buffer, stderr, code, truncated }.
   * Throws GitError unless allowExit includes the exit code.
   */
  function run(label, file, argv, cwd, { timeout = TIMEOUTS.quick, maxBuffer = MIB, input, allowExit = [0], truncate = false, env: callEnv } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(file, argv, { cwd, env: callEnv ? { ...env, ...callEnv } : env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      const group = child.pid;
      if (group) trackGroup(group);
      const out = [];
      let outBytes = 0, errText = '', truncated = false, settled = false, timedOut = false, grace = null;
      const timer = setTimeout(() => {
        timedOut = true;
        signalGroup(group, 'SIGTERM');
        grace = setTimeout(() => signalGroup(group, 'SIGKILL'), KILL_GRACE_MS);
      }, timeout);
      timer.unref?.();
      // When the leader exits, nothing it started may keep running in its group.
      child.on('exit', () => { clearTimeout(grace); liveGroups.delete(group); signalGroup(group, 'SIGKILL'); });
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      child.stdout.on('data', chunk => {
        if (truncated) return;
        if (outBytes + chunk.length > maxBuffer) {
          out.push(chunk.subarray(0, maxBuffer - outBytes));
          outBytes = maxBuffer;
          truncated = true;
          if (!truncate) signalGroup(group, 'SIGKILL');
          else child.stdout.destroy();
          return;
        }
        out.push(chunk);
        outBytes += chunk.length;
      });
      child.stderr.on('data', chunk => { if (errText.length < 16384) errText += chunk.toString('utf8'); });
      child.on('error', error => finish(new GitError(`${label} could not run: ${error.message}`, { code: error.code })));
      child.stdin.on('error', () => {});
      child.on('close', code => {
        const stdout = Buffer.concat(out);
        if (timedOut) return finish(new GitError(`${label} timed out after ${Math.round(timeout / 1000)} seconds.`, { stderr: errText }));
        if (truncated && !truncate) return finish(new GitError(`${label} produced more output than the engine allows.`, { stderr: errText }));
        if (truncated) return finish(null, { stdout, stderr: errText, code, truncated: true });
        if (!allowExit.includes(code)) {
          const detail = errText.trim().split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 600);
          return finish(new GitError(`${label} failed${detail ? `: ${detail}` : ` with exit code ${code}.`}`, { code, stderr: errText }));
        }
        finish(null, { stdout, stderr: errText, code, truncated: false });
      });
      if (input !== undefined) child.stdin.end(input); else child.stdin.end();
    });
  }
  const raw = (cwd, args, options) => run(`Git ${args[0]}`, binary, [...policyArgs, ...args], cwd, options);
  /** Run a helper executable (never through `git <name>`, which could resolve to an alias). */
  const tool = (file, args, cwd, options) => run(path.basename(file), file, args, cwd, options);
  async function text(cwd, args, options) { return (await raw(cwd, args, options)).stdout.toString('utf8'); }
  async function line(cwd, args, options) { return (await text(cwd, args, options)).trim(); }
  return { raw, text, line, tool, env, policyArgs };
}

export const splitNul = value => value.toString('utf8').split('\0').filter(Boolean);

/** Effective `filter.<driver>.*` configuration visible from `cwd`. */
export async function filterDrivers(git, cwd) {
  const result = await git.raw(cwd, ['config', '-z', '--get-regexp', '^filter\\.'], { allowExit: [0, 1] });
  const drivers = new Map();
  for (const entry of splitNul(result.stdout)) {
    const newline = entry.indexOf('\n');
    const key = newline < 0 ? entry : entry.slice(0, newline);
    const value = newline < 0 ? null : entry.slice(newline + 1);
    const lastDot = key.lastIndexOf('.');
    if (lastDot <= 7) continue;
    const name = key.slice(7, lastDot);
    const variable = key.slice(lastDot + 1).toLowerCase();
    if (!drivers.has(name)) drivers.set(name, {});
    drivers.get(name)[variable] = value; // Git uses the last value of a single-valued key.
  }
  return drivers;
}

/** An executable `name` in an absolute PATH entry; relative entries would resolve inside the repository. */
function findExecutable(name, searchPath = '') {
  for (const dir of searchPath.split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* Not here. */ }
  }
  return null;
}

// `git lfs` would fall through to a repository alias when git-lfs is not on
// PATH, so the executable is located and run directly.
const lfsProbes = new WeakMap();
function lfsInstalled(git) {
  if (!lfsProbes.has(git)) {
    const binary = findExecutable('git-lfs', git.env.PATH);
    lfsProbes.set(git, binary
      ? git.tool(binary, ['version'], path.parse(process.cwd()).root, { timeout: TIMEOUTS.quick }).then(result => /^git-lfs\//.test(result.stdout.toString('utf8')), () => false)
      : Promise.resolve(false));
  }
  return lfsProbes.get(git);
}

/** Classify every configured driver as inert (no command), standard LFS, or custom. */
export async function classifyDrivers(git, cwd) {
  const drivers = await filterDrivers(git, cwd);
  const result = new Map();
  for (const [name, config] of drivers) {
    const commands = FILTER_COMMANDS.filter(key => typeof config[key] === 'string' && config[key].trim());
    if (!commands.length) { result.set(name, 'inert'); continue; }
    const standard = name === 'lfs' && commands.every(key => LFS_COMMANDS[key].includes(config[key].trim()));
    result.set(name, standard && await lfsInstalled(git) ? 'lfs' : 'custom');
  }
  return result;
}

function expandIncludePath(value, origin) {
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  if (path.isAbsolute(value)) return value;
  const file = origin.startsWith('file:') ? origin.slice(5) : null;
  return file ? path.resolve(path.dirname(file), value) : null;
}

/**
 * Config-defined hooks and attr.tree are refused in every scope, including
 * included files. Repository-local conditional includes are refused outright.
 * Conditional includes elsewhere are acceptable only when the included file
 * cannot change the hook, filter, or attribute policy, because their
 * conditions differ between the source checkout and the engine worktree
 * (gitdir, branch, remotes).
 */
export async function assertConfigPolicy(git, cwd) {
  const refused = await git.raw(cwd, ['config', '-z', '--show-origin', '--name-only', '--get-regexp', REFUSED_CONFIG], { allowExit: [0, 1] });
  const entries = [];
  const pairs = refused.stdout.toString('utf8').split('\0');
  for (let index = 0; index + 1 < pairs.length; index += 2) if (pairs[index + 1]) entries.push({ origin: pairs[index], key: pairs[index + 1] });
  const describe = items => `${items.slice(0, 3).map(item => `${item.key} from ${item.origin}`).join(', ')}${items.length > 3 ? `, and ${items.length - 3} more` : ''}`;
  const hooks = entries.filter(item => item.key.startsWith('hook.'));
  if (hooks.length) {
    throw new PolicyError(`Git configuration defines hooks (${describe(hooks)}). Claude Penguin refuses config-defined hooks because core.hooksPath does not disable them, and no hook may run for engine-owned Git operations. Remove the hook.* settings from that configuration, then retry.`);
  }
  if (entries.length) {
    throw new PolicyError(`Git configuration sets attr.tree (${describe(entries)}), so checkout and status would read attributes from a tree other than the one Claude Penguin inspects for filters. Remove attr.tree, then retry.`);
  }
  const result = await git.raw(cwd, ['config', '-z', '--show-scope', '--show-origin', '--get-regexp', '^includeif\\.'], { allowExit: [0, 1] });
  const fields = result.stdout.toString('utf8').split('\0');
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const [scope, origin, entry] = [fields[index], fields[index + 1], fields[index + 2]];
    if (!entry) continue;
    const newline = entry.indexOf('\n');
    const key = newline < 0 ? entry : entry.slice(0, newline);
    const value = newline < 0 ? '' : entry.slice(newline + 1);
    if (scope === 'local' || scope === 'worktree' || scope === 'command') {
      throw new PolicyError(`This repository's own configuration uses conditional includes (${key}). Claude Penguin refuses repository-local includeIf because it cannot establish the same filter policy for its worktree. Remove it from the repository configuration, then retry.`);
    }
    if (!/\.path$/i.test(key)) continue;
    const included = expandIncludePath(value, origin);
    if (!included) throw new PolicyError(`Conditional configuration ${key} from ${origin} cannot be resolved, so the worktree filter policy is unknown. Use an absolute include path, then retry.`);
    if (!fs.existsSync(included)) continue;
    const contents = await git.raw(cwd, ['config', '--file', included, '--includes', '-z', '--name-only', '--get-regexp', CONDITIONAL_SENSITIVE_CONFIG], { allowExit: [0, 1] });
    if (splitNul(contents.stdout).length) {
      throw new PolicyError(`Conditional configuration ${key} (${included}) changes Git hook, filter, or attribute settings. Its condition may differ between the source checkout and the engine worktree, so Claude Penguin cannot establish the effective hook and filter policy. Move those settings out of the conditional include, then retry.`);
    }
  }
}

/** Map each path to its effective `filter` attribute, optionally reading attributes from a tree. */
export async function filterAttributes(git, cwd, paths, source) {
  if (!paths.length) return new Map();
  const args = ['check-attr', ...(source ? [`--source=${source}`] : []), '--stdin', '-z', 'filter'];
  const output = await git.raw(cwd, args, { input: `${paths.join('\0')}\0`, timeout: TIMEOUTS.attributes, maxBuffer: 256 * MIB });
  const fields = output.stdout.toString('utf8').split('\0');
  const values = new Map();
  for (let index = 0; index + 2 < fields.length; index += 3) values.set(fields[index], fields[index + 2]);
  return values;
}

export async function treePaths(git, cwd, revision) {
  return splitNul((await git.raw(cwd, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', revision], { timeout: TIMEOUTS.attributes, maxBuffer: 256 * MIB })).stdout);
}

function rejectCustom(values, classes, where) {
  const blocked = [];
  for (const [file, driver] of values) {
    if (['unspecified', 'unset', 'set'].includes(driver)) continue;
    if (classes.get(driver) === 'custom') blocked.push(`${file} (filter=${driver})`);
  }
  if (blocked.length) {
    throw new PolicyError(`Unsupported Git filter command for ${where}: ${blocked.slice(0, 5).join(', ')}${blocked.length > 5 ? `, and ${blocked.length - 5} more` : ''}. Claude Penguin runs only the standard Git LFS driver in skip mode, so custom clean/smudge/process filters never execute on its behalf. Remove the driver or its attributes, then retry.`);
  }
}

/** Run before checkout: inspects every baseline path with the baseline's attributes plus repository and user attributes. */
export async function inspectBaseline(git, sourceDir, baseline) {
  await assertConfigPolicy(git, sourceDir);
  const classes = await classifyDrivers(git, sourceDir);
  const paths = await treePaths(git, sourceDir, baseline);
  const values = await filterAttributes(git, sourceDir, paths, baseline);
  rejectCustom(values, classes, 'the baseline commit');
  let lfsPaths = 0;
  for (const driver of values.values()) if (classes.get(driver) === 'lfs') lfsPaths++;
  return { paths: paths.length, lfsPaths };
}

/**
 * Before engine-owned reads that may invoke filters (status, diff). Config is
 * checked on every call. Attribute inspection is needed only when a custom
 * driver is configured, because Git runs no command for a driver without one;
 * in that case the current index, HEAD, and baseline paths are checked against
 * the current working-tree attributes every time.
 */
export async function assertReadPolicy(git, cwd, revisions = []) {
  await assertConfigPolicy(git, cwd);
  const classes = await classifyDrivers(git, cwd);
  if (![...classes.values()].includes('custom')) return;
  const paths = new Set(splitNul((await git.raw(cwd, ['ls-files', '-z', '--cached'], { timeout: TIMEOUTS.attributes, maxBuffer: 256 * MIB })).stdout));
  for (const revision of ['HEAD', ...revisions]) {
    const resolved = await git.raw(cwd, ['rev-parse', '-q', '--verify', `${revision}^{commit}`], { allowExit: [0, 1] });
    if (resolved.code === 0) for (const file of await treePaths(git, cwd, revision)) paths.add(file);
  }
  rejectCustom(await filterAttributes(git, cwd, [...paths]), classes, 'this checkout');
  for (const revision of revisions) rejectCustom(await filterAttributes(git, cwd, await treePaths(git, cwd, revision), revision), classes, `commit ${revision.slice(0, 12)}`);
}
