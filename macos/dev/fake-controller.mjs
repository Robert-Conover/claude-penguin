#!/usr/bin/env node
// Fake Claude Penguin controller for developing the macOS app without the real one.
// Speaks the JSON-lines protocol from .local/plans/macos-contract.md (no dependencies).
//
//   node fake-controller.mjs --resources <dir> --runtimes <dir> --data <dir> [--page-port 47180]
//
// Env switches (all optional):
//   FAKE_PAGE_PORT      game page port (default 47180); the agents page uses port+1
//   FAKE_SETUP_COMPLETE 1 = start already set up (state "stopped"); FAKE_MODE=explore|code for that mode
//   FAKE_PORT_CONFLICT  1 = preflight reports a conflict on 47080 (web)
//   FAKE_DISK_SHORT     1 = preflight reports too little free space
//   FAKE_SURVIVOR       1 (or FAKE_RECOVERY=1) = start in "recovery"; recover(stop-survivors) clears it
//   FAKE_FAIL_SETUP     1 = setup fails mid-way (media ~40%) on the first attempt; FAKE_FAIL_ALWAYS=1 on every attempt
//   FAKE_SESSIONS       number reported as sessions.running
//   FAKE_STEP_MS        delay per progress tick (default 350)
//   FAKE_STOP_HANG      1 = "stop" never completes (tests the quit fallback)
//   FAKE_CRASH_AFTER_MS exit(3) after this many ms (tests the unexpected-exit screen)
//   FAKE_LOG            file receiving one JSON line per request / lifecycle event

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const env = process.env;
const flag = (name) => env[name] === '1' || env[name] === 'true';

const dataDir = arg('data', path.join(os.tmpdir(), 'cp-fake-data'));
const pagePort = Number(arg('page-port', env.FAKE_PAGE_PORT || 47180));
const agentsPort = pagePort + 1;
const stepMs = Number(env.FAKE_STEP_MS || 350);
const logPath = env.FAKE_LOG || null;

const urls = { game: `http://localhost:${pagePort}/`, agents: `http://localhost:${agentsPort}/` };
const TASKS = [
  ['runtime', 'Runtimes', 8],
  ['media', 'Game files', 40],
  ['extensions', 'Puffle extensions', 5],
  ['database', 'Island database', 4],
  ['claude', 'Claude Code', 12],
];

let state = 'needs-setup';
let mode = null;
let setupComplete = flag('FAKE_SETUP_COMPLETE');
let failedOnce = false;
let setupAbort = null;
let survivors = flag('FAKE_SURVIVOR') || flag('FAKE_RECOVERY');
let servers = [];
let shuttingDown = false;

const log = (entry) => {
  const line = JSON.stringify({ t: new Date().toISOString(), ...entry });
  if (logPath) fs.appendFileSync(logPath, line + '\n');
  process.stderr.write(line + '\n');
};
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });

function setState(next, message) {
  state = next;
  send({
    event: 'state', state, mode,
    urls: state === 'running' || state === 'starting' || state === 'stopping' ? urls : { game: urls.game, agents: urls.agents },
    message: message ?? '',
    futureField: 'tolerated', // the app must ignore fields it does not know
  });
  log({ ev: 'state', state, mode });
}
const respond = (id, result) => send({ id, ok: true, result });
const fail = (id, code, message) => send({ id, ok: false, error: { code, message } });

// ---- pages -----------------------------------------------------------------

