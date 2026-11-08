import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { download, DownloadError } from './download.mjs';
import { rangeHandler, sha256, startServer } from './testlib.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-dl-'));
const blob = (n, seed = 1) => crypto.createHash('sha512').update(String(seed)).digest().length && Buffer.concat(Array.from({ length: Math.ceil(n / 64) }, (_, i) => crypto.createHash('sha512').update(`${seed}:${i}`).digest())).subarray(0, n);
const fast = { backoffMs: 1 };

test('downloads, verifies and reports progress', async () => {
  const body = blob(200_000);
  const srv = await startServer(rangeHandler(() => ({ body, etag: '"a"' })));
  const dir = tmp();
  const seen = [];
  try {
    const r = await download({ url: `${srv.url}/f`, dest: path.join(dir, 'f'), sha256: sha256(body), size: body.length, onProgress: (p) => seen.push(p), ...fast });
    assert.equal(r.size, body.length);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'f')), body);
    assert.ok(seen.length >= 2 && seen.at(-1).done === body.length && seen.at(-1).total === body.length);
    assert.ok(!fs.existsSync(path.join(dir, 'f.partial')));
  } finally {
    await srv.close();
  }
});

test('resumes with Range and If-Range after the server drops the connection mid-body', async () => {
  const body = blob(300_000);
  const srv = await startServer(rangeHandler((n) => ({ body, etag: '"v1"', dropAt: n === 1 ? 120_000 : null })));
  const dir = tmp();
  try {
    const r = await download({ url: `${srv.url}/f`, dest: path.join(dir, 'f'), sha256: sha256(body), size: body.length, ...fast });
    assert.deepEqual(fs.readFileSync(path.join(dir, 'f')), body);
    assert.equal(srv.requests.length, 2);
    const second = srv.requests[1].headers;
    assert.match(second.range, /^bytes=\d+-$/);
    assert.ok(Number(/\d+/.exec(second.range)[0]) > 0);
    assert.equal(second['if-range'], '"v1"');
    assert.ok(r.resumedBytes > 0 && r.resumedBytes < body.length);
  } finally {
    await srv.close();
  }
});

test('an ETag change forces a restart from zero', async () => {
  const oldBody = blob(300_000, 1);
  const newBody = blob(300_000, 2);
  const srv = await startServer(rangeHandler((n) => (n === 1 ? { body: oldBody, etag: '"old"', dropAt: 100_000 } : { body: newBody, etag: '"new"' })));
  const dir = tmp();
  try {
    const r = await download({ url: `${srv.url}/f`, dest: path.join(dir, 'f'), sha256: sha256(newBody), size: newBody.length, ...fast });
    assert.deepEqual(fs.readFileSync(path.join(dir, 'f')), newBody);
    assert.equal(srv.requests[1].headers['if-range'], '"old"'); // we asked, server refused with a full 200
    assert.ok(r.restarts >= 1);
    assert.equal(r.resumedBytes, 0);
  } finally {
    await srv.close();
  }
});

test('a 206 whose ETag differs from the stored validator also restarts', async () => {
  const oldBody = blob(300_000, 1);
  const newBody = blob(300_000, 2);
  const inner = rangeHandler((n) => (n === 1 ? { body: oldBody, etag: '"old"', dropAt: 100_000 } : { body: newBody, etag: '"new"' }));
  const srv = await startServer((req, res, n) => {
    if (n === 2) delete req.headers['if-range']; // a buggy server that honors Range but not If-Range
    inner(req, res, n);
  });
  const dir = tmp();
  try {
    await download({ url: `${srv.url}/f`, dest: path.join(dir, 'f'), sha256: sha256(newBody), size: newBody.length, ...fast });
    assert.deepEqual(fs.readFileSync(path.join(dir, 'f')), newBody);
  } finally {
    await srv.close();
  }
});

