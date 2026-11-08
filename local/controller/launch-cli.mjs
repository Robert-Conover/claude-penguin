#!/usr/bin/env node
// ./launch: run the native Claude Penguin environment from a checkout. Human-readable output only.
// The CLI itself runs on the system node (22+); the controller runs on the pinned runtime node.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORTS, PRODUCT_NAME, resolveConfig, serviceTable } from './config.mjs';
import { tcpProbe } from './health.mjs';
import { runningController } from './lock.mjs';
import { classifyRecord, listRecords } from './owners.mjs';
import { loadRelease, loadSetupState } from './setup.mjs';
import { pidAlive, usePidPathHelper } from './procinfo.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const out = line => process.stdout.write(`${line}\n`);
const err = line => process.stderr.write(`${line}\n`);

const HELP = `Usage: ./launch <command> [options]

Runs the ${PRODUCT_NAME} servers natively from this checkout, with the same controller the macOS app uses.
It never touches the Compose stack (./local/start) and uses its own ports (web ${DEFAULT_PORTS.web}, agents ${DEFAULT_PORTS.engine}).

Commands:
  setup [--mode explore|code]   Prepare the database, media, in-game extensions (and, for code, Claude Code). Resumable.
  start                         Start the servers in the foreground. Ctrl-C stops them gracefully.
  status                        Show whether the environment is set up and running (reads state; does not start anything).
  stop                          Ask the running controller (see data/controller.json) to stop, after checking it is that process.
  --help                        This text.

Environment:
  CP_APP_DATA      data directory (default .local/launch)
  CP_RUNTIMES      runtimes directory (default .local/runtimes; build with local/native/build-runtimes.sh)
  CP_MEDIA_DIR     not used here: the checkout's vanilla-media/ is always the media source
  CP_LAUNCH_VERBOSE=1  show the controller's own log lines
`;

function locations() {
  const data = path.resolve(process.env.CP_APP_DATA || path.join(repo, '.local', 'launch'));
  const runtimes = path.resolve(process.env.CP_RUNTIMES || path.join(repo, '.local', 'runtimes'));
  const ports = process.env.CP_PORTS_JSON ? JSON.parse(process.env.CP_PORTS_JSON) : {};
  const resources = path.resolve(process.env.CP_RESOURCES || repo);
  const config = resolveConfig({ resources, runtimes, data, layout: 'launch', ports, env: {} });
  usePidPathHelper(config.paths.supervise);
  return { config, data, runtimes };
}

function requireRuntimes({ config }) {
  if (!existsSync(config.paths.node) || !existsSync(config.paths.runtimesManifest)) {
    err(`The pinned runtimes are not installed (${config.runtimes}).`);
    err('Run local/native/build-runtimes.sh first, then ./launch setup.');
    return false;
  }
  return true;
}

const mb = n => `${Math.round(n / 1048576)} MB`;
const gb = n => `${(n / 1073741824).toFixed(1)} GB`;

/** A controller subprocess with request/response and event callbacks. */
function startController({ config, data }, onEvent) {
  const args = [path.join(here, 'main.mjs'), '--resources', config.resources, '--runtimes', config.runtimes, '--data', data, '--layout', 'launch', '--ports', JSON.stringify(config.ports)];
  if (process.env.CP_CONTROLLER_DEPS) args.push('--deps-module', process.env.CP_CONTROLLER_DEPS);
  const child = spawn(config.paths.node, args, { stdio: ['pipe', 'pipe', process.env.CP_LAUNCH_VERBOSE ? 'inherit' : 'ignore'], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME ?? '', ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}), ...(process.env.LANG ? { LANG: process.env.LANG } : {}), ...(process.env.CP_HEALTH_TIMEOUT_MS ? { CP_HEALTH_TIMEOUT_MS: process.env.CP_HEALTH_TIMEOUT_MS } : {}) } });
  const waiters = new Map();
  let nextId = 1;
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    for (const [id, w] of waiters) w({ id, ok: false, error: { code: 'CONTROLLER_EXITED', message: 'The controller exited.' } });
    resolve({ code, signal });
  }));
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.event) onEvent(msg); else waiters.get(msg.id)?.(msg);
  });
  child.stdin.on('error', () => {});
  return {
    child, exited,
    send: (cmd, extra = {}) => new Promise(resolve => { const id = nextId++; waiters.set(id, resolve); child.stdin.write(`${JSON.stringify({ id, cmd, ...extra })}\n`); }),
    close: () => { child.stdin.end(); return exited; },
  };
}

