import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { InstallerError } from './claude.mjs';
import { installMedia } from './media.mjs';
import { MIN_GIT_VERSION, installGitMedia, validateGitMediaManifest } from './media-git.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-media-git-')));
const isolated = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };

// The bundled Git when it has been built, otherwise a new enough Git on PATH.
function findGit() {
  const candidates = [process.env.CP_TEST_GIT, path.join(here, '..', '..', '.local', 'runtimes', 'git', 'bin', 'git'), 'git'].filter(Boolean);
  for (const git of candidates) {
    try {
      const m = /git version (\d+)\.(\d+)\.(\d+)/.exec(execFileSync(git, ['--version'], { encoding: 'utf8' }));
      const v = m.slice(1, 4).map(Number);
      const ok = v[0] !== MIN_GIT_VERSION[0] ? v[0] > MIN_GIT_VERSION[0] : v[1] !== MIN_GIT_VERSION[1] ? v[1] > MIN_GIT_VERSION[1] : v[2] >= MIN_GIT_VERSION[2];
      if (ok) return git;
    } catch { /* try the next */ }
  }
  return null;
}
const GIT = findGit();
const skip = GIT ? false : `needs Git ${MIN_GIT_VERSION.join('.')} or newer`;
const git = (cwd, ...args) => execFileSync(GIT, args, { cwd, env: isolated, encoding: 'utf8' }).trim();

/** A source repository with one commit; partial-clone fetches allowed, as on the real host. */
function makeSource(files, { symlink = null } = {}) {
  const dir = tmp();
  git(dir, 'init', '-q');
  for (const [name, data] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), data);
  }
  if (symlink) fs.symlinkSync(symlink.target, path.join(dir, symlink.name));
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'media');
  git(dir, 'config', 'uploadpack.allowFilter', 'true');
  git(dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const installedSize = Object.values(files).reduce((n, d) => n + Buffer.byteLength(d), 0);
  const manifest = (over = {}) => ({
    source: 'git', version: 'v1', url: pathToFileURL(dir).href, commit: git(dir, 'rev-parse', 'HEAD'), tree: git(dir, 'rev-parse', 'HEAD^{tree}'),
    files: Object.keys(files).length + (symlink ? 1 : 0), size: 4096, installedSize, ...over,
  });
  return { dir, manifest };
}

/** Wraps git to count fetches; the installer gives it a minimal PATH, so the wrapper uses absolute paths. */
function countingGit() {
  const dir = tmp();
  const log = path.join(dir, 'calls.log');
  const real = GIT.includes('/') ? path.resolve(GIT) : execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const wrapper = path.join(dir, 'git');
  fs.writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  return { wrapper, fetches: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(l => / fetch /.test(` ${l} `) && l.includes('--stdin')).length : 0) };
}

const files = {
  'play/index.html': 'hello',
  'media/a.swf': Buffer.alloc(5000, 1),
  'media/b.swf': Buffer.alloc(7000, 2),
  'media/copy-of-a.swf': Buffer.alloc(5000, 1), // same content as a.swf: one blob, two files
  'README.md': 'media',
};
const fast = { allowFileUrl: true, backoffMs: 0, pollMs: 5 };

test('installs a pinned commit to media/<version>/ without its Git data and points current at it', { skip }, async () => {
  const { manifest } = makeSource(files);
  const root = tmp();
  const labels = new Set();
  const r = await installMedia({ manifest: manifest(), root, git: GIT, ...fast, batchSize: 1, onProgress: e => labels.add(e.label) });
  assert.equal(fs.readFileSync(path.join(root, 'media/v1/play/index.html'), 'utf8'), 'hello');
  assert.equal(fs.readFileSync(path.join(root, 'media/v1/media/copy-of-a.swf')).length, 5000);
  assert.equal(fs.readlinkSync(path.join(root, 'media/current')), 'v1');
  assert.ok(!fs.existsSync(path.join(root, 'media/v1/.git')));
  assert.ok(!fs.existsSync(path.join(root, 'media/v1.partial')));
  assert.deepEqual([...labels].sort(), ['activate', 'checkout', 'download', 'space', 'trees', 'verify']);
  const record = JSON.parse(fs.readFileSync(path.join(root, 'media/v1.install.json'), 'utf8'));
  assert.equal(record.commit, manifest().commit);
  assert.equal(record.files, 5);
  assert.equal(r.reused, false);
  assert.ok(r.downloadedBytes > 0);

  const again = await installMedia({ manifest: manifest(), root, git: '/nonexistent/git', ...fast });
  assert.equal(again.reused, true, 'an installed version needs no Git and no network');
});