function page(kind) {
  const wt = path.join(dataDir, 'worktrees');
  const demo = path.join(wt, 'demo');
  const msgs = [
    ['Reveal demo worktree (allowed)', { type: 'reveal', path: demo }],
    ['Open demo in editor (allowed)', { type: 'openInEditor', path: demo }],
    ['Reveal via symlink escape (rejected)', { type: 'reveal', path: path.join(wt, 'escape') }],
    ['Reveal with .. (rejected)', { type: 'reveal', path: path.join(demo, '..', '..', '..') }],
    ['Reveal sibling prefix (rejected)', { type: 'reveal', path: path.join(dataDir, 'worktrees-evil', 'demo') }],
    ['Reveal /etc (rejected)', { type: 'reveal', path: '/etc' }],
  ];
  return `<!doctype html><meta charset="utf-8"><title>Fake ${kind}</title>
<style>
 body{font:16px -apple-system,system-ui;margin:0;padding:32px;background:${kind === 'game' ? '#d7ecfa' : '#1c2733'};color:${kind === 'game' ? '#12324a' : '#e8f1f8'}}
 button,a.b{display:inline-block;margin:4px 6px 4px 0;padding:8px 14px;border-radius:10px;border:0;background:#2b73d1;color:#fff;font:inherit;text-decoration:none;cursor:pointer}
 pre{background:#0002;padding:12px;border-radius:8px;min-height:3em}
 textarea{width:100%;height:5em}
</style>
<h1>Fake ${kind} page</h1>
<p>Origin: <b id=o></b> &middot; host handler: <b id=h></b></p>
<p><a class=b href="https://example.com/">External link (should open in browser)</a>
<a class=b href="https://example.com/" target="_blank">External target=_blank</a>
<button onclick="window.open('https://example.com/new')">window.open</button>
<a class=b href="http://localhost:${kind === 'game' ? agentsPort : pagePort}/">Other loopback origin (in-app)</a></p>
<p><button onclick="alert('Hello from the page')">alert</button>
<button onclick="log('confirm -> '+confirm('Really?'))">confirm</button>
<button onclick="log('prompt -> '+prompt('Your name?','Waddles'))">prompt</button>
<button onclick="document.documentElement.requestFullscreen()">element fullscreen</button>
<button onclick="new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=').play().then(()=>log('audio play ok'),e=>log('audio blocked: '+e.name))">autoplay audio</button></p>
<p>Host messages:<br>${msgs.map(([l, m]) => `<button onclick='host(${JSON.stringify(m).replace(/'/g, '&#39;')})'>${l}</button>`).join('')}</p>
<p>Paste test (Cmd-A, Cmd-C, Cmd-V, Cmd-X work here):<br><textarea>select me and copy</textarea></p>
<pre id=out></pre>
<script>
 const out=document.getElementById('out');
 const log=t=>out.textContent+=t+'\\n';
 document.getElementById('o').textContent=location.origin;
 const hh=window.webkit?.messageHandlers?.claudePenguinHost;
 document.getElementById('h').textContent=hh?'present':'absent';
 function host(m){ if(!hh){log('no host handler');return;} hh.postMessage(m); log('posted '+JSON.stringify(m)); }
