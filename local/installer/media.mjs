// Install the game media archive. The host is undecided (gate 0), so the caller supplies the manifest.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { download, DownloadError } from './download.mjs';
import { extractArchive, ExtractError } from './extract.mjs';
import { InstallerError } from './claude.mjs';

const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateMediaManifest(m) {
  const bad = (msg) => {
    throw new InstallerError(`invalid media manifest: ${msg}`, 'BAD_INPUT');
  };
  if (!m || typeof m !== 'object') bad('not an object');
  if (!VERSION_RE.test(m.version || '') || m.version === 'current') bad('version');
  let u;
  try {
    u = new URL(m.url);
  } catch {
    bad('url');
  }
  const loopback = u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !loopback) bad('url must be https (http only for loopback)');
  if (!/^[0-9a-f]{64}$/i.test(m.sha256 || '')) bad('sha256');
  if (!Number.isSafeInteger(m.size) || m.size <= 0) bad('size');
  if (!Number.isSafeInteger(m.installedSize) || m.installedSize <= 0) bad('installedSize');
  if (m.format !== 'tar.gz' && m.format !== 'tar') bad('format must be tar.gz or tar');
  return m;
}

async function freeBytes(dir, statfs) {
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

async function exists(p) {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Point `<mediaDir>/current` at `version` via temp symlink + rename. Returns the previous target or null. */
export async function switchCurrent(mediaDir, version) {
  const link = path.join(mediaDir, 'current');
  let previous = null;
  try {
    const st = await fsp.lstat(link);
    if (!st.isSymbolicLink()) throw new InstallerError(`${link} exists and is not a symlink`, 'BAD_INPUT');
    previous = await fsp.readlink(link);
  } catch (e) {
    if (e instanceof InstallerError) throw e;
    if (e.code !== 'ENOENT') throw e;
  }
  const tmp = path.join(mediaDir, `.current.tmp-${crypto.randomBytes(4).toString('hex')}`);
  await fsp.symlink(version, tmp); // relative target keeps the data root relocatable
  try {
    await fsp.rename(tmp, link);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
  return previous;
}

/**
 * installMedia({ manifest, root, onProgress, signal })
 * -> { dir, current, version, previous, pruned, reused }
 * Optional: fetchImpl, statfs (injectable for tests), keepPrevious, downloadOptions.
 * onProgress receives { label: 'space'|'download'|'extract'|'activate', done, total }.
 * A manifest with `source: "git"` is installed from a pinned commit by media-git.mjs; it also needs `git`.
 */
export async function installMedia(options) {
  if (options?.manifest?.source === 'git') {
    const { installGitMedia } = await import('./media-git.mjs');
    return installGitMedia(options);
  }
  return installArchiveMedia(options);
}

async function installArchiveMedia({
  manifest, root, onProgress, signal, fetchImpl = globalThis.fetch, statfs = fsp.statfs,
  keepPrevious = false, downloadOptions = {},
}) {
  if (!root) throw new InstallerError('root is required', 'BAD_INPUT');
  validateMediaManifest(manifest);
  root = path.resolve(root);
  const mediaDir = path.join(root, 'media');
  const downloadsDir = path.join(root, 'downloads');
  const target = path.join(mediaDir, manifest.version);
  const step = (label, done, total = null) => onProgress?.({ label, done, total });
  await fsp.mkdir(mediaDir, { recursive: true });
  await fsp.mkdir(downloadsDir, { recursive: true });

  const archive = path.join(downloadsDir, `media-${manifest.version}.${manifest.format}`);
  let reused = false;
  if (await exists(target)) {
    reused = true; // extraction is an atomic rename, so an existing directory is complete
  } else {
    let partialBytes = 0;
    for (const f of [archive, `${archive}.partial`]) {
      try {
        partialBytes = Math.max(partialBytes, (await fsp.stat(f)).size);
      } catch { /* none */ }
    }
    const required = Math.max(manifest.size - partialBytes, 0) + manifest.installedSize;
    const free = await freeBytes(mediaDir, statfs);
    step('space', free, required);
    if (free < required) {
      throw new InstallerError(
        `not enough free disk space: need ${required} bytes, have ${free}`,
        'DISK_SPACE',
        { freeBytes: free, requiredBytes: required, downloadBytes: manifest.size, installedBytes: manifest.installedSize },
      );
    }
    try {
      await download({
        url: manifest.url, dest: archive, sha256: manifest.sha256, size: manifest.size, signal, fetchImpl,
        onProgress: ({ done, total }) => step('download', done, total),
        ...downloadOptions,
      });
    } catch (e) {
      if (e instanceof DownloadError) {
        const code = e.code === 'ABORTED' ? 'ABORTED' : e.code === 'VERIFY' || e.code === 'SIZE' ? 'VERIFY' : 'DOWNLOAD';
        throw new InstallerError(e.message, code, e.detail);
      }
      throw e;
    }
    try {
      await extractArchive({
        archive, destDir: target, format: manifest.format, signal,
        maxTotalBytes: Math.max(Math.ceil(manifest.installedSize * 1.1), manifest.installedSize + (16 << 20)),
        onProgress: ({ done }) => step('extract', done, manifest.installedSize),
      });
    } catch (e) {
      if (e instanceof ExtractError) throw new InstallerError(e.message, e.code === 'ABORTED' ? 'ABORTED' : 'VERIFY', { reason: e.code, ...e.detail });
      throw e;
    }
    await fsp.writeFile(
      path.join(mediaDir, `${manifest.version}.install.json`),
      `${JSON.stringify({ version: manifest.version, sha256: manifest.sha256, size: manifest.size, installedSize: manifest.installedSize, url: manifest.url, installedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    await fsp.rm(archive, { force: true });
  }

  step('activate', 0, 1);
  const previous = await switchCurrent(mediaDir, manifest.version);
  step('activate', 1, 1);

  const pruned = [];
  if (!keepPrevious && previous && previous !== manifest.version && VERSION_RE.test(previous)) {
    await fsp.rm(path.join(mediaDir, previous), { recursive: true, force: true });
    await fsp.rm(path.join(mediaDir, `${previous}.install.json`), { force: true });
    pruned.push(previous);
  }
  return { dir: target, current: path.join(mediaDir, 'current'), version: manifest.version, previous, pruned, reused };
}