test('an interrupted download resumes and fetches only what is still missing', { skip }, async () => {
  const { manifest } = makeSource(files);
  const root = tmp();
  const { wrapper, fetches } = countingGit();
  const ac = new AbortController();
  let batches = 0;
  await assert.rejects(
    installGitMedia({
      manifest: manifest(), root, git: wrapper, ...fast, pollMs: 60_000, batchSize: 1, signal: ac.signal,
      // 'download' is reported once before the batches and once after each; no polling in between here.
      onProgress: e => { if (e.label === 'download' && ++batches === 2) ac.abort(); },
    }),
    e => e instanceof InstallerError && e.code === 'ABORTED',
  );
  assert.equal(fetches(), 1);
  assert.ok(fs.existsSync(path.join(root, 'media/v1.partial/.git')));
  assert.ok(!fs.existsSync(path.join(root, 'media/current')));

  await installGitMedia({ manifest: manifest(), root, git: wrapper, ...fast, batchSize: 1 });
  assert.equal(fetches(), 4, 'four distinct blobs: one before the interruption, three after');
  assert.equal(fs.readFileSync(path.join(root, 'media/current/play/index.html'), 'utf8'), 'hello');
});

test('a tree or file count that does not match the pin is refused and the partial download removed', { skip }, async () => {
  const { manifest } = makeSource(files);
  for (const over of [{ tree: 'f'.repeat(40) }, { files: 4 }]) {
    const root = tmp();
    await assert.rejects(installGitMedia({ manifest: manifest(over), root, git: GIT, ...fast }), e => e.code === 'VERIFY');
    assert.ok(!fs.existsSync(path.join(root, 'media/v1.partial')));
    assert.ok(!fs.existsSync(path.join(root, 'media/current')));
  }
});

test('a symbolic link in the media tree is refused', { skip }, async () => {
  const { manifest } = makeSource(files, { symlink: { name: 'media/link', target: '../../etc/passwd' } });
  const root = tmp();
  await assert.rejects(installGitMedia({ manifest: manifest(), root, git: GIT, ...fast }), e => e.code === 'VERIFY' && /unsupported entry \(120000/.test(e.message));
});

test('not enough disk space stops before any download', { skip }, async () => {
  const { manifest } = makeSource(files);
  const root = tmp();
  const { wrapper, fetches } = countingGit();
  await assert.rejects(
    installGitMedia({ manifest: manifest(), root, git: wrapper, ...fast, statfs: async () => ({ bavail: 1, bsize: 1024 }) }),
    e => e.code === 'DISK_SPACE' && e.detail.requiredBytes > 1024,
  );
  assert.equal(fetches(), 0);
});

test('an unreachable source fails with DOWNLOAD after the retries', { skip }, async () => {
  const { manifest } = makeSource(files);
  const root = tmp();
  let sleeps = 0;
  await assert.rejects(
    installGitMedia({ manifest: manifest({ url: pathToFileURL(path.join(root, 'nowhere.git')).href }), root, git: GIT, ...fast, retries: 2, sleep: async () => { sleeps++; } }),
    e => e.code === 'DOWNLOAD',
  );
  assert.equal(sleeps, 2);
});

test('a Git older than the minimum is refused', { skip }, async () => {
  const dir = tmp();
  const old = path.join(dir, 'git');
  fs.writeFileSync(old, '#!/bin/sh\necho "git version 2.39.5"\n', { mode: 0o755 });
  const { manifest } = makeSource(files);
  await assert.rejects(installGitMedia({ manifest: manifest(), root: tmp(), git: old, ...fast }), e => e.code === 'BAD_INPUT' && /too old/.test(e.message));
});

test('manifest validation', () => {
  const good = { source: 'git', version: 'e8666de19835', url: 'https://example.invalid/media.git', commit: 'a'.repeat(40), tree: 'b'.repeat(40), files: 1, size: 1, installedSize: 1 };
  assert.equal(validateGitMediaManifest(good), good);
  for (const over of [
    { url: 'http://example.invalid/m.git' }, { url: 'file:///tmp/m.git' }, { commit: 'abc1234' }, { tree: 'B'.repeat(40) },
    { version: 'current' }, { version: 'v1.partial' }, { version: '../x' }, { files: 0 }, { size: -1 }, { source: 'archive' },
  ]) {
    assert.throws(() => validateGitMediaManifest({ ...good, ...over }), e => e.code === 'BAD_INPUT', JSON.stringify(over));
  }
  assert.doesNotThrow(() => validateGitMediaManifest({ ...good, url: 'file:///tmp/m.git' }, { allowFileUrl: true }));
  assert.doesNotThrow(() => validateGitMediaManifest({ ...good, url: 'http://127.0.0.1:9/m.git' }));
});
