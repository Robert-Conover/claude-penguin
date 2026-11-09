// Install the game media from a pinned Git commit with the app's bundled Git.
//
// The media's only public source is a Git repository (the checkout's `vanilla-media` submodule). A generated
// archive of it has no size and no resume support, so this fetches the commit itself, in a way that resumes:
//   1. a shallow, blob-less fetch of the pinned commit (its trees only, a few MB), checked against the pinned tree;
//   2. the file contents (blobs) in batches; every finished batch stays on disk, so a retry or a later run
//      fetches only what is still missing;
//   3. an offline checkout, a status check, then the Git data is deleted and the directory renamed into place.
// Git checks every object it receives against its ID, and the commit and tree IDs are pinned, so the result
// is exactly the pinned tree.
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InstallerError } from './claude.mjs';
import { switchCurrent } from './media.mjs';

const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const OID_RE = /^[0-9a-f]{40}$/;
/** GIT_NO_LAZY_FETCH and the partial-clone behaviour relied on here; the app bundles 2.56. */
export const MIN_GIT_VERSION = Object.freeze([2, 45, 0]);
const PASS_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'ALL_PROXY', 'all_proxy', 'TMPDIR'];
// Every Git command: no prompts, no background maintenance or repacking, and give up on a stalled connection
// (under 1 KiB/s for 60 s) so the retry can take over.
const GIT_CONFIG = [
  'protocol.version=2', 'core.autocrlf=false', 'core.fsmonitor=false', 'gc.auto=0', 'maintenance.auto=false',
  'fetch.writeCommitGraph=false', 'http.lowSpeedLimit=1024', 'http.lowSpeedTime=60', 'checkout.workers=0',
].flatMap(c => ['-c', c]);
const LOCKS = ['index.lock', 'shallow.lock', 'config.lock', 'HEAD.lock'];

export function validateGitMediaManifest(m, { allowFileUrl = false } = {}) {
  const bad = (msg) => {
    throw new InstallerError(`invalid media manifest: ${msg}`, 'BAD_INPUT');
  };
  if (!m || typeof m !== 'object') bad('not an object');
  if (m.source !== 'git') bad('source must be git');
  if (!VERSION_RE.test(m.version || '') || m.version === 'current' || m.version.endsWith('.partial')) bad('version');
  let u;
  try {
    u = new URL(m.url);
  } catch {
    bad('url');
  }
  const loopback = u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !loopback && !(allowFileUrl && u.protocol === 'file:')) bad('url must be https (http only for loopback)');
  if (!OID_RE.test(m.commit || '')) bad('commit must be a full 40-character commit ID');
  if (!OID_RE.test(m.tree || '')) bad('tree must be a full 40-character tree ID');
  for (const key of ['files', 'size', 'installedSize']) {
    if (!Number.isSafeInteger(m[key]) || m[key] <= 0) bad(key);
  }
  return m;
}

const aborted = () => new InstallerError('aborted', 'ABORTED');
const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(aborted());
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(aborted()); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

async function exists(p) {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** A minimal environment: no user or system Git configuration, no prompts; proxies pass through. */
export function gitEnvironment(base = process.env, extra = {}) {
  const env = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: base.HOME || os.homedir(), LANG: 'C', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  };
  for (const k of PASS_ENV) if (base[k]) env[k] = base[k];
  return { ...env, ...extra };
}

/** Runs git without a shell. Resolves on any exit status; rejects only when git cannot start or on abort. */
function runGit(git, args, { cwd, env, input, signal, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted());
    const child = spawn(git, [...GIT_CONFIG, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    const onAbort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', c => out.push(c));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', c => {
      err = (err + c).slice(-16384);
      onStderr?.(c);
    });
    child.stdin.on('error', () => {}); // git may exit before reading all of its input
    child.once('error', e => {
      signal?.removeEventListener('abort', onAbort);
      reject(new InstallerError(`could not run ${git}: ${e.message}`, 'BAD_INPUT'));
    });
    child.once('close', (code, sig) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(aborted());
      resolve({ code: code ?? 128, signal: sig, stdout: Buffer.concat(out).toString('utf8'), stderr: err });
    });
    child.stdin.end(input ?? '');
  });
}

