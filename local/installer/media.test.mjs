import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { InstallerError } from './claude.mjs';
import { installMedia, switchCurrent, validateMediaManifest } from './media.mjs';
import { buildTar, rangeHandler, sha256, startServer } from './testlib.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-media-'));
const cli = path.join(path.dirname(new URL(import.meta.url).pathname), 'cli.mjs');

async function serve(entries, { gzip = true } = {}) {
  const body = buildTar(entries, { gzip });
  const installedSize = entries.reduce((n, e) => n + (e.data ? Buffer.byteLength(e.data) : 0), 0) || 1;
  const srv = await startServer(rangeHandler(() => ({ body, etag: '"m"' })));
  const manifest = (version) => ({ version, url: `${srv.url}/media.tgz`, sha256: sha256(body), size: body.length, installedSize, format: gzip ? 'tar.gz' : 'tar' });
  return { srv, manifest };
}

const files = [{ name: 'play/', type: '5' }, { name: 'play/index.html', data: 'hello' }, { name: 'media/a.swf', data: Buffer.alloc(3000, 1) }];

test('installs to media/<version>/ and points current at it', async () => {
  const { srv, manifest } = await serve(files);
  const root = tmp();
  const labels = new Set();
  try {
    const r = await installMedia({ manifest: manifest('v1'), root, onProgress: (e) => labels.add(e.label) });
    assert.equal(fs.readFileSync(path.join(root, 'media/v1/play/index.html'), 'utf8'), 'hello');
    assert.equal(fs.readlinkSync(path.join(root, 'media/current')), 'v1');
    assert.equal(fs.readFileSync(path.join(root, 'media/current/play/index.html'), 'utf8'), 'hello');
    assert.deepEqual([...labels].sort(), ['activate', 'download', 'extract', 'space']);
    assert.equal(r.previous, null);
    assert.deepEqual(fs.readdirSync(path.join(root, 'downloads')), []);
  } finally { await srv.close(); }
});

test('switching versions leaves the old one until the switch succeeds, then prunes it', async () => {
  const a = await serve(files);
  const b = await serve([{ name: 'play/index.html', data: 'v2' }]);
  const root = tmp();
  try {
    await installMedia({ manifest: a.manifest('v1'), root });
    // A failing second install (traversal in the archive) must leave v1 current and on disk.
    const evil = await serve([{ name: '../escape', data: 'x' }]);
    await assert.rejects(installMedia({ manifest: evil.manifest('v2'), root }), (e) => e instanceof InstallerError && e.code === 'VERIFY');
    await evil.srv.close();
    assert.equal(fs.readlinkSync(path.join(root, 'media/current')), 'v1');
    assert.ok(fs.existsSync(path.join(root, 'media/v1/play/index.html')));
    assert.ok(!fs.existsSync(path.join(root, 'media/v2')));
    assert.ok(!fs.existsSync(path.join(root, 'media/escape')) && !fs.existsSync(path.join(root, 'escape')));

    const r = await installMedia({ manifest: b.manifest('v2'), root });
    assert.equal(r.previous, 'v1');
    assert.deepEqual(r.pruned, ['v1']);
    assert.equal(fs.readlinkSync(path.join(root, 'media/current')), 'v2');
    assert.ok(!fs.existsSync(path.join(root, 'media/v1')));
  } finally { await a.srv.close(); await b.srv.close(); }
});

test('keepPrevious keeps the old version', async () => {
  const a = await serve(files);
  const root = tmp();
  try {
    await installMedia({ manifest: a.manifest('v1'), root });
    await installMedia({ manifest: a.manifest('v2'), root, keepPrevious: true });
    assert.ok(fs.existsSync(path.join(root, 'media/v1')));
    assert.equal(fs.readlinkSync(path.join(root, 'media/current')), 'v2');
  } finally { await a.srv.close(); }
});

test('the current switch is atomic: readers never see it missing', async () => {
  const root = tmp();
  const media = path.join(root, 'media');
  fs.mkdirSync(path.join(media, 'a'), { recursive: true });
  fs.mkdirSync(path.join(media, 'b'));
  await switchCurrent(media, 'a');
  let stop = false;
  let misses = 0;
  let reads = 0;
  const reader = (async () => {
    while (!stop) {
      try { fs.readlinkSync(path.join(media, 'current')); reads++; } catch { misses++; }
      await new Promise((r) => setImmediate(r));
    }
  })();
  for (let i = 0; i < 300; i++) await switchCurrent(media, i % 2 ? 'a' : 'b');
  stop = true;
  await reader;
  assert.equal(misses, 0);
  assert.ok(reads > 0);
  assert.deepEqual(fs.readdirSync(media).filter((f) => f.startsWith('.current.tmp')), []);
});

