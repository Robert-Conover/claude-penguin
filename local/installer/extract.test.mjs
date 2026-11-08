import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ExtractError, extractArchive } from './extract.mjs';
import { buildTar } from './testlib.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-ex-'));

async function run(entries, opts = {}, tarOpts = {}) {
  const dir = tmp();
  const archive = path.join(dir, 'a.tar');
  fs.writeFileSync(archive, buildTar(entries, tarOpts));
  const dest = path.join(dir, 'out');
  const p = extractArchive({ archive, destDir: dest, ...opts });
  return { dir, dest, p };
}

async function rejected(entries, code, opts) {
  const { dir, dest, p } = await run(entries, opts);
  await assert.rejects(p, (e) => e instanceof ExtractError && e.code === code, `expected ${code}`);
  assert.ok(!fs.existsSync(dest), 'destination must not exist');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f !== 'a.tar'), [], 'no staging leftovers');
}

test('extracts files and directories from a ustar archive, atomically', async () => {
  const { dest, p } = await run([
    { name: 'play/', type: '5' },
    { name: 'play/index.html', data: 'hi' },
    { name: 'bin/tool', data: '#!/bin/sh\n', mode: 0o755 },
  ]);
  const r = await p;
  assert.equal(r.files, 2);
  assert.equal(fs.readFileSync(path.join(dest, 'play/index.html'), 'utf8'), 'hi');
  assert.ok(fs.statSync(path.join(dest, 'bin/tool')).mode & 0o100);
});

test('reads gzip archives and pax long paths', async () => {
  const dir = tmp();
  const long = `${'d/'.repeat(80)}file.txt`;
  const archive = path.join(dir, 'a.tgz');
  fs.writeFileSync(archive, buildTar([{ name: 'short', data: 'x', pax: { path: long } }], { gzip: true }));
  await extractArchive({ archive, destDir: path.join(dir, 'out') });
  assert.equal(fs.readFileSync(path.join(dir, 'out', long), 'utf8'), 'x');
});

test('rejects path traversal', async () => {
  await rejected([{ name: '../evil', data: 'x' }], 'UNSAFE_PATH');
  await rejected([{ name: 'a/../../evil', data: 'x' }], 'UNSAFE_PATH');
  await rejected([{ name: 'ok', data: 'x', pax: { path: '../../pax-evil' } }], 'UNSAFE_PATH');
});

test('rejects absolute paths', async () => {
  await rejected([{ name: '/etc/passwd', data: 'x' }], 'UNSAFE_PATH');
  await rejected([{ name: 'x', data: 'x', pax: { path: '/tmp/abs' } }], 'UNSAFE_PATH');
});

test('rejects symlinks and hardlinks, even harmless-looking ones', async () => {
  await rejected([{ name: 'link', type: '2', linkname: '/etc' }, { name: 'link/passwd', data: 'x' }], 'UNSAFE_ENTRY');
  await rejected([{ name: 'link', type: '2', linkname: 'target' }], 'UNSAFE_ENTRY');
  await rejected([{ name: 'a', data: 'x' }, { name: 'h', type: '1', linkname: 'a' }], 'UNSAFE_ENTRY');
});

test('rejects devices and FIFOs', async () => {
  await rejected([{ name: 'dev/null', type: '3' }], 'UNSAFE_ENTRY');
  await rejected([{ name: 'dev/sda', type: '4' }], 'UNSAFE_ENTRY');
  await rejected([{ name: 'pipe', type: '6' }], 'UNSAFE_ENTRY');
});

test('enforces the total-size cap before writing the oversized file', async () => {
  await rejected([{ name: 'a', data: Buffer.alloc(600) }, { name: 'b', data: Buffer.alloc(600) }], 'TOO_LARGE', { maxTotalBytes: 1000 });
});

test('rejects truncated and corrupt archives', async () => {
  const dir = tmp();
  const full = buildTar([{ name: 'a', data: Buffer.alloc(5000, 1) }]);
  fs.writeFileSync(path.join(dir, 't.tar'), full.subarray(0, 2000));
  await assert.rejects(extractArchive({ archive: path.join(dir, 't.tar'), destDir: path.join(dir, 'o') }), (e) => e.code === 'BAD_ARCHIVE');
  const bad = Buffer.from(full);
  bad[10] ^= 0xff;
  fs.writeFileSync(path.join(dir, 'c.tar'), bad);
  await assert.rejects(extractArchive({ archive: path.join(dir, 'c.tar'), destDir: path.join(dir, 'o2') }), (e) => e.code === 'BAD_ARCHIVE');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['c.tar', 't.tar']);
});

test('refuses an existing destination unless replace is set', async () => {
  const dir = tmp();
  const archive = path.join(dir, 'a.tar');
  fs.writeFileSync(archive, buildTar([{ name: 'new', data: 'n' }]));
  fs.mkdirSync(path.join(dir, 'out'));
  fs.writeFileSync(path.join(dir, 'out', 'old'), 'o');
  await assert.rejects(extractArchive({ archive, destDir: path.join(dir, 'out') }), (e) => e.code === 'EXISTS');
  assert.ok(fs.existsSync(path.join(dir, 'out', 'old')));
  await extractArchive({ archive, destDir: path.join(dir, 'out'), replace: true });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'out')), ['new']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a.tar', 'out']);
});

test('abort cancels and cleans staging', async () => {
  const dir = tmp();
  const archive = path.join(dir, 'a.tar');
  fs.writeFileSync(archive, buildTar(Array.from({ length: 20 }, (_, i) => ({ name: `f${i}`, data: Buffer.alloc(100_000) }))));
  const ac = new AbortController();
  await assert.rejects(
    extractArchive({ archive, destDir: path.join(dir, 'o'), signal: ac.signal, onProgress: ({ done }) => { if (done > 150_000) ac.abort(); } }),
    (e) => e.code === 'ABORTED',
  );
  assert.deepEqual(fs.readdirSync(dir), ['a.tar']);
});
