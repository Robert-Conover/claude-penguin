// Safe in-process tar / tar.gz extraction. See README.md.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

export class ExtractError extends Error {
  /** @param code UNSAFE_PATH | UNSAFE_ENTRY | TOO_LARGE | BAD_ARCHIVE | ABORTED | EXISTS */
  constructor(message, code, detail = {}) {
    super(message);
    this.name = 'ExtractError';
    this.code = code;
    this.detail = detail;
  }
}

class Reader {
  constructor(iterable) {
    this.it = iterable[Symbol.asyncIterator]();
    this.queue = [];
    this.queued = 0;
    this.eof = false;
    this.consumed = 0;
  }

  async fill(n) {
    while (this.queued < n && !this.eof) {
      const { value, done } = await this.it.next();
      if (done) this.eof = true;
      else {
        const b = Buffer.isBuffer(value) ? value : Buffer.from(value);
        this.queue.push(b);
        this.queued += b.length;
      }
    }
  }

  /** Up to n bytes (fewer only at EOF). */
  async read(n) {
    await this.fill(n);
    const take = Math.min(n, this.queued);
    const out = Buffer.allocUnsafe(take);
    let off = 0;
    while (off < take) {
      const head = this.queue[0];
      const c = Math.min(head.length, take - off);
      head.copy(out, off, 0, c);
      off += c;
      if (c === head.length) this.queue.shift();
      else this.queue[0] = head.subarray(c);
    }
    this.queued -= take;
    this.consumed += take;
    return out;
  }

  /** Yield exactly n bytes in chunks; throws if the stream ends first. */
  async *chunks(n, signal) {
    let left = n;
    while (left > 0) {
      if (signal?.aborted) throw new ExtractError('extraction aborted', 'ABORTED');
      const b = await this.read(Math.min(left, 1 << 20));
      if (!b.length) throw new ExtractError('archive truncated', 'BAD_ARCHIVE');
      left -= b.length;
      yield b;
    }
  }

  async drain() {
    for (;;) {
      const b = await this.read(1 << 20);
      if (!b.length) return;
    }
  }
}

function cstr(buf) {
  const z = buf.indexOf(0);
  return buf.toString('utf8', 0, z < 0 ? buf.length : z);
}

function parseNumber(buf) {
  if (buf[0] & 0x80) {
    // GNU base-256
    let v = BigInt(buf[0] & 0x7f);
    for (let i = 1; i < buf.length; i++) v = (v << 8n) | BigInt(buf[i]);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ExtractError('numeric field too large', 'BAD_ARCHIVE');
    return Number(v);
  }
  const s = cstr(buf).trim();
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) throw new ExtractError(`bad numeric field "${s}"`, 'BAD_ARCHIVE');
  return parseInt(s, 8);
}

function checksumOk(h) {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  return sum === parseNumber(h.subarray(148, 156));
}

function parsePax(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp < 0) throw new ExtractError('bad pax record', 'BAD_ARCHIVE');
    const len = parseInt(buf.toString('ascii', i, sp), 10);
    if (!(len > sp - i + 1) || i + len > buf.length) throw new ExtractError('bad pax record length', 'BAD_ARCHIVE');
    const rec = buf.toString('utf8', sp + 1, i + len - 1); // drop trailing \n
    const eq = rec.indexOf('=');
    if (eq < 0) throw new ExtractError('bad pax record', 'BAD_ARCHIVE');
    out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/** Returns a normalized relative POSIX path or throws UNSAFE_PATH. */
export function safeRelativePath(name) {
  if (typeof name !== 'string' || !name) throw new ExtractError('empty entry name', 'UNSAFE_PATH', { name });
  if (name.includes('\0')) throw new ExtractError('NUL in entry name', 'UNSAFE_PATH', { name });
  if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name)) {
    throw new ExtractError(`absolute path in archive: ${name}`, 'UNSAFE_PATH', { name });
  }
  const parts = name.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) throw new ExtractError(`path traversal in archive: ${name}`, 'UNSAFE_PATH', { name });
  if (name.includes('\\') && name.split(/[\\/]/).includes('..')) {
    throw new ExtractError(`path traversal in archive: ${name}`, 'UNSAFE_PATH', { name });
  }
  return parts.join('/');
}

async function* gunzipped(file) {
  const gz = fs.createReadStream(file).pipe(zlib.createGunzip());
  yield* gz;
}

