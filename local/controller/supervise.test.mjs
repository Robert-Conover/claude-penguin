import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { alive, allGone, buildShim, cleanupRoots, readPid, sleep, waitFor } from './fixtures.mjs';

let shim, scratch;
const spawned = [];
const pidsToKill = new Set();
before(() => { shim = buildShim(); scratch = mkdtempSync(path.join(os.tmpdir(), 'cps-sup-')); });
after(() => { for (const p of pidsToKill) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } try { process.kill(-p, 'SIGKILL'); } catch { /* gone */ } } for (const c of spawned) { try { process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } } cleanupRoots(); });

// A program that records its pid and a descendant's pid, and ignores SIGTERM/SIGINT in both.
const stubborn = (name, extra = '') => ['-e', `
const { spawn } = require('node:child_process'); const fs = require('node:fs');
process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); ${extra}
const kid = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(path.join(scratch ?? '', name))} + '.pids', process.pid + ' ' + kid.pid);
setInterval(() => {}, 1000);`];

function owner() {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  spawned.push(child);
  return child;
}
function supervise(ownerPid, name, { signal = 'SIGTERM', grace = 500, program, stdio = 'ignore' } = {}) {
  const record = path.join(scratch, `${name}.json`);
  const child = spawn(shim, ['--owner-pid', String(ownerPid), '--record', record, '--stop-signal', signal, '--grace-ms', String(grace), '--', ...program], { stdio: ['ignore', stdio, stdio], detached: true });
  spawned.push(child);
  const exited = new Promise(resolve => child.once('exit', (code, sig) => resolve({ code, sig })));
  return { child, record, exited };
}
const readPids = async name => {
  const file = path.join(scratch, `${name}.pids`);
  await waitFor(() => { try { return readFileSync(file, 'utf8').includes(' '); } catch { return false; } }, { what: `${name} pids` });
  return readFileSync(file, 'utf8').split(' ').map(Number);
};

describe('cp-supervise', () => {
  test('owner SIGKILL: stop signal, grace, then SIGKILL of the whole group', async () => {
    const o = owner();
    const s = supervise(o.pid, 'owner-kill', { program: [process.execPath, ...stubborn('owner-kill')] });
    const [program, kid] = await readPids('owner-kill');
    pidsToKill.add(program);
    assert.ok(alive(program) && alive(kid));
    const sidecar = JSON.parse(readFileSync(`${s.record}.child`, 'utf8'));
    assert.equal(sidecar.pid, program);
    assert.equal(sidecar.pgid, program, 'the program leads a new process group');
    assert.equal(sidecar.shimPid, s.child.pid);
    const started = Date.now();
    process.kill(o.pid, 'SIGKILL');
    const result = await s.exited;
    const took = Date.now() - started;
    assert.equal(result.code, 128 + 9, 'exit status passes through (killed by SIGKILL)');
    assert.ok(took >= 450, `waited the grace period (${took} ms)`);
    assert.ok(took < 3000, `finished promptly (${took} ms)`);
    await waitFor(() => allGone([program, kid]), { what: 'program and descendant gone' });
  });

  test('a program that handles the stop signal exits within the grace period with its own status', async () => {
    const o = owner();
    const s = supervise(o.pid, 'polite', { grace: 3000, program: [process.execPath, '-e', "process.on('SIGTERM',()=>process.exit(42));setInterval(()=>{},1000)"] });
    await waitFor(() => readPid(`${s.record}.child`) !== null || (() => { try { readFileSync(`${s.record}.child`); return true; } catch { return false; } })());
    await sleep(150);
    const started = Date.now();
    process.kill(o.pid, 'SIGKILL');
    const result = await s.exited;
    assert.equal(result.code, 42);
    assert.ok(Date.now() - started < 1500);
  });

  test('SIGUSR1 requests a stop with the configured signal (SIGINT here)', async () => {
    const o = owner();
    const s = supervise(o.pid, 'usr1', { signal: 'SIGINT', program: [process.execPath, '-e', "process.on('SIGINT',()=>process.exit(7));setInterval(()=>{},1000)"] });
    await sleep(300);
    process.kill(s.child.pid, 'SIGUSR1');
    assert.equal((await s.exited).code, 7);
    process.kill(o.pid, 'SIGKILL');
  });

  test('SIGTERM to the shim is forwarded to the program group', async () => {
    const o = owner();
    const s = supervise(o.pid, 'fwd', { program: [process.execPath, '-e', "process.on('SIGTERM',()=>process.exit(9));setInterval(()=>{},1000)"] });
    await sleep(300);
    process.kill(s.child.pid, 'SIGTERM');
    assert.equal((await s.exited).code, 9);
    process.kill(o.pid, 'SIGKILL');
  });

  test('exit status of the program passes through, and leftover group members are swept', async () => {
    const o = owner();
    const s = supervise(o.pid, 'status', { program: ['/bin/sh', '-c', `sleep 300 & echo $! > ${path.join(scratch, 'status.kid')}; exit 17`] });
    assert.equal((await s.exited).code, 17);
    const kid = readPid(path.join(scratch, 'status.kid'));
    await waitFor(() => !alive(kid), { what: 'orphaned group member killed' });
    process.kill(o.pid, 'SIGKILL');
  });

  test('exec failure reports 127', async () => {
    const o = owner();
    const s = supervise(o.pid, 'noexec', { program: ['/nonexistent/program'] });
    assert.equal((await s.exited).code, 127);
    process.kill(o.pid, 'SIGKILL');
  });

  test('an owner that is already dead: the program is never started', async () => {
    const o = owner();
    const pid = o.pid;
    process.kill(pid, 'SIGKILL');
    await waitFor(() => !alive(pid));
    const marker = path.join(scratch, 'dead-owner.started');
    const s = supervise(pid, 'dead-owner', { program: ['/bin/sh', '-c', `touch ${marker}; sleep 30`] });
    assert.equal((await s.exited).code, 71);
    await sleep(100);
    assert.throws(() => readFileSync(marker), /ENOENT/);
  });

  test('lock <fd>: acquires, and reports 75 while another open description holds it', async () => {
    const file = path.join(scratch, 'lock-file');
    writeFileSync(file, '');
    const run = fd => new Promise(resolve => spawn(shim, ['lock', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] }).once('exit', resolve));
    const first = openSync(file, 'a+');
    assert.equal(await run(first), 0);
    const second = openSync(file, 'a+');
    assert.equal(await run(second), 75, 'held through the first descriptor even though the helper exited');
    const { closeSync } = await import('node:fs');
    closeSync(first);
    assert.equal(await run(second), 0, 'released when the holder closes its descriptor');
  });

  test('bad usage exits 64', async () => {
    const result = await new Promise(resolve => spawn(shim, ['--owner-pid', '1'], { stdio: 'ignore' }).once('exit', resolve));
    assert.equal(result, 64);
  });
});
