import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, readlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { applySwfPatch, installPatchSet, buildSwf, splitSwf, PatchError, PATCH_FORMAT, PATCHSET_FORMAT, main } from './patcher.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = data => createHash('sha256').update(data).digest('hex');

function noise(seed, size) {
  const out = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i += 1) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; out[i] = x >>> 24; }
  return out;
}
function tag(code, payload) {
  if (payload.length < 63) { const h = Buffer.alloc(2); h.writeUInt16LE((code << 6) | payload.length); return Buffer.concat([h, payload]); }
  const h = Buffer.alloc(6); h.writeUInt16LE((code << 6) | 63); h.writeUInt32LE(payload.length, 2); return Buffer.concat([h, payload]);
}
const HEAD = Buffer.from([8, 0, 0, 0x0c, 1, 0]);
function bodies(seed = 1, extra = 'PROJECT-OWNED-CODE') {
  const common = Buffer.concat([tag(82, noise(seed, 3000)), tag(82, noise(seed + 1, 5000)), tag(12, noise(seed + 2, 90))]);
  const end = Buffer.concat([tag(1, Buffer.alloc(0)), tag(0, Buffer.alloc(0))]);
  const original = Buffer.concat([HEAD, common, end]);
  const changed = Buffer.concat([HEAD, common, tag(12, Buffer.from(extra + ':' + 'x'.repeat(100))), end]);
  return { original, changed, prefix: HEAD.length + common.length };
}
/** Hand-built patch: copy the shared prefix and suffix, insert the middle. */
function makePatch({ originalFile, originalBody, changedBody, prefix, signature = 'CWS', version = 8, target = 'engine.swf', recordFile = 'build.json', record = { kind: 'test', originalTagsUnchanged: true } }) {
  const suffix = originalBody.length - prefix;
  const middle = changedBody.subarray(prefix, changedBody.length - suffix);
  return {
    format: PATCH_FORMAT, target, recordFile,
    original: { path: `media/play/v2/client/${target}`, sha256: sha(originalFile), decompressedSha256: sha(originalBody), decompressedLength: originalBody.length, signature, version },
    result: { decompressedSha256: sha(changedBody), decompressedLength: changedBody.length, signature, version, compression: signature === 'CWS' ? 'zlib' : 'none' },
    record,
    ops: [['copy', 0, prefix], ['insert', middle.toString('base64')], ['copy', prefix, suffix]],
  };
}
function fixture(opts = {}) {
  const { original, changed, prefix } = bodies(opts.seed, opts.extra);
  const signature = opts.signature ?? 'CWS';
  const originalFile = buildSwf(signature, 8, original);
  return { originalBody: original, changedBody: changed, originalFile, patch: makePatch({ originalFile, originalBody: original, changedBody: changed, prefix, signature, ...opts.patch }) };
}
const code = (fn) => { try { fn(); } catch (error) { assert.ok(error instanceof PatchError, String(error)); return error.code; } assert.fail('expected a PatchError'); };
const scratch = () => mkdtempSync(path.join(tmpdir(), 'cp-patcher-'));

test('applySwfPatch round trips compressed and uncompressed SWFs', () => {
  for (const signature of ['CWS', 'FWS']) {
    const { originalFile, changedBody, patch } = fixture({ signature });
    const built = applySwfPatch(originalFile, patch);
    assert.equal(built.decompressedSha256, sha(changedBody));
    assert.equal(built.decompressedLength, changedBody.length);
    const parsed = splitSwf(built.bytes);
    assert.equal(parsed.signature, signature);
    assert.deepEqual(parsed.body, changedBody);
    assert.equal(built.bytes.readUInt32LE(4), changedBody.length + 8);
    assert.equal(built.fileSha256, sha(built.bytes));
    assert.equal(applySwfPatch(originalFile, JSON.stringify(patch)).decompressedSha256, sha(changedBody), 'accepts JSON text');
  }
});