const tail = (text, n = 600) => String(text || '').trim().slice(-n);

export async function gitVersion(git, env) {
  const r = await runGit(git, ['--version'], { env });
  const m = /git version (\d+)\.(\d+)\.(\d+)/.exec(r.stdout);
  if (r.code !== 0 || !m) throw new InstallerError(`could not read the Git version of ${git}`, 'BAD_INPUT', { stderr: tail(r.stderr) });
  return m.slice(1, 4).map(Number);
}

const versionAtLeast = (have, want) => {
  for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return have[i] > want[i];
  return true;
};

/** Bytes of fetched pack data, including a pack still being received. */
async function packBytes(work) {
  const dir = path.join(work, '.git', 'objects', 'pack');
  let total = 0;
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith('.pack') && !name.startsWith('tmp_')) continue;
    try {
      total += (await fsp.stat(path.join(dir, name))).size;
    } catch { /* renamed or removed meanwhile */ }
  }
  return total;
}

/** What an interrupted Git process leaves: temporary packs and lock files. */
async function clearInterrupted(work) {
  const dir = path.join(work, '.git', 'objects', 'pack');
  try {
    for (const name of await fsp.readdir(dir)) if (name.startsWith('tmp_')) await fsp.rm(path.join(dir, name), { force: true });
  } catch { /* no pack directory yet */ }
  for (const lock of LOCKS) await fsp.rm(path.join(work, '.git', lock), { force: true });
}

