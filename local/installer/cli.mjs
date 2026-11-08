#!/usr/bin/env node
// node local/installer/cli.mjs claude --version V --root DIR [--config-dir DIR]
// node local/installer/cli.mjs media --manifest FILE --root DIR
// Emits JSON lines: progress events, problem events, and a final {"event":"done",...}.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installClaude, verifyClaude, InstallerError, loadReleasePin } from './claude.mjs';
import { installMedia } from './media.mjs';

const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) out[a.slice(2)] = true;
      else out[a.slice(2)] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

function throttled(task) {
  let last = 0;
  let lastKey = '';
  return ({ label, done, total }) => {
    const now = Date.now();
    const key = `${label}`;
    const final = total != null && done >= total;
    if (final || key !== lastKey || now - last >= 250) {
      last = now;
      lastKey = key;
      emit({ event: 'progress', task, label, done, total: total ?? null });
    }
  };
}

function problem(err) {
  const code = err instanceof InstallerError ? err.code : 'DOWNLOAD';
  const mapped = code === 'ABORTED' ? 'ABORTED' : code === 'BAD_INPUT' ? 'VERIFY' : code;
  emit({ event: 'problem', code: mapped, message: err.message, detail: err.detail ?? {} });
}

export async function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  const ac = new AbortController();
  for (const s of ['SIGINT', 'SIGTERM']) process.once(s, () => ac.abort());
  try {
    if (!args.root) throw new InstallerError('--root is required', 'BAD_INPUT');
    const root = path.resolve(args.root);
    if (cmd === 'claude') {
      const pin = await loadReleasePin();
      const version = typeof args.version === 'string' ? args.version : pin.version;
      const res = await installClaude({ version, root, signal: ac.signal, onProgress: throttled('claude') });
      let verified = null;
      if (args['config-dir']) {
        verified = await verifyClaude({ path: res.path, version, configDir: path.resolve(args['config-dir']), signal: ac.signal });
      }
      emit({ event: 'done', task: 'claude', ok: true, ...res, verified });
      return 0;
    }
    if (cmd === 'media') {
      if (typeof args.manifest !== 'string') throw new InstallerError('--manifest FILE is required', 'BAD_INPUT');
      const manifest = JSON.parse(await fsp.readFile(args.manifest, 'utf8'));
      const res = await installMedia({ manifest, root, signal: ac.signal, onProgress: throttled('media') });
      emit({ event: 'done', task: 'media', ok: true, ...res });
      return 0;
    }
    throw new InstallerError('usage: cli.mjs claude --version V --root DIR | cli.mjs media --manifest FILE --root DIR', 'BAD_INPUT');
  } catch (err) {
    problem(err);
    emit({ event: 'done', task: cmd ?? null, ok: false, error: err.message });
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