test('a modified or wrong original is refused', () => {
  const { originalFile, patch } = fixture();
  const flipped = Buffer.from(originalFile); flipped[flipped.length - 5] ^= 1;
  assert.equal(code(() => applySwfPatch(flipped, patch)), 'ORIGINAL_HASH');
  assert.equal(code(() => applySwfPatch(Buffer.concat([originalFile, Buffer.from('x')]), patch)), 'ORIGINAL_HASH');
  assert.equal(code(() => applySwfPatch(fixture({ seed: 77 }).originalFile, patch)), 'ORIGINAL_HASH');
});

test('header problems are reported before any patching', () => {
  const { originalBody, changedBody, originalFile } = fixture();
  // Unsupported signature (ZWS), pinned by hash so only the header check can fire.
  const zws = Buffer.from(originalFile); zws.write('ZWS', 0, 'latin1');
  const zwsPatch = fixture().patch; zwsPatch.original.sha256 = sha(zws);
  assert.equal(code(() => applySwfPatch(zws, zwsPatch)), 'HEADER');
  // Version differs from the patch.
  const version = Buffer.from(originalFile); version[3] = 9;
  const versionPatch = fixture().patch; versionPatch.original.sha256 = sha(version);
  assert.equal(code(() => applySwfPatch(version, versionPatch)), 'HEADER');
  // Declared length does not match the decompressed contents.
  const lying = Buffer.from(originalFile); lying.writeUInt32LE(originalBody.length + 9, 4);
  const lyingPatch = fixture().patch; lyingPatch.original.sha256 = sha(lying);
  assert.equal(code(() => applySwfPatch(lying, lyingPatch)), 'LENGTH');
  // Corrupt zlib stream.
  const broken = Buffer.from(originalFile); broken[12] ^= 0xff;
  const brokenPatch = fixture().patch; brokenPatch.original.sha256 = sha(broken);
  assert.ok(['HEADER', 'LENGTH'].includes(code(() => applySwfPatch(broken, brokenPatch))));
  // Truncated and declared-too-small files.
  assert.equal(code(() => splitSwf(Buffer.from('CWS'))), 'HEADER');
  const small = Buffer.from(originalFile); small.writeUInt32LE(20, 4);
  assert.equal(code(() => splitSwf(small)), 'LENGTH');
});

test('the result is checked: wrong hash, wrong length, wrong header', () => {
  const { originalFile, patch } = fixture();
  const badHash = structuredClone(patch); badHash.result.decompressedSha256 = '0'.repeat(64);
  assert.equal(code(() => applySwfPatch(originalFile, badHash)), 'RESULT_HASH');
  const badLength = structuredClone(patch); badLength.result.decompressedLength += 1;
  assert.equal(code(() => applySwfPatch(originalFile, badLength)), 'PATCH');
  const badCompression = structuredClone(patch); badCompression.result.compression = 'none';
  assert.equal(code(() => applySwfPatch(originalFile, badCompression)), 'PATCH');
  const oneBit = structuredClone(patch); { const middle = Buffer.from(oneBit.ops[1][1], 'base64'); middle[10] ^= 1; oneBit.ops[1][1] = middle.toString('base64'); }
  assert.equal(code(() => applySwfPatch(originalFile, oneBit)), 'RESULT_HASH');
});

test('corrupted patches are rejected', () => {
  const { originalFile, patch } = fixture();
  const mutations = [
    p => { p.ops.push(['copy', 0, 1]); },
    p => { p.ops[0] = ['copy', 0, 2 ** 40]; },
    p => { p.ops[0] = ['copy', -1, 4]; },
    p => { p.ops[0] = ['copy', 0, 0]; },
    p => { p.ops[0] = ['copy', 1.5, 4]; },
    p => { p.ops.push(['xor', 1]); },
    p => { p.ops[1] = ['insert', 'not base64!']; },
    p => { p.ops[1] = ['insert', '']; },
    p => { p.ops[1][1] += '\n'; },
    p => { p.format = 'claude-penguin/swf-patch/2'; },
    p => { p.surprise = true; },
    p => { delete p.original; },
    p => { p.target = '../engine.swf'; },
    p => { p.recordFile = 'a/b.json'; },
    p => { p.original.path = '../outside/engine.swf'; },
    p => { p.original.path = '/abs/engine.swf'; },
    p => { p.original.sha256 = 'ABC'; },
    p => { p.original.version = 3; p.original.signature = 'CWS'; },
    p => { p.ops = 'nope'; },
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(patch); mutate(bad);
    assert.equal(code(() => applySwfPatch(originalFile, bad)), 'PATCH', JSON.stringify(mutate.toString()));
  }
  assert.equal(code(() => applySwfPatch(originalFile, '{not json')), 'PATCH');
});

