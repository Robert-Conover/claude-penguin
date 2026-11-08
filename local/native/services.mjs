// Native macOS service definitions: the seven game servers as plain processes
// started from the pinned runtimes. This module only describes them (and
// prepares the data directory); starting, supervising and health-checking is
// the controller's job (local/native/run-stack.mjs is a minimal dev harness).
//
// Every listener binds 127.0.0.1. Nothing here reads or writes outside
// `config.data`, and the Postgres data directory is never replaced.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as fsc, readFileSync } from 'node:fs';
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const LOOPBACK = '127.0.0.1';
export const DEFAULT_PORTS = Object.freeze({
  web: 47080, engine: 47081, login: 47112, world: 47875, snow: 47002, dash: 47300, postgres: 47432, valkey: 47379,
});
export const DB_USER = 'penguin';
export const DB_NAME = 'houdini';
export const SERVER_NAME = 'Blizzard';
export const SERVER_ID = 3100;
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

function resolve(config) {
  const ports = { ...DEFAULT_PORTS, ...(config.ports ?? {}) };
  const data = config.data;
  return {
    ...config,
    ports,
    resources: config.resources,
    runtimes: config.runtimes,
    data,
    mediaRoot: config.mediaRoot ?? path.join(config.resources, 'vanilla-media'),
    clientBridgeRoot: config.clientBridgeRoot ?? path.join(data, 'client-bridge/current'),
    ruffleRoot: config.ruffleRoot ?? path.join(config.resources, '.local/ruffle'),
    bridgePublicRoot: config.bridgePublicRoot ?? path.join(data, 'bridge-public'),
  };
}

const rt = (c, ...parts) => path.join(c.runtimes, ...parts);
const dataPath = (c, ...parts) => path.join(c.data, ...parts);
const res = (c, ...parts) => path.join(c.resources, ...parts);

/** Interpreter id for a service (one interpreter today; see runtimes/manifest.json if that changes). */
export function pythonFor(config, service) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(config.runtimes, 'manifest.json'), 'utf8'));
    return manifest.components?.[`envs/${service}`]?.python ?? 'python';
  } catch { return 'python'; }
}

export function secretsPath(config) { return path.join(config.data, 'secrets/db.json'); }

