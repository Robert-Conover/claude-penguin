// Explicit v1 → v2 state migration. Usage:
//   node local/engine/migrate.mjs --state-dir <dir> --rehearsal
// It takes the runtime lock (so no engine can start meanwhile), refuses while
// a saved engine or worker process may be alive, preserves the original bytes
// in a 0600 backup, and replaces state.json atomically.
//
// Stage 1 boundary: only rehearsal copies outside this checkout's .local/ may
// be migrated. Real Atlas migration is enabled after the archive and
// isolated-replacement controls exist.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock } from './lock.mjs';
import { inside } from './workspace.mjs';
import { migrateStateDir } from './state.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function migrate({ stateDir, rehearsal = false, at } = {}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw new Error('Pass --state-dir with an absolute path.');
  const real = fs.realpathSync.native(stateDir);
  // .local/ may be absent (a fresh checkout) or a symlink elsewhere; resolve it only when present.
  const localDir = path.join(projectRoot, '.local');
  const protectedDirs = [projectRoot, ...(fs.existsSync(localDir) ? [localDir] : [])].map(dir => fs.realpathSync.native(dir));
  if (!rehearsal || protectedDirs.some(dir => inside(dir, real))) {
    throw new Error('This milestone migrates only private rehearsal copies outside the checkout (pass --rehearsal). Real state migration is enabled with the archive and replacement controls.');
  }
  const unlock = await acquireLock(real);
  try { return migrateStateDir(real, { at }); }
  finally { await unlock(); }
}

async function main(argv) {
  const index = argv.indexOf('--state-dir');
  const stateDir = index >= 0 ? path.resolve(argv[index + 1] ?? '') : undefined;
  const result = await migrate({ stateDir, rehearsal: argv.includes('--rehearsal') });
  if (!result.migrated) { console.log('State is already version 2; nothing changed.'); return; }
  console.log(`Migrated to version 2. Original bytes preserved at ${result.backup}`);
  for (const project of result.state.projects) console.log(`Project ${project.id} (${project.name}): source ${project.sourceAvailable ? 'available' : 'unavailable'}, game ${project.game?.source ?? 'none'}.`);
  for (const worker of result.state.workers) console.log(`Archived worker ${worker.name} (${worker.id}), session ${worker.sessionId}, ${worker.taskHistory.length} tasks.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(failure => { console.error(failure.message); process.exitCode = 1; });
}
