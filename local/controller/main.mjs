#!/usr/bin/env node
// Claude Penguin controller: node main.mjs --resources <dir> --runtimes <dir> --data <dir> [--layout app|launch]
// stdin/stdout carry JSON lines (see README.md); stderr is for people.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig, PRODUCT_NAME } from './config.mjs';
import { usePidPathHelper } from './procinfo.mjs';
import { Controller } from './controller.mjs';
import { createDeps, loadOverrides } from './deps.mjs';
import { serve } from './protocol.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith('--') || argv[i + 1] === undefined) throw new Error(`Bad argument ${key ?? ''}`);
    out[key.slice(2)] = argv[i + 1];
  }
  return out;
}

export async function main(argv = process.argv.slice(2), { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  const log = message => { try { stderr.write(`[controller ${process.pid}] ${message}\n`); } catch { /* closed */ } };
  let args;
  try { args = parseArgs(argv); } catch (failure) { log(`${failure.message}. Usage: main.mjs --resources <dir> --runtimes <dir> --data <dir> [--layout app|launch] [--ports <json>] [--deps-module <file>]`); return 64; }
  const config = resolveConfig({
    resources: args.resources ? path.resolve(args.resources) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
    runtimes: args.runtimes && path.resolve(args.runtimes), data: args.data && path.resolve(args.data),
    layout: args.layout ?? 'app', ports: args.ports ? JSON.parse(args.ports) : {}, env,
  });
  usePidPathHelper(config.paths.supervise);
  const deps = createDeps(config.resources, await loadOverrides(args['deps-module']));
  const write = body => { try { stdout.write(`${JSON.stringify(body)}\n`); } catch { /* closed */ } };
  const controller = new Controller({
    config, deps, emit: write, log,
    healthTimeoutMs: Number(env.CP_HEALTH_TIMEOUT_MS) || 60000,
    ...(deps.controllerOptions ?? {}),
  });
  stdout.on?.('error', () => {});
  log(`${PRODUCT_NAME} controller starting (${config.layout}, data ${config.data})`);
  await controller.init();
  let exitCode = 0;
  let stopping = false;
  const shutdown = async reason => {
    if (stopping) return;
    stopping = true;
    log(`shutting down (${reason})`);
    await controller.shutdown();
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { shutdown(signal).then(() => process.exit(controller.lockError ? 75 : 0)); });
  process.on('uncaughtException', failure => { log(`uncaught: ${failure.stack ?? failure}`); shutdown('uncaughtException').then(() => process.exit(70)); });
  await serve({ controller, input: stdin, write, log, onEnd: () => shutdown('stdin closed'), onLocked: () => setTimeout(() => process.exit(75), 200).unref() });
  await shutdown('stdin closed');
  if (controller.lockError) exitCode = 75;
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => process.exit(code), failure => { process.stderr.write(`${failure.stack ?? failure}\n`); process.exit(70); });
}