function sniff(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(2);
    fs.readSync(fd, b, 0, 2, 0);
    return b[0] === 0x1f && b[1] === 0x8b ? 'tar.gz' : 'tar';
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * extractArchive({ archive, destDir, format, maxTotalBytes, maxEntries, replace, onProgress, signal })
 * Extracts into a sibling staging directory and renames it to destDir at the end.
 * Returns { destDir, files, directories, bytes }.
 * Only regular files and directories are accepted; everything else rejects the whole archive.
 */
export async function extractArchive({
  archive, destDir, format, maxTotalBytes = 16 * 1024 ** 3, maxEntries = 2_000_000,
  replace = false, onProgress, signal,
}) {
  if (!archive || !destDir) throw new TypeError('extractArchive: archive and destDir are required');
  destDir = path.resolve(destDir);
  const fmt = format === 'tar' || format === 'tar.gz' ? format : sniff(archive);
  if (!replace) {
    try {
      await fsp.lstat(destDir);
      throw new ExtractError(`destination exists: ${destDir}`, 'EXISTS');
    } catch (e) {
      if (e instanceof ExtractError) throw e;
    }
  }
  await fsp.mkdir(path.dirname(destDir), { recursive: true });
  const staging = path.join(path.dirname(destDir), `.${path.basename(destDir)}.staging-${crypto.randomBytes(4).toString('hex')}`);
  await fsp.mkdir(staging, { mode: 0o755 });
  const stats = { files: 0, directories: 0, bytes: 0 };
  try {
    const source = fmt === 'tar.gz' ? gunzipped(archive) : fs.createReadStream(archive);
    const r = new Reader(source);
    let paxGlobal = {};
    let paxNext = null;
    let longName = null;
    let entries = 0;
    let declared = 0;
    for (;;) {
      if (signal?.aborted) throw new ExtractError('extraction aborted', 'ABORTED');
      const h = await r.read(512);
      if (h.length === 0) throw new ExtractError('archive ended without end-of-archive marker', 'BAD_ARCHIVE');
      if (h.length < 512) throw new ExtractError('archive truncated in header', 'BAD_ARCHIVE');
      if (h.every((b) => b === 0)) break;
      if (!checksumOk(h)) throw new ExtractError('tar header checksum mismatch', 'BAD_ARCHIVE');
      const type = String.fromCharCode(h[156] || 0x30);
      let size = parseNumber(h.subarray(124, 136));
      const magic = h.toString('ascii', 257, 262);
      let name = cstr(h.subarray(0, 100));
      if (magic === 'ustar') {
        const prefix = cstr(h.subarray(345, 500));
        if (prefix) name = `${prefix}/${name}`;
      }
      const padded = Math.ceil(size / 512) * 512;

      if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
        if (size > 1 << 20) throw new ExtractError('metadata header too large', 'BAD_ARCHIVE');
        const body = Buffer.concat([await r.read(size)]);
        if (body.length < size) throw new ExtractError('archive truncated', 'BAD_ARCHIVE');
        await r.read(padded - size);
        if (type === 'x') paxNext = parsePax(body);
        else if (type === 'g') paxGlobal = { ...paxGlobal, ...parsePax(body) };
        else if (type === 'L') longName = cstr(body);
        continue; // 'K' (long link name) only matters for links, which are rejected anyway
      }
      const pax = { ...paxGlobal, ...(paxNext || {}) };
      paxNext = null;
      if (pax.path) name = pax.path;
      if (longName) {
        name = longName;
        longName = null;
      }
      if (pax.size != null) size = Number(pax.size);
      if (!Number.isSafeInteger(size) || size < 0) throw new ExtractError('bad entry size', 'BAD_ARCHIVE');

      if (++entries > maxEntries) throw new ExtractError(`archive has more than ${maxEntries} entries`, 'TOO_LARGE');
      const isFile = type === '0';
      const isDir = type === '5';
      if (!isFile && !isDir) {
        const kind = { 1: 'hard link', 2: 'symbolic link', 3: 'character device', 4: 'block device', 6: 'FIFO', 7: 'contiguous file' }[type] || `type '${type}'`;
        throw new ExtractError(`unsupported entry (${kind}): ${name}`, 'UNSAFE_ENTRY', { name, type });
      }
      const rel = safeRelativePath(name);
      const target = path.join(staging, rel);
      const back = path.relative(staging, target);
      if (back.startsWith('..') || path.isAbsolute(back)) throw new ExtractError(`path escapes destination: ${name}`, 'UNSAFE_PATH', { name });

      if (isDir) {
        if (rel) await fsp.mkdir(target, { recursive: true, mode: 0o755 });
        stats.directories++;
        if (size) await r.read(Math.ceil(size / 512) * 512);
        continue;
      }
      if (!rel) throw new ExtractError('file entry with empty name', 'UNSAFE_PATH', { name });
      declared += size;
      if (declared > maxTotalBytes) throw new ExtractError(`archive exceeds size cap of ${maxTotalBytes} bytes`, 'TOO_LARGE', { declared });
      await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      const mode = parseNumber(h.subarray(100, 108));
      const fh = await fsp.open(target, 'w', mode & 0o111 ? 0o755 : 0o644);
      try {
        for await (const chunk of r.chunks(size, signal)) {
          await fh.write(chunk);
          stats.bytes += chunk.length;
          onProgress?.({ done: stats.bytes, total: null, file: rel });
        }
      } finally {
        await fh.close();
      }
      await r.read(padded - size);
      stats.files++;
    }
    await r.drain(); // surfaces gzip CRC / trailing errors
    onProgress?.({ done: stats.bytes, total: null });
    if (replace) {
      const old = `${destDir}.old-${crypto.randomBytes(4).toString('hex')}`;
      let moved = false;
      try {
        await fsp.rename(destDir, old);
        moved = true;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      await fsp.rename(staging, destDir);
      if (moved) await fsp.rm(old, { recursive: true, force: true });
    } else {
      await fsp.rename(staging, destDir);
    }
    return { destDir, ...stats };
  } catch (err) {
    await fsp.rm(staging, { recursive: true, force: true });
    if (err instanceof ExtractError) throw err;
    if (signal?.aborted) throw new ExtractError('extraction aborted', 'ABORTED');
    throw new ExtractError(`extraction failed: ${err.message}`, 'BAD_ARCHIVE');
  }
}