/** Reads the generated database credentials ({user, database, password}). */
export function readSecrets(config) {
  const file = secretsPath(config);
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Database credentials are missing (${file}); run prepareData first (${error.code ?? error.message}).`); }
  for (const key of ['user', 'database', 'password']) {
    if (typeof parsed[key] !== 'string' || !parsed[key]) throw new Error(`${file} lacks "${key}"`);
  }
  return parsed;
}

function pythonEnvironment(c, service, extra = {}) {
  return {
    PATH: SYSTEM_PATH,
    PYTHONPATH: rt(c, 'envs', service),
    PYTHONDONTWRITEBYTECODE: '1',   // the vendored sources sit in read-only resources
    PYTHONUNBUFFERED: '1',
    PYTHONNOUSERSITE: '1',
    ...extra,
  };
}

const pythonBin = (c, service) => rt(c, pythonFor(c, service), 'bin/python3');

export function nativeServices(rawConfig) {
  const c = resolve(rawConfig);
  const { ports } = c;
  const secrets = rawConfig.secrets ?? readSecrets(c);
  const dbAddress = `${LOOPBACK}:${ports.postgres}`;
  const logDir = name => dataPath(c, 'logs', name);
  const nativeIgloos = dataPath(c, 'native-igloos');
  const houdiniArgs = (extra) => [
    '--address', LOOPBACK,
    '--redis-address', LOOPBACK, '--redis-port', String(ports.valkey),
    '--database-address', dbAddress, '--database-username', secrets.user,
    '--database-name', secrets.database, '--database-password', secrets.password,
    ...extra,
  ];
  const connection = {
    POSTGRES_HOST: LOOPBACK, POSTGRES_PORT: String(ports.postgres), POSTGRES_USER: secrets.user,
    POSTGRES_DB: secrets.database, POSTGRES_PASSWORD: secrets.password,
    REDIS_HOST: LOOPBACK, REDIS_PORT: String(ports.valkey),
  };
  const pg = bin => rt(c, 'postgres/bin', bin);

  const services = [
    {
      name: 'postgres',
      after: [],
      command: [pg('postgres'), '-D', dataPath(c, 'postgres'),
        '-c', `listen_addresses=${LOOPBACK}`, '-c', `port=${ports.postgres}`, '-c', 'unix_socket_directories=',
        '-c', 'password_encryption=scram-sha-256', '-c', 'logging_collector=off'],
      cwd: dataPath(c),
      env: { PATH: SYSTEM_PATH, LANG: 'en_US.UTF-8' },
      port: ports.postgres,
      health: { type: 'command', command: [pg('pg_isready'), '-h', LOOPBACK, '-p', String(ports.postgres), '-U', secrets.user, '-d', secrets.database], env: { PATH: SYSTEM_PATH } },
      stop: { signal: 'SIGINT', graceMs: 30000 },   // SIGINT is Postgres's fast shutdown
      logDir: logDir('postgres'),
      ready: () => postgresReady(c, secrets),
    },
    {
      name: 'valkey',
      after: [],
      command: [rt(c, 'valkey/bin/valkey-server'),
        '--bind', LOOPBACK, '--port', String(ports.valkey), '--protected-mode', 'yes',
        '--dir', dataPath(c, 'valkey'), '--appendonly', 'yes', '--appendfsync', 'everysec', '--daemonize', 'no'],
      cwd: dataPath(c, 'valkey'),
      env: { PATH: SYSTEM_PATH },
      port: ports.valkey,
      health: { type: 'command', command: [rt(c, 'valkey/bin/valkey-cli'), '-h', LOOPBACK, '-p', String(ports.valkey), '-e', 'ping'], env: { PATH: SYSTEM_PATH } },
      stop: { signal: 'SIGTERM', graceMs: 15000 },
      logDir: logDir('valkey'),
    },
    {
      name: 'login',
      after: ['postgres', 'valkey'],
      command: [pythonBin(c, 'houdini'), '-s', res(c, 'houdini/bootstrap.py'), 'login', '--name', 'Login', '--port', String(ports.login),
        ...houdiniArgs(['--logging-general', path.join(logDir('login'), 'general.log'), '--logging-error', path.join(logDir('login'), 'errors.log')])],
      cwd: res(c, 'houdini'),
      env: pythonEnvironment(c, 'houdini', { PYTHONPYCACHEPREFIX: dataPath(c, 'cache/pycache') }),
      port: ports.login,
      health: { type: 'tcp', port: ports.login },
      stop: { signal: 'SIGINT', graceMs: 10000 },
      logDir: logDir('login'),
    },
    {
      name: 'world',
      after: ['login'],
      command: [pythonBin(c, 'houdini'), '-s', res(c, 'local/houdini_bootstrap.py'), 'world', '-id', String(SERVER_ID), '--name', SERVER_NAME,
        '--port', String(ports.world), '--lang', 'en',
        ...houdiniArgs(['--logging-general', path.join(logDir('world'), 'general.log'), '--logging-error', path.join(logDir('world'), 'errors.log')])],
      cwd: res(c, 'houdini'),
      env: pythonEnvironment(c, 'houdini', {
        PYTHONPYCACHEPREFIX: dataPath(c, 'cache/pycache'),
        CP_HOUDINI_ROOT: res(c, 'houdini'),
        CP_NATIVE_IGLOOS_FILE: path.join(nativeIgloos, 'published.json'),
      }),
      port: ports.world,
      health: { type: 'tcp', port: ports.world },
      stop: { signal: 'SIGINT', graceMs: 10000 },
      logDir: logDir('world'),
    },
    {
      name: 'dash',
      after: ['postgres', 'valkey'],
      command: [pythonBin(c, 'dash'), '-s', res(c, 'local/native/dash_launch.py'), '-c', '../local/dash_config.py'],
      cwd: res(c, 'dash'),
      env: pythonEnvironment(c, 'dash', {
        PYTHONPYCACHEPREFIX: dataPath(c, 'cache/pycache'),
        ...connection,
        CP_DASH_ROOT: res(c, 'dash'),
        CP_DASH_ADDRESS: LOOPBACK, CP_DASH_PORT: String(ports.dash),
        CP_PLAY_LINK: `http://localhost:${ports.web}`,
        CP_CJS_HOST: LOOPBACK, CP_CJS_PORT: String(ports.snow),
        CP_DASH_ITEMS: path.join(c.mediaRoot, 'media/avatar/paper'),
      }),
      port: ports.dash,
      // Dash has no health route; any HTTP answer (it 404s unknown paths) proves it is serving.
      health: { type: 'http', url: `http://${LOOPBACK}:${ports.dash}/`, anyStatus: true },
      stop: { signal: 'SIGINT', graceMs: 10000 },
      logDir: logDir('dash'),
    },
    {
      name: 'snowflake',
      after: ['postgres', 'valkey'],
      command: [pythonBin(c, 'snowflake'), '-s', res(c, 'local/snowflake_bootstrap.py')],
      cwd: res(c, 'snowflake'),
      env: pythonEnvironment(c, 'snowflake', {
        PYTHONPYCACHEPREFIX: dataPath(c, 'cache/pycache'),
        ...connection,
        POSTGRES_DBNAME: secrets.database,
        PORT: String(ports.snow),
        MEDIA_LOCATION: `http://localhost:${ports.web}/media`,
        CP_SNOWFLAKE_ROOT: res(c, 'snowflake'),
        CP_SNOWFLAKE_BIND: LOOPBACK,
        CP_SNOWFLAKE_NO_DOTENV: '1',
        // ENABLE_POLICY_SERVER stays unset (False): the Flash policy listener on 843 is off.
      }),
      port: ports.snow,
      health: { type: 'tcp', port: ports.snow },
      stop: { signal: 'SIGINT', graceMs: 10000 },
      logDir: logDir('snowflake'),
    },
    {
      name: 'web',
      after: ['login', 'world', 'dash', 'snowflake'],
      command: [rt(c, 'node/bin/node'), res(c, 'local/web/server.mjs')],
      cwd: res(c, 'local/web'),
      env: {
        PATH: SYSTEM_PATH,
        PORT: String(ports.web), BIND_ADDRESS: LOOPBACK,
        PROJECT_ROOT: c.resources, RUFFLE_ROOT: c.ruffleRoot, MEDIA_ROOT: c.mediaRoot,
        CLIENT_BRIDGE_ROOT: c.clientBridgeRoot, BRIDGE_PUBLIC_ROOT: c.bridgePublicRoot,
        PUBLIC_ORIGIN: `http://localhost:${ports.web}`,
        AGENT_ORIGIN: `http://localhost:${ports.engine}`,
        LOGIN_HOST: LOOPBACK, LOGIN_PORT: String(ports.login),
        WORLD_HOST: LOOPBACK, WORLD_PORT: String(ports.world),
        SNOW_HOST: LOOPBACK, SNOW_PORT: String(ports.snow),
        DASH_ORIGIN: `http://${LOOPBACK}:${ports.dash}`,
      },
      port: ports.web,
      health: { type: 'http', url: `http://${LOOPBACK}:${ports.web}/healthz` },
      stop: { signal: 'SIGTERM', graceMs: 5000 },
      logDir: logDir('web'),
    },
  ];
  return services;
}

