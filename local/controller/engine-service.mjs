import { randomBytes } from 'node:crypto';
import { accessSync, constants, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const BASE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/**
 * The user's working git, found without ever running /usr/bin/git (Apple's stub opens an install dialog
 * when no developer tools are present). /usr/bin/git counts only when `xcode-select -p` names a
 * developer directory that actually contains usr/bin/git. Returns an absolute path or null.
 */
export function findUserGit({ env = process.env, bundledGit, exists = existsSync, developerDir = defaultDeveloperDir } = {}) {
  const dirs = [...(env.PATH ?? '').split(':').filter(Boolean), '/opt/homebrew/bin', '/usr/local/bin'];
  const seen = new Set();
  for (const dir of dirs) {
    if (!path.isAbsolute(dir) || seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, 'git');
    if (candidate === bundledGit || !isExecutable(candidate)) continue;
    if (dir === '/usr/bin') {
      const dev = developerDir();
      if (!dev || !exists(path.join(dev, 'usr', 'bin', 'git'))) continue;
    }
    return candidate;
  }
  const dev = developerDir();
  if (dev && exists(path.join(dev, 'usr', 'bin', 'git')) && isExecutable(path.join(dev, 'usr', 'bin', 'git'))) return path.join(dev, 'usr', 'bin', 'git');
  return null;
}

function isExecutable(file) { try { accessSync(file, constants.X_OK); return true; } catch { return false; } }
function defaultDeveloperDir() {
  try { return execFileSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; }
  catch { return null; }
}

/** HOME, USER, LOGNAME, SHELL, TMPDIR, LANG from the controller's environment; nothing else is inherited. */
export function baseEnvironment(env = process.env) {
  const out = { PATH: BASE_PATH };
  for (const key of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG']) if (env[key]) out[key] = env[key];
  return out;
}

/**
 * Engine service definition for code mode. The control token is regenerated for every start and lives
 * only in this definition (engine environment) and the controller's memory.
 */
export async function engineService({ config, deps, claudePath, token = randomBytes(24).toString('base64url'), env = process.env }) {
  const native = await deps.native();
  const git = (deps.findGit ?? (() => findUserGit({ env, bundledGit: config.paths.bundledGit })))() ?? config.paths.bundledGit;
  const engineEnv = {
    ...baseEnvironment(env),
    ...native.engineEnvironment(config),
    CP_ENGINE_PORT: String(config.ports.engine),
    CP_ENGINE_STATE_DIR: config.paths.engineState,
    CP_ENGINE_WORKTREE_ROOT: config.paths.worktrees,
    CP_CLAUDE_PATH: claudePath,
    CP_CLAUDE_CONFIG_DIR: config.paths.claudeConfig,
    CP_CLAUDE_DISABLE_UPDATES: '1',
    CP_LOGIN_SHELL_ENV: '1',
    CP_BUNDLED_GIT_DIR: config.paths.gitOnly,
    CP_ENGINE_GIT: git,
    CP_ENGINE_CONTROL_TOKEN: token,
  };
  return {
    token,
    git: { source: git === config.paths.bundledGit ? 'bundled' : 'user', path: git },
    def: {
      name: 'engine',
      after: ['web'],
      command: [config.paths.node, config.paths.engineEntry],
      cwd: config.resources,
      env: engineEnv,
      port: config.ports.engine,
      health: { type: 'http', url: `http://127.0.0.1:${config.ports.engine}/engine/control/status`, headers: { authorization: `Bearer ${token}` }, timeoutMs: 45000 },
      stop: { signal: 'SIGTERM', graceMs: 15000 },
      logDir: path.join(config.paths.logs, 'engine'),
    },
  };
}
