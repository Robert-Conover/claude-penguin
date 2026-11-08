import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('Cancelled.'), { code: 'CANCELLED' })); }, { once: true });
});

export function tcpProbe(port, host = '127.0.0.1', timeoutMs = 1000) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host });
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** `anyStatus`: any HTTP response counts (for servers without a health route, such as Dash). */
export function httpProbe(url, { headers = {}, timeoutMs = 3000, anyStatus = false } = {}) {
  return new Promise(resolve => {
    const req = http.get(url, { headers, timeout: timeoutMs, agent: false }, res => { res.resume(); resolve(anyStatus || (res.statusCode >= 200 && res.statusCode < 300)); });
    req.once('timeout', () => { req.destroy(); resolve(false); });
    req.once('error', () => resolve(false));
  });
}

export function httpJson(url, { headers = {}, timeoutMs = 3000 } = {}) {
  return new Promise(resolve => {
    const req = http.get(url, { headers, timeout: timeoutMs, agent: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null); } catch { resolve(null); } });
    });
    req.once('timeout', () => { req.destroy(); resolve(null); });
    req.once('error', () => resolve(null));
  });
}

export function commandProbe(command, env = {}, timeoutMs = 5000) {
  return new Promise(resolve => {
    const child = spawn(command[0], command.slice(1), { env, stdio: 'ignore', timeout: timeoutMs });
    child.once('error', () => resolve(false));
    child.once('exit', code => resolve(code === 0));
  });
}

export function probeOnce(health) {
  if (health.type === 'tcp') return tcpProbe(health.port);
  if (health.type === 'http') return httpProbe(health.url, { headers: health.headers, anyStatus: health.anyStatus === true });
  if (health.type === 'command') return commandProbe(health.command, health.env);
  return Promise.reject(new Error(`Unknown health check type ${health.type}`));
}

/** Polls until healthy. `alive()` returning false aborts early; resolves true/false. */
export async function waitHealthy(health, { timeoutMs = 60000, intervalMs = 200, signal, alive = () => true, probe = probeOnce } = {}) {
  const deadline = Date.now() + (health.timeoutMs ?? timeoutMs);
  for (;;) {
    if (signal?.aborted) throw Object.assign(new Error('Cancelled.'), { code: 'CANCELLED' });
    if (!alive()) return { ok: false, reason: 'exited' };
    if (await probe(health)) return { ok: true };
    if (Date.now() >= deadline) return { ok: false, reason: 'timeout' };
    await sleep(health.intervalMs ?? intervalMs, signal);
  }
}