/** The environment the controller adds for the engine process. */
export function engineEnvironment(rawConfig) {
  const c = resolve(rawConfig);
  const { ports } = c;
  return {
    CP_ENGINE_PORT: String(ports.engine),
    CP_PROVISION_COMMAND: JSON.stringify([pythonBin(c, 'houdini'), '-s', res(c, 'local/game_provision.py')]),
    CP_PROVISION_ENV_FILE: dataPath(c, 'secrets/provision-env.json'),
    CP_WEB_ORIGIN: `http://localhost:${ports.web}`,
    CP_GAME_HOST: LOOPBACK,
    CP_LOGIN_PORT: String(ports.login), CP_WORLD_PORT: String(ports.world), CP_SNOW_PORT: String(ports.snow),
    LOGIN_PORT: String(ports.login), WORLD_PORT: String(ports.world), SNOW_PORT: String(ports.snow),
    CP_NATIVE_IGLOOS_DIR: dataPath(c, 'native-igloos'),
    MEDIA_ROOT: c.mediaRoot, CLIENT_BRIDGE_ROOT: c.clientBridgeRoot, RUFFLE_ROOT: c.ruffleRoot, BRIDGE_PUBLIC_ROOT: c.bridgePublicRoot,
    CP_BUNDLED_GIT_DIR: rt(c, 'git-only'),
    CP_ENGINE_GIT: rt(c, 'git/bin/git'),
  };
}

