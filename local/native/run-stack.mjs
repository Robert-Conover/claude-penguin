#!/usr/bin/env node
// Minimal development harness for the native stack. NOT the product controller:
// it has no supervisor shim, ownership records, locks or recovery. It starts the
// services from services.mjs in dependency order against a scratch data root and
// stops them all on Ctrl-C / SIGTERM.
//
//   node local/native/run-stack.mjs [--data DIR] [--runtimes DIR] [--once]
//     --data      scratch data root (default .local/native-test)
//     --runtimes  runtimes directory (default .local/runtimes)
//     --once      stop again as soon as every service is healthy
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeServices, prepareData, DEFAULT_PORTS } from './services.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(name) ? path.resolve(argv[argv.indexOf(name) + 1]) : fallback);
const config = {
  resources: repo,
  runtimes: opt('--runtimes', path.join(repo, '.local/runtimes')),
  data: opt('--data', path.join(repo, '.local/native-test')),
  mediaRoot: path.join(repo, 'vanilla-media'),
  clientBridgeRoot: path.join(repo, '.local/client-bridge'),
  ruffleRoot: path.join(repo, '.local/ruffle'),
  ports: { ...DEFAULT_PORTS },
};
const log = (...a) => console.log(`[stack ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const running = new Map();   // name -> { child, def }
let stopping = false;

function tcpUp(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1500, () => { socket.destroy(); resolve(false); });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}
function commandUp(command, env) {
  return new Promise(resolve => {
    const child = spawn(command[0], command.slice(1), { env, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
  });
}
async function healthy(def) {
  const h = def.health;
  if (h.type === 'tcp') return tcpUp(h.port);
  if (h.type === 'command') return commandUp(h.command, h.env ?? {});
  if (h.type === 'http') {
    try { const r = await fetch(h.url, { signal: AbortSignal.timeout(2000) }); return h.anyStatus ? true : r.ok; } catch { return false; }
  }
  return false;
}

async function start(def) {
  mkdirSync(def.logDir, { recursive: true });
  const out = openSync(path.join(def.logDir, 'process.log'), 'a');
  log(`starting ${def.name} on 127.0.0.1:${def.port}`);
  if (await tcpUp(def.port)) throw new Error(`${def.name}: port ${def.port} is already in use`);
  const child = spawn(def.command[0], def.command.slice(1), { cwd: def.cwd, env: def.env, stdio: ['ignore', out, out], detached: true });
  running.set(def.name, { child, def });
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; running.delete(def.name); if (!stopping) log(`${def.name} exited unexpectedly (${code ?? signal})`); });
  for (let i = 0; i < 240; i++) {
    if (exited) throw new Error(`${def.name} exited during startup (${exited.code ?? exited.signal}); see ${def.logDir}/process.log`);
    if (await healthy(def)) break;
    if (i === 239) throw new Error(`${def.name} did not become healthy`);
    await sleep(500);
  }
  log(`${def.name} healthy (pid ${child.pid})`);
  if (def.ready) { log(`${def.name}: running ready hook`); await def.ready(); log(`${def.name}: ready hook done`); }
}

async function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const [name, { child, def }] of [...running].reverse()) {
    log(`stopping ${name} (${def.stop.signal})`);
    const done = new Promise(resolve => child.once('exit', resolve));
    try { process.kill(child.pid, def.stop.signal); } catch { /* already gone */ }
    const timeout = sleep(def.stop.graceMs).then(() => 'timeout');
    if (await Promise.race([done, timeout]) === 'timeout') {
      log(`${name} ignored ${def.stop.signal}; killing its process group`);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
      await Promise.race([done, sleep(3000)]);
    }
    // Reap any stragglers in the group (children of a stopped service).
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* none */ }
  }
  rmSync(path.join(config.data, 'run-stack.pid'), { force: true });
  log('all services stopped');
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { stopAll().then(() => process.exit(0)); });
process.on('uncaughtException', e => { console.error(e); stopAll().then(() => process.exit(1)); });

try {
  await prepareData(config, { onProgress: e => log(`${e.label} (${e.done}/${e.total})`) });
  writeFileSync(path.join(config.data, 'run-stack.pid'), `${process.pid}\n`);
  const services = nativeServices(config);
  for (const def of services) {
    for (const dep of def.after) if (!running.has(dep)) throw new Error(`${def.name} needs ${dep}`);
    await start(def);
  }
  log(`stack is up: http://localhost:${config.ports.web}/`);
  if (argv.includes('--once')) { await stopAll(); process.exit(0); }
  await new Promise(() => setInterval(() => {}, 1 << 30));
} catch (error) {
  console.error(`run-stack: ${error.message}`);
  await stopAll();
  process.exit(1);
}
