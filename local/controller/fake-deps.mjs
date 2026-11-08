// Fake implementations of the modules other implementers own, for controller tests.
import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_SERVICE = path.join(here, 'fake-service.mjs');
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('Cancelled.'), { code: 'CANCELLED' })); }, { once: true });
});

const GRAPH = {
  postgres: [], valkey: [], login: ['postgres', 'valkey'], world: ['postgres', 'valkey'],
  dash: ['login', 'world'], snowflake: ['login', 'world'], web: ['dash', 'snowflake'],
};
const KEY = { snowflake: 'snow' };

const track = config => process.env.FAKE_TRACK_DIR ?? path.join(config.data, '..', 'track');

export default function fakeDeps() {
  const env = process.env;
  const marker = name => env.FAKE_TRACK_DIR && existsSync(path.join(env.FAKE_TRACK_DIR, name));
  return {
    native: async () => ({
      nativeServices(config) {
        return Object.entries(GRAPH).map(([name, after]) => {
          const port = config.ports[KEY[name] ?? name];
          const flags = [];
          if (env.FAKE_DESCENDANT) flags.push('--descendant');
          if (env.FAKE_IGNORE_TERM) flags.push('--ignore-term');
          if (env.FAKE_NEVER_HEALTHY === name) flags.push('--never-healthy');
          if (env.FAKE_EXIT_IMMEDIATELY === name) flags.push('--exit-immediately');
          if (env.FAKE_EXIT_AFTER === name) flags.push('--exit-after', '1500', '--exit-code', '3');
          if (env.FAKE_STOP_DELAY) flags.push('--stop-delay', env.FAKE_STOP_DELAY);
          return {
            name, after, command: [process.execPath, FAKE_SERVICE, '--name', name, '--port', String(port), ...flags],
            cwd: config.data, port,
            env: { FAKE_TRACK_DIR: track(config), FAKE_SERVICE_NAME: name },
            health: name === 'web' ? { type: 'http', url: `http://127.0.0.1:${port}/healthz` } : { type: 'tcp', port },
            stop: { signal: name === 'postgres' ? 'SIGINT' : 'SIGTERM', graceMs: Number(env.FAKE_GRACE_MS ?? 800) },
            logDir: path.join(config.data, 'logs', name),
            ...(name === 'postgres' ? { ready: async () => { if (env.FAKE_TRACK_DIR) writeFileSync(path.join(env.FAKE_TRACK_DIR, 'postgres.ready'), '1'); } } : {}),
          };
        });
      },
      async prepareData(config, { onProgress, signal }) {
        if (env.FAKE_SLOW_PREPARE) { onProgress?.({ label: 'initdb', done: 0, total: 2 }); await sleep(Number(env.FAKE_SLOW_PREPARE), signal); }
        mkdirSync(config.paths?.secrets ?? path.join(config.data, 'secrets'), { recursive: true });
        writeFileSync(path.join(config.data, 'secrets', 'db.json'), '{}', { mode: 0o600 });
        onProgress?.({ label: 'initdb', done: 2, total: 2 });
      },
      async writeProvisionEnv(config) {
        if (env.FAKE_TRACK_DIR) writeFileSync(path.join(env.FAKE_TRACK_DIR, 'provision-env.written'), config.runtimes ?? '');
      },
      engineEnvironment: () => ({ FAKE_ENGINE_ENV: '1', FAKE_TRACK_DIR: env.FAKE_TRACK_DIR ?? '', CP_WEB_ORIGIN: 'http://localhost:1' }),
    }),
    claude: async () => ({
      async installClaude({ version, root, onProgress }) {
        if (marker('fail-claude')) throw Object.assign(new Error('simulated download failure'), { code: 'DOWNLOAD' });
        const file = path.join(root, 'versions', version, 'claude');
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, '#!/bin/sh\n'); chmodSync(file, 0o755);
        onProgress?.({ done: 10, total: 10 });
        return { path: file, version, sha256: 'x'.repeat(64) };
      },
      async verifyClaude() { if (marker('fail-verify')) throw new Error('signature mismatch'); },
    }),
    media: async () => ({ async installMedia() { throw new Error('not used in launch layout'); } }),
    patcher: async () => ({
      async installPatchSet({ out, patchset }) {
        const dir = path.join(out, patchset);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'engine.swf'), 'swf');
        const { symlinkSync, rmSync } = await import('node:fs');
        rmSync(path.join(out, 'current'), { force: true });
        symlinkSync(patchset, path.join(out, 'current'));
      },
    }),
    findGit: () => env.FAKE_GIT || null,
  };
}