test('a bad checksum leaves no destination file and no partial', async () => {
  const body = blob(50_000);
  const srv = await startServer(rangeHandler(() => ({ body, etag: '"a"' })));
  const dir = tmp();
  try {
    await assert.rejects(
      download({ url: `${srv.url}/f`, dest: path.join(dir, 'f'), sha256: sha256(Buffer.from('other')), size: body.length, ...fast }),
      (e) => e instanceof DownloadError && e.code === 'VERIFY',
    );
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    await srv.close();
  }
});

test('a wrong size is rejected', async () => {
  const body = blob(50_000);
  const srv = await startServer(rangeHandler(() => ({ body, etag: '"a"' })));
  const dir = tmp();
  try {
    await assert.rejects(download({ url: `${srv.url}/f`, dest: path.join(dir, 'f'), sha256: sha256(body), size: body.length - 1, ...fast }), (e) => e.code === 'SIZE' || e.code === 'VERIFY');
    assert.ok(!fs.existsSync(path.join(dir, 'f')));
  } finally {
    await srv.close();
  }
});

test('retries 5xx with backoff, but not 404', async () => {
  const body = blob(10_000);
  const delays = [];
  const srv = await startServer((req, res, n) => {
    if (req.url === '/missing') { res.writeHead(404); res.end(); return; }
    if (n <= 2) { res.writeHead(503); res.end(); return; }
    res.end(body);
  });
  const dir = tmp();
  try {
    await download({ url: `${srv.url}/ok`, dest: path.join(dir, 'ok'), sha256: sha256(body), size: body.length, backoffMs: 10, sleep: async (ms) => delays.push(ms) });
    assert.deepEqual(delays, [10, 20]);
    const before = srv.requests.length;
    await assert.rejects(download({ url: `${srv.url}/missing`, dest: path.join(dir, 'm'), ...fast }), (e) => e.code === 'HTTP');
    assert.equal(srv.requests.length, before + 1);
  } finally {
    await srv.close();
  }
});

test('gives up after the retry budget', async () => {
  const srv = await startServer((req, res) => { res.writeHead(500); res.end(); });
  const dir = tmp();
  try {
    await assert.rejects(download({ url: `${srv.url}/f`, dest: path.join(dir, 'f'), retries: 2, ...fast }), (e) => e.code === 'NETWORK');
    assert.equal(srv.requests.length, 3);
  } finally {
    await srv.close();
  }
});

test('cancel via AbortSignal keeps the partial file and rejects with ABORTED', async () => {
  const body = blob(2_000_000);
  const srv = await startServer(rangeHandler(() => ({ body, etag: '"a"', slow: 20_000 })));
  const dir = tmp();
  const ac = new AbortController();
  try {
    const p = download({
      url: `${srv.url}/f`, dest: path.join(dir, 'f'), sha256: sha256(body), size: body.length, signal: ac.signal, ...fast,
      onProgress: ({ done }) => { if (done > 40_000) ac.abort(); },
    });
    await assert.rejects(p, (e) => e.code === 'ABORTED');
    assert.ok(!fs.existsSync(path.join(dir, 'f')));
    assert.ok(fs.statSync(path.join(dir, 'f.partial')).size > 0);
    // ... and a later call resumes it.
    const srv2 = await startServer(rangeHandler(() => ({ body, etag: '"a"' })));
    try {
      const r = await download({ url: `${srv2.url}/f`, dest: path.join(dir, 'f'), sha256: sha256(body), size: body.length, ...fast });
      assert.equal(r.size, body.length);
    } finally { await srv2.close(); }
  } finally {
    await srv.close();
  }
});

test('injectable fetchImpl is used', async () => {
  const body = Buffer.from('hello');
  const dir = tmp();
  const fetchImpl = async () => new Response(body, { status: 200, headers: { etag: '"x"', 'content-length': '5' } });
  const r = await download({ url: 'https://example.invalid/f', dest: path.join(dir, 'f'), sha256: sha256(body), size: 5, fetchImpl });
  assert.equal(r.size, 5);
});
