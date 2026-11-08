// Install and verify the official Claude Code executable. See README.md.
//
// The binary is never modified: it is downloaded, checked against the signed
// manifest and Apple's code signature, then moved into place unchanged.
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { download, sha256File, DownloadError } from './download.mjs';
import { verifyDetached, OpenPgpError } from './openpgp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export const RELEASE_BASE = 'https://downloads.claude.ai/claude-code-releases';
export const SIGNING_KEY_FINGERPRINT = '31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE';
export const SIGNING_KEY_FILE = path.join(here, 'keys', 'claude-code.asc');
export const CODESIGN_AUTHORITY = 'Developer ID Application: Anthropic PBC';
export const CODESIGN_TEAM_ID = 'Q6L2SF6YDW';
export const CODESIGN_IDENTIFIER = 'com.anthropic.claude-code';
export const MIN_SIGNED_VERSION = '2.1.89';
export const PLATFORM = 'darwin-arm64';

export class InstallerError extends Error {
  /** @param code DOWNLOAD | VERIFY | DISK_SPACE | ABORTED | BAD_INPUT */
  constructor(message, code, detail = {}) {
    super(message);
    this.name = 'InstallerError';
    this.code = code;
    this.detail = detail;
  }
}

export async function loadReleasePin() {
  return JSON.parse(await fsp.readFile(path.join(here, 'claude-release.json'), 'utf8'));
}

function cmpVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

function checkVersion(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new InstallerError(`invalid Claude version "${version}"`, 'BAD_INPUT');
  }
  if (cmpVersion(version, MIN_SIGNED_VERSION) < 0) {
    throw new InstallerError(`Claude ${version} has no signed manifest (signatures start at ${MIN_SIGNED_VERSION})`, 'BAD_INPUT');
  }
}

/** Default runner: execFile without a shell. Resolves { code, stdout, stderr } and never rejects on non-zero exit. */
export function defaultRunner(cmd, args, { env, timeoutMs = 60_000, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, cwd, timeout: timeoutMs, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? '') + (err && typeof err.code !== 'number' ? `\n${err.message}` : ''),
      });
    });
  });
}

