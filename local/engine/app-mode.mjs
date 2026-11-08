// App-mode support for the engine: validated configuration, Claude's child
// environment, sign-in reporting, the Git fallback, and the login-shell capture.
// With none of the CP_* variables below set, every function reduces to the
// behavior the engine always had.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];
const NEVER_FORWARDED = /^(CLAUDE_CODE_SESSION|CLAUDE_CODE_CHILD|CLAUDE_CODE_MESSAGING|NEBULA_|AGENT_OFFICE_|CLAUDE_PENGUIN_|CP_|POSTGRES_)/;
const STRIPPED = new Set(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID', 'CLAUDE_EFFORT', 'NO_COLOR', 'FORCE_COLOR', 'VSCODE_INJECTION', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION']);
const APPLE_GIT_STUB = '/usr/bin/git';

function invalid(message) { return Object.assign(new Error(message), { statusCode: 500 }); }
const set = value => typeof value === 'string' && value !== '';

/** True when the engine runs inside the macOS app (or ./launch) rather than the Compose dev setup. */
export function isAppMode(env = process.env) { return set(env.CP_CLAUDE_CONFIG_DIR) || set(env.CP_LOGIN_SHELL_ENV); }

// ---------------------------------------------------------------- ports and hosts

function port(env, key) {
  if (!set(env[key])) return undefined;
  const value = Number(env[key]);
  if (!/^\d+$/.test(env[key]) || !Number.isInteger(value) || value < 1024 || value > 65535) throw invalid(`${key} must be an integer from 1024 to 65535.`);
  return value;
}

/**
 * CP_WEB_ORIGIN, CP_GAME_HOST and the three game ports. Unset values are
 * undefined so the web server's own defaults (and LOGIN_PORT etc.) still apply.
 */
export function readNetworkConfig(env = process.env) {
  let webOrigin;
  if (set(env.CP_WEB_ORIGIN)) {
    let url;
    try { url = new URL(env.CP_WEB_ORIGIN); } catch { throw invalid('CP_WEB_ORIGIN must be an http URL such as http://localhost:47080.'); }
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password
        || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
      throw invalid('CP_WEB_ORIGIN must be a loopback http origin without a path, such as http://localhost:47080.');
    }
    webOrigin = url.origin;
  }
  let gameHost;
  if (set(env.CP_GAME_HOST)) {
    if (!LOOPBACK_HOSTS.includes(env.CP_GAME_HOST)) throw invalid(`CP_GAME_HOST must be one of ${LOOPBACK_HOSTS.join(', ')}.`);
    gameHost = env.CP_GAME_HOST;
  }
  return { webOrigin, gameHost, loginPort: port(env, 'CP_LOGIN_PORT'), worldPort: port(env, 'CP_WORLD_PORT'), snowPort: port(env, 'CP_SNOW_PORT') };
}

/** Options for createEngineServer/createLocalServer: only what was configured. */
export function serverNetworkOptions(config) {
  return Object.fromEntries(Object.entries({
    dashOrigin: config.webOrigin, loginHost: config.gameHost, worldHost: config.gameHost, snowHost: config.gameHost,
    loginPort: config.loginPort, worldPort: config.worldPort, snowPort: config.snowPort,
  }).filter(([, value]) => value !== undefined));
}

// ---------------------------------------------------------------- provisioning

/** CP_PROVISION_COMMAND: a JSON array of strings whose first entry is an absolute program path. */
export function parseProvisionCommand(text, key = 'CP_PROVISION_COMMAND') {
  if (!set(text)) return null;
  let value;
  try { value = JSON.parse(text); } catch { throw invalid(`${key} must be a JSON array of strings.`); }
  if (!Array.isArray(value) || value.length === 0 || !value.every(item => typeof item === 'string' && !item.includes('\0'))) {
    throw invalid(`${key} must be a non-empty JSON array of strings.`);
  }
  if (!value[0] || !path.isAbsolute(value[0])) throw invalid(`${key} must start with an absolute program path.`);
  return value;
}

