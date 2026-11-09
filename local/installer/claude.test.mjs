import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  CODESIGN_AUTHORITY, CODESIGN_TEAM_ID, CODESIGN_IDENTIFIER, SIGNING_KEY_FILE, SIGNING_KEY_FINGERPRINT,
  InstallerError, checkCodeSignature, installClaude, parseCodesignDetails, verifyClaude,
} from './claude.mjs';
import { OpenPgpError, parsePublicKey, verifyDetached } from './openpgp.mjs';
import { makePgpKey, rangeHandler, sha256, startServer } from './testlib.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-cl-'));
const VERSION = '2.1.200';
const TEAM = 'TESTTEAM01';

const CODESIGN_OK = `Executable=/x/claude
Identifier=${CODESIGN_IDENTIFIER}
Authority=${CODESIGN_AUTHORITY} (${TEAM})
Authority=Developer ID Certification Authority
Authority=Apple Root CA
TeamIdentifier=${TEAM}
`;

/** Fake codesign + binary runner. `overrides` change what codesign -dv prints. */
function fakeRunner({ details = CODESIGN_OK, verifyCode = 0, versionOut = `${VERSION} (Claude Code)\n`, calls = [] } = {}) {
  return async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd.endsWith('codesign')) {
      if (args[0] === '--verify') return { code: verifyCode, stdout: '', stderr: verifyCode ? 'a sealed resource is missing or invalid' : 'valid on disk' };
      return { code: 0, stdout: '', stderr: details };
    }
    return { code: 0, stdout: versionOut, stderr: '' };
  };
}

async function release({ binary = Buffer.from('#!fake claude binary\n'.repeat(500)), signWith, tamper, manifestBinary } = {}) {
  const key = makePgpKey();
  const manifest = Buffer.from(JSON.stringify({
    version: VERSION,
    platforms: { 'darwin-arm64': { binary: 'claude', checksum: sha256(manifestBinary ?? binary), size: (manifestBinary ?? binary).length } },
  }));
  const sig = (signWith ?? key).sign(manifest);
  const served = tamper ? Buffer.from(manifest.toString().replace(VERSION, '2.1.201')) : manifest;
  const srv = await startServer((req, res, n) => {
    if (req.url === `/${VERSION}/manifest.json`) res.end(served);
    else if (req.url === `/${VERSION}/manifest.json.sig`) res.end(sig);
    else if (req.url === `/${VERSION}/darwin-arm64/claude`) rangeHandler(() => ({ body: binary, etag: '"b"' }))(req, res, n);
    else { res.writeHead(404); res.end(); }
  });
  return { key, srv, binary, manifest };
}

const common = (r, root, runner) => ({ version: VERSION, root, baseUrl: r.srv.url, publicKey: r.key.armoredPublic, fingerprint: r.key.fingerprint, runner, teamId: TEAM, pin: null });
const noInstall = (root) => assert.ok(!fs.existsSync(path.join(root, 'versions')) || fs.readdirSync(path.join(root, 'versions')).length === 0, 'nothing installed');

test('the shipped key parses and matches the pinned fingerprint', () => {
  const k = parsePublicKey(fs.readFileSync(SIGNING_KEY_FILE, 'utf8'));
  assert.equal(k.primary.fingerprint, SIGNING_KEY_FINGERPRINT);
  assert.equal(k.primary.bits, 4096);
  assert.deepEqual(k.userIds, ['Anthropic Claude Code Release Signing <security@anthropic.com>']);
});

test('a real Anthropic manifest signature (2.1.311) verifies; a one-byte change does not', () => {
  const data = fs.readFileSync(path.join(here, 'fixtures/manifest-2.1.311.json'));
  const signature = fs.readFileSync(path.join(here, 'fixtures/manifest-2.1.311.json.sig'));
  const publicKey = fs.readFileSync(SIGNING_KEY_FILE);
  const ok = verifyDetached({ data, signature, publicKey, expectedFingerprint: SIGNING_KEY_FINGERPRINT });
  assert.equal(ok.fingerprint, SIGNING_KEY_FINGERPRINT);
  const bad = Buffer.from(data);
  bad[bad.length - 5] ^= 1;
  assert.throws(() => verifyDetached({ data: bad, signature, publicKey, expectedFingerprint: SIGNING_KEY_FINGERPRINT }), (e) => e.code === 'BAD_SIGNATURE');
});