async function fetchSmall(fetchImpl, url, signal, { retries = 3, backoffMs = 400, maxBytes = 2 << 20 } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    if (signal?.aborted) throw new InstallerError('aborted', 'ABORTED');
    try {
      const res = await fetchImpl(url, { signal });
      if (res.status >= 400) {
        await res.body?.cancel?.();
        if (res.status < 500 && res.status !== 429) throw new InstallerError(`HTTP ${res.status} for ${url}`, 'DOWNLOAD', { url, status: res.status });
        throw new Error(`HTTP ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new InstallerError(`${url} is unexpectedly large`, 'DOWNLOAD', { url });
      return buf;
    } catch (e) {
      if (signal?.aborted) throw new InstallerError('aborted', 'ABORTED');
      if (e instanceof InstallerError) throw e;
      last = e;
      if (i < retries) await new Promise((r) => setTimeout(r, backoffMs * 2 ** i));
    }
  }
  throw new InstallerError(`could not fetch ${url}: ${last?.message}`, 'DOWNLOAD', { url });
}

/** Fetch the stable channel's version string (the docs do not describe this endpoint; see README). */
export async function fetchChannelVersion(channel = 'stable', { fetchImpl = globalThis.fetch, baseUrl = RELEASE_BASE, signal } = {}) {
  if (channel !== 'stable' && channel !== 'latest') throw new InstallerError('channel must be stable or latest', 'BAD_INPUT');
  const v = (await fetchSmall(fetchImpl, `${baseUrl}/${channel}`, signal)).toString('utf8').trim();
  checkVersion(v);
  return v;
}

/**
 * Fetch manifest.json + manifest.json.sig for a version and verify the signature
 * against the pinned key fingerprint. Returns { manifest, manifestSha256, signer }.
 */
export async function fetchVerifiedManifest({
  version, fetchImpl = globalThis.fetch, baseUrl = RELEASE_BASE, signal,
  publicKey, fingerprint = SIGNING_KEY_FINGERPRINT,
}) {
  checkVersion(version);
  const raw = await fetchSmall(fetchImpl, `${baseUrl}/${version}/manifest.json`, signal);
  const sig = await fetchSmall(fetchImpl, `${baseUrl}/${version}/manifest.json.sig`, signal);
  const key = publicKey ?? (await fsp.readFile(SIGNING_KEY_FILE));
  let signer;
  try {
    signer = verifyDetached({ data: raw, signature: sig, publicKey: key, expectedFingerprint: fingerprint });
  } catch (e) {
    if (e instanceof OpenPgpError) throw new InstallerError(`manifest signature check failed: ${e.message}`, 'VERIFY', { reason: e.code });
    throw e;
  }
  let manifest;
  try {
    manifest = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new InstallerError('manifest.json is not valid JSON', 'VERIFY');
  }
  if (manifest.version !== version) {
    throw new InstallerError(`manifest is for ${manifest.version}, expected ${version}`, 'VERIFY');
  }
  return { manifest, manifestSha256: crypto.createHash('sha256').update(raw).digest('hex'), signer };
}

/** Parse `codesign -dv --verbose=4` output (it prints to stderr). */
export function parseCodesignDetails(text) {
  const authorities = [...text.matchAll(/^Authority=(.+)$/gm)].map((m) => m[1].trim());
  const team = /^TeamIdentifier=(.+)$/m.exec(text)?.[1].trim() ?? null;
  const identifier = /^Identifier=(.+)$/m.exec(text)?.[1].trim() ?? null;
  return { authorities, teamId: team, identifier, leaf: authorities[0] ?? null };
}

/**
 * Run codesign --verify --strict and check the leaf authority and team ID.
 * Returns { authority, teamId, identifier }. Throws InstallerError(VERIFY).
 */
export async function checkCodeSignature(file, runner = defaultRunner, { teamId = CODESIGN_TEAM_ID } = {}) {
  const v = await runner('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', file]);
  if (v.code !== 0) {
    throw new InstallerError(`codesign --verify failed: ${(v.stderr || v.stdout).trim()}`, 'VERIFY', { step: 'codesign-verify' });
  }
  const d = await runner('/usr/bin/codesign', ['-dv', '--verbose=4', file]);
  if (d.code !== 0) throw new InstallerError(`codesign -dv failed: ${d.stderr.trim()}`, 'VERIFY', { step: 'codesign-details' });
  const info = parseCodesignDetails(`${d.stderr}\n${d.stdout}`);
  const expectedLeaf = `${CODESIGN_AUTHORITY} (${teamId})`;
  if (info.leaf !== expectedLeaf) {
    throw new InstallerError(`unexpected code-signing authority "${info.leaf}" (want "${expectedLeaf}")`, 'VERIFY', { authorities: info.authorities });
  }
  if (info.teamId !== teamId) {
    throw new InstallerError(`unexpected TeamIdentifier "${info.teamId}" (want ${teamId})`, 'VERIFY', { teamId: info.teamId });
  }
  if (info.identifier !== CODESIGN_IDENTIFIER) {
    throw new InstallerError(`unexpected code-signing identifier "${info.identifier}"`, 'VERIFY', { identifier: info.identifier });
  }
  return { authority: CODESIGN_AUTHORITY, teamId: info.teamId, identifier: info.identifier };
}

export function claudePaths(root, version) {
  const dir = path.join(root, 'versions', version);
  return { dir, binary: path.join(dir, 'claude'), record: path.join(dir, 'install.json') };
}

async function readInstallRecord(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * installClaude({ version, root, onProgress, signal, fetchImpl, runner })
 * -> { path, version, sha256, reused }
 * Extra optional inputs: baseUrl, publicKey, fingerprint, platform, teamId (all for tests).
 * onProgress receives { label, done, total } where label is manifest | download | verify | install.
 */
export async function installClaude({
  version, root, onProgress, signal, fetchImpl = globalThis.fetch, runner = defaultRunner,
  baseUrl = RELEASE_BASE, publicKey, fingerprint = SIGNING_KEY_FINGERPRINT, platform = PLATFORM,
  teamId = CODESIGN_TEAM_ID, pin, download: dl = download,
}) {
  if (!root) throw new InstallerError('root is required', 'BAD_INPUT');
  root = path.resolve(root);
  const releasePin = pin === undefined ? await loadReleasePin() : pin;
  version ??= releasePin?.version;
  checkVersion(version);
  const step = (label, done, total = null) => onProgress?.({ label, done, total });
  const paths = claudePaths(root, version);

  // Already installed and intact: no network needed.
  const existing = await readInstallRecord(paths.record);
  if (existing?.version === version && existing.sha256) {
    try {
      if ((await sha256File(paths.binary, signal)) === existing.sha256) {
        await checkCodeSignature(paths.binary, runner, { teamId });
        step('install', 1, 1);
        return { path: paths.binary, version, sha256: existing.sha256, reused: true };
      }
    } catch (e) {
      if (e instanceof InstallerError && e.code === 'ABORTED') throw e;
      // fall through and reinstall
    }
  }

  step('manifest', 0, 2);
  const { manifest, manifestSha256 } = await fetchVerifiedManifest({ version, fetchImpl, baseUrl, signal, publicKey, fingerprint });
  step('manifest', 2, 2);
  const entry = manifest.platforms?.[platform];
  if (!entry || !/^[0-9a-f]{64}$/.test(entry.checksum || '') || !Number.isSafeInteger(entry.size) || entry.size <= 0) {
    throw new InstallerError(`manifest has no usable ${platform} entry`, 'VERIFY');
  }
  if (releasePin && releasePin.version === version && releasePin.platform === platform) {
    if (releasePin.sha256 && releasePin.sha256 !== entry.checksum) {
      throw new InstallerError(`manifest checksum for ${version} differs from the pinned ${releasePin.sha256}`, 'VERIFY');
    }
    if (releasePin.manifestSha256 && releasePin.manifestSha256 !== manifestSha256) {
      throw new InstallerError(`manifest for ${version} differs from the pinned manifest hash`, 'VERIFY');
    }
  }
  const binName = entry.binary || 'claude';
  if (binName !== 'claude') throw new InstallerError(`unexpected binary name ${binName}`, 'VERIFY');

  const downloadsDir = path.join(root, 'downloads');
  const dest = path.join(downloadsDir, `claude-${version}-${platform}`);
  try {
    await dl({
      url: `${baseUrl}/${version}/${platform}/${binName}`,
      dest,
      sha256: entry.checksum,
      size: entry.size,
      signal,
      fetchImpl,
      onProgress: ({ done, total }) => step('download', done, total),
    });
  } catch (e) {
    if (e instanceof DownloadError) {
      const code = e.code === 'ABORTED' ? 'ABORTED' : e.code === 'VERIFY' || e.code === 'SIZE' ? 'VERIFY' : 'DOWNLOAD';
      throw new InstallerError(e.message, code, e.detail);
    }
    throw e;
  }

  step('verify', 0, 2);
  const sha256 = await sha256File(dest, signal); // downloader verified it; re-assert after any gap
  if (sha256 !== entry.checksum) throw new InstallerError('binary SHA-256 does not match the signed manifest', 'VERIFY');
  await fsp.chmod(dest, 0o755);
  const sig = await checkCodeSignature(dest, runner, { teamId });
  step('verify', 2, 2);

  step('install', 0, 1);
  const stage = path.join(root, 'versions', `.${version}.staging-${crypto.randomBytes(4).toString('hex')}`);
  await fsp.mkdir(stage, { recursive: true, mode: 0o755 });
  try {
    await fsp.rename(dest, path.join(stage, 'claude'));
    const record = {
      version,
      platform,
      sha256,
      size: entry.size,
      manifestSha256,
      signingKeyFingerprint: fingerprint,
      authority: sig.authority,
      teamId: sig.teamId,
      identifier: sig.identifier,
      verifiedAt: new Date().toISOString(),
    };
    await fsp.writeFile(path.join(stage, 'install.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
    let old = null;
    try {
      await fsp.lstat(paths.dir);
      old = `${paths.dir}.old-${crypto.randomBytes(4).toString('hex')}`;
      await fsp.rename(paths.dir, old);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await fsp.rename(stage, paths.dir);
    if (old) await fsp.rm(old, { recursive: true, force: true });
  } catch (e) {
    await fsp.rm(stage, { recursive: true, force: true });
    throw e;
  }
  step('install', 1, 1);
  return { path: paths.binary, version, sha256, reused: false };
}

/**
 * verifyClaude({ path, version, configDir, runner })
 * Rechecks the recorded SHA-256 and the code signature, then runs `<path> --version`
 * with DISABLE_UPDATES=1 and CLAUDE_CONFIG_DIR=<configDir>. configDir is mandatory.
 * Returns { path, version, sha256, authority, teamId, versionOutput }.
 */
export async function verifyClaude({ path: file, version, configDir, runner = defaultRunner, teamId = CODESIGN_TEAM_ID, signal }) {
  if (!file) throw new InstallerError('path is required', 'BAD_INPUT');
  if (!configDir) throw new InstallerError('configDir is required (verifyClaude never uses ~/.claude)', 'BAD_INPUT');
  const record = await readInstallRecord(path.join(path.dirname(file), 'install.json'));
  if (!record?.sha256) throw new InstallerError('no install.json next to the binary', 'VERIFY');
  if (version && record.version !== version) {
    throw new InstallerError(`installed version ${record.version} is not ${version}`, 'VERIFY');
  }
  const sha256 = await sha256File(file, signal);
  if (sha256 !== record.sha256) throw new InstallerError('binary SHA-256 differs from the recorded value', 'VERIFY');
  const sig = await checkCodeSignature(file, runner, { teamId });
  await fsp.mkdir(configDir, { recursive: true, mode: 0o700 });
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    DISABLE_UPDATES: '1',
    CLAUDE_CONFIG_DIR: path.resolve(configDir),
  };
  const r = await runner(file, ['--version'], { env, timeoutMs: 30_000 });
  const out = r.stdout.trim();
  const m = /^(\d+\.\d+\.\d+)(?:\s+\(Claude Code\))?$/.exec(out);
  if (r.code !== 0 || !m) {
    throw new InstallerError(`${file} --version failed (exit ${r.code}): ${(out || r.stderr).trim().slice(0, 300)}`, 'VERIFY', { step: 'version' });
  }
  if (m[1] !== record.version) {
    throw new InstallerError(`binary reports ${m[1]} but ${record.version} was installed`, 'VERIFY', { step: 'version' });
  }
  return { path: file, version: m[1], sha256, authority: sig.authority, teamId: sig.teamId, versionOutput: out };
}
