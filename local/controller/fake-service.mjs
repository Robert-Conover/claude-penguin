// Test double for a managed service: a loopback HTTP server that answers /healthz and
// /engine/control/status, optionally with a descendant, and logs its life to FAKE_TRACK_DIR.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const has = name => args.includes(`--${name}`);
const isEngine = Boolean(process.env.CP_ENGINE_PORT);
const name = isEngine ? 'engine' : opt('name');
const port = Number(isEngine ? process.env.CP_ENGINE_PORT : opt('port'));
const track = process.env.FAKE_TRACK_DIR;
const log = line => track && appendFileSync(path.join(track, 'order.log'), `${Date.now()} ${line}\n`);

if (track) {
  writeFileSync(path.join(track, `${name}.pid`), String(process.pid));
  writeFileSync(path.join(track, `${name}.env.json`), JSON.stringify(process.env));
}
log(`start ${name}`);

let descendant = null;
if (has('descendant')) {
  // A child that ignores SIGTERM and SIGINT, so only SIGKILL of the group removes it.
  descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' });
  if (track) writeFileSync(path.join(track, `${name}.child.pid`), String(descendant.pid));
}

const healthyAt = Date.now() + Number(opt('health-delay') ?? 0);
const server = http.createServer((req, res) => {
  const ok = (body = 'ok') => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (has('never-healthy') || Date.now() < healthyAt) { res.writeHead(503); res.end(); return; }
  if (req.url === '/healthz') return ok();
  if (req.url === '/engine/control/status') {
    if (req.headers.authorization !== `Bearer ${process.env.CP_ENGINE_CONTROL_TOKEN}`) { res.writeHead(401); res.end(); return; }
    return ok({ sessions: { running: 2, total: 3 }, signIn: { method: 'login', overriddenBy: [] }, git: { source: 'user', path: process.env.CP_ENGINE_GIT }, claude: { path: process.env.CP_CLAUDE_PATH, version: '1.0.0' } });
  }
  res.writeHead(404); res.end();
});
// tcp health checks connect even when HTTP is "never healthy"; --no-listen delays binding entirely.
const bind = () => server.listen(port, '127.0.0.1');
if (has('never-listen')) setInterval(() => {}, 1000); else bind();

if (has('exit-after')) setTimeout(() => process.exit(Number(opt('exit-code') ?? 3)), Number(opt('exit-after')));
if (has('exit-immediately')) process.exit(5);

const ignoreTerm = has('ignore-term');
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log(`signal ${name} ${signal}`);
    if (ignoreTerm) return;
    const delay = Number(opt('stop-delay') ?? 0);
    setTimeout(() => { log(`stop ${name}`); process.exit(0); }, delay);
  });
}
setInterval(() => {}, 1000);
