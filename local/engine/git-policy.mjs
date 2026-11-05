// Offline Git execution for engine-owned operations. Every call uses an
// argument array, a sanitized environment, bounded output, and a timeout.
// Repository hooks, fsmonitor, lazy fetching, transports, and unsupported
// filter commands must never run on the engine's behalf.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const MIN_GIT_VERSION = Object.freeze([2, 48, 0]);
export const TIMEOUTS = Object.freeze({ quick: 15000, status: 60000, diff: 60000, attributes: 120000, worktree: 600000 });
const MIB = 1024 * 1024;

// Repository-location and injected-configuration variables would let the
// caller's environment redirect engine reads to another repository or policy.
const STRIPPED_GIT_ENV = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|EXTERNAL_DIFF|DIFF_OPTS|PAGER|EDITOR|SEQUENCE_EDITOR|ASKPASS|SSH|SSH_COMMAND|PROXY_COMMAND|EXEC_PATH|TRACE\w*|REPLACE_REF_BASE|NO_REPLACE_OBJECTS|SHALLOW_FILE|QUARANTINE_PATH|PREFIX|INTERNAL_\w*)$/;

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

function sanitizedEnvironment(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!STRIPPED_GIT_ENV.test(key)) env[key] = value;
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
    '-c', 'protocol.allow=never', '-c', 'core.sshCommand=false', '-c', 'credential.helper='];

  /** Returns { stdout: Buffer, stderr, code, truncated }. Throws GitError unless allowExit includes the exit code. */
  function raw(cwd, args, { timeout = TIMEOUTS.quick, maxBuffer = MIB, input, allowExit = [0], truncate = false } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, [...policyArgs, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      const out = [];
      let outBytes = 0, errText = '', truncated = false, settled = false, timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
      timer.unref?.();
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
          if (!truncate) child.kill('SIGKILL');
          else child.stdout.destroy();
          return;
        }
        out.push(chunk);
        outBytes += chunk.length;
      });
      child.stderr.on('data', chunk => { if (errText.length < 16384) errText += chunk.toString('utf8'); });
      child.on('error', error => finish(new GitError(`Git could not run: ${error.message}`, { code: error.code })));
      child.stdin.on('error', () => {});
      child.on('close', code => {
        const stdout = Buffer.concat(out);
        if (timedOut) return finish(new GitError(`Git ${args[0]} timed out after ${Math.round(timeout / 1000)} seconds.`, { stderr: errText }));
        if (truncated && !truncate) return finish(new GitError(`Git ${args[0]} produced more output than the engine allows.`, { stderr: errText }));
        if (truncated) return finish(null, { stdout, stderr: errText, code, truncated: true });
        if (!allowExit.includes(code)) {
          const detail = errText.trim().split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 600);
          return finish(new GitError(`Git ${args[0]} failed${detail ? `: ${detail}` : ` with exit code ${code}.`}`, { code, stderr: errText }));
        }
        finish(null, { stdout, stderr: errText, code, truncated: false });
      });
      if (input !== undefined) child.stdin.end(input); else child.stdin.end();
    });
  }
  async function text(cwd, args, options) { return (await raw(cwd, args, options)).stdout.toString('utf8'); }
  async function line(cwd, args, options) { return (await text(cwd, args, options)).trim(); }
  return { raw, text, line, env, policyArgs };
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

let lfsProbe;
async function lfsInstalled(git, cwd) {
  lfsProbe ??= git.raw(cwd, ['lfs', 'version'], { timeout: TIMEOUTS.quick }).then(result => /^git-lfs\//.test(result.stdout.toString('utf8')), () => false);
  return lfsProbe;
}

/** Classify every configured driver as inert (no command), standard LFS, or custom. */
export async function classifyDrivers(git, cwd) {
  const drivers = await filterDrivers(git, cwd);
  const result = new Map();
  for (const [name, config] of drivers) {
    const commands = FILTER_COMMANDS.filter(key => typeof config[key] === 'string' && config[key].trim());
    if (!commands.length) { result.set(name, 'inert'); continue; }
    const standard = name === 'lfs' && commands.every(key => LFS_COMMANDS[key].includes(config[key].trim()));
    result.set(name, standard && await lfsInstalled(git, cwd) ? 'lfs' : 'custom');
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
 * Repository-local conditional includes are refused outright. Conditional
 * includes elsewhere are acceptable only when the included file cannot change
 * the filter policy, because their conditions differ between the source
 * checkout and the engine worktree (gitdir, branch, remotes).
 */
export async function assertConfigPolicy(git, cwd) {
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
    const contents = await git.raw(cwd, ['config', '--file', included, '--includes', '-z', '--name-only', '--get-regexp', '^(filter\\.|core\\.attributesfile$)'], { allowExit: [0, 1] });
    if (splitNul(contents.stdout).length) {
      throw new PolicyError(`Conditional configuration ${key} (${included}) changes Git filter or attribute settings. Its condition may differ between the source checkout and the engine worktree, so Claude Penguin cannot establish the effective filter policy. Move those settings out of the conditional include, then retry.`);
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
