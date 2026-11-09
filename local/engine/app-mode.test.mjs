// App-mode behavior: configuration, Claude's environment, sign-in and Git reporting,
// native provisioning with a fake command, and the controller endpoint. No real Claude,
// Docker, or login shell profile is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createManager } from './manager.mjs';
import { migrateStateDir } from './state.mjs';
import { createGameProvisioner } from './game.mjs';
import { createEngineServer } from './server.mjs';
import { FakePty, fakeGame, legacyState, memoryPublisher, sandbox } from './testing.mjs';
import {
  captureLoginShellEnvironment, claudeEnvironment, detectClaudeGit, insertBeforeUsrBin, isAppMode, parseProvisionCommand, prepareClaudeRuntime,
  readNetworkConfig, readProvisionEnvFile, resumeCommandFor, serverNetworkOptions, signInReport, versionFromPath,
} from './app-mode.mjs';

// ---------------------------------------------------------------- configuration

test('network configuration is validated and unset values stay undefined', () => {
  assert.deepEqual(readNetworkConfig({}), { webOrigin: undefined, gameHost: undefined, loginPort: undefined, worldPort: undefined, snowPort: undefined });
  assert.deepEqual(serverNetworkOptions(readNetworkConfig({})), {});
  const config = readNetworkConfig({ CP_WEB_ORIGIN: 'http://localhost:47080/', CP_GAME_HOST: '127.0.0.1', CP_LOGIN_PORT: '47112', CP_WORLD_PORT: '47875', CP_SNOW_PORT: '47002' });
  assert.deepEqual(serverNetworkOptions(config), { dashOrigin: 'http://localhost:47080', loginHost: '127.0.0.1', worldHost: '127.0.0.1', snowHost: '127.0.0.1',
    loginPort: 47112, worldPort: 47875, snowPort: 47002 });
  for (const bad of [{ CP_WEB_ORIGIN: 'https://localhost:1' }, { CP_WEB_ORIGIN: 'http://example.com' }, { CP_WEB_ORIGIN: 'http://localhost:1/x' }, { CP_WEB_ORIGIN: 'nope' },
    { CP_GAME_HOST: '0.0.0.0' }, { CP_GAME_HOST: 'example.com' }, { CP_LOGIN_PORT: '80' }, { CP_WORLD_PORT: 'abc' }, { CP_SNOW_PORT: '70000' }, { CP_LOGIN_PORT: '1e4' }]) {
    assert.throws(() => readNetworkConfig(bad), /must be/, JSON.stringify(bad));
  }
  assert.equal(isAppMode({}), false);
  assert.equal(isAppMode({ CP_LOGIN_SHELL_ENV: '1' }), true);
  assert.equal(isAppMode({ CP_CLAUDE_CONFIG_DIR: '/x' }), true);
});

test('the provision command is a JSON argv with an absolute program', () => {
  assert.equal(parseProvisionCommand(undefined), null);
  assert.deepEqual(parseProvisionCommand('["/usr/bin/python3","-s","x.py"]'), ['/usr/bin/python3', '-s', 'x.py']);
  for (const bad of ['python3', '[]', '["python3"]', '[1]', '{"a":1}', '[""]']) assert.throws(() => parseProvisionCommand(bad), /CP_PROVISION_COMMAND/, bad);
});