// ----------------------------------------------------------------- installPatchSet

function writeSet(dir, patches, id = 'ps-test') {
  mkdirSync(dir, { recursive: true });
  const entries = patches.map(patch => {
    const text = JSON.stringify(patch, null, 1) + '\n';
    writeFileSync(path.join(dir, `${patch.target}.patch.json`), text);
    return { file: `${patch.target}.patch.json`, sha256: sha(text), target: patch.target };
  });
  writeFileSync(path.join(dir, 'patchset.json'), JSON.stringify({ format: PATCHSET_FORMAT, id, patches: entries }, null, 2) + '\n');
}
function world({ id = 'ps-test', seed = 1, extra } = {}) {
  const root = scratch();
  const media = path.join(root, 'media'); mkdirSync(path.join(media, 'media/play/v2/client'), { recursive: true });
  const patches = [];
  for (const [index, target] of ['engine.swf', 'puffle_adoption.swf'].entries()) {
    const f = fixture({ seed: seed + index * 10, extra, patch: { target, recordFile: index ? 'adoption-build.json' : 'build.json' } });
    writeFileSync(path.join(media, 'media/play/v2/client', target), f.originalFile);
    patches.push(f.patch);
  }
  const patchDir = path.join(root, 'patches'); writeSet(patchDir, patches, id);
  return { root, media, patchDir, patches, out: path.join(root, 'data', 'client-bridge') };
}
const listing = dir => readdirSync(dir).sort();

test('installPatchSet installs a versioned directory and switches current through a symlink', async () => {
  const w = world();
  const events = [];
  const result = await installPatchSet({ media: w.media, patches: w.patchDir, out: w.out, patchset: 'ps-test', onProgress: e => events.push(e) });
  assert.equal(result.patchset, 'ps-test');
  assert.deepEqual(listing(w.out), ['current', 'ps-test']);
  assert.ok(lstatSync(path.join(w.out, 'current')).isSymbolicLink());
  assert.equal(readlinkSync(path.join(w.out, 'current')), 'ps-test');
  const current = path.join(w.out, 'current');
  assert.deepEqual(listing(current), ['adoption-build.json', 'build.json', 'engine.swf', 'patchset.json', 'puffle_adoption.swf']);
  assert.ok(events.every(e => e.task === 'extensions') && events.length >= 3);
  for (const [target, recordName] of [['engine.swf', 'build.json'], ['puffle_adoption.swf', 'adoption-build.json']]) {
    const file = readFileSync(path.join(current, target));
    const record = JSON.parse(readFileSync(path.join(current, recordName), 'utf8'));
    // What local/agent-start and local/doctor.py compare: the record describes the installed bytes.
    assert.equal(record.outputSha256, sha(file));
    assert.equal(record.originalTagsUnchanged, true);
    assert.equal(record.patchset, 'ps-test');
    assert.equal(record.outputDecompressedSha256, sha(splitSwf(file).body));
    assert.equal(record.outputDecompressedLength, splitSwf(file).body.length);
  }
});

