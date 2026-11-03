import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const STATE_VERSION = 1;

/** State is private host data. Never recover a corrupt identity by silently replacing it. */
export function readState(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, 'state.json');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { version: STATE_VERSION, revision: 0, projects: [], workers: [] }; throw error; }
  let state;
  try { state = JSON.parse(raw); } catch { throw new Error('Agent state is invalid JSON; preserve it and repair it before restarting.'); }
  if (state?.version !== STATE_VERSION || !Array.isArray(state.projects) || !Array.isArray(state.workers) ||
      state.projects.length > 1 || state.workers.length > 1) throw new Error('Unsupported agent state; refusing to replace saved sessions.');
  state.revision ??= 0;
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error('Saved agent revision is invalid.');
  return state;
}

export function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function writeState(stateDir, state) {
  writePrivateJson(path.join(stateDir, 'state.json'), state);
}
