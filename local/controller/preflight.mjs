import net from 'node:net';
import { statfs } from 'node:fs/promises';
import path from 'node:path';
import { LOOPBACK } from './config.mjs';
import { tcpProbe } from './health.mjs';

/** True when something already holds 127.0.0.1:<port>. Bind first; also try a connect, because BSD sockets allow a bind beside a wildcard listener. */
export async function portInUse(port, host = LOOPBACK) {
  const bindFailed = await new Promise(resolve => {
    const server = net.createServer();
    server.once('error', failure => resolve(failure.code === 'EADDRINUSE' || failure.code === 'EACCES'));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(false)));
  });
  return bindFailed || tcpProbe(port, host, 500);
}

/**
 * Port conflicts for the listed services. A port held by a process this controller is itself running
 * (`ownPorts`) is not a conflict. Nothing is ever signalled or contacted beyond the bind and connect probe.
 */
export async function findPortConflicts(table, { ownPorts = new Set(), inUse = portInUse } = {}) {
  const conflicts = [];
  for (const { name, port } of table) {
    if (ownPorts.has(port)) continue;
    if (await inUse(port)) conflicts.push({ port, service: name });
  }
  return conflicts;
}

export async function freeBytes(dir, stat = statfs) {
  let probe = dir;
  for (let i = 0; i < 20; i++) {
    try { const info = await stat(probe); return Number(info.bavail) * Number(info.bsize); }
    catch (failure) { if (failure.code !== 'ENOENT') throw failure; const parent = path.dirname(probe); if (parent === probe) break; probe = parent; }
  }
  return 0;
}