test('the provision environment file must be a private regular file of strings owned by the user', t => {
  const s = sandbox(t, 'penguin-envfile-');
  const file = path.join(s.dir, 'env.json');
  fs.writeFileSync(file, JSON.stringify({ POSTGRES_PASSWORD: 'pw', PGPORT: '47432' }), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  assert.deepEqual(readProvisionEnvFile(file), { POSTGRES_PASSWORD: 'pw', PGPORT: '47432' });
  fs.chmodSync(file, 0o640);
  assert.throws(() => readProvisionEnvFile(file), /mode 0600/);
  fs.chmodSync(file, 0o600);
  assert.throws(() => readProvisionEnvFile(file, { uid: process.getuid() + 1 }), /owned by the current user/);
  const link = path.join(s.dir, 'link.json');
  fs.symlinkSync(file, link);
  assert.throws(() => readProvisionEnvFile(link), /regular file/);
  fs.writeFileSync(file, '{"A":1}', { mode: 0o600 });
  assert.throws(() => readProvisionEnvFile(file), /string values/);
  fs.writeFileSync(file, '[]', { mode: 0o600 });
  assert.throws(() => readProvisionEnvFile(file), /JSON object/);
  assert.throws(() => readProvisionEnvFile(path.join(s.dir, 'missing.json')), /cannot be read/);
});

// ---------------------------------------------------------------- native provisioning

test('native provisioning runs the fake command with the stdin request and the env file, which never reaches process.env', async t => {
  const s = sandbox(t, 'penguin-native-');
  const out = path.join(s.dir, 'seen.json');
  const script = path.join(s.dir, 'fake-provision.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
fs.writeFileSync(process.env.SEEN_FILE, JSON.stringify({ request, password: process.env.POSTGRES_PASSWORD ?? null, args: process.argv.slice(2) }));
if (request.op === 'fail') { console.error('boom ' + process.env.POSTGRES_PASSWORD); process.exit(3); }
console.log('noise');
console.log(JSON.stringify({ status: 'ok', username: 'bridgecheck', penguinId: 107, created: false }));
`);
  const envFile = path.join(s.dir, 'provision-env.json');
  fs.writeFileSync(envFile, JSON.stringify({ POSTGRES_PASSWORD: 'sekret-value', SEEN_FILE: out }), { mode: 0o600 });
  fs.chmodSync(envFile, 0o600);
  const provisioner = createGameProvisioner({ root: s.dir, provisionCommand: [process.execPath, script, 'extra'], provisionEnvFile: envFile, env: { PATH: process.env.PATH } });
  t.after(() => provisioner.close());
  assert.deepEqual(await provisioner.ensureVisitor(), { penguinId: 107, username: 'bridgecheck', created: false });
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(seen.request.op, 'visitor');
  assert.equal(seen.password, 'sekret-value', 'the command received the file environment');
  assert.deepEqual(seen.args, ['extra']);
  assert.equal(process.env.POSTGRES_PASSWORD, undefined, 'the engine environment never holds file values');
  assert.equal(process.env.SEEN_FILE, undefined);
});

test('native provisioning errors: a refused env file and a missing program are provisioning failures', async t => {
  const s = sandbox(t, 'penguin-native-bad-');
  const envFile = path.join(s.dir, 'loose.json');
  fs.writeFileSync(envFile, '{}', { mode: 0o644 });
  fs.chmodSync(envFile, 0o644);
  const loose = createGameProvisioner({ root: s.dir, provisionCommand: [process.execPath, '-e', ''], provisionEnvFile: envFile, env: {} });
  await assert.rejects(loose.ensureVisitor(), error => error.code === 'UNAVAILABLE' && /mode 0600/.test(error.message));
  const missing = createGameProvisioner({ root: s.dir, provisionCommand: [path.join(s.dir, 'no-such-program')], env: {} });
  await assert.rejects(missing.ensureVisitor(), error => error.code === 'UNAVAILABLE' && /Could not run the provisioning service/.test(error.message));
  assert.throws(() => createGameProvisioner({ root: s.dir, provisionCommand: ['relative'], env: {} }), /absolute/);
});

test('the fake command output is parsed from the last JSON line and failures redact secrets', async t => {
  const s = sandbox(t, 'penguin-native-fail-');
  const script = path.join(s.dir, 'fail.mjs');
  fs.writeFileSync(script, "console.error('Traceback: password sekret-value rejected'); process.exit(3);\n");
  const envFile = path.join(s.dir, 'e.json');
  fs.writeFileSync(envFile, JSON.stringify({ POSTGRES_PASSWORD: 'sekret-value' }), { mode: 0o600 });
  fs.chmodSync(envFile, 0o600);
  const provisioner = createGameProvisioner({ root: s.dir, provisionCommand: [process.execPath, script], provisionEnvFile: envFile, env: {} });
  await assert.rejects(provisioner.ensureVisitor(), error => /exit 3/.test(error.message) && !error.message.includes('sekret-value') && error.message.includes('[redacted]'));
});

// ---------------------------------------------------------------- Claude's environment

test('Claude never receives CP_, POSTGRES_ or CLAUDE_PENGUIN_ variables, but sign-in variables pass through unchanged', () => {
  const base = { PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/me', CP_ENGINE_STATE_DIR: '/x', CP_CLAUDE_PATH: '/c', CP_PROVISION_ENV_FILE: '/e', POSTGRES_PASSWORD: 'pw',
    CLAUDE_PENGUIN_HOOK_TOKEN: 't', CLAUDECODE: '1', TERM_PROGRAM: 'x', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 'a', CLAUDE_CODE_OAUTH_TOKEN: 'o',
    CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_PROFILE: 'p', AWS_PROFILE: 'work' };
  const env = claudeEnvironment({ base, settings: {} });
  for (const key of Object.keys(env)) assert.doesNotMatch(key, /^(CP_|POSTGRES_|CLAUDE_PENGUIN_)/);
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_PROFILE', 'AWS_PROFILE']) assert.equal(env[key], base[key], key);
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(env.DISABLE_UPDATES, undefined);
  const app = claudeEnvironment({ base, settings: { CP_CLAUDE_CONFIG_DIR: '/data/claude/config', CP_CLAUDE_DISABLE_UPDATES: '1' } });
  assert.equal(app.CLAUDE_CONFIG_DIR, '/data/claude/config');
  assert.equal(app.DISABLE_UPDATES, '1');
  assert.equal(claudeEnvironment({ base, settings: { CP_CLAUDE_DISABLE_UPDATES: '0' } }).DISABLE_UPDATES, undefined);
  assert.equal(insertBeforeUsrBin('/a:/usr/bin:/bin', '/g'), '/a:/g:/usr/bin:/bin');
  assert.equal(insertBeforeUsrBin('/a:/bin', '/g'), '/a:/bin:/g');
  assert.equal(claudeEnvironment({ base, settings: {}, pathDir: '/g' }).PATH, '/opt/homebrew/bin:/g:/usr/bin');
});

test('the login-shell capture reads only between markers, drops volatile variables, and falls back with a warning', async t => {
  const s = sandbox(t, 'penguin-shell-');
  const shell = path.join(s.dir, 'fake-shell');
  // Prints profile noise, then evaluates the -c command, with a modified environment.
  fs.writeFileSync(shell, `#!/bin/sh
echo "Welcome banner"; echo "oh-my-zsh updated" >&2
for last; do :; done
[ "$1 $2 $3" = "-i -l -c" ] || exit 9
export PATH=/opt/fake/bin:/usr/bin FROM_PROFILE='two words' SHLVL=7 OLDPWD=/old CP_NOT_FOR_CLAUDE=1
eval "$last"
echo "trailing noise"
`, { mode: 0o755 });
  const result = await captureLoginShellEnvironment({ shell });
  assert.equal(result.warning, null);
  assert.equal(result.env.PATH, '/opt/fake/bin:/usr/bin');
  assert.equal(result.env.FROM_PROFILE, 'two words');
  for (const key of ['SHLVL', 'PWD', 'OLDPWD', '_']) assert.equal(result.env[key], undefined, key);
  assert.equal(JSON.stringify(result.env).includes('Welcome'), false);

  // Failure modes never throw.
  const failing = path.join(s.dir, 'bad-shell');
  fs.writeFileSync(failing, '#!/bin/sh\necho nothing\n', { mode: 0o755 });
  const bad = await captureLoginShellEnvironment({ shell: failing });
  assert.equal(bad.env, null);
  assert.match(bad.warning, /Could not read your login-shell environment/);
  const hang = path.join(s.dir, 'hang-shell');
  fs.writeFileSync(hang, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const slow = await captureLoginShellEnvironment({ shell: hang, timeoutMs: 300 });
  assert.equal(slow.env, null);
  assert.match(slow.warning, /did not finish/);
  assert.equal((await captureLoginShellEnvironment({ shell: path.join(s.dir, 'absent') })).env, null);
});

test('prepareClaudeRuntime uses the captured environment as the base, or falls back with a status warning', async () => {
  const detectGit = async () => ({ source: 'user', path: '/opt/homebrew/bin/git', pathDir: null });
  const ok = await prepareClaudeRuntime({ settings: { CP_LOGIN_SHELL_ENV: '1', CP_CLAUDE_CONFIG_DIR: '/cfg' }, claudePath: '/d/claude/versions/2.1.5/claude',
    capture: async () => ({ env: { PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk-secret', CP_X: '1' }, warning: null }), detectGit });
  const env = ok.environment();
  assert.equal(env.HOME, '/h');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/cfg');
  assert.equal(env.CP_X, undefined);
  assert.equal(ok.appMode, true);
  const report = ok.report();
  assert.deepEqual(report.signIn, { method: 'api-key', overriddenBy: ['ANTHROPIC_API_KEY'], variable: 'ANTHROPIC_API_KEY' });
  assert.equal(JSON.stringify(report).includes('sk-secret'), false, 'values never appear in the report');
  assert.deepEqual(report.claude, { path: '/d/claude/versions/2.1.5/claude', version: '2.1.5' });
  assert.deepEqual(report.git, { source: 'user', path: '/opt/homebrew/bin/git' });
  const fallback = await prepareClaudeRuntime({ settings: { CP_LOGIN_SHELL_ENV: '1' }, capture: async () => ({ env: null, warning: 'shell failed' }), detectGit });
  assert.deepEqual(fallback.report().warnings, ['shell failed']);
  assert.equal(fallback.loginShell, false);
  const plain = await prepareClaudeRuntime({ settings: {}, detectGit, versionOf: async () => '9.9.9' });
  assert.equal(plain.appMode, false);
  assert.equal(plain.report().claude.version, '9.9.9');
  await assert.rejects(prepareClaudeRuntime({ settings: { CP_CLAUDE_CONFIG_DIR: 'relative' }, detectGit }), /absolute/);
  const missing = await prepareClaudeRuntime({ settings: {}, detectGit: async () => ({ source: 'missing', path: null, pathDir: null }) });
  assert.match(missing.report().warnings[0], /cannot find Git/);
  assert.equal(versionFromPath('claude'), null);
});

// ---------------------------------------------------------------- sign-in

test('sign-in reporting follows the documented precedence and reports names only', () => {
  assert.deepEqual(signInReport({ PATH: '/x' }), { method: 'login', overriddenBy: [], variable: null });
  assert.equal(signInReport({ CLAUDE_CODE_OAUTH_TOKEN: 'x' }).method, 'oauth-token');
  assert.equal(signInReport({ CLAUDE_CODE_OAUTH_TOKEN: 'x', ANTHROPIC_API_KEY: 'k' }).method, 'api-key');
  assert.equal(signInReport({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 'a' }).method, 'auth-token');
  const cloud = signInReport({ ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_BEDROCK: 'true' });
  assert.equal(cloud.method, 'bedrock');
  assert.deepEqual(cloud.overriddenBy, ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_API_KEY']);
  assert.equal(signInReport({ CLAUDE_CODE_USE_FOUNDRY: '1' }).method, 'foundry');
  assert.equal(signInReport({ CLAUDE_CODE_USE_BEDROCK: '0' }).method, 'login', 'a disabled provider flag is not a sign-in');
  assert.equal(signInReport({ ANTHROPIC_API_KEY: '' }).method, 'login');
  assert.equal(signInReport({ ANTHROPIC_PROFILE: 'work' }).method, 'profile');
  assert.equal(signInReport({ ANTHROPIC_FEDERATION_RULE_ID: 'r' }).method, 'login', 'federation needs both variables');
  const fed = signInReport({ ANTHROPIC_FEDERATION_RULE_ID: 'r', ANTHROPIC_ORGANIZATION_ID: 'o' });
  assert.deepEqual([fed.method, fed.overriddenBy], ['federation', ['ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID']]);
  assert.equal(JSON.stringify(signInReport({ ANTHROPIC_API_KEY: 'sk-ant-secret' })).includes('secret'), false);
});

// ---------------------------------------------------------------- Git for Claude

test('Git detection never runs /usr/bin/git and covers every branch', async () => {
  const calls = [];
  const exe = set => file => set.includes(file);
  const run = (output, fail = false) => async (file, args) => { calls.push([file, ...args]); if (fail) throw new Error('no developer tools'); return output; };
  // A real Git before the stub, or without one: the user's.
  assert.deepEqual(await detectClaudeGit({ pathValue: '/opt/homebrew/bin:/usr/bin', isExecutable: exe(['/opt/homebrew/bin/git', '/usr/bin/git']), run: run('') }),
    { source: 'user', path: '/opt/homebrew/bin/git', pathDir: null });
  assert.deepEqual(calls, [], 'xcode-select is not needed when a real Git comes first');
  // The stub with Command Line Tools: user.
  const tools = await detectClaudeGit({ pathValue: '/usr/bin:/bin', isExecutable: exe(['/usr/bin/git', '/Library/Developer/CommandLineTools/usr/bin/git']), bundledDir: '/b', run: run('/Library/Developer/CommandLineTools\n') });
  assert.deepEqual(tools, { source: 'user', path: '/Library/Developer/CommandLineTools/usr/bin/git', pathDir: null });
  assert.deepEqual(calls, [['/usr/bin/xcode-select', '-p']]);
  // The stub, xcode-select succeeds but the binary is absent: bundled.
  assert.deepEqual(await detectClaudeGit({ pathValue: '/usr/bin', isExecutable: exe(['/usr/bin/git']), bundledDir: '/b', run: run('/Applications/Xcode.app/Contents/Developer') }),
    { source: 'bundled', path: '/b/git', pathDir: '/b' });
  // The stub, xcode-select fails: bundled, or missing without a bundle.
  assert.equal((await detectClaudeGit({ pathValue: '/usr/bin', isExecutable: exe(['/usr/bin/git']), bundledDir: '/b', run: run('', true) })).source, 'bundled');
  assert.deepEqual(await detectClaudeGit({ pathValue: '/usr/bin', isExecutable: exe(['/usr/bin/git']), run: run('', true) }), { source: 'missing', path: null, pathDir: null });
  // No git on PATH at all.
  assert.equal((await detectClaudeGit({ pathValue: '/bin', isExecutable: exe([]), bundledDir: '/b', run: run('') })).source, 'bundled');
  assert.equal((await detectClaudeGit({ pathValue: '/bin', isExecutable: exe([]), run: run('') })).source, 'missing');
  for (const call of calls) assert.notEqual(call[0], '/usr/bin/git');
});

// ---------------------------------------------------------------- resume command

test('the resume command names the managed Claude and configuration with safe quoting', () => {
  const base = { workspacePath: '/w/tree', sessionId: 'abc' };
  assert.equal(resumeCommandFor(base), "cd '/w/tree' && claude --resume abc");
  assert.equal(resumeCommandFor({ ...base, claudePath: '/data/claude/versions/2.1.5/claude', configDir: '/data/claude/config' }),
    "cd '/w/tree' && CLAUDE_CONFIG_DIR='/data/claude/config' '/data/claude/versions/2.1.5/claude' --resume abc");
  assert.equal(resumeCommandFor({ ...base, claudePath: '/data/claude/versions/2.1.5/claude', configDir: '/data/claude/config', disableUpdates: true }),
    "cd '/w/tree' && CLAUDE_CONFIG_DIR='/data/claude/config' DISABLE_UPDATES=1 '/data/claude/versions/2.1.5/claude' --resume abc");
  assert.equal(resumeCommandFor({ workspacePath: "/Users/o'neil/My Work/tree", sessionId: 'abc', claudePath: "/Users/o'neil/Application Support/claude", configDir: "/Users/o'neil/App Support/cfg" }),
    "cd '/Users/o'\\''neil/My Work/tree' && CLAUDE_CONFIG_DIR='/Users/o'\\''neil/App Support/cfg' '/Users/o'\\''neil/Application Support/claude' --resume abc");
});

// ---------------------------------------------------------------- manager integration

async function managed(t, extra = {}) {
  const s = sandbox(t, 'penguin-appmode-');
  const spawned = [];
  const stateDir = path.join(s.dir, 'state');
  const options = { stateDir, worktreeRoot: path.join(s.dir, 'worktrees'), gitEnv: s.gitEnv, hookBaseUrl: 'http://localhost:8081/engine/hooks',
    ptySpawn: (command, args, spawnOptions) => { const proc = new FakePty(); spawned.push({ proc, command, args, options: spawnOptions }); return proc; },
    game: fakeGame(), publisher: memoryPublisher(), ...extra };
  const manager = await createManager(options);
  t.after(() => manager.close());
  return { ...s, manager, spawned, stateDir, options };
}

test('the manager gives Claude the managed environment plus only its hook variables', async t => {
  const runtime = await prepareClaudeRuntime({ settings: { CP_CLAUDE_CONFIG_DIR: '/cfg', CP_CLAUDE_DISABLE_UPDATES: '1', CP_LOGIN_SHELL_ENV: '1' },
    capture: async () => ({ env: { PATH: '/usr/bin:/bin', HOME: '/h', POSTGRES_USER: 'x', CP_SECRET: 's' }, warning: null }),
    detectGit: async () => ({ source: 'bundled', path: '/b/git', pathDir: '/b' }) });
  const e = await managed(t, { claudeRuntime: runtime, claudePath: '/data/claude/versions/1.0.0/claude' });
  const repo = e.repo('app');
  const project = await e.manager.registerProject({ path: repo });
  await e.manager.settled(project.id);
  const adoption = await e.manager.reserveAdoption({ projectId: project.id, typeId: 0, subtypeId: 0, name: 'Atlas' });
  const reply = e.options.game.purchase(e.options.publisher.payload, { adoptionId: adoption.id, typeId: 0, subtypeId: 0, name: 'Atlas' });
  await e.manager.reportAdoption({ adoptionId: adoption.id, result: reply });
  await e.manager.settled(project.id);
  const worker = e.manager.snapshot().workers[0];
  await e.manager.start({ projectId: project.id, workerId: worker.id });
  const { command, options } = e.spawned.at(-1);
  assert.equal(command, '/data/claude/versions/1.0.0/claude');
  const hookKeys = ['CLAUDE_PENGUIN_HOOK_URL', 'CLAUDE_PENGUIN_WORKER_ID', 'CLAUDE_PENGUIN_HOOK_TOKEN'];
  assert.deepEqual(Object.keys(options.env).filter(key => /^(CP_|POSTGRES_|CLAUDE_PENGUIN_)/.test(key)).sort(), hookKeys.sort());
  assert.equal(options.env.CLAUDE_PENGUIN_WORKER_ID, worker.id);
  assert.equal(options.env.CLAUDE_CONFIG_DIR, '/cfg');
  assert.equal(options.env.DISABLE_UPDATES, '1');
  assert.equal(options.env.PATH, '/b:/usr/bin:/bin');
  assert.deepEqual(e.spawned.at(-1).args.slice(0, 2), ['--permission-mode', 'manual'], 'without a guard, Claude is the terminal\'s program');
});

test('with CP_ENGINE_PTY_GUARD, Claude starts through cp-supervise guard, owned by this engine', async t => {
  const runtime = await prepareClaudeRuntime({ settings: { CP_ENGINE_PTY_GUARD: '/app/runtimes/supervise/cp-supervise' },
    detectGit: async () => ({ source: 'user', path: '/g', pathDir: null }) });
  await assert.rejects(prepareClaudeRuntime({ settings: { CP_ENGINE_PTY_GUARD: 'cp-supervise' }, detectGit: async () => ({ source: 'user', path: '/g', pathDir: null }) }), /absolute/);
  const e = await managed(t, { claudeRuntime: runtime, claudePath: '/data/claude/versions/1.0.0/claude' });
  const project = await e.manager.registerProject({ path: e.repo('guarded') });
  await e.manager.settled(project.id);
  const adoption = await e.manager.reserveAdoption({ projectId: project.id, typeId: 0, subtypeId: 0, name: 'Guard' });
  const reply = e.options.game.purchase(e.options.publisher.payload, { adoptionId: adoption.id, typeId: 0, subtypeId: 0, name: 'Guard' });
  await e.manager.reportAdoption({ adoptionId: adoption.id, result: reply });
  await e.manager.settled(project.id);
  const worker = e.manager.snapshot().workers[0];
  await e.manager.start({ projectId: project.id, workerId: worker.id });
  const { command, args, options } = e.spawned.at(-1);
  assert.equal(command, '/app/runtimes/supervise/cp-supervise');
  assert.deepEqual(args.slice(0, 7), ['guard', '--owner-pid', String(process.pid), '--grace-ms', '1500', '--', '/data/claude/versions/1.0.0/claude']);
  assert.deepEqual(args.slice(7, 9), ['--permission-mode', 'manual']);
  assert.equal(options.env.CP_ENGINE_PTY_GUARD, undefined, 'the setting never reaches Claude');
});

test('an archived conversation resumes with the managed executable, configuration directory and update setting', async t => {
  const runtime = await prepareClaudeRuntime({ settings: { CP_CLAUDE_CONFIG_DIR: '/data/Claude Penguin/cfg', CP_CLAUDE_DISABLE_UPDATES: '1' }, detectGit: async () => ({ source: 'user', path: '/g', pathDir: null }) });
  const e = await managed(t, { claudeRuntime: runtime, claudePath: '/data/Claude Penguin/claude' });
  const source = e.repo('legacy');
  await e.manager.close();
  fs.writeFileSync(path.join(e.stateDir, 'state.json'), JSON.stringify(legacyState(source, { baseCommit: e.git(source, 'rev-parse', 'HEAD').trim() })));
  migrateStateDir(e.stateDir);
  const manager = await createManager(e.options);
  t.after(() => manager.close());
  const [archived] = manager.snapshot().archivedWorkers;
  assert.equal(archived.resumeCommand, `cd '${source}' && CLAUDE_CONFIG_DIR='/data/Claude Penguin/cfg' DISABLE_UPDATES=1 '/data/Claude Penguin/claude' --resume ${archived.sessionId}`);
});

test('the engine Git binary is configurable', async t => {
  await assert.rejects(managed(t, { gitBinary: '/nonexistent/git' }));
});

// ---------------------------------------------------------------- controller endpoint

const request = (url, { headers = {}, method = 'GET' } = {}) => new Promise((resolve, reject) => {
  const req = http.request(url, { method, headers }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }); });
  });
  req.on('error', reject);
  req.end();
});

async function server(t, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'penguin-control-'));
  fs.mkdirSync(path.join(root, 'templates/vanilla-media/play'), { recursive: true });
  fs.writeFileSync(path.join(root, 'templates/vanilla-media/play/index.html.template'), '<html><head></head></html>');
  const manager = { snapshot: () => ({ projects: [], workers: [{ running: true }, { running: false }, { running: true }] }), hook: async () => { throw new Error('no'); } };
  const host = createEngineServer({ manager, root, publicOrigin: 'http://localhost:8081', uiToken: 'ui_token_value', ...options });
  host.server.listen(0, '127.0.0.1');
  await once(host.server, 'listening');
  t.after(async () => { await host.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return `http://127.0.0.1:${host.server.address().port}`;
}

test('the controller status endpoint exists only with a token, is bearer-only, origin-free, and separate from the UI token', async t => {
  const report = { signIn: { method: 'login', overriddenBy: [], variable: null }, git: { source: 'user', path: '/g' }, claude: { path: '/c', version: '1.0.0' }, warnings: [] };
  const none = await server(t, {});
  assert.equal((await request(`${none}/engine/control/status`, { headers: { Host: 'localhost:8081' } })).status, 403, 'not served without a control token');
  const address = await server(t, { controlToken: 'control_token_0123456789', environment: () => report });
  const ok = await request(`${address}/engine/control/status`, { headers: { Host: '127.0.0.1:8081', Authorization: 'Bearer control_token_0123456789' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json(), { sessions: { running: 2, total: 3 }, ...report });
  assert.equal((await request(`${address}/engine/control/status`, { headers: { Host: 'localhost:8081', Authorization: 'Bearer control_token_0123456789' } })).status, 200);
  for (const [label, headers] of [
    ['no token', { Host: 'localhost:8081' }],
    ['wrong token', { Host: 'localhost:8081', Authorization: 'Bearer control_token_0123456780' }],
    ['the UI token', { Host: 'localhost:8081', Authorization: 'Bearer ui_token_value' }],
    ['an Origin header', { Host: 'localhost:8081', Origin: 'http://localhost:8081', Authorization: 'Bearer control_token_0123456789' }],
    ['a null Origin', { Host: 'localhost:8081', Origin: 'null', Authorization: 'Bearer control_token_0123456789' }],
    ['a foreign host', { Host: 'evil.example:8081', Authorization: 'Bearer control_token_0123456789' }],
  ]) assert.notEqual((await request(`${address}/engine/control/status`, { headers })).status, 200, label);
  // The control token does not open the UI API, and the UI token does not open control.
  assert.equal((await request(`${address}/engine/snapshot`, { headers: { Host: 'localhost:8081', Authorization: 'Bearer control_token_0123456789' } })).status, 403);
  assert.equal((await request(`${address}/engine/control/other`, { headers: { Host: 'localhost:8081', Authorization: 'Bearer control_token_0123456789' } })).status, 404);
  assert.equal((await request(`${address}/engine/control/status`, { method: 'POST', headers: { Host: 'localhost:8081', Authorization: 'Bearer control_token_0123456789' } })).status, 405);
});

test('the UI environment endpoint is token-protected, same-site, and only in app mode', async t => {
  const report = { signIn: { method: 'api-key', overriddenBy: ['ANTHROPIC_API_KEY'], variable: 'ANTHROPIC_API_KEY' }, git: { source: 'bundled', path: '/b/git' }, claude: { path: '/c', version: null }, warnings: [] };
  const app = await server(t, { environment: () => report });
  const ui = { Host: 'localhost:8081', Origin: 'http://localhost:8081', Authorization: 'Bearer ui_token_value' };
  assert.deepEqual((await request(`${app}/engine/environment`, { headers: ui })).json(), report);
  assert.equal((await request(`${app}/engine/environment`, { headers: { ...ui, Authorization: 'Bearer wrong' } })).status, 403);
  assert.equal((await request(`${app}/engine/environment`, { headers: { ...ui, Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await request(`${app}/engine/bootstrap`, { headers: { Host: 'localhost:8081' } })).json().appMode, true);
  // Dev mode: no environment and no flag.
  const dev = await server(t, {});
  assert.equal((await request(`${dev}/engine/environment`, { headers: ui })).status, 404);
  assert.equal((await request(`${dev}/engine/bootstrap`, { headers: { Host: 'localhost:8081' } })).json().appMode, undefined);
  // Controller-only environment: not shown in the UI.
  const controller = await server(t, { environment: () => report, controlToken: 'control_token_0123456789', showEnvironment: false });
  assert.equal((await request(`${controller}/engine/environment`, { headers: ui })).status, 404);
});
