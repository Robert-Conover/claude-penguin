import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { alive, buildShim, cleanupRoots, here, killAll, makeEnvironment, portMap, sleep, trackedPids, waitFor } from './fixtures.mjs';

const repo = path.resolve(here, '../..');
const launch = path.join(repo, 'launch');
let shim, env, ports, cliEnv;
const spawned = [];
before(async () => {
  shim = buildShim();
  env = makeEnvironment({ shim });
  ports = await portMap();
  mkdirSync(env.track, { recursive: true });
  // The CLI computes resources from its own location (the real checkout), so tests run the CLI module
  // against scratch runtimes/data and the fake dependency module; the controller's resources stay the checkout
  // but every dependency it would load is replaced.
  cliEnv = { PATH: process.env.PATH, HOME: process.env.HOME, CP_APP_DATA: env.data, CP_RESOURCES: env.resources, CP_RUNTIMES: env.runtimes, CP_PORTS_JSON: JSON.stringify(ports), CP_CONTROLLER_DEPS: path.join(here, 'fake-deps.mjs'), CP_HEALTH_TIMEOUT_MS: '8000', FAKE_GRACE_MS: '600' };
});
after(() => { for (const c of spawned) { try { process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } } killAll(env); cleanupRoots(); });

const run = (...args) => spawnSync(launch, args, { env: cliEnv, encoding: 'utf8', timeout: 60000 });

describe('./launch', () => {
  test('--help and unknown commands', () => {
    const help = run('--help');
    assert.equal(help.status, 0);
    assert.match(help.stdout, /setup \[--mode explore\|code\]/);
    assert.match(help.stdout, /Ctrl-C/);
    assert.equal(run('frobnicate').status, 2);
    assert.equal(run('setup', '--mode', 'turbo').status, 2);
  });

  test('missing runtimes: says to run build-runtimes.sh', () => {
    const r = spawnSync(launch, ['setup'], { env: { ...cliEnv, CP_RUNTIMES: path.join(env.root, 'nowhere') }, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /local\/native\/build-runtimes\.sh/);
  });

  test('status before setup is human-readable and starts nothing', () => {
    const r = run('status');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /setup:\s+not done/);
    assert.match(r.stdout, /controller: not running/);
    assert.doesNotMatch(r.stdout, /^\s*[{[]/m);
  });

  test('setup, start (foreground), status, Ctrl-C stops gracefully; stop refuses an impostor', async () => {
    const setup = run('setup');
    assert.equal(setup.status, 0, setup.stderr + setup.stdout);
    assert.match(setup.stdout, /Setup complete \(explore\)/);
    assert.match(run('status').stdout, /setup:\s+explore mode/);

    const child = spawn(launch, ['start'], { env: cliEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    spawned.push(child);
    let output = '';
    child.stdout.on('data', d => { output += d; });
    child.stderr.on('data', d => { output += d; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    await waitFor(() => /Press Ctrl-C to stop/.test(output), { timeout: 20000, what: 'start to finish' });
    assert.match(output, new RegExp(`Game:\\s+http://localhost:${ports.web}/`));
    const pids = trackedPids(env.track);
    assert.ok(pids.length >= 7 && pids.every(alive));
    const status = run('status');
    assert.match(status.stdout, /controller: running, pid \d+/);
    assert.match(status.stdout, /listening/);

    // stop must verify the recorded controller: an unrelated process with a stale record is left alone.
    const controllerJson = path.join(env.data, 'controller.json');
    const real = readFileSync(controllerJson, 'utf8');
    const innocent = spawn('/bin/sleep', ['300'], { stdio: 'ignore' });
    spawned.push(innocent);
    writeFileSync(controllerJson, JSON.stringify({ ...JSON.parse(real), pid: innocent.pid }));
    const refused = run('stop');
    assert.match(refused.stdout, /No controller is running/);
    assert.ok(alive(innocent.pid), 'the unrelated process was not signalled');
    innocent.kill('SIGKILL');
    writeFileSync(controllerJson, real);

    const stopped = run('stop');
    assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
    assert.match(stopped.stdout, /Stopped/);
    await waitFor(() => pids.every(p => !alive(p)), { what: 'services gone after ./launch stop' });
    await exited; // `start` ends because its controller was told to stop
    assert.match(run('status').stdout, /controller: not running/);
  });

  test('Ctrl-C (SIGINT) on a foreground start stops the services', async () => {
    const child = spawn(launch, ['start'], { env: cliEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    spawned.push(child);
    let output = '';
    child.stdout.on('data', d => { output += d; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    await waitFor(() => /Press Ctrl-C/.test(output), { timeout: 20000, what: 'running' });
    const pids = trackedPids(env.track);
    // `launch` execs node, so the child pid is the CLI itself.
    process.kill(child.pid, 'SIGINT');
    const result = await exited;
    assert.equal(result.code, 0, output);
    assert.ok(pids.every(p => !alive(p)));
    assert.match(output, /Stopping/);
    await sleep(50);
  });
});
