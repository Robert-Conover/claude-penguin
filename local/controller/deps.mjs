import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ControllerError } from './lock.mjs';

/**
 * Modules written by other parts of the build are imported lazily and only when a step needs them, so
 * the controller starts (and answers status) even when one is missing. Every dependency is replaceable:
 * pass `overrides` (tests do) or `--deps-module <file>` on the command line.
 */
async function importFrom(resources, relative, label) {
  const file = path.join(resources, relative);
  try { return await import(pathToFileURL(file).href); }
  catch (failure) {
    if (failure.code === 'ERR_MODULE_NOT_FOUND' || failure.code === 'ENOENT') throw new ControllerError('MODULE_MISSING', `${label} is not available (${relative}).`, { module: relative });
    throw failure;
  }
}

export function createDeps(resources, overrides = {}) {
  const cache = new Map();
  const lazy = (key, relative, label) => () => {
    if (!cache.has(key)) cache.set(key, importFrom(resources, relative, label));
    return cache.get(key);
  };
  return {
    native: lazy('native', 'local/native/services.mjs', 'The native service definitions'),
    claude: lazy('claude', 'local/installer/claude.mjs', 'The Claude installer'),
    media: lazy('media', 'local/installer/media.mjs', 'The media installer'),
    patcher: lazy('patcher', 'local/client-bridge/patcher.mjs', 'The extension patcher'),
    findGit: null, // set by engine-service.mjs defaults
    randomToken: null,
    ...overrides,
  };
}

export async function loadOverrides(file) {
  if (!file) return {};
  const mod = await import(pathToFileURL(path.resolve(file)).href);
  return typeof mod.default === 'function' ? await mod.default() : (mod.default ?? mod);
}
