import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir, open, rm } from 'node:fs/promises';
import { WebSocketServer, WebSocket } from 'ws';
import { createLocalServer } from '../web/server.mjs';
import { validateFixtures } from '../web/bridge/model.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '../..');
const MAX_BODY = 256 * 1024;
const MAX_BUFFERED = 2 * 1024 * 1024;

function equalSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function bearer(req) { return /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? '')?.[1]; }
function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function reply(res, status, data, method = 'GET') {
  const bytes = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(method === 'HEAD' ? undefined : bytes);
}
async function jsonBody(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw error('Expected application/json.', 415);
  if (Number(req.headers['content-length']) > MAX_BODY) throw error('Request too large.', 413);
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) throw error('Request too large.', 413);
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw error('Invalid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('Expected a JSON object.');
  return value;
}

/** Host-only server: the game container never obtains a terminal or provider credential. */
export function createEngineServer({ manager, publicOrigin = 'http://localhost:8081', root = projectRoot, uiToken = randomBytes(32).toString('base64url'), ...options }) {
  const origin = new URL(publicOrigin);
  if (origin.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(origin.hostname)) throw error('The agent engine must use a loopback HTTP origin.');
  const clients = new Set();
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const actions = new Map([
    ['register', 'registerProject'], ['create', 'createWorker'], ['start', 'start'],
    ['submit', 'submit'], ['input', 'input'], ['resize', 'resize'],
    ['interrupt', 'interrupt'], ['stop', 'stop'], ['diff', 'diff'],
  ]);
  const staticFiles = new Map([
    ['/engine/client.mjs', [path.join(root, 'local/web/engine/client.mjs'), 'text/javascript; charset=utf-8']],
    ['/engine/client.css', [path.join(root, 'local/web/engine/client.css'), 'text/css; charset=utf-8']],
    ['/engine/ui-model.mjs', [path.join(root, 'local/web/engine/ui-model.mjs'), 'text/javascript; charset=utf-8']],
    ['/engine/art/puffle-blue.svg', [path.join(root, 'local/web/engine/art/puffle-blue.svg'), 'image/svg+xml']],
    ['/engine/art/puffle-blue.png', [path.join(root, 'local/web/engine/art/puffle-blue.png'), 'image/png']],
    ['/engine/vendor/xterm.js', [path.join(here, 'node_modules/@xterm/xterm/lib/xterm.js'), 'text/javascript; charset=utf-8']],
    ['/engine/vendor/xterm.css', [path.join(here, 'node_modules/@xterm/xterm/css/xterm.css'), 'text/css; charset=utf-8']],
    ['/engine/vendor/addon-fit.js', [path.join(here, 'node_modules/@xterm/addon-fit/lib/addon-fit.js'), 'text/javascript; charset=utf-8']],
  ]);
  const validHost = req => req.headers.host === origin.host && req.url.startsWith('/') && !req.url.startsWith('//');
  const sameSite = req => (!req.headers.origin || req.headers.origin === origin.origin) &&
    (!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']));
  const authenticated = req => sameSite(req) && equalSecret(bearer(req), uiToken);
  function send(client, value) {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    if (client.ws.bufferedAmount > MAX_BUFFERED) { client.ws.close(1013, 'Reconnect to refresh the terminal.'); return; }
    client.ws.send(JSON.stringify(value));
  }
  function publish(event) {
    if (event.type === 'snapshot') {
      const snapshot = event.snapshot ?? { revision: event.revision, projects: event.projects, workers: event.workers };
      for (const client of clients) if (client.authenticated) send(client, { type: 'snapshot', snapshot });
    } else if (event.type === 'terminal') {
      for (const client of clients) {
        if (!client.authenticated || client.projectId !== event.projectId || client.workerId !== event.workerId) continue;
        if (client.attaching) {
          client.pendingBytes += Buffer.byteLength(event.data);
          if (client.pendingBytes > MAX_BUFFERED) client.ws.close(1013, 'Reconnect to refresh the terminal.');
          else client.pending.push(event);
        }
        else send(client, event);
      }
    }
  }
  const server = createLocalServer({
    root, publicOrigin: origin.origin, loginHost: '127.0.0.1', worldHost: '127.0.0.1', snowHost: '127.0.0.1',
    dashOrigin: 'http://localhost:8080', dashViaWeb: true, ...options, agentMode: true, validateRequest: validHost,
    async onRequest(req, res, url) {
      if (!url.pathname.startsWith('/engine/')) return false;
      try {
        if (!sameSite(req)) throw error('Origin not allowed.', 403);
        if (staticFiles.has(url.pathname)) {
          if (!['GET', 'HEAD'].includes(req.method)) throw error('Method not allowed.', 405);
          const [file, type] = staticFiles.get(url.pathname);
          const bytes = await readFile(file);
          res.writeHead(200, { 'content-type': type, 'content-length': bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
          res.end(req.method === 'HEAD' ? undefined : bytes);
        } else if (url.pathname === '/engine/bootstrap') {
          if (req.method !== 'GET') throw error('Method not allowed.', 405);
          reply(res, 200, { token: uiToken, snapshot: manager.snapshot() });
        } else if (url.pathname === '/engine/hooks') {
          // Hook credentials are per Claude process. Never accept a browser origin here.
          if (req.method !== 'POST') throw error('Method not allowed.', 405);
          if (req.headers.origin || !bearer(req)) throw error('Hook authentication required.', 403);
          const { workerId, event } = await jsonBody(req);
          const result = await manager.hook({ workerId, event, token: bearer(req) });
          reply(res, 200, result);
        } else {
          if (!authenticated(req)) throw error('Engine authentication required.', 403);
          if (url.pathname === '/engine/snapshot' && req.method === 'GET') reply(res, 200, { snapshot: manager.snapshot() });
          else if (url.pathname === '/engine/action' && req.method === 'POST') {
            if (req.headers.origin !== origin.origin) throw error('A same-origin request is required.', 403);
            const body = await jsonBody(req);
            const method = actions.get(body.action);
            if (!method) throw error('Unknown engine action.');
            const result = await manager[method](body);
            reply(res, 200, { result: result ?? null, snapshot: manager.snapshot() });
          } else throw error('Unknown engine endpoint.', 404);
        }
      } catch (failure) {
        reply(res, failure.statusCode ?? (failure.code === 'ENOENT' ? 404 : 500), { error: failure.statusCode ? failure.message : 'Engine request failed. Check the local engine terminal.' });
        if (!failure.statusCode && failure.code !== 'ENOENT') console.error('Engine request failed:', failure.message);
      }
      return true;
    },
    onUpgrade(req, socket, head) {
      if (new URL(req.url, origin).pathname !== '/engine/ws') return false;
      if (req.headers.origin !== origin.origin) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return true;
      }
      wsServer.handleUpgrade(req, socket, head, ws => {
        const client = { ws, authenticated: false, projectId: null, workerId: null, attaching: false, pending: [], pendingBytes: 0, generation: 0, queued: 0 };
        clients.add(client);
        const timer = setTimeout(() => ws.close(1008, 'Authentication required.'), 5000);
        timer.unref();
        ws.on('close', () => { clearTimeout(timer); clients.delete(client); });
        ws.on('error', () => {});
        let queue = Promise.resolve();
        ws.on('message', (data, binary) => {
          if (++client.queued > 256) { ws.close(1008, 'Too many pending messages.'); return; }
          queue = queue.then(async () => {
            if (binary) throw error('Expected JSON text.');
            const message = JSON.parse(data.toString());
            if (!message || typeof message !== 'object' || Array.isArray(message)) throw error('Invalid message.');
            if (!client.authenticated) {
              if (message.type !== 'auth' || !equalSecret(message.token, uiToken)) { ws.close(1008, 'Authentication failed.'); return; }
              client.authenticated = true;
              clearTimeout(timer);
              send(client, { type: 'snapshot', snapshot: manager.snapshot() });
            } else if (message.type === 'attach') {
              const generation = ++client.generation;
              client.projectId = message.projectId;
              client.workerId = message.workerId;
              client.attaching = true;
              client.pending = [];
              client.pendingBytes = 0;
              try {
                const snapshot = await manager.terminal(message);
                if (generation !== client.generation) return;
                send(client, { type: 'terminal.snapshot', projectId: message.projectId, workerId: message.workerId, ...snapshot });
                // The serialized screen includes all data flushed before the snapshot.
                // Events queued during serialization are replayed by the manager's sequence marker when available.
                for (const event of client.pending) if (snapshot.sequence === undefined || event.sequence > snapshot.sequence) send(client, event);
              } finally { client.attaching = false; client.pending = []; client.pendingBytes = 0; }
            } else if (message.type === 'detach') {
              client.generation++;
              client.projectId = client.workerId = null;
            } else if (message.type === 'input' || message.type === 'resize') {
              if (!client.workerId || client.projectId !== message.projectId || client.workerId !== message.workerId) throw error('Attach this exact worker before controlling its terminal.', 403);
              await manager[message.type](message);
            } else throw error('Unknown terminal message.');
          }).catch(failure => send(client, { type: 'error', error: failure.statusCode ? failure.message : 'Invalid terminal request.' })).finally(() => client.queued--);
        });
      });
      return true;
    },
  });
  server.on('close', () => { for (const client of clients) client.ws.terminate(); wsServer.close(); });
  async function close() {
    for (const client of clients) client.ws.terminate();
    server.closeGameConnections();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  return { server, publish, close };
}

export async function acquireLock(stateDir) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(stateDir, 'runtime.lock');
  const nonce = randomBytes(16).toString('hex');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(lockPath, 'wx', 0o600);
      await file.writeFile(JSON.stringify({ pid: process.pid, nonce }));
      await file.close();
      return async () => {
        const current = JSON.parse(await readFile(lockPath, 'utf8'));
        if (current.nonce === nonce) await rm(lockPath);
      };
    } catch (failure) {
      if (failure.code !== 'EEXIST') throw failure;
      let previous;
      try { previous = JSON.parse(await readFile(lockPath, 'utf8')); }
      catch { throw error(`Engine lock is unreadable: ${lockPath}. Inspect the previous runtime before removing it.`); }
      if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw error('Invalid engine lock; inspect it before restarting.');
      try { process.kill(previous.pid, 0); throw error(`An engine may already be running (PID ${previous.pid}).`); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      throw error(`A stale engine lock remains at ${lockPath}. Confirm the old runtime and its Claude processes have stopped, then remove this lock explicitly before restarting.`);
    }
  }
  throw error('Could not acquire the engine lock.');
}

async function main() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw error('This first engine supports macOS and Linux hosts.');
  const port = Number(process.env.CP_ENGINE_PORT ?? 8081);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw error('Invalid CP_ENGINE_PORT.');
  const publicOrigin = `http://localhost:${port}`;
  const fixtures = validateFixtures(JSON.parse(await readFile(path.join(projectRoot, '.local/bridge-fixtures.json'), 'utf8')));
  const stateDir = process.env.CP_ENGINE_STATE_DIR ? path.resolve(process.env.CP_ENGINE_STATE_DIR) : path.join(projectRoot, '.local/agent-engine');
  const unlock = await acquireLock(stateDir);
  let manager;
  try {
    const { createManager } = await import('./manager.mjs');
    let publish = () => {};
    manager = await createManager({ stateDir, fixtures, onEvent: event => publish(event), claudePath: process.env.CP_CLAUDE_PATH ?? 'claude', hookBaseUrl: `${publicOrigin}/engine/hooks` });
    const host = createEngineServer({ manager, publicOrigin });
    publish = host.publish;
    const server = host.server;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    console.log(`Claude Penguin engine: ${publicOrigin}/?bridge=1&agents=1#/login`);
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      await manager.close();
      await host.close();
      await unlock();
      process.exit(0);
    };
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, shutdown);
  } catch (failure) {
    await manager?.close();
    await unlock();
    throw failure;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(failure => { console.error(failure.message); process.exitCode = 1; });