async function freeBytes(dir, statfs) {
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/**
 * installGitMedia({ manifest, root, git, onProgress, signal })
 * -> { dir, current, version, previous, pruned, reused, downloadedBytes }
 * Optional: statfs, env, keepPrevious, batchSize, retries, backoffMs, sleep, pollMs, allowFileUrl (tests).
 * onProgress receives { label: 'space'|'trees'|'download'|'checkout'|'verify'|'activate', done, total }.
 */
export async function installGitMedia({
  manifest, root, git, onProgress, signal, statfs = fsp.statfs, env = process.env, keepPrevious = false,
  batchSize = 2000, retries = 4, backoffMs = 1000, sleep = defaultSleep, pollMs = 500, allowFileUrl = false,
}) {
  if (!root) throw new InstallerError('root is required', 'BAD_INPUT');
  if (!git) throw new InstallerError('git is required', 'BAD_INPUT');
  // Git runs with a minimal PATH, so a bare name would not be the Git the caller meant.
  if (!path.isAbsolute(git)) throw new InstallerError(`git must be a full path, not ${JSON.stringify(git)}`, 'BAD_INPUT');
  validateGitMediaManifest(manifest, { allowFileUrl });
  root = path.resolve(root);
  const mediaDir = path.join(root, 'media');
  const target = path.join(mediaDir, manifest.version);
  const work = path.join(mediaDir, `${manifest.version}.partial`);
  const step = (label, done, total = null) => onProgress?.({ label, done, total });
  const baseEnv = gitEnvironment(env);
  const offline = gitEnvironment(env, { GIT_NO_LAZY_FETCH: '1' });
  const inWork = (args, opts = {}) => runGit(git, args, { cwd: work, env: baseEnv, signal, ...opts });
  await fsp.mkdir(mediaDir, { recursive: true });

  let reused = false;
  let downloadedBytes = 0;
  if (await exists(target)) {
    reused = true; // the rename below is the commit point, so an existing directory is complete
  } else {
    const version = await gitVersion(git, baseEnv);
    if (!versionAtLeast(version, MIN_GIT_VERSION)) {
      throw new InstallerError(`Git ${version.join('.')} is too old to install the media; ${MIN_GIT_VERSION.join('.')} or newer is needed`, 'BAD_INPUT');
    }

    // A previous attempt's repository is reused only when it points at the same source.
    let resume = false;
    if (await exists(path.join(work, '.git'))) {
      const r = await inWork(['config', '--get', 'remote.origin.url']);
      resume = r.code === 0 && r.stdout.trim() === manifest.url;
    }
    if (!resume) {
      await fsp.rm(work, { recursive: true, force: true });
      await fsp.mkdir(work, { recursive: true });
      for (const args of [['init', '-q'], ['remote', 'add', 'origin', manifest.url]]) {
        const r = await inWork(args);
        if (r.code !== 0) throw new InstallerError(`git ${args[0]} failed: ${tail(r.stderr)}`, 'BAD_INPUT');
      }
    }
    await clearInterrupted(work);

    const fetched = await packBytes(work);
    const required = Math.max(manifest.size - fetched, 0) + manifest.installedSize;
    const free = await freeBytes(mediaDir, statfs);
    step('space', free, required);
    if (free < required) {
      throw new InstallerError(
        `not enough free disk space: need ${required} bytes, have ${free}`,
        'DISK_SPACE',
        { freeBytes: free, requiredBytes: required, downloadBytes: Math.max(manifest.size - fetched, 0), installedBytes: manifest.installedSize },
      );
    }

    const gitFetch = async (args, { input, label = 'download' } = {}) => {
      let last = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1), signal);
        await clearInterrupted(work);
        let polling = false;
        const timer = setInterval(async () => {
          if (polling) return;
          polling = true;
          try { step(label, await packBytes(work), manifest.size); } finally { polling = false; }
        }, pollMs);
        try {
          last = await inWork(args, { input });
        } finally {
          clearInterval(timer);
        }
        if (last.code === 0) return;
      }
      throw new InstallerError(`could not download the game media from ${manifest.url}: ${tail(last?.stderr) || `git exited ${last?.code}`}`, 'DOWNLOAD', { stderr: tail(last?.stderr, 2000) });
    };

    // 1. The commit and its trees.
    const hasCommit = (await runGit(git, ['cat-file', '-e', `${manifest.commit}^{commit}`], { cwd: work, env: offline, signal })).code === 0;
    if (!hasCommit) {
      step('trees', 0, 1);
      await gitFetch(['fetch', '--progress', '--depth=1', '--filter=blob:none', '--no-tags', '--no-write-fetch-head', 'origin', manifest.commit], { label: 'trees' });
      step('trees', 1, 1);
    }
    const tree = await runGit(git, ['rev-parse', '--verify', '--quiet', `${manifest.commit}^{tree}`], { cwd: work, env: offline, signal });
    if (tree.code !== 0 || tree.stdout.trim() !== manifest.tree) {
      await fsp.rm(work, { recursive: true, force: true });
      throw new InstallerError(`the media commit's tree is ${tree.stdout.trim() || 'missing'}, expected ${manifest.tree}`, 'VERIFY');
    }

    // 2. Every file must be a regular file; the count must match the pin.
    const listing = await runGit(git, ['ls-tree', '-r', '-z', manifest.commit], { cwd: work, env: offline, signal });
    if (listing.code !== 0) throw new InstallerError(`could not list the media tree: ${tail(listing.stderr)}`, 'VERIFY');
    const blobs = new Set();
    let files = 0;
    for (const record of listing.stdout.split('\0')) {
      if (!record) continue;
      const tab = record.indexOf('\t');
      const [mode, type, oid] = record.slice(0, tab).split(' ');
      if (type !== 'blob' || (mode !== '100644' && mode !== '100755') || !OID_RE.test(oid)) {
        await fsp.rm(work, { recursive: true, force: true });
        throw new InstallerError(`the media tree has an unsupported entry (${mode} ${type}) at ${record.slice(tab + 1)}`, 'VERIFY');
      }
      blobs.add(oid);
      files++;
    }
    if (files !== manifest.files) {
      await fsp.rm(work, { recursive: true, force: true });
      throw new InstallerError(`the media tree has ${files} files, expected ${manifest.files}`, 'VERIFY');
    }

    // 3. The file contents, in batches; each finished batch is kept.
    const missing = async () => {
      const r = await runGit(git, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { cwd: work, env: offline, signal, input: `${[...blobs].join('\n')}\n` });
      if (r.code !== 0) throw new InstallerError(`could not check the fetched media: ${tail(r.stderr)}`, 'VERIFY');
      const out = [];
      for (const line of r.stdout.split('\n')) {
        if (!line) continue;
        const [oid, type] = line.split(' ');
        if (type === 'missing') out.push(oid);
        else if (type !== 'blob') throw new InstallerError(`media object ${oid} is a ${type}, expected a blob`, 'VERIFY');
      }
      return out;
    };
    const before = await packBytes(work);
    let todo = await missing();
    step('download', before, manifest.size);
    for (let i = 0; i < todo.length; i += batchSize) {
      const batch = todo.slice(i, i + batchSize);
      await gitFetch(
        ['-c', 'fetch.negotiationAlgorithm=noop', 'fetch', '--progress', '--no-tags', '--no-write-fetch-head', '--recurse-submodules=no', '--filter=blob:none', '--stdin', 'origin'],
        { input: `${batch.join('\n')}\n` },
      );
      step('download', await packBytes(work), manifest.size);
    }
    todo = await missing();
    if (todo.length) throw new InstallerError(`the server did not send ${todo.length} media files (for example ${todo[0]})`, 'DOWNLOAD', { missing: todo.length });
    downloadedBytes = (await packBytes(work)) - before;

    // 4. Offline checkout, then confirm every file matches.
    step('checkout', 0, files);
    const checkout = await runGit(git, ['checkout', '--progress', '-f', '--detach', manifest.commit], {
      cwd: work, env: offline, signal,
      onStderr: chunk => {
        let m, last = null;
        const re = /Updating files:\s+\d+% \((\d+)\/(\d+)\)/g;
        while ((m = re.exec(chunk))) last = m;
        if (last) step('checkout', Number(last[1]), Number(last[2]));
      },
    });
    if (checkout.code !== 0) throw new InstallerError(`could not unpack the game media: ${tail(checkout.stderr)}`, 'VERIFY');
    step('verify', 0, 1);
    const head = await runGit(git, ['rev-parse', 'HEAD'], { cwd: work, env: offline, signal });
    const status = await runGit(git, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--no-renames'], { cwd: work, env: offline, signal });
    if (head.stdout.trim() !== manifest.commit || status.code !== 0 || status.stdout !== '') {
      throw new InstallerError(`the unpacked media does not match commit ${manifest.commit}`, 'VERIFY', { head: head.stdout.trim(), changes: status.stdout.split('\0').filter(Boolean).slice(0, 10) });
    }
    step('verify', 1, 1);

    // 5. Drop the Git data and move the files into place.
    await fsp.rm(path.join(work, '.git'), { recursive: true, force: true });
    await fsp.writeFile(
      path.join(mediaDir, `${manifest.version}.install.json`),
      `${JSON.stringify({ version: manifest.version, source: 'git', url: manifest.url, commit: manifest.commit, tree: manifest.tree, files, installedSize: manifest.installedSize, downloadedBytes, installedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    await fsp.rename(work, target);
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
  // Unfinished downloads of other versions are not needed any more.
  for (const name of await fsp.readdir(mediaDir)) {
    if (name.endsWith('.partial') && name !== `${manifest.version}.partial`) await fsp.rm(path.join(mediaDir, name), { recursive: true, force: true });
  }
  return { dir: target, current: path.join(mediaDir, 'current'), version: manifest.version, previous, pruned, reused, downloadedBytes };
}
