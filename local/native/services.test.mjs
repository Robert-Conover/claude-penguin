import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PORTS, engineEnvironment, ensureSecrets, nativeServices, postgresReady, prepareData, readSecrets, writeProvisionEnv } from './services.mjs';

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'cp native '));
  const config = {
    resources: path.join(base, 'Resources app'), runtimes: path.join(base, 'runtimes'), data: path.join(base, 'Application Support/Claude Penguin'),
    ports: { ...DEFAULT_PORTS },
  };
  return { base, config, cleanup: () => rm(base, { recursive: true, force: true }) };
}
const mode = async file => (await stat(file)).mode & 0o777;

test('definitions: names, order, ports, absolute programs, stop signals', async () => {
  const { config, cleanup } = await fixture();
  try {
    await ensureSecrets(config);
    const services = nativeServices(config);
    assert.deepEqual(services.map(s => s.name), ['postgres', 'valkey', 'login', 'world', 'dash', 'snowflake', 'web']);
    const ports = Object.fromEntries(services.map(s => [s.name, s.port]));
    assert.deepEqual(ports, { postgres: 47432, valkey: 47379, login: 47112, world: 47875, dash: 47300, snowflake: 47002, web: 47080 });
    assert.equal(new Set(Object.values(ports)).size, 7);
    const seen = new Set();
    for (const s of services) {
      for (const dep of s.after) assert.ok(seen.has(dep), `${s.name} needs ${dep} listed first`);
      seen.add(s.name);
      assert.ok(path.isAbsolute(s.command[0]), `${s.name} program is absolute`);
      assert.ok(path.isAbsolute(s.cwd));
      assert.ok(s.logDir.startsWith(config.data) && s.logDir.endsWith(`logs/${s.name}`));
      assert.ok(['SIGINT', 'SIGTERM', 'SIGQUIT'].includes(s.stop.signal) && s.stop.graceMs > 0);
      assert.ok(['tcp', 'http', 'command'].includes(s.health.type));
      assert.equal(typeof s.env, 'object');
    }
    const by = Object.fromEntries(services.map(s => [s.name, s]));
    assert.deepEqual(by.world.after, ['login']);
    assert.deepEqual(by.web.after.sort(), ['dash', 'login', 'snowflake', 'world']);
    assert.equal(by.postgres.stop.signal, 'SIGINT', 'Postgres fast shutdown');
    assert.equal(typeof by.postgres.ready, 'function');
    assert.equal(by.web.health.url, 'http://127.0.0.1:47080/healthz');
    assert.equal(by.web.env.PUBLIC_ORIGIN, 'http://localhost:47080');
    assert.equal(by.snowflake.env.MEDIA_LOCATION, 'http://localhost:47080/media');
    assert.equal(by.snowflake.env.ENABLE_POLICY_SERVER, undefined, 'the 843 policy listener stays off');
    assert.equal(by.dash.env.CP_CJS_PORT, '47002');
    assert.equal(by.dash.env.CP_DASH_ITEMS, path.join(config.resources, 'vanilla-media/media/avatar/paper'));
    assert.equal(by.dash.command.at(-1), '../local/dash_config.py');
    assert.ok(by.postgres.command.includes('unix_socket_directories='));
    assert.ok(by.world.env.CP_NATIVE_IGLOOS_FILE.startsWith(path.join(config.data, 'native-igloos')));
  } finally { await cleanup(); }
});

test('every listener and connection is loopback; nothing names 0.0.0.0 or ::', async () => {
  const { config, cleanup } = await fixture();
  try {
    await ensureSecrets(config);
    const text = JSON.stringify(nativeServices(config).map(({ ready, ...rest }) => rest));
    assert.doesNotMatch(text, /0\.0\.0\.0|"::"|\[::\]/);
    const by = Object.fromEntries(nativeServices(config).map(s => [s.name, s]));
    const flag = (service, name) => by[service].command[by[service].command.indexOf(name) + 1];
    assert.ok(by.postgres.command.includes('listen_addresses=127.0.0.1'));
    assert.equal(flag('valkey', '--bind'), '127.0.0.1');
    assert.equal(flag('valkey', '--protected-mode'), 'yes');
    assert.equal(flag('login', '--address'), '127.0.0.1');
    assert.equal(flag('world', '--address'), '127.0.0.1');
    assert.equal(flag('login', '--database-address'), '127.0.0.1:47432');
    assert.equal(by.dash.env.CP_DASH_ADDRESS, '127.0.0.1');
    assert.equal(by.snowflake.env.CP_SNOWFLAKE_BIND, '127.0.0.1');
    assert.equal(by.web.env.BIND_ADDRESS, '127.0.0.1');
  } finally { await cleanup(); }
});

