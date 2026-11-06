// Explicit state migration (v1 → v2 → v3, one step at a time). Usage:
//   node local/engine/migrate.mjs --state-dir <dir>
// It takes the runtime lock (so no engine can start meanwhile), refuses while
// a saved engine or worker process may be alive, preserves the original bytes
// in a 0600 backup, and replaces state.json atomically.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock } from './lock.mjs';
import { stateDirProblem } from './state-dir.mjs';
import { migrateStateDir } from './state.mjs';

export async function migrate({ stateDir, rehearsal = false, at } = {}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw new Error('Pass --state-dir with an absolute path.');
  const real = fs.realpathSync.native(stateDir);
  if (rehearsal) {
    const root = fs.realpathSync.native(fileURLToPath(new URL('../../', import.meta.url)));
    const local = path.join(root, '.local');
    const protectedDirs = [root, ...(fs.existsSync(local) ? [fs.realpathSync.native(local)] : [])];
    if (protectedDirs.some(dir => real === dir || real.startsWith(dir + path.sep))) {
      throw new Error('Use --rehearsal on a private copy outside this checkout. Omit it for an explicit in-place migration.');
    }
  }
  const problem = stateDirProblem(real);
  if (problem) throw new Error(problem);
  const unlock = await acquireLock(real);
  try { return migrateStateDir(real, { at }); }
  finally { await unlock(); }
}

async function main(argv) {
  // Keep the old rehearsal spelling for scripts migrating private copies.
  const args = argv.filter(arg => arg !== '--rehearsal');
  if (args.length !== 2 || args[0] !== '--state-dir' || !args[1] || args[1].startsWith('--')) {
    throw new Error('Usage: node local/engine/migrate.mjs --state-dir <state folder>');
  }
  const result = await migrate({ stateDir: path.resolve(args[1]), rehearsal: argv.includes('--rehearsal') });
  if (!result.migrated) { console.log('State is already version 3; nothing changed.'); return; }
  console.log('Migrated to version 3. The bytes before each step are preserved at:');
  for (const backup of result.backups) console.log(`  ${backup}`);
  for (const project of result.state.projects) console.log(`Project ${project.id} (${project.name}): source ${project.sourceAvailable ? 'available' : 'unavailable'}, game ${project.game?.source ?? 'none'}.`);
  for (const worker of result.state.workers) {
    const binding = worker.puffle ? `puffle ${worker.puffle.puffleId}` : 'no puffle';
    console.log(`${worker.archived ? 'Archived' : 'Active'} worker ${worker.name} (${worker.id}), session ${worker.sessionId}, ${binding}, ${worker.taskHistory.length} tasks.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(failure => { console.error(failure.message); process.exitCode = 1; });
}