test('GPG verification: valid, bad signature, wrong fingerprint, wrong signer', () => {
  const k1 = makePgpKey();
  const k2 = makePgpKey();
  const data = Buffer.from('payload');
  const sig = k1.sign(data);
  assert.equal(verifyDetached({ data, signature: sig, publicKey: k1.armoredPublic, expectedFingerprint: k1.fingerprint }).fingerprint, k1.fingerprint);
  assert.throws(() => verifyDetached({ data: Buffer.from('payloae'), signature: sig, publicKey: k1.armoredPublic, expectedFingerprint: k1.fingerprint }), (e) => e.code === 'BAD_SIGNATURE');
  assert.throws(() => verifyDetached({ data, signature: sig, publicKey: k1.armoredPublic, expectedFingerprint: k2.fingerprint }), (e) => e.code === 'FINGERPRINT_MISMATCH');
  assert.throws(() => verifyDetached({ data, signature: k2.sign(data), publicKey: k1.armoredPublic, expectedFingerprint: k1.fingerprint }), (e) => e instanceof OpenPgpError && e.code === 'WRONG_SIGNER');
  assert.throws(() => verifyDetached({ data, signature: sig, publicKey: k1.armoredPublic }), (e) => e.code === 'NO_PIN');
});

test('installs atomically with install.json, mode 755 and an unmodified binary', async () => {
  const r = await release();
  const root = tmp();
  const calls = [];
  const events = [];
  try {
    const res = await installClaude({ ...common(r, root, fakeRunner({ calls })), onProgress: (e) => events.push(e.label) });
    assert.equal(res.path, path.join(root, 'versions', VERSION, 'claude'));
    assert.equal(res.sha256, sha256(r.binary));
    assert.deepEqual(fs.readFileSync(res.path), r.binary);
    assert.equal(fs.statSync(res.path).mode & 0o777, 0o755);
    const rec = JSON.parse(fs.readFileSync(path.join(root, 'versions', VERSION, 'install.json'), 'utf8'));
    assert.equal(rec.version, VERSION);
    assert.equal(rec.sha256, sha256(r.binary));
    assert.equal(rec.manifestSha256, sha256(r.manifest));
    assert.equal(rec.authority, CODESIGN_AUTHORITY);
    assert.equal(rec.teamId, TEAM);
    assert.ok(!Number.isNaN(Date.parse(rec.verifiedAt)));
    assert.deepEqual(fs.readdirSync(path.join(root, 'versions')), [VERSION]);
    assert.ok(['manifest', 'download', 'verify', 'install'].every((l) => events.includes(l)));
    assert.deepEqual(calls.filter((c) => c.cmd.endsWith('codesign')).map((c) => c.args.slice(0, 2).join(' ')), ['--verify --strict', '-dv --verbose=4']);
    assert.ok(calls[0].args.includes('--verbose=2'));

    // A second install reuses the verified binary without touching the network.
    const before = r.srv.requests.length;
    const again = await installClaude(common(r, root, fakeRunner()));
    assert.equal(again.reused, true);
    assert.equal(r.srv.requests.length, before);
  } finally { await r.srv.close(); }
});

test('a tampered manifest installs nothing', async () => {
  const r = await release({ tamper: true });
  const root = tmp();
  try {
    await assert.rejects(installClaude(common(r, root, fakeRunner())), (e) => e instanceof InstallerError && e.code === 'VERIFY' && /signature/.test(e.message));
    noInstall(root);
    assert.ok(!r.srv.requests.some((q) => q.url.endsWith('/claude')), 'binary must not even be requested');
  } finally { await r.srv.close(); }
});

test('a manifest signed by a different key, or against a different pin, is refused', async () => {
  const other = makePgpKey();
  const r = await release({ signWith: other });
  const root = tmp();
  try {
    await assert.rejects(installClaude(common(r, root, fakeRunner())), (e) => e.code === 'VERIFY');
    await assert.rejects(installClaude({ ...common(r, root, fakeRunner()), fingerprint: other.fingerprint }), (e) => e.code === 'VERIFY' && /does not match pinned/.test(e.message));
    noInstall(root);
  } finally { await r.srv.close(); }
});

test('a binary whose checksum differs from the signed manifest installs nothing', async () => {
  const good = Buffer.from('good binary '.repeat(1000));
  const r = await release({ binary: Buffer.from('evil binary '.repeat(1000)), manifestBinary: good });
  const root = tmp();
  try {
    await assert.rejects(installClaude(common(r, root, fakeRunner())), (e) => e.code === 'VERIFY');
    noInstall(root);
    assert.deepEqual(fs.existsSync(path.join(root, 'downloads')) ? fs.readdirSync(path.join(root, 'downloads')) : [], []);
  } finally { await r.srv.close(); }
});