test('ports are configurable and flow into every dependent setting', async () => {
  const { config, cleanup } = await fixture();
  try {
    await ensureSecrets(config);
    const ports = { web: 1, engine: 2, login: 3, world: 4, snow: 5, dash: 6, postgres: 7, valkey: 8 };
    const by = Object.fromEntries(nativeServices({ ...config, ports }).map(s => [s.name, s]));
    assert.equal(by.web.env.WORLD_PORT, '4');
    assert.equal(by.web.env.DASH_ORIGIN, 'http://127.0.0.1:6');
    assert.equal(by.dash.env.POSTGRES_PORT, '7');
    assert.equal(by.snowflake.env.REDIS_PORT, '8');
    assert.equal(by.snowflake.env.PORT, '5');
    assert.equal(by.world.command[by.world.command.indexOf('--port') + 1], '4');
    const env = engineEnvironment({ ...config, ports });
    assert.equal(env.CP_WORLD_PORT, '4');
    assert.equal(env.CP_WEB_ORIGIN, 'http://localhost:1');
    assert.equal(env.CP_ENGINE_PORT, '2');
  } finally { await cleanup(); }
});

test('the database password never appears outside the process environment and Houdini arguments', async () => {
  const { config, cleanup } = await fixture();
  try {
    const secrets = await ensureSecrets(config);
    const services = nativeServices(config);
    const holders = services.filter(s => JSON.stringify([s.command, s.env, s.health]).includes(secrets.password)).map(s => s.name);
    assert.deepEqual(holders.sort(), ['dash', 'login', 'snowflake', 'world']);
    const env = engineEnvironment(config);
    assert.doesNotMatch(JSON.stringify(env), new RegExp(secrets.password));
  } finally { await cleanup(); }
});

test('engine environment names the provisioner, its 0600 env file, and the native paths', async () => {
  const { config, cleanup } = await fixture();
  try {
    const env = engineEnvironment({ ...config, mediaRoot: '/m', clientBridgeRoot: '/b', ruffleRoot: '/r' });
    assert.deepEqual(JSON.parse(env.CP_PROVISION_COMMAND), [path.join(config.runtimes, 'python/bin/python3'), '-s', path.join(config.resources, 'local/game_provision.py')]);
    assert.equal(env.CP_PROVISION_ENV_FILE, path.join(config.data, 'secrets/provision-env.json'));
    assert.equal(env.CP_NATIVE_IGLOOS_DIR, path.join(config.data, 'native-igloos'));
    assert.equal(env.CP_GAME_HOST, '127.0.0.1');
    assert.equal(env.LOGIN_PORT, '47112');
    assert.equal(env.MEDIA_ROOT, '/m'); assert.equal(env.CLIENT_BRIDGE_ROOT, '/b'); assert.equal(env.RUFFLE_ROOT, '/r');
    assert.equal(env.CP_BUNDLED_GIT_DIR, path.join(config.runtimes, 'git-only'));
  } finally { await cleanup(); }
});

test('secrets: generated once, mode 0600, never rewritten', async () => {
  const { config, cleanup } = await fixture();
  try {
    const first = await ensureSecrets(config);
    const file = path.join(config.data, 'secrets/db.json');
    assert.equal(await mode(file), 0o600);
    assert.equal(await mode(path.dirname(file)), 0o700);
    assert.match(first.password, /^[0-9a-f]{48}$/);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(file, 'utf8'))).sort(), ['database', 'password', 'user']);
    const second = await ensureSecrets(config);
    assert.deepEqual(second, first);
    assert.deepEqual(readSecrets(config), first);
  } finally { await cleanup(); }
});