function printer() {
  let lastLabel = '', lastPct = -1;
  return event => {
    if (event.event === 'progress') {
      const pct = event.total ? Math.floor((event.done / event.total) * 10) : -1;
      if (event.label === lastLabel && pct === lastPct && event.total) return;
      lastLabel = event.label; lastPct = pct;
      const amount = event.total ? ` (${event.done > 1e5 ? `${mb(event.done)} of ${mb(event.total)}` : `${event.done}/${event.total}`})` : '';
      out(`  [${event.task}] ${event.label}${event.total && event.total > 1 ? amount : ''}`);
    } else if (event.event === 'problem') {
      err(`  ! ${event.code}: ${event.message}`);
    } else if (event.event === 'service') {
      if (event.state === 'healthy') out(`  ${event.name} is up${event.pid ? ` (pid ${event.pid})` : ''}`);
      else if (event.state === 'exited') out(`  ${event.name} exited${event.code != null ? ` (code ${event.code})` : ''}`);
    } else if (event.event === 'state' && ['recovery', 'error'].includes(event.state)) {
      err(`  state: ${event.state}${event.message ? ` - ${event.message}` : ''}`);
    }
  };
}

function explainError(error) {
  const hints = {
    LOCKED: 'Another controller owns this data directory. If a game is running, stop it with ./launch stop.',
    NEEDS_SETUP: 'Run ./launch setup first.',
    PORT_IN_USE: 'Another program is using one of the ports; it was left alone. Free the port and try again.',
    RECOVERY_REQUIRED: 'Processes from an earlier run could not be identified safely. Check `ps` for the PIDs in data/owners/, stop them yourself if they are yours, then rerun.',
    RUNTIMES_MISSING: 'Run local/native/build-runtimes.sh.',
  };
  err(`Error (${error.code}): ${error.message}`);
  if (hints[error.code]) err(hints[error.code]);
}

async function cmdSetup(argv) {
  let mode = 'explore';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mode') mode = argv[++i];
    else if (argv[i].startsWith('--mode=')) mode = argv[i].slice(7);
    else { err(`Unknown option ${argv[i]}`); return 2; }
  }
  if (!['explore', 'code'].includes(mode)) { err('--mode must be explore or code.'); return 2; }
  const loc = locations();
  if (!requireRuntimes(loc)) return 1;
  const controller = startController(loc, printer());
  try {
    const pre = await controller.send('preflight', { mode });
    if (!pre.ok) { explainError(pre.error); return 1; }
    const p = pre.result;
    out(`Setting up (${mode}). Free space ${gb(p.freeBytes)}; download ${p.downloadBytes == null ? 'size not known yet' : mb(p.downloadBytes)}.`);
    const result = await controller.send('setup', { mode });
    if (!result.ok) { explainError(result.error); return 1; }
    out(`Setup complete (${result.result.mode}). Ran: ${result.result.ran.join(', ') || 'nothing'}; already done: ${result.result.skipped.join(', ') || 'nothing'}.`);
    out('Next: ./launch start');
    return 0;
  } finally { await controller.close(); }
}