test('refuses to replace a real directory named current', async () => {
  const media = path.join(tmp(), 'media');
  fs.mkdirSync(path.join(media, 'current'), { recursive: true });
  await assert.rejects(switchCurrent(media, 'a'), /not a symlink/);
});

test('insufficient disk space (injected statfs) fails before any download', async () => {
  const { srv, manifest } = await serve(files);
  const root = tmp();
  const m = { ...manifest('v1'), size: 1000, installedSize: 5000 };
  try {
    await assert.rejects(
      installMedia({ manifest: m, root, statfs: async () => ({ bavail: 5, bsize: 1000 }) }),
      (e) => e.code === 'DISK_SPACE' && e.detail.requiredBytes === 6000 && e.detail.freeBytes === 5000,
    );
    assert.equal(srv.requests.length, 0);
    // Exactly enough space passes the check.
    await installMedia({ manifest: manifest('v1'), root, statfs: async () => ({ bavail: 1e9, bsize: 1 }) });
  } finally { await srv.close(); }
});

test('a bad checksum installs nothing', async () => {
  const { srv, manifest } = await serve(files);
  const root = tmp();
  try {
    await assert.rejects(installMedia({ manifest: { ...manifest('v1'), sha256: sha256(Buffer.from('x')) }, root }), (e) => e.code === 'VERIFY');
    assert.ok(!fs.existsSync(path.join(root, 'media/v1')) && !fs.existsSync(path.join(root, 'media/current')));
  } finally { await srv.close(); }
});

test('manifest validation', () => {
  const ok = { version: 'v1', url: 'https://example.com/m.tgz', sha256: 'a'.repeat(64), size: 1, installedSize: 2, format: 'tar.gz' };
  validateMediaManifest(ok);
  for (const bad of [{ version: '../x' }, { version: 'current' }, { url: 'http://example.com/x' }, { sha256: 'zz' }, { size: 0 }, { installedSize: -1 }, { format: 'zip' }]) {
    assert.throws(() => validateMediaManifest({ ...ok, ...bad }), /invalid media manifest/);
  }
});

test('CLI media emits progress JSON lines and a final done event', async () => {
  const { srv, manifest } = await serve(files);
  const root = tmp();
  const mf = path.join(root, 'manifest.json');
  fs.writeFileSync(mf, JSON.stringify(manifest('v1')));
  try {
    const p = await new Promise((resolve) => {
      import('node:child_process').then(({ execFile }) => execFile(process.execPath, [cli, 'media', '--manifest', mf, '--root', path.join(root, 'data')], (err, stdout) => resolve({ code: err ? err.code : 0, stdout })));
    });
    const lines = p.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(p.code, 0);
    assert.ok(lines.some((l) => l.event === 'progress' && l.task === 'media'));
    const last = lines.at(-1);
    assert.equal(last.event, 'done');
    assert.equal(last.ok, true);
    assert.equal(fs.readlinkSync(path.join(root, 'data/media/current')), 'v1');
  } finally { await srv.close(); }
});

test('CLI reports a problem event and exits 1 on failure', async () => {
  const srv = await startServer((req, res) => { res.writeHead(404); res.end(); });
  const root = tmp();
  const mf = path.join(root, 'manifest.json');
  fs.writeFileSync(mf, JSON.stringify({ version: 'v1', url: `${srv.url}/x`, sha256: 'a'.repeat(64), size: 10, installedSize: 10, format: 'tar.gz' }));
  try {
    const { execFile } = await import('node:child_process');
    const r = await new Promise((resolve) => execFile(process.execPath, [cli, 'media', '--manifest', mf, '--root', path.join(root, 'data')], (err, stdout) => resolve({ status: err ? err.code : 0, stdout })));
    assert.equal(r.status, 1);
    const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    const prob = lines.find((l) => l.event === 'problem');
    assert.ok(prob && prob.code === 'DOWNLOAD' && prob.message);
    assert.equal(lines.at(-1).event, 'done');
    assert.equal(lines.at(-1).ok, false);
  } finally { await srv.close(); }
});