/**
 * Reads CP_PROVISION_ENV_FILE. The file must be a regular file (not a link),
 * owned by this user, with mode 0600, holding a JSON object of strings.
 * Call it only when spawning: the values must not be kept.
 */
export function readProvisionEnvFile(file, { uid = process.getuid?.() } = {}) {
  let stats;
  try { stats = fs.lstatSync(file); } catch (failure) { throw invalid(`The provisioning environment file cannot be read (${failure.code ?? failure.message}).`); }
  if (!stats.isFile()) throw invalid('The provisioning environment file must be a regular file.');
  if ((stats.mode & 0o777) !== 0o600) throw invalid('The provisioning environment file must have mode 0600.');
  if (uid !== undefined && stats.uid !== uid) throw invalid('The provisioning environment file must be owned by the current user.');
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw invalid('The provisioning environment file is not valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.entries(value).every(([key, item]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof item === 'string')) {
    throw invalid('The provisioning environment file must be a JSON object of string values.');
  }
  return value;
}

// ---------------------------------------------------------------- Claude's environment

/**
 * Claude's child environment. `base` is process.env or the captured login-shell
 * environment; `settings` is the engine's own environment (the CP_* switches).
 * Sign-in variables are passed through unchanged: see signInReport.
 */
export function claudeEnvironment({ base = process.env, settings = process.env, pathDir = null } = {}) {
  const env = { ...base };
  for (const key of Object.keys(env)) if (STRIPPED.has(key) || NEVER_FORWARDED.test(key)) delete env[key];
  if (set(settings.CP_CLAUDE_CONFIG_DIR)) env.CLAUDE_CONFIG_DIR = settings.CP_CLAUDE_CONFIG_DIR;
  if (settings.CP_CLAUDE_DISABLE_UPDATES === '1') env.DISABLE_UPDATES = '1';
  if (pathDir) env.PATH = insertBeforeUsrBin(env.PATH, pathDir);
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
}

export function insertBeforeUsrBin(pathValue, dir) {
  const parts = (pathValue ?? '').split(':').filter(Boolean);
  const index = parts.indexOf('/usr/bin');
  if (index === -1) parts.push(dir); else parts.splice(index, 0, dir);
  return parts.join(':');
}

const DROPPED_FROM_LOGIN_SHELL = new Set(['SHLVL', 'PWD', 'OLDPWD', '_']);

/**
 * Captures the user's login-shell environment once. The shell is an
 * interactive login shell with stdin /dev/null; random markers bracket
 * `/usr/bin/env -0` so profile noise is ignored. Never throws: on failure it
 * returns { env: null, warning }.
 */
/** The engine's environment without its own settings and secrets, for the login shell it reads. */
function shellEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(CP_|POSTGRES_|CLAUDE_PENGUIN_)/.test(key)));
}