// ---------------------------------------------------------------- data preparation

async function exists(file) { try { await stat(file); return true; } catch { return false; } }

function runProcess(command, args, { env, input, signal, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, signal, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', d => { output += d; });
    child.stderr.on('data', d => { output += d; });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve(output) : reject(new Error(`${path.basename(command)} exited ${code}: ${output.trim().slice(-600)}`))));
    child.stdin.end(input ?? '');
  });
}

/** Creates db.json once (mode 0600); an existing file is validated and left alone. */
export async function ensureSecrets(rawConfig) {
  const c = resolve(rawConfig);
  const file = secretsPath(c);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), 0o700);
  try {
    const existing = JSON.parse(await readFile(file, 'utf8'));
    for (const key of ['user', 'database', 'password']) if (typeof existing[key] !== 'string' || !existing[key]) throw new Error(`${file} lacks "${key}"`);
    await chmod(file, 0o600);
    return existing;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const secrets = { user: DB_USER, database: DB_NAME, password: randomBytes(24).toString('hex') };
  const handle = await open(file, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, 0o600);
  try { await handle.writeFile(JSON.stringify(secrets) + '\n'); } finally { await handle.close(); }
  return secrets;
}

/**
 * The engine's game-provisioning environment (secrets/provision-env.json, mode 0600). It holds absolute
 * runtime paths, so the controller rewrites it before every engine start: an app that was moved or
 * renamed since setup must never provision through its old location.
 */
export async function writeProvisionEnv(rawConfig, secrets = readSecrets(resolve(rawConfig))) {
  const c = resolve(rawConfig);
  const file = dataPath(c, 'secrets/provision-env.json');
  await writePrivateJson(file, {
    POSTGRES_HOST: LOOPBACK, POSTGRES_PORT: String(c.ports.postgres), POSTGRES_USER: secrets.user,
    POSTGRES_DB: secrets.database, POSTGRES_PASSWORD: secrets.password,
    PYTHONPATH: rt(c, 'envs/houdini'), PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1',
  });
  return file;
}

async function writePrivateJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  const handle = await open(temp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_TRUNC, 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); } finally { await handle.close(); }
  await rename(temp, file);
}

const MANAGED_BLOCK = ['# --- managed by Claude Penguin (loopback only) ---',
  `listen_addresses = '${LOOPBACK}'`, "unix_socket_directories = ''", "password_encryption = 'scram-sha-256'",
  'max_connections = 60', "shared_buffers = '64MB'", ''].join('\n');

/**
 * Idempotent first-run setup. Creates directories, db.json and, only when no
 * cluster exists, a loopback-only scram-authenticated Postgres cluster. An
 * existing data directory is never replaced.
 */