test('a failing patch leaves the installed set and current untouched and no staging behind', async () => {
  const w = world();
  await installPatchSet({ media: w.media, patches: w.patchDir, out: w.out });
  const before = listing(w.out);
  const engineBefore = readFileSync(path.join(w.out, 'current/engine.swf'));

  // Second set: first file fine, second original corrupted on disk.
  const next = world({ id: 'ps-next', seed: 5 });
  const target = path.join(next.media, 'media/play/v2/client/puffle_adoption.swf');
  const damaged = readFileSync(target); damaged[damaged.length - 2] ^= 1; writeFileSync(target, damaged);
  await assert.rejects(installPatchSet({ media: next.media, patches: next.patchDir, out: w.out }), error => error.code === 'ORIGINAL_HASH');
  assert.deepEqual(listing(w.out), before);
  assert.equal(readlinkSync(path.join(w.out, 'current')), 'ps-test');
  assert.deepEqual(readFileSync(path.join(w.out, 'current/engine.swf')), engineBefore);

  // Missing original.
  rmSync(target);
  await assert.rejects(installPatchSet({ media: next.media, patches: next.patchDir, out: w.out }), error => error.code === 'ORIGINAL_MISSING');
  assert.deepEqual(listing(w.out), before);

  // Patch file that no longer matches the manifest hash.
  const patchFile = path.join(next.patchDir, 'engine.swf.patch.json');
  writeFileSync(patchFile, readFileSync(patchFile, 'utf8').replace('"copy"', '"copy" '));
  await assert.rejects(installPatchSet({ media: next.media, patches: next.patchDir, out: w.out }), error => error.code === 'PATCH');
  assert.deepEqual(listing(w.out), before);

  // Wrong expected patch set id.
  await assert.rejects(installPatchSet({ media: w.media, patches: w.patchDir, out: w.out, patchset: 'other' }), error => error.code === 'PATCHSET');
  assert.deepEqual(listing(w.out), before);
});

test('installing a newer set switches current; reinstalling the same set is idempotent; a damaged copy is repaired', async () => {
  const w = world();
  await installPatchSet({ media: w.media, patches: w.patchDir, out: w.out });
  const first = readFileSync(path.join(w.out, 'current/engine.swf'));
  await installPatchSet({ media: w.media, patches: w.patchDir, out: w.out });
  assert.deepEqual(listing(w.out), ['current', 'ps-test']);

  const second = world({ id: 'ps-two', seed: 9, extra: 'OTHER' });
  await installPatchSet({ media: second.media, patches: second.patchDir, out: w.out });
  assert.deepEqual(listing(w.out), ['current', 'ps-test', 'ps-two']);
  assert.equal(readlinkSync(path.join(w.out, 'current')), 'ps-two');
  assert.notDeepEqual(readFileSync(path.join(w.out, 'current/engine.swf')), first);
  assert.deepEqual(readFileSync(path.join(w.out, 'ps-test/engine.swf')), first, 'the previous set stays for rollback');

  writeFileSync(path.join(w.out, 'ps-test/engine.swf'), 'damaged');
  await installPatchSet({ media: w.media, patches: w.patchDir, out: w.out });
  assert.equal(readlinkSync(path.join(w.out, 'current')), 'ps-test');
  assert.equal(sha(readFileSync(path.join(w.out, 'ps-test/engine.swf'))), JSON.parse(readFileSync(path.join(w.out, 'ps-test/build.json'), 'utf8')).outputSha256);
  assert.deepEqual(listing(w.out), ['current', 'ps-test', 'ps-two']);
});