export async function captureLoginShellEnvironment({ shell = process.env.SHELL || '/bin/zsh', execFileImpl = execFile, timeoutMs = 10000, random = () => randomBytes(12).toString('hex') } = {}) {
  const start = `CPENV_START_${random()}`, end = `CPENV_END_${random()}`;
  const command = `printf '%s' '${start}'; /usr/bin/env -0; printf '%s' '${end}'`;
  try {
    const stdout = await new Promise((resolve, reject) => {
      const child = execFileImpl(shell, ['-i', '-l', '-c', command], { encoding: 'buffer', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
        env: { ...shellEnvironment(process.env), DISABLE_AUTO_UPDATE: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] }, (failure, out) => (failure ? reject(failure) : resolve(out)));
      child?.stdin?.end?.();
    });
    const text = Buffer.from(stdout).toString('utf8');
    const from = text.indexOf(start), to = text.lastIndexOf(end);
    if (from === -1 || to === -1 || to < from) throw new Error('the shell did not print the environment markers');
    const env = {};
    for (const entry of text.slice(from + start.length, to).split('\0')) {
      const equals = entry.indexOf('=');
      if (equals <= 0) continue;
      const key = entry.slice(0, equals);
      if (DROPPED_FROM_LOGIN_SHELL.has(key) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      env[key] = entry.slice(equals + 1);
    }
    if (!env.PATH) throw new Error('the login shell reported no PATH');
    return { env, warning: null };
  } catch (failure) {
    const why = failure.killed || failure.signal ? `it did not finish within ${Math.round(timeoutMs / 1000)} seconds` : failure.message;
    return { env: null, warning: `Could not read your login-shell environment (${String(why).slice(0, 200)}). Claude uses the app's own environment, so tools from your shell profile such as Homebrew or nvm may be missing.` };
  }
}

// ---------------------------------------------------------------- sign-in

/**
 * Which sign-in Claude Code will use, from the environment Claude gets. Names
 * only, never values. Sign-in variables are never removed: Anthropic's terms
 * keep every built-in method available, so the app only reports.
 *
 * Precedence and names: https://code.claude.com/docs/en/authentication
 * ("Authentication precedence" and "Anthropic profiles and federation
 * credentials"): 1. CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY,
 * 2. ANTHROPIC_AUTH_TOKEN, 3. ANTHROPIC_API_KEY (interactive Claude asks once
 * before using it), 4. apiKeyHelper (a settings file, not visible here),
 * 5. CLAUDE_CODE_OAUTH_TOKEN, 6. profile/federation (ANTHROPIC_PROFILE, or
 * ANTHROPIC_FEDERATION_RULE_ID with ANTHROPIC_ORGANIZATION_ID), 7. /login.
 * Env-var provider selection: https://code.claude.com/docs/en/third-party-integrations.md
 */
const FALSY = new Set(['', '0', 'false', 'no', 'off']);
const truthy = value => typeof value === 'string' && !FALSY.has(value.trim().toLowerCase());
export function signInReport(env) {
  const overriddenBy = [];
  const found = {};
  for (const [name, method] of [['CLAUDE_CODE_USE_BEDROCK', 'bedrock'], ['CLAUDE_CODE_USE_VERTEX', 'vertex'], ['CLAUDE_CODE_USE_FOUNDRY', 'foundry']]) {
    if (truthy(env[name])) { overriddenBy.push(name); found[method] ??= name; }
  }
  const named = (name, method) => { if (set(env[name])) { overriddenBy.push(name); found[method] ??= name; } };
  named('ANTHROPIC_AUTH_TOKEN', 'auth-token');
  named('ANTHROPIC_API_KEY', 'api-key');
  named('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-token');
  named('ANTHROPIC_PROFILE', 'profile');
  if (set(env.ANTHROPIC_FEDERATION_RULE_ID) && set(env.ANTHROPIC_ORGANIZATION_ID)) {
    overriddenBy.push('ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID');
    found.federation = 'ANTHROPIC_FEDERATION_RULE_ID';
  }
  const order = ['bedrock', 'vertex', 'foundry', 'auth-token', 'api-key', 'oauth-token', 'profile', 'federation'];
  const method = order.find(item => found[item]) ?? 'login';
  return { method, overriddenBy, variable: found[method] ?? null };
}

// ---------------------------------------------------------------- Git for Claude

function defaultExecutable(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
}

function defaultRun(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000, encoding: 'utf8' }, (failure, stdout) => (failure ? reject(failure) : resolve(stdout)));
  });
}

/**
 * Which Git Claude will find, given the PATH Claude gets. Never executes
 * /usr/bin/git (Apple's stub opens the Command Line Tools install dialog);
 * `xcode-select -p` and a file check decide whether the stub is backed by a
 * real installation. Returns { source: 'user'|'bundled'|'missing', path, pathDir }
 * where pathDir is the directory to insert before /usr/bin (bundled only).
 */