async function cmdStart() {
  const loc = locations();
  if (!requireRuntimes(loc)) return 1;
  const controller = startController(loc, printer());
  let stopping = false;
  const stopAll = async () => {
    if (stopping) { out('Forcing the controller to exit...'); controller.child.kill('SIGTERM'); return; }
    stopping = true;
    out('\nStopping (Ctrl-C again to force)...');
    await controller.send('stop');
    await controller.close();
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { stopAll(); });
  const started = await controller.send('start');
  if (!started.ok) {
    if (!stopping) explainError(started.error);
    await controller.close();
    return stopping ? 0 : 1;
  }
  out(`${PRODUCT_NAME} is running (${started.result.mode}).`);
  out(`  Game:   ${started.result.urls.game}`);
  if (started.result.urls.agents) out(`  Agents: ${started.result.urls.agents}`);
  out('Press Ctrl-C to stop.');
  const exit = await controller.exited;
  // A clean exit without Ctrl-C here means `./launch stop` asked it to stop.
  out(stopping || exit.code === 0 ? 'Stopped.' : `The controller exited unexpectedly (${exit.code ?? exit.signal}).`);
  return stopping || exit.code === 0 ? 0 : 1;
}

async function cmdStatus() {
  const { config } = locations();
  const setup = await loadSetupState(config);
  const release = await loadRelease(config).catch(() => null);
  out(`${PRODUCT_NAME} (launch layout)`);
  out(`  data:       ${config.data}`);
  out(`  runtimes:   ${existsSync(config.paths.runtimesManifest) ? config.runtimes : `missing (${config.runtimes}); run local/native/build-runtimes.sh`}`);
  out(`  setup:      ${setup.mode ? `${setup.mode} mode` : 'not done'}${Object.keys(setup.steps).length ? ` (steps: ${Object.entries(setup.steps).filter(([, v]) => v.ok).map(([k]) => k).join(', ')})` : ''}`);
  if (setup.steps.extensions?.fallback) out('  extensions: existing .local/client-bridge build (no patch set yet)');
  if (setup.mode === 'code' && release?.claude?.version) out(`  claude:     ${setup.steps.claude?.version ?? 'not installed'} (release pins ${release.claude.version})`);
  const controller = await runningController(config.paths.controllerJson);
  out(`  controller: ${controller ? `running, pid ${controller.pid}, since ${controller.startedAt}` : 'not running'}`);
  const records = await listRecords(config.paths.owners);
  for (const entry of records) {
    const verdict = await classifyRecord(entry);
    const where = verdict.pid ? ` pid ${verdict.pid}` : '';
    out(`  process:    ${entry.name}${where} - ${{ survivor: controller ? 'running' : 'left over from an earlier run (the next start stops it)', dead: 'not running', foreign: 'record is stale (pid reused)', ambiguous: `unclear (${verdict.reason})` }[verdict.kind]}`);
  }
  if (controller) {
    const mode = setup.mode ?? 'explore';
    for (const { name, port } of serviceTable(config, mode)) out(`  port ${String(port).padEnd(5)} ${name.padEnd(10)} ${(await tcpProbe(port)) ? 'listening' : 'closed'}`);
    out(`  game:       http://localhost:${config.ports.web}/`);
  }
  return 0;
}

async function cmdStop() {
  const { config } = locations();
  const controller = await runningController(config.paths.controllerJson);
  if (!controller) {
    out('No controller is running for this data directory.');
    const left = (await listRecords(config.paths.owners)).length;
    if (left) out(`There are ${left} ownership record(s) from an earlier run; the next ./launch start identifies and stops any survivors.`);
    return 0;
  }
  out(`Stopping the controller (pid ${controller.pid})...`);
  process.kill(controller.pid, 'SIGTERM');
  const deadline = Date.now() + 90000;
  while (pidAlive(controller.pid) && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
  if (pidAlive(controller.pid)) { err('The controller did not exit within 90 s. It is still shutting down; check ./launch status.'); return 1; }
  out('Stopped.');
  return 0;
}

export async function run(argv) {
  const [command, ...rest] = argv;
  if (!command || ['--help', '-h', 'help'].includes(command)) { out(HELP); return command ? 0 : 2; }
  const handlers = { setup: () => cmdSetup(rest), start: cmdStart, status: cmdStatus, stop: cmdStop };
  if (!handlers[command]) { err(`Unknown command ${command}.\n`); err(HELP); return 2; }
  return handlers[command]();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(code => process.exit(code), failure => { err(failure.stack ?? String(failure)); process.exit(1); });
}
