import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
// Folders served over HTTP (local/web/server.mjs) or mounted into containers (compose.yml).
const EXPOSED_DIRS = ['vanilla-media', 'templates', '.local/ruffle', '.local/client-bridge', '.local/native-igloos', '.local/logs', 'local', 'houdini', 'dash', 'snowflake', '.local/bridge-public'];
const DEFAULT_STATE_DIR = '.local/agent-engine';

/** Realpath of the nearest existing ancestor plus the missing rest; a dangling link is refused. */
function canonicalPath(target) {
  const rest = [];
  for (let probe = path.resolve(target); ; probe = path.dirname(probe)) {
    try { return path.join(fs.realpathSync.native(probe), ...rest); }
    catch (failure) {
      if (failure.code !== 'ENOENT' || path.dirname(probe) === probe) throw failure;
      if (fs.lstatSync(probe, { throwIfNoEntry: false })) throw new Error(`${probe} is a dangling link.`);
      rest.unshift(path.basename(probe));
    }
  }
}

/**
 * Private state (sessions, hook settings, game-secrets.json) must never live
 * where the game serves or mounts files. Compares canonical paths, and on
 * macOS case-insensitively. main() always runs this, before acquiring a lock.
 */
export function stateDirProblem(dir, { root = projectRoot, platform = process.platform } = {}) {
  const fold = value => platform === 'darwin' ? value.toLowerCase() : value;
  const within = (parent, child) => {
    const relative = path.relative(fold(parent), fold(child));
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  const resolved = relative => { try { return canonicalPath(path.join(root, relative)); } catch { return path.resolve(root, relative); } };
  let chosen;
  try { chosen = canonicalPath(dir); } catch (failure) { return `CP_ENGINE_STATE_DIR cannot be resolved safely: ${failure.message}`; }
  const exposed = EXPOSED_DIRS.find(relative => within(resolved(relative), chosen));
  if (exposed) return `CP_ENGINE_STATE_DIR must not be inside ${exposed}/: that folder is served over HTTP or mounted into the game containers, which would expose private engine state.`;
  return null;
}

export function engineStateDir(env = process.env, root = projectRoot) {
  return path.resolve(root, env.CP_ENGINE_STATE_DIR || DEFAULT_STATE_DIR);
}