export async function detectClaudeGit({ pathValue, bundledDir = null, isExecutable = defaultExecutable, run = defaultRun } = {}) {
  const dirs = (pathValue ?? '').split(':').filter(path.isAbsolute);
  const found = dirs.map(dir => path.join(dir, 'git')).find(isExecutable) ?? null;
  if (found && found !== APPLE_GIT_STUB) return { source: 'user', path: found, pathDir: null };
  if (found === APPLE_GIT_STUB) {
    try {
      const developerDir = String(await run('/usr/bin/xcode-select', ['-p'])).trim();
      const real = path.join(developerDir, 'usr/bin/git');
      if (developerDir && path.isAbsolute(developerDir) && isExecutable(real)) return { source: 'user', path: real, pathDir: null };
    } catch { /* no developer tools selected */ }
  }
  if (set(bundledDir)) return { source: 'bundled', path: path.join(bundledDir, 'git'), pathDir: bundledDir };
  return { source: 'missing', path: null, pathDir: null };
}

// ---------------------------------------------------------------- Claude version

/** The version a managed install records in its path (`.../versions/<version>/claude`), else null. */
export function versionFromPath(claudePath) {
  return /\/versions\/([0-9][^/]*)\/claude$/.exec(claudePath ?? '')?.[1] ?? null;
}

// ---------------------------------------------------------------- resume command

const SAFE_WORD = /^[A-Za-z0-9._+@%=,:-]+$/;
export function shellWord(value) { return SAFE_WORD.test(value) ? value : `'${String(value).replace(/'/g, `'\\''`)}'`; }

/** The shell command that continues an archived conversation with the managed Claude and configuration. */
export function resumeCommandFor({ workspacePath, sessionId, claudePath = 'claude', configDir = null }) {
  const executable = claudePath.includes('/') ? `'${claudePath.replace(/'/g, `'\\''`)}'` : shellWord(claudePath);
  const prefix = set(configDir) ? `CLAUDE_CONFIG_DIR=${`'${configDir.replace(/'/g, `'\\''`)}'`} ` : '';
  return `cd '${String(workspacePath).replace(/'/g, `'\\''`)}' && ${prefix}${executable} --resume ${sessionId}`;
}

// ---------------------------------------------------------------- the whole picture

/**
 * Everything the manager, server and controller need to know about Claude's
 * runtime, computed once at startup. All process access is injectable.
 */
export async function prepareClaudeRuntime({ settings = process.env, claudePath = 'claude', capture = captureLoginShellEnvironment,
  detectGit = detectClaudeGit, versionOf = null } = {}) {
  const warnings = [];
  let baseEnv = process.env;
  let loginShell = false;
  if (settings.CP_LOGIN_SHELL_ENV === '1') {
    const captured = await capture();
    if (captured.env) { baseEnv = captured.env; loginShell = true; }
    else if (captured.warning) warnings.push(captured.warning);
  }
  if (set(settings.CP_CLAUDE_CONFIG_DIR) && !path.isAbsolute(settings.CP_CLAUDE_CONFIG_DIR)) throw invalid('CP_CLAUDE_CONFIG_DIR must be an absolute path.');
  const probe = claudeEnvironment({ base: baseEnv, settings });
  const git = await detectGit({ pathValue: probe.PATH, bundledDir: set(settings.CP_BUNDLED_GIT_DIR) ? settings.CP_BUNDLED_GIT_DIR : null });
  if (git.source === 'missing') warnings.push('Claude cannot find Git. Install the Xcode Command Line Tools or Git, or use the app\'s bundled Git.');
  const environment = () => claudeEnvironment({ base: baseEnv, settings, pathDir: git.pathDir });
  let version = versionFromPath(claudePath);
  if (!version && versionOf) { try { version = (await versionOf(claudePath, environment())) ?? null; } catch { version = null; } }
  return {
    baseEnv, loginShell, warnings, git, environment,
    configDir: set(settings.CP_CLAUDE_CONFIG_DIR) ? settings.CP_CLAUDE_CONFIG_DIR : null,
    appMode: isAppMode(settings),
    // Names only. The sign-in is recomputed from the live Claude environment.
    report() {
      return { signIn: signInReport(environment()), git: { source: git.source, path: git.path }, claude: { path: claudePath, version }, warnings: [...warnings] };
    },
  };
}
