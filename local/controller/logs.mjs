import { closeSync, mkdirSync, openSync } from 'node:fs';
import { copyFile, stat, truncate } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_LOG_CAP_BYTES = 8 * 1024 * 1024;

/** Opens <logDir>/<name>.log for appending and returns the descriptor handed to the child as stdout and stderr. */
export function openLog(logDir, name) {
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const file = path.join(logDir, `${name}.log`);
  return { file, fd: openSync(file, 'a', 0o600) };
}
export function closeLog(fd) { try { closeSync(fd); } catch { /* closed */ } }

/**
 * Size cap without a pipe in the way (a pipe would break the service when the controller dies):
 * the service writes straight to an O_APPEND file; when it grows past the cap the controller keeps
 * the old content as <file>.1 (one generation) and truncates. Bytes written during the copy can be lost.
 */
export async function rotateIfNeeded(file, capBytes = DEFAULT_LOG_CAP_BYTES) {
  try {
    const info = await stat(file);
    if (info.size <= capBytes) return false;
    await copyFile(file, `${file}.1`);
    await truncate(file, 0);
    return true;
  } catch { return false; }
}