export async function prepareData(rawConfig, { onProgress = () => {}, signal } = {}) {
  const c = resolve(rawConfig);
  const progress = (label, done, total = 4) => onProgress({ event: 'progress', task: 'database', label, done, total });
  await mkdir(c.data, { recursive: true });
  for (const sub of ['secrets', 'valkey', 'native-igloos', 'cache/pycache', 'bridge-public',
    ...['postgres', 'valkey', 'login', 'world', 'dash', 'snowflake', 'web'].map(n => `logs/${n}`)]) {
    await mkdir(dataPath(c, sub), { recursive: true });
  }
  await chmod(dataPath(c, 'secrets'), 0o700);
  await chmod(dataPath(c, 'valkey'), 0o700);
  progress('Preparing credentials', 1);
  const secrets = await ensureSecrets(c);

  const cluster = dataPath(c, 'postgres');
  if (await exists(path.join(cluster, 'PG_VERSION'))) {
    progress('Database already initialized', 2);
  } else {
    if (await exists(cluster) && (await readdir(cluster)).length > 0) {
      throw new Error(`${cluster} exists and is not a Postgres data directory; refusing to touch it.`);
    }
    progress('Initializing the database', 2);
    const temp = dataPath(c, 'postgres.initdb-tmp');
    await rm(temp, { recursive: true, force: true });   // only ever our own crashed attempt
    const pwfile = dataPath(c, 'secrets/initdb.pw');
    await rm(pwfile, { force: true });
    await writeFile(pwfile, secrets.password + '\n', { mode: 0o600, flag: 'wx' });
    try {
      await runProcess(rt(c, 'postgres/bin/initdb'), ['-D', temp, '-U', secrets.user, '--pwfile', pwfile,
        '--auth-host=scram-sha-256', '--auth-local=reject', '--locale=en_US.UTF-8', '--encoding=UTF8', '--no-sync'],
      { env: { PATH: SYSTEM_PATH, LANG: 'en_US.UTF-8' }, signal });
    } finally { await rm(pwfile, { force: true }); }
    const conf = path.join(temp, 'postgresql.conf');
    await writeFile(conf, (await readFile(conf, 'utf8')) + '\n' + MANAGED_BLOCK);
    await rm(cluster, { recursive: true, force: true });  // empty or absent (checked above)
    await rename(temp, cluster);
  }
  progress('Writing provisioning settings', 3);
  await writeProvisionEnv(c, secrets);
  progress('Data directory ready', 4);
  return { secretsPath: secretsPath(c), postgresDir: cluster };
}

/** Postgres `ready` hook: database, one-time schema load, fixture accounts. All idempotent. */
export async function postgresReady(c, secrets, run = runProcess) {
  const env = { PATH: SYSTEM_PATH, PGPASSWORD: secrets.password, PGCONNECT_TIMEOUT: '10' };
  const psql = (database, args, input) => run(rt(c, 'postgres/bin/psql'),
    ['-h', LOOPBACK, '-p', String(c.ports.postgres), '-U', secrets.user, '-d', database, '-v', 'ON_ERROR_STOP=1', '-X', '-A', '-t', ...args], { env, input });
  const found = (await psql('postgres', ['-c', `SELECT 1 FROM pg_database WHERE datname = '${secrets.database.replace(/'/g, "''")}'`])).trim();
  if (found !== '1') await psql('postgres', ['-c', `CREATE DATABASE "${secrets.database.replace(/"/g, '""')}"`]);
  // houdini.sql starts with DROP TABLE IF EXISTS, so it may only ever run on an empty schema.
  const tables = Number((await psql(secrets.database, ['-c', "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"])).trim());
  if (tables === 0) await psql(secrets.database, ['-1', '-q', '-f', path.join(c.resources, 'houdini/houdini.sql')]);
  await run(pythonBin(c, 'houdini'), ['-s', path.join(c.resources, 'local/verify_seed.py')], {
    env: pythonEnvironment(c, 'houdini', { POSTGRES_HOST: LOOPBACK, POSTGRES_PORT: String(c.ports.postgres), POSTGRES_USER: secrets.user, POSTGRES_DB: secrets.database, POSTGRES_PASSWORD: secrets.password }),
  });
}
