import path from 'node:path';

/** The product name lives here only; a rename is one edit. */
export const PRODUCT_NAME = 'Claude Penguin';

export const DEFAULT_PORTS = Object.freeze({
  web: 47080, engine: 47081, login: 47112, world: 47875, snow: 47002, dash: 47300, postgres: 47432, valkey: 47379,
});

/** Display service name -> key in the ports table. */
export const SERVICE_PORT_KEYS = Object.freeze({
  postgres: 'postgres', valkey: 'valkey', login: 'login', world: 'world', dash: 'dash', snowflake: 'snow', web: 'web', engine: 'engine',
});

export const MODES = Object.freeze(['explore', 'code']);
export const LOOPBACK = '127.0.0.1';

/**
 * layout 'launch': ./launch from a checkout (media is the checkout's vanilla-media/, Ruffle in .local/ruffle).
 * layout 'app': packaged app (media installed under data/media or CP_MEDIA_DIR).
 */
export function resolveConfig({ resources, runtimes, data, layout = 'app', ports = {}, env = process.env }) {
  for (const [name, value] of Object.entries({ resources, runtimes, data })) {
    if (!value || !path.isAbsolute(value)) throw Object.assign(new Error(`--${name} must be an absolute path.`), { code: 'BAD_CONFIG' });
  }
  if (!['launch', 'app'].includes(layout)) throw Object.assign(new Error(`Unknown layout ${layout}.`), { code: 'BAD_CONFIG' });
  const merged = { ...DEFAULT_PORTS, ...ports };
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw Object.assign(new Error(`Invalid port for ${key}.`), { code: 'BAD_CONFIG' });
  }
  const paths = {
    controllerLock: path.join(data, 'controller.lock'),
    controllerJson: path.join(data, 'controller.json'),
    owners: path.join(data, 'owners'),
    // Last known identity of each service's program; kept after exit (engine lock recovery).
    journal: path.join(data, 'journal'),
    setup: path.join(data, 'setup.json'),
    secrets: path.join(data, 'secrets'),
    logs: path.join(data, 'logs'),
    clientBridge: path.join(data, 'client-bridge'),
    media: path.join(data, 'media'),
    engineState: path.join(data, 'engine'),
    worktrees: path.join(data, 'worktrees'),
    claude: path.join(data, 'claude'),
    claudeConfig: path.join(data, 'claude', 'config'),
    downloads: path.join(data, 'downloads'),
    nativeIgloos: path.join(data, 'native-igloos'),
    supervise: path.join(runtimes, 'supervise', 'cp-supervise'),
    runtimesManifest: path.join(runtimes, 'manifest.json'),
    node: path.join(runtimes, 'node', 'bin', 'node'),
    gitOnly: path.join(runtimes, 'git-only'),
    bundledGit: path.join(runtimes, 'git', 'bin', 'git'),
    release: path.join(resources, 'local', 'controller', 'release.json'),
    // The app bundles the release patch set here; a checkout uses the generator's output (patch_generate.py).
    patches: layout === 'launch' ? path.join(resources, '.local', 'client-bridge-patches') : path.join(resources, 'local', 'client-bridge', 'patches'),
    engineEntry: path.join(resources, 'local', 'engine', 'server.mjs'),
    launchBridgeBuild: path.join(resources, '.local', 'client-bridge'),
  };
  const media = env.CP_MEDIA_DIR ? { dir: env.CP_MEDIA_DIR, source: 'CP_MEDIA_DIR' } : null;
  return {
    product: PRODUCT_NAME, layout, resources, runtimes, data, ports: merged, paths,
    externalMediaDir: layout === 'app' ? media?.dir ?? null : null,
    // Defaults; the controller overlays what setup actually installed (see setup.mjs).
    mediaRoot: layout === 'launch' ? path.join(resources, 'vanilla-media') : path.join(data, 'media', 'current'),
    clientBridgeRoot: path.join(data, 'client-bridge', 'current'),
    ruffleRoot: layout === 'launch' ? path.join(resources, '.local', 'ruffle') : path.join(resources, 'ruffle'),
  };
}

export function urlsFor(config, mode) {
  // The pages the app window opens: the game's login, and the engine's puffle page.
  const urls = { game: `http://localhost:${config.ports.web}/#/login` };
  if (mode === 'code') urls.agents = `http://localhost:${config.ports.engine}/?bridge=1&agents=1#/login`;
  return urls;
}

export function serviceTable(config, mode) {
  return Object.entries(SERVICE_PORT_KEYS)
    .filter(([name]) => name !== 'engine' || mode === 'code')
    .map(([name, key]) => ({ name, port: config.ports[key] }));
}
