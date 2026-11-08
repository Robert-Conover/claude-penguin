// Resumable, verified HTTP download. See README.md.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export class DownloadError extends Error {
  /** @param code ABORTED | HTTP | NETWORK | VERIFY | SIZE */
  constructor(message, code, detail = {}) {
    super(message);
    this.name = 'DownloadError';
    this.code = code;
    this.detail = detail;
  }
}

export async function sha256File(file, signal) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) {
    if (signal?.aborted) throw new DownloadError('aborted', 'ABORTED');
    h.update(chunk);
  }
  return h.digest('hex');
}

const sleepDefault = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DownloadError('aborted', 'ABORTED'));
    }, { once: true });
  });

async function statSize(file) {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return 0;
  }
}

async function readMeta(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function validatorOf(headers) {
  const etag = headers.get('etag');
  if (etag && !etag.startsWith('W/')) return etag; // weak ETags are not valid for If-Range
  return headers.get('last-modified') || null;
}

/**
 * download({ url, dest, sha256, size, onProgress, signal, fetchImpl, retries, backoffMs, sleep })
 * -> { path, sha256, size, resumedBytes, restarts, attempts }
 * `sha256` and `size` are optional but every caller in this package passes them.
 */
export async function download({
  url, dest, sha256, size, onProgress, signal, fetchImpl = globalThis.fetch,
  retries = 4, backoffMs = 500, sleep = sleepDefault, headers = {},
}) {
  if (!url || !dest) throw new TypeError('download: url and dest are required');
  const partial = `${dest}.partial`;
  const metaFile = `${dest}.partial.json`;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const wantHash = sha256 ? sha256.toLowerCase() : null;

  // Already complete and verified from an earlier run.
  if ((await statSize(dest)) > 0 && wantHash) {
    if (size == null || (await statSize(dest)) === size) {
      if ((await sha256File(dest, signal)) === wantHash) {
        onProgress?.({ done: await statSize(dest), total: size ?? null });
        return { path: dest, sha256: wantHash, size: await statSize(dest), resumedBytes: 0, restarts: 0, attempts: 0, cached: true };
      }
    }
  }

  let restarts = 0;
  let attempts = 0;
  let failures = 0;
  let resumedBytes = 0;
  let lastReport = 0;
  let freshVerifyRetried = false;

  const report = (done, total, force) => {
    const now = Date.now();
    if (force || now - lastReport >= 100) {
      lastReport = now;
      onProgress?.({ done, total });
    }
  };
  const reset = async () => {
    await fsp.rm(partial, { force: true });
    await fsp.rm(metaFile, { force: true });
  };

  for (;;) {
    if (signal?.aborted) throw new DownloadError('download aborted', 'ABORTED');
    attempts++;
    let have = await statSize(partial);
    const meta = await readMeta(metaFile);
    if (have > 0 && (!meta?.validator || meta.url !== url || (size != null && have > size))) {
      await reset();
      restarts++;
      have = 0;
    }
    const reqHeaders = { ...headers };
    if (have > 0) {
      reqHeaders.Range = `bytes=${have}-`;
      reqHeaders['If-Range'] = meta.validator;
    }
    let progressed = false;
    try {
      let res;
      try {
        res = await fetchImpl(url, { headers: reqHeaders, signal, redirect: 'follow' });
      } catch (e) {
        if (signal?.aborted) throw new DownloadError('download aborted', 'ABORTED');
        throw new DownloadError(`request failed: ${e.message}`, 'NETWORK');
      }
      if (res.status === 416) {
        await res.body?.cancel?.();
        // Our partial is not a valid prefix of the current file. Start over.
        await reset();
        restarts++;
        continue;
      }
      if (res.status >= 400) {
        await res.body?.cancel?.();
        const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
        throw new DownloadError(`HTTP ${res.status} for ${url}`, retryable ? 'NETWORK' : 'HTTP', { status: res.status });
      }
      let offset = 0;
      const validator = validatorOf(res.headers);
      if (res.status === 206) {
        const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(res.headers.get('content-range') || '');
        const changed = meta?.validator && validator && validator !== meta.validator;
        if (!m || Number(m[1]) !== have || changed) {
          await res.body?.cancel?.();
          await reset();
          restarts++;
          continue;
        }
        offset = have;
        resumedBytes = Math.max(resumedBytes, have);
      } else if (have > 0) {
        restarts++; // server ignored the range or If-Range failed: full body follows
      }
      const contentLength = Number(res.headers.get('content-length'));
      const total = size ?? (Number.isFinite(contentLength) && contentLength > 0 ? offset + contentLength : null);
      const expectedEnd = total;
      if (!validator && offset === 0) {
        // No validator: a later resume can't be safe, but this attempt can proceed.
      }
      const fh = await fsp.open(partial, offset > 0 ? 'a' : 'w');
      let written = offset;
      try {
        if (offset === 0) await fsp.writeFile(metaFile, JSON.stringify({ url, validator: validator || null }));
        report(written, total, true);
        for await (const chunk of res.body) {
          await fh.write(chunk);
          written += chunk.length;
          progressed = true;
          if (size != null && written > size) throw new DownloadError('body larger than expected size', 'SIZE', { written, size });
          report(written, total);
        }
      } finally {
        await fh.close();
      }
      if (signal?.aborted) throw new DownloadError('download aborted', 'ABORTED');
      if (expectedEnd != null && written < expectedEnd) {
        throw new DownloadError(`connection ended early (${written}/${expectedEnd})`, 'NETWORK');
      }
      report(written, total, true);

      // Verify before the final rename.
      const actual = await statSize(partial);
      if (size != null && actual !== size) {
        await reset();
        throw new DownloadError(`size mismatch: got ${actual}, expected ${size}`, 'VERIFY', { actual, size });
      }
      if (wantHash) {
        const got = await sha256File(partial, signal);
        if (got !== wantHash) {
          const wasResumed = offset > 0;
          await reset();
          if (wasResumed && !freshVerifyRetried) {
            freshVerifyRetried = true; // a stitched file may be corrupt: retry once from zero
            restarts++;
            continue;
          }
          throw new DownloadError(`SHA-256 mismatch: got ${got}, expected ${wantHash}`, 'VERIFY', { actual: got, expected: wantHash });
        }
      }
      await fsp.rename(partial, dest);
      await fsp.rm(metaFile, { force: true });
      return { path: dest, sha256: wantHash ?? null, size: actual, resumedBytes, restarts, attempts };
    } catch (err) {
      if (err instanceof DownloadError && (err.code === 'ABORTED' || err.code === 'HTTP' || err.code === 'VERIFY' || err.code === 'SIZE')) {
        if (err.code === 'SIZE') await reset();
        throw err;
      }
      if (signal?.aborted) throw new DownloadError('download aborted', 'ABORTED');
      failures = progressed ? 1 : failures + 1;
      if (failures > retries) {
        throw err instanceof DownloadError ? err : new DownloadError(`download failed: ${err.message}`, 'NETWORK');
      }
      await sleep(backoffMs * 2 ** (failures - 1), signal);
    }
  }
}
