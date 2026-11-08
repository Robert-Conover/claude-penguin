import readline from 'node:readline';
import { ControllerError } from './lock.mjs';

const MAX_LINE = 1024 * 1024;
const COMMANDS = {
  status: c => c.status(),
  preflight: (c, req) => c.preflight(req.mode),
  setup: (c, req) => c.setup(req.mode),
  start: (c, req) => c.start(req.mode),
  stop: c => c.stop(),
  cancel: c => c.cancel(),
  recover: (c, req) => c.recover(req.action),
};

export function errorBody(failure) {
  if (failure instanceof ControllerError || typeof failure?.code === 'string' && /^[A-Z_]+$/.test(failure.code)) {
    return { code: failure.code, message: failure.message, ...(failure.detail ? { detail: failure.detail } : {}) };
  }
  return { code: 'INTERNAL', message: failure?.message ?? String(failure) };
}

/**
 * JSON-lines protocol over a pair of streams. Requests run concurrently (the controller itself
 * serializes conflicting operations), so `status` and `cancel` answer while setup runs.
 * Resolves when the input ends.
 */
export function serve({ controller, input, write, log = () => {}, onEnd = async () => {}, onLocked = () => {} }) {
  const pending = new Set();
  const respond = body => write(body);
  const handle = async line => {
    let request;
    try { request = JSON.parse(line); }
    catch { respond({ id: null, ok: false, error: { code: 'BAD_REQUEST', message: 'The request is not valid JSON.' } }); return; }
    if (!request || typeof request !== 'object' || Array.isArray(request)) { respond({ id: null, ok: false, error: { code: 'BAD_REQUEST', message: 'A request must be a JSON object.' } }); return; }
    const id = request.id ?? null;
    if (id !== null && typeof id !== 'number' && typeof id !== 'string') { respond({ id: null, ok: false, error: { code: 'BAD_REQUEST', message: 'id must be a number or string.' } }); return; }
    const run = Object.hasOwn(COMMANDS, request.cmd) ? COMMANDS[request.cmd] : null;
    if (!run) { respond({ id, ok: false, error: { code: 'UNKNOWN_COMMAND', message: `Unknown command ${JSON.stringify(request.cmd)}.` } }); return; }
    if (controller.lockError) { respond({ id, ok: false, error: errorBody(controller.lockError) }); onLocked(); return; }
    try { respond({ id, ok: true, result: await run(controller, request) }); }
    catch (failure) { log(`${request.cmd} failed: ${failure.message}`); respond({ id, ok: false, error: errorBody(failure) }); }
  };
  return new Promise(resolve => {
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    rl.on('line', line => {
      if (!line.trim()) return;
      if (line.length > MAX_LINE) { respond({ id: null, ok: false, error: { code: 'BAD_REQUEST', message: 'Request line too long.' } }); return; }
      const task = handle(line).finally(() => pending.delete(task));
      pending.add(task);
    });
    rl.once('close', async () => { const ending = Promise.resolve().then(onEnd).catch(() => {}); await Promise.allSettled([...pending]); await ending; resolve(); });
  });
}