</script>`;
}

function startPages() {
  fs.mkdirSync(path.join(dataDir, 'worktrees', 'demo'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'worktrees-evil', 'demo'), { recursive: true });
  const escape = path.join(dataDir, 'worktrees', 'escape');
  if (!fs.existsSync(escape)) fs.symlinkSync(os.tmpdir(), escape);
  for (const [port, kind] of [[pagePort, 'game'], [agentsPort, 'agents']]) {
    const s = http.createServer((req, res) => {
      log({ ev: 'http', port, url: req.url });
      if (req.url === '/healthz') { res.end('ok'); return; }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(page(kind));
    });
    s.on('error', (e) => log({ ev: 'page-server-error', port, error: String(e) }));
    s.listen(port, '127.0.0.1');
    servers.push(s);
  }
}

// ---- handlers ----------------------------------------------------------------

function preflight(m) {
  const GB = 1e9;
  const required = m === 'code' ? 7.5 * GB : 6.6 * GB;
  const result = {
    downloadBytes: m === 'code' ? 4.4 * GB : 4.1 * GB,
    requiredBytes: required,
    freeBytes: flag('FAKE_DISK_SHORT') ? 2 * GB : 120 * GB,
    portConflicts: flag('FAKE_PORT_CONFLICT') ? [{ port: 47080, service: 'web' }] : [],
    problems: [],
    futureField: 1,
  };
  if (flag('FAKE_DISK_SHORT')) result.problems.push({ code: 'DISK_SPACE', message: 'Not enough free space for setup.' });
  return result;
}

async function runSetup(m, id) {
  mode = m;
  setupAbort = new AbortController();
  const { signal } = setupAbort;
  setState('setting-up', `Setting up (${m})`);
  const wanted = TASKS.filter(([t]) => m === 'code' || t !== 'claude');
  const shouldFail = (flag('FAKE_FAIL_SETUP') && !failedOnce) || flag('FAKE_FAIL_ALWAYS');
  try {
    for (const [task, label, steps] of wanted) {
      for (let i = 0; i <= steps; i++) {
        send({ event: 'progress', task, label, done: task === 'media' || task === 'runtime' || task === 'claude' ? Math.round((i / steps) * 400e6) : i,
               total: task === 'media' || task === 'runtime' || task === 'claude' ? 400e6 : steps });
        if (task === 'media' && shouldFail && i === Math.floor(steps * 0.4)) {
          failedOnce = true;
          send({ event: 'problem', code: 'DOWNLOAD', message: 'The connection dropped while downloading game files.', detail: { task } });
          setState('error', 'Setup failed');
          fail(id, 'DOWNLOAD', 'The connection dropped while downloading game files.');
          return;
        }
        await sleep(stepMs / 4, signal);
      }
    }
  } catch {
    mode = null;
    setState('needs-setup', 'Setup cancelled');
    fail(id, 'CANCELLED', 'Setup was cancelled.');
    return;
  } finally {
    setupAbort = null;
  }
  setupComplete = true;
  setState('stopped', 'Setup complete');
  respond(id, { setupComplete: true });
}

async function runStart(id) {
  setState('starting', 'Starting services');
  for (const name of ['postgres', 'valkey', 'login', 'world', 'dash', 'snowflake', 'web', ...(mode === 'code' ? ['engine'] : [])]) {
    send({ event: 'service', name, state: 'starting', pid: 1000 + Math.floor(Math.random() * 9000) });
    await sleep(stepMs / 2);
    send({ event: 'service', name, state: 'healthy', pid: 1000 });
  }
  setState('running', 'The island is open');
  respond(id, { state: 'running', urls });
}

async function runStop(id) {
  if (flag('FAKE_STOP_HANG')) { setState('stopping', 'Stopping'); log({ ev: 'stop-hang' }); return; }
  setState('stopping', 'Stopping services');
  for (const name of ['engine', 'web', 'snowflake', 'dash', 'world', 'login', 'valkey', 'postgres']) {
    send({ event: 'service', name, state: 'stopping' });
    await sleep(stepMs / 4);
    send({ event: 'service', name, state: 'exited', code: 0 });
  }
  setState('stopped', 'Stopped');
  respond(id, {});
}

function status() {
  return {
    state, mode, setupComplete, urls,
    ports: { web: 47080, engine: 47081 },
    services: [],
    sessions: { running: Number(env.FAKE_SESSIONS || 0) },
    disk: { freeBytes: 120e9, requiredBytes: 7.5e9 },
  };
}

async function handle(req) {
  const { id, cmd } = req;
  log({ ev: 'request', req });
  switch (cmd) {
    case 'status': return respond(id, status());
    case 'preflight': return respond(id, preflight(req.mode));
    case 'setup': return runSetup(req.mode, id);
    case 'start':
      if (!setupComplete) return fail(id, 'NOT_SET_UP', 'Run setup first.');
      return runStart(id);
    case 'stop': return runStop(id);
    case 'cancel':
      if (setupAbort) setupAbort.abort();
      return respond(id, { cancelled: Boolean(setupAbort) });
    case 'recover':
      if (state !== 'recovery') return fail(id, 'BAD_STATE', 'Not in recovery.');
      await sleep(stepMs * 2);
      survivors = false;
      setState(setupComplete ? 'stopped' : 'needs-setup', req.action === 'ignore' ? 'Ignored' : 'Survivors stopped');
      return respond(id, { recovered: true });
    default: return fail(id, 'UNKNOWN_COMMAND', `Unknown command: ${cmd}`);
  }
}

// ---- main ----------------------------------------------------------------------

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log({ ev: 'shutdown', code });
  for (const s of servers) s.close();
  setTimeout(() => process.exit(code), 50);
}

fs.mkdirSync(dataDir, { recursive: true });
startPages();
log({ ev: 'start', pid: process.pid, args, urls, setupComplete, survivors });
if (setupComplete) mode = env.FAKE_MODE === 'explore' ? 'explore' : 'code';
setState(survivors ? 'recovery' : setupComplete ? 'stopped' : 'needs-setup',
         survivors ? 'A previous session left processes running.' : '');

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch { log({ ev: 'bad-line', line }); return; }
  handle(req).catch((e) => fail(req.id, 'INTERNAL', String(e)));
});
rl.on('close', () => { log({ ev: 'stdin-eof' }); shutdown(0); });
process.on('SIGTERM', () => shutdown(0));
if (env.FAKE_CRASH_AFTER_MS) setTimeout(() => { log({ ev: 'crash' }); process.exit(3); }, Number(env.FAKE_CRASH_AFTER_MS));