test('switching current replaces the link in one step: readers only ever see a whole patch set', async () => {
  const a = world({ id: 'ps-a' });
  const b = world({ id: 'ps-b', seed: 9 });
  await installPatchSet({ media: a.media, patches: a.patchDir, out: a.out });
  let stop = false;
  let reads = 0;
  const seen = new Set();
  const errors = new Set();
  const reader = (async () => {
    while (!stop) {
      // On APFS a lookup that races the rename can fail once (ENOENT, or EINVAL from open); it never
      // resolves to a half-built set, because only finished directories are ever linked.
      try { seen.add(JSON.parse(readFileSync(path.join(a.out, 'current/build.json'), 'utf8')).patchset); reads++; }
      catch (error) { errors.add(error.code ?? error.name); }
      await new Promise(resolve => setImmediate(resolve));
    }
  })();
  for (const set of [b, a, b]) await installPatchSet({ media: set.media, patches: set.patchDir, out: a.out });
  stop = true; await reader;
  assert.ok(reads > 0);
  assert.deepEqual([...seen].filter(id => id !== 'ps-a' && id !== 'ps-b'), []);
  assert.deepEqual([...errors].filter(code => code !== 'ENOENT' && code !== 'EINVAL'), []);
  assert.equal(readlinkSync(path.join(a.out, 'current')), 'ps-b');
  assert.deepEqual(listing(a.out).filter(name => name.startsWith('.current-') || name.startsWith('.staging-')), []);
});

test('current that is a real directory is not replaced', async () => {
  const w = world();
  mkdirSync(path.join(w.out, 'current'), { recursive: true });
  writeFileSync(path.join(w.out, 'current/keep'), 'x');
  await assert.rejects(installPatchSet({ media: w.media, patches: w.patchDir, out: w.out }), error => error.code === 'INSTALL');
  assert.deepEqual(listing(path.join(w.out, 'current')), ['keep']);
  assert.ok(!listing(w.out).some(name => name.startsWith('.current-')), 'temp symlink cleaned up');
});

test('the CLI installs, reports JSON events and fails with a code', async () => {
  const w = world();
  const run = args => spawnSync(process.execPath, [path.join(here, 'patcher.mjs'), ...args], { encoding: 'utf8' });
  const ok = run(['--media', w.media, '--patches', w.patchDir, '--out', w.out, '--patchset', 'ps-test', '--json']);
  assert.equal(ok.status, 0, ok.stderr);
  const lines = ok.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.at(-1).event, 'done');
  assert.ok(lines.some(line => line.event === 'progress' && line.task === 'extensions'));
  const bad = run(['--media', path.join(w.root, 'nowhere'), '--patches', w.patchDir, '--out', path.join(w.root, 'o2'), '--json']);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout.trim().split('\n').at(-1)).code, 'ORIGINAL_MISSING');
  assert.equal(run(['--media', 'x']).status, 2);
  assert.equal(await main(['--bogus']), 2);
});

test('patches written by the Python generator apply identically in Node', { skip: spawnSync('python3', ['--version']).status !== 0 }, () => {
  const { originalBody, changedBody } = fixture();
  const original = buildSwf('CWS', 8, originalBody);
  const changed = buildSwf('CWS', 8, Buffer.concat([changedBody.subarray(0, 4000), noise(42, 300), changedBody.subarray(1000, 6000), changedBody.subarray(4000)]));
  const root = scratch();
  writeFileSync(path.join(root, 'o.swf'), original); writeFileSync(path.join(root, 'r.swf'), changed);
  const script = `
import sys, json
sys.path.insert(0, ${JSON.stringify(here)})
import patch_generate as g, patchlib as lib
o = open(${JSON.stringify(path.join(root, 'o.swf'))}, 'rb').read(); r = open(${JSON.stringify(path.join(root, 'r.swf'))}, 'rb').read()
p = g.make_patch(o, r, target='engine.swf', original_path='media/play/v2/client/engine.swf', record_file='build.json', record={'originalTagsUnchanged': True})
sys.stdout.write(lib.dump_patch(p))`;
  const run = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const built = applySwfPatch(original, run.stdout);
  assert.equal(built.decompressedSha256, sha(splitSwf(changed).body));
  assert.ok(JSON.parse(run.stdout).ops.length >= 3);
});

test('inflate bombs are bounded by the declared length', () => {
  const bomb = zlib.deflateSync(Buffer.alloc(5_000_000));
  const header = Buffer.alloc(8); header.write('CWS', 0, 'latin1'); header[3] = 8; header.writeUInt32LE(1000, 4);
  assert.equal(code(() => splitSwf(Buffer.concat([header, bomb]))), 'LENGTH');
});