test('codesign authority, team and identifier checks', async () => {
  const run = (details, verifyCode) => checkCodeSignature('/x/claude', fakeRunner({ details, verifyCode }), { teamId: TEAM });
  assert.deepEqual(await run(CODESIGN_OK), { authority: CODESIGN_AUTHORITY, teamId: TEAM, identifier: CODESIGN_IDENTIFIER });
  await assert.rejects(run(CODESIGN_OK.replace('Anthropic PBC', 'Mallory Inc')), /authority/);
  await assert.rejects(run(CODESIGN_OK.replace(`(${TEAM})`, '(OTHERTEAM1)')), /authority/);
  await assert.rejects(run(CODESIGN_OK.replace(`TeamIdentifier=${TEAM}`, 'TeamIdentifier=OTHERTEAM1')), /TeamIdentifier/);
  await assert.rejects(run(CODESIGN_OK.replace(CODESIGN_IDENTIFIER, 'com.evil.claude')), /identifier/);
  await assert.rejects(run(CODESIGN_OK.replace(/Authority=Developer ID Application.*\n/, '')), /authority/);
  await assert.rejects(run(CODESIGN_OK, 1), /codesign --verify failed/);
  const info = parseCodesignDetails(CODESIGN_OK);
  assert.equal(info.authorities.length, 3);
});

test('a bad code signature or authority aborts the install and leaves nothing', async () => {
  const r = await release();
  const root = tmp();
  try {
    await assert.rejects(installClaude(common(r, root, fakeRunner({ details: CODESIGN_OK.replace('Anthropic PBC', 'Someone Else') }))), (e) => e.code === 'VERIFY');
    await assert.rejects(installClaude(common(r, root, fakeRunner({ verifyCode: 3 }))), (e) => e.code === 'VERIFY');
    noInstall(root);
  } finally { await r.srv.close(); }
});

test('versions without signed manifests are refused', async () => {
  await assert.rejects(installClaude({ version: '2.1.88', root: tmp(), pin: null }), (e) => e.code === 'BAD_INPUT');
  await assert.rejects(installClaude({ version: '../../etc', root: tmp(), pin: null }), (e) => e.code === 'BAD_INPUT');
});

test('verifyClaude rechecks hash and signature, then runs --version with a pinned environment', async () => {
  const r = await release();
  const root = tmp();
  const configDir = path.join(root, 'cfg');
  try {
    const { path: bin } = await installClaude(common(r, root, fakeRunner()));
    const calls = [];
    const out = await verifyClaude({ path: bin, version: VERSION, configDir, runner: fakeRunner({ calls }), teamId: TEAM });
    assert.equal(out.version, VERSION);
    const run = calls.find((c) => c.cmd === bin);
    assert.deepEqual(run.args, ['--version']);
    assert.equal(run.opts.env.DISABLE_UPDATES, '1');
    assert.equal(run.opts.env.CLAUDE_CONFIG_DIR, configDir);
    assert.ok(!('ANTHROPIC_API_KEY' in run.opts.env));
    assert.ok(fs.statSync(configDir).isDirectory());

    await assert.rejects(verifyClaude({ path: bin, version: VERSION, runner: fakeRunner(), teamId: TEAM }), (e) => e.code === 'BAD_INPUT');
    await assert.rejects(verifyClaude({ path: bin, configDir, runner: fakeRunner({ versionOut: '9.9.9 (Claude Code)' }), teamId: TEAM }), (e) => e.code === 'VERIFY');
    await assert.rejects(verifyClaude({ path: bin, configDir, runner: fakeRunner({ verifyCode: 1 }), teamId: TEAM }), (e) => e.code === 'VERIFY');
    await assert.rejects(verifyClaude({ path: bin, version: '2.1.201', configDir, runner: fakeRunner(), teamId: TEAM }), (e) => e.code === 'VERIFY');

    fs.chmodSync(bin, 0o755);
    fs.appendFileSync(bin, 'x');
    await assert.rejects(verifyClaude({ path: bin, configDir, runner: fakeRunner(), teamId: TEAM }), /SHA-256/);
  } finally { await r.srv.close(); }
});

test('cancelling mid-download rejects with ABORTED and installs nothing', async () => {
  const binary = Buffer.alloc(3_000_000, 7);
  const key = makePgpKey();
  const manifest = Buffer.from(JSON.stringify({ version: VERSION, platforms: { 'darwin-arm64': { binary: 'claude', checksum: sha256(binary), size: binary.length } } }));
  const sig = key.sign(manifest);
  const srv = await startServer((req, res, n) => {
    if (req.url.endsWith('manifest.json')) res.end(manifest);
    else if (req.url.endsWith('.sig')) res.end(sig);
    else rangeHandler(() => ({ body: binary, etag: '"b"', slow: 30_000 }))(req, res, n);
  });
  const root = tmp();
  const ac = new AbortController();
  try {
    await assert.rejects(
      installClaude({ version: VERSION, root, baseUrl: srv.url, publicKey: key.armoredPublic, fingerprint: key.fingerprint, runner: fakeRunner(), teamId: TEAM, pin: null, signal: ac.signal,
        onProgress: (e) => { if (e.label === 'download' && e.done > 60_000) ac.abort(); } }),
      (e) => e.code === 'ABORTED',
    );
    noInstall(root);
  } finally { await srv.close(); }
});