test('prepareData is idempotent and never replaces an existing Postgres cluster', async () => {
  const { config, cleanup } = await fixture();
  try {
    const cluster = path.join(config.data, 'postgres');
    await mkdir(cluster, { recursive: true });
    await writeFile(path.join(cluster, 'PG_VERSION'), '16\n');
    await writeFile(path.join(cluster, 'player-progress'), 'precious');
    const events = [];
    const first = await prepareData(config, { onProgress: e => events.push(e) });
    const secrets = await readFile(first.secretsPath, 'utf8');
    await prepareData(config);
    assert.equal(await readFile(first.secretsPath, 'utf8'), secrets);
    assert.equal(await readFile(path.join(cluster, 'player-progress'), 'utf8'), 'precious');
    assert.equal(await readFile(path.join(cluster, 'PG_VERSION'), 'utf8'), '16\n');
    assert.ok(events.every(e => e.event === 'progress' && e.task === 'database'));
    assert.equal(await mode(path.join(config.data, 'secrets/provision-env.json')), 0o600);
    const provision = JSON.parse(await readFile(path.join(config.data, 'secrets/provision-env.json'), 'utf8'));
    assert.equal(provision.POSTGRES_HOST, '127.0.0.1');
    assert.equal(provision.POSTGRES_PORT, '47432');
    assert.equal(provision.PYTHONPATH, path.join(config.runtimes, 'envs/houdini'));
    for (const name of ['postgres', 'valkey', 'login', 'world', 'dash', 'snowflake', 'web']) await stat(path.join(config.data, 'logs', name));
    assert.deepEqual((await readdir(config.data)).filter(n => n.includes('tmp')), []);
  } finally { await cleanup(); }
});

test('writeProvisionEnv follows the app to a new location (rewritten at every engine start)', async () => {
  const { config, cleanup } = await fixture();
  try {
    await mkdir(path.join(config.data, 'postgres'), { recursive: true });
    await writeFile(path.join(config.data, 'postgres', 'PG_VERSION'), '16\n');
    await prepareData(config);
    const file = path.join(config.data, 'secrets/provision-env.json');
    const before = JSON.parse(await readFile(file, 'utf8'));
    const moved = { ...config, runtimes: path.join(path.dirname(config.runtimes), 'Moved App', 'runtimes') };
    assert.equal(await writeProvisionEnv(moved), file);
    const after = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(after.PYTHONPATH, path.join(moved.runtimes, 'envs/houdini'));
    assert.equal(after.POSTGRES_PASSWORD, before.POSTGRES_PASSWORD, 'the credentials come from db.json, unchanged');
    assert.equal(await mode(file), 0o600);
    assert.deepEqual((await readdir(path.join(config.data, 'secrets'))).filter(n => n.includes('tmp')), []);
  } finally { await cleanup(); }
});

test('prepareData refuses a non-empty directory that is not a Postgres cluster', async () => {
  const { config, cleanup } = await fixture();
  try {
    const cluster = path.join(config.data, 'postgres');
    await mkdir(cluster, { recursive: true });
    await writeFile(path.join(cluster, 'something'), 'keep');
    await assert.rejects(prepareData(config), /refusing to touch/);
    assert.equal(await readFile(path.join(cluster, 'something'), 'utf8'), 'keep');
  } finally { await cleanup(); }
});

test('postgres ready hook: creates the database, loads the schema only into an empty one, then seeds', async () => {
  const { config, cleanup } = await fixture();
  try {
    const secrets = await ensureSecrets(config);
    const resolved = { ...config, ports: DEFAULT_PORTS, mediaRoot: '/m' };
    const scenario = async (dbExists, tables) => {
      const calls = [];
      const run = async (cmd, args, opts) => {
        calls.push({ cmd: path.basename(cmd), args, env: opts.env });
        const sql = args[args.indexOf('-c') + 1] ?? '';
        if (sql.includes('pg_database')) return dbExists ? '1\n' : '';
        if (sql.includes('pg_tables')) return `${tables}\n`;
        return '';
      };
      await postgresReady(resolved, secrets, run);
      return calls;
    };
    let calls = await scenario(false, 0);
    assert.ok(calls.some(c => c.args.some(a => /CREATE DATABASE/.test(a))));
    assert.ok(calls.some(c => c.args.includes('-f') && c.args.at(-1).endsWith('houdini/houdini.sql')));
    assert.equal(calls.at(-1).cmd, 'python3');
    assert.ok(calls.at(-1).args.at(-1).endsWith('local/verify_seed.py'));
    assert.equal(calls.at(-1).env.POSTGRES_HOST, '127.0.0.1');
    assert.equal(calls.at(-1).env.PYTHONPATH, path.join(config.runtimes, 'envs/houdini'));
    assert.equal(calls[0].env.PGPASSWORD, secrets.password);
    assert.ok(calls.every(c => c.cmd !== 'psql' || c.args.includes('127.0.0.1')));
    calls = await scenario(true, 120);
    assert.ok(!calls.some(c => c.args.some(a => /CREATE DATABASE/.test(a))), 'existing database is kept');
    assert.ok(!calls.some(c => c.args.includes('-f')), 'houdini.sql (which begins with DROP TABLE) never runs on a populated database');
    assert.equal(calls.at(-1).cmd, 'python3', 'the idempotent seed still runs');
  } finally { await cleanup(); }
});
