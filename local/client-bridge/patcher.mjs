#!/usr/bin/env node
// Applies extension patches (PATCH_FORMAT.md) to the user's verified original SWFs and installs the
// derived modules atomically. Node 22+, no dependencies.
//
//   node local/client-bridge/patcher.mjs --media <dir with play/ and media/> --patches <dir> --out <data>/client-bridge
//        [--patchset <id>] [--json]
//
// Library: applySwfPatch(originalBytes, patch) and installPatchSet({ media, patches, out, ... }).
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

export const PATCH_FORMAT = 'claude-penguin/swf-patch/1';
export const PATCHSET_FORMAT = 'claude-penguin/swf-patchset/1';
export const MANIFEST_NAME = 'patchset.json';
const MAX_BODY = 256 * 1024 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SIGNATURES = { CWS: 'zlib', FWS: 'none' };

export class PatchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PatchError';
    this.code = code; // PATCH, ORIGINAL_MISSING, ORIGINAL_HASH, HEADER, LENGTH, RESULT_HASH, PATCHSET, INSTALL
  }
}

const sha256 = data => createHash('sha256').update(data).digest('hex');
const own = (object, keys) => object && typeof object === 'object' && !Array.isArray(object)
  && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
const uint = (value, what) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_BODY) throw new PatchError('PATCH', `${what} must be an integer between 0 and ${MAX_BODY}`);
  return value;
};
const hex = (value, what) => {
  if (typeof value !== 'string' || !HEX64.test(value)) throw new PatchError('PATCH', `${what} must be a lowercase SHA-256 hex string`);
  return value;
};
const name = (value, what) => {
  if (typeof value !== 'string' || !NAME.test(value)) throw new PatchError('PATCH', `${what} must be a plain file name`);
  return value;
};

/** Parse a CWS/FWS file; checks the signature, version and that the declared length matches the contents. */
export function splitSwf(data, label = 'SWF') {
  if (data.length < 9) throw new PatchError('HEADER', `${label}: too short for a SWF`);
  const signature = data.toString('latin1', 0, 3);
  if (!Object.hasOwn(SIGNATURES, signature)) throw new PatchError('HEADER', `${label}: unsupported SWF signature ${JSON.stringify(signature)}`);
  const version = data[3];
  const declared = data.readUInt32LE(4);
  let body;
  if (signature === 'CWS') {
    if (version < 6) throw new PatchError('HEADER', `${label}: zlib-compressed SWF needs version 6 or later`);
    if (declared < 8 || declared - 8 > MAX_BODY) throw new PatchError('LENGTH', `${label}: implausible declared length ${declared}`);
    try {
      body = zlib.inflateSync(data.subarray(8), { maxOutputLength: declared - 8 + 1 });
    } catch (error) {
      if (error.code === 'ERR_BUFFER_TOO_LARGE') throw new PatchError('LENGTH', `${label}: contents are longer than the declared length ${declared}`);
      throw new PatchError('HEADER', `${label}: corrupt zlib stream (${error.message})`);
    }
  } else {
    body = data.subarray(8);
  }
  if (declared !== body.length + 8) throw new PatchError('LENGTH', `${label}: declared length ${declared} does not match contents (${body.length + 8})`);
  return { signature, version, body };
}

export function buildSwf(signature, version, body, level = 9) {
  const header = Buffer.alloc(8);
  header.write(signature, 0, 'latin1');
  header[3] = version;
  header.writeUInt32LE(body.length + 8, 4);
  return Buffer.concat([header, signature === 'CWS' ? zlib.deflateSync(body, { level }) : body]);
}

/** Structure check. Returns ops with literals decoded: { copy: true, offset, length } | { data: Buffer }. */
export function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || patch.format !== PATCH_FORMAT) throw new PatchError('PATCH', `not a ${PATCH_FORMAT} patch`);
  const keys = Object.keys(patch);
  const allowed = ['format', 'target', 'recordFile', 'original', 'result', 'record', 'ops'];
  if (keys.some(key => !allowed.includes(key)) || ['target', 'recordFile', 'original', 'result', 'ops'].some(key => !keys.includes(key))) {
    throw new PatchError('PATCH', 'unexpected or missing patch fields');
  }
  name(patch.target, 'target');
  name(patch.recordFile, 'recordFile');
  const { original, result } = patch;
  if (!own(original, ['path', 'sha256', 'decompressedSha256', 'decompressedLength', 'signature', 'version'])) throw new PatchError('PATCH', 'original has unexpected fields');
  if (!own(result, ['decompressedSha256', 'decompressedLength', 'signature', 'version', 'compression'])) throw new PatchError('PATCH', 'result has unexpected fields');
  const parts = typeof original.path === 'string' ? original.path.split('/') : [];
  if (!parts.length || parts.some(part => part === '' || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) {
    throw new PatchError('PATCH', 'original.path must be a relative path without . or .. parts');
  }
  hex(original.sha256, 'original.sha256');
  hex(original.decompressedSha256, 'original.decompressedSha256');
  const originalLength = uint(original.decompressedLength, 'original.decompressedLength');
  hex(result.decompressedSha256, 'result.decompressedSha256');
  const resultLength = uint(result.decompressedLength, 'result.decompressedLength');
  for (const side of [original, result]) {
    if (!Object.hasOwn(SIGNATURES, side.signature)) throw new PatchError('PATCH', 'signature must be CWS or FWS');
    if (!Number.isInteger(side.version) || side.version < 1 || side.version > 255) throw new PatchError('PATCH', 'version must be 1-255');
    if (side.signature === 'CWS' && side.version < 6) throw new PatchError('PATCH', 'CWS needs version 6 or later');
  }
  if (SIGNATURES[result.signature] !== result.compression) throw new PatchError('PATCH', 'result.compression does not match result.signature');
  if (patch.record !== undefined && (patch.record === null || typeof patch.record !== 'object' || Array.isArray(patch.record))) throw new PatchError('PATCH', 'record must be an object');
  if (!Array.isArray(patch.ops)) throw new PatchError('PATCH', 'ops must be a list');
  const ops = [];
  let total = 0;
  patch.ops.forEach((op, index) => {
    if (Array.isArray(op) && op.length === 3 && op[0] === 'copy') {
      const offset = uint(op[1], 'copy offset');
      const length = uint(op[2], 'copy length');
      if (length === 0 || offset + length > originalLength) throw new PatchError('PATCH', `op ${index}: copy range is empty or outside the original`);
      ops.push({ copy: true, offset, length });
      total += length;
    } else if (Array.isArray(op) && op.length === 2 && op[0] === 'insert') {
      const text = op[1];
      const data = typeof text === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(text) ? Buffer.from(text, 'base64') : null;
      if (!data || !data.length || data.toString('base64') !== text) throw new PatchError('PATCH', `op ${index}: insert data is empty or not canonical base64`);
      ops.push({ data });
      total += data.length;
    } else {
      throw new PatchError('PATCH', `op ${index}: unknown operation`);
    }
    if (total > MAX_BODY) throw new PatchError('PATCH', 'result too large');
  });
  if (total !== resultLength) throw new PatchError('PATCH', `ops produce ${total} bytes but result.decompressedLength is ${resultLength}`);
  return ops;
}

/**
 * Verify the original, apply the patch, verify the result.
 * @param {Buffer} originalBytes the user's original SWF file
 * @param {object|string|Buffer} patch parsed patch or its JSON text
 * @returns {{ bytes: Buffer, fileSha256: string, decompressedSha256: string, decompressedLength: number, target: string, record: object }}
 */
export function applySwfPatch(originalBytes, patch, { level = 9 } = {}) {
  if (typeof patch === 'string' || Buffer.isBuffer(patch)) {
    try { patch = JSON.parse(patch.toString()); } catch { throw new PatchError('PATCH', 'patch is not valid JSON'); }
  }
  const ops = validatePatch(patch);
  const { original, result } = patch;
  if (sha256(originalBytes) !== original.sha256) throw new PatchError('ORIGINAL_HASH', 'the original file does not match the patch (wrong or modified file)');
  const parsed = splitSwf(originalBytes, 'original');
  if (parsed.signature !== original.signature || parsed.version !== original.version) throw new PatchError('HEADER', 'original SWF signature or version differs from the patch');
  if (parsed.body.length !== original.decompressedLength || sha256(parsed.body) !== original.decompressedSha256) throw new PatchError('ORIGINAL_HASH', 'the original contents do not match the patch');
  const body = Buffer.alloc(result.decompressedLength);
  let at = 0;
  for (const op of ops) {
    if (op.copy) at += parsed.body.copy(body, at, op.offset, op.offset + op.length);
    else at += op.data.copy(body, at);
  }
  if (at !== body.length) throw new PatchError('PATCH', 'ops did not fill the result');
  const decompressedSha256 = sha256(body);
  if (decompressedSha256 !== result.decompressedSha256) throw new PatchError('RESULT_HASH', 'the patched contents do not match the expected hash');
  const bytes = buildSwf(result.signature, result.version, body, level);
  // Re-read what will be written: header and declared length of the output.
  const check = splitSwf(bytes, 'output');
  if (check.body.length !== body.length || check.version !== result.version || check.signature !== result.signature) throw new PatchError('LENGTH', 'output header check failed');
  return { bytes, fileSha256: sha256(bytes), decompressedSha256, decompressedLength: body.length, target: patch.target, record: patch.record ?? {} };
}

async function readJson(file, what) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch (error) { throw new PatchError('PATCHSET', `cannot read ${what}: ${error.code ?? error.message}`); }
  try { return { value: JSON.parse(text), text }; } catch { throw new PatchError('PATCH', `${what} is not valid JSON`); }
}

/** Load and verify a patch set directory: the manifest and the hash of each patch file. */
export async function loadPatchSet(dir) {
  const { value: manifest, text: manifestText } = await readJson(path.join(dir, MANIFEST_NAME), MANIFEST_NAME);
  if (!own(manifest, ['format', 'id', 'patches']) || manifest.format !== PATCHSET_FORMAT) throw new PatchError('PATCH', `${MANIFEST_NAME} is not a ${PATCHSET_FORMAT} manifest`);
  name(manifest.id, 'patch set id');
  if (manifest.id === 'current' || !Array.isArray(manifest.patches) || !manifest.patches.length) throw new PatchError('PATCH', 'manifest id or patches invalid');
  const targets = new Set();
  const patches = [];
  for (const entry of manifest.patches) {
    if (!own(entry, ['file', 'sha256', 'target'])) throw new PatchError('PATCH', 'manifest patch entry has unexpected fields');
    name(entry.file, 'file'); name(entry.target, 'target'); hex(entry.sha256, 'sha256');
    if (targets.has(entry.target)) throw new PatchError('PATCH', 'duplicate target in manifest');
    targets.add(entry.target);
    let raw;
    try { raw = await fs.readFile(path.join(dir, entry.file)); } catch (error) { throw new PatchError('PATCHSET', `cannot read ${entry.file}: ${error.code ?? error.message}`); }
    if (sha256(raw) !== entry.sha256) throw new PatchError('PATCH', `${entry.file} does not match the hash in ${MANIFEST_NAME} (corrupt or modified patch)`);
    const patch = JSON.parse(raw.toString());
    if (patch?.target !== entry.target) throw new PatchError('PATCH', `${entry.file}: target differs from the manifest`);
    patches.push(patch);
  }
  return { manifest, manifestText, patches };
}

async function writeSynced(file, data) {
  const handle = await fs.open(file, 'w', 0o644);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
}

async function readIfExists(file) {
  try { return await fs.readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/**
 * Checks an installed patch set (`dir`, for example <out>/current) against the patch set it was built from:
 * the same manifest and, for every target, a record of this set that names the file's hash and contents that
 * decompress to the patch's expected result. Nothing is written.
 * @returns {Promise<{ ok: true, patchset: string } | { ok: false, problem: string }>}
 */
export async function verifyInstalledPatchSet({ patches, dir }) {
  const { manifest, manifestText, patches: loaded } = await loadPatchSet(patches);
  const installedManifest = await readIfExists(path.join(dir, MANIFEST_NAME));
  if (!installedManifest || installedManifest.toString() !== manifestText) return { ok: false, problem: `${MANIFEST_NAME} is missing or differs from patch set ${manifest.id}` };
  for (const patch of loaded) {
    validatePatch(patch);
    const file = await readIfExists(path.join(dir, patch.target));
    if (!file) return { ok: false, problem: `${patch.target} is missing` };
    let record = null;
    try { record = JSON.parse((await readIfExists(path.join(dir, patch.recordFile)))?.toString() ?? ''); } catch { /* reported below */ }
    if (!record || record.patchset !== manifest.id || record.outputSha256 !== sha256(file)) return { ok: false, problem: `${patch.target} does not match ${patch.recordFile}` };
    let parsed;
    try { parsed = splitSwf(file, patch.target); } catch { return { ok: false, problem: `${patch.target} is not a readable SWF` }; }
    const { result } = patch;
    if (parsed.signature !== result.signature || parsed.version !== result.version || parsed.body.length !== result.decompressedLength || sha256(parsed.body) !== result.decompressedSha256) {
      return { ok: false, problem: `${patch.target} differs from the patch result` };
    }
  }
  return { ok: true, patchset: manifest.id };
}

/**
 * Apply every patch of a set and install the result atomically.
 * Output: <out>/<patchset>/{engine.swf, puffle_adoption.swf, build.json, adoption-build.json, patchset.json}
 * and <out>/current -> <patchset> (temp symlink + rename). Nothing under <out> changes unless all patches verify.
 * @returns {{ patchset, dir, current, files: Array<{target, sha256, decompressedSha256, bytes}> }}
 */
export async function installPatchSet({ media, patches, out, patchset, onProgress = () => {}, level = 9 }) {
  const { manifest, manifestText, patches: loaded } = await loadPatchSet(patches);
  if (patchset && patchset !== manifest.id) throw new PatchError('PATCHSET', `expected patch set ${patchset} but ${patches} holds ${manifest.id}`);
  const id = manifest.id;
  await fs.mkdir(out, { recursive: true });
  const staging = path.join(out, `.staging-${id}-${process.pid}-${randomBytes(4).toString('hex')}`);
  await fs.mkdir(staging);
  const installed = [];
  try {
    const mediaRoot = path.resolve(media);
    for (const [index, patch] of loaded.entries()) {
      onProgress({ task: 'extensions', label: `Building ${patch.target}`, done: index, total: loaded.length });
      const source = path.resolve(mediaRoot, ...patch.original.path.split('/'));
      if (!source.startsWith(mediaRoot + path.sep)) throw new PatchError('PATCH', 'original.path leaves the media directory');
      let original;
      try { original = await fs.readFile(source); } catch (error) {
        throw new PatchError('ORIGINAL_MISSING', `cannot read the original ${patch.original.path}: ${error.code ?? error.message}`);
      }
      const built = applySwfPatch(original, patch, { level });
      const record = {
        ...built.record,
        outputSha256: built.fileSha256,
        outputDecompressedSha256: built.decompressedSha256,
        outputDecompressedLength: built.decompressedLength,
        patchset: id,
        derivedBy: 'patcher.mjs',
      };
      await writeSynced(path.join(staging, patch.target), built.bytes);
      await writeSynced(path.join(staging, patch.recordFile), JSON.stringify(record, null, 2) + '\n');
      installed.push({ target: patch.target, sha256: built.fileSha256, decompressedSha256: built.decompressedSha256, bytes: built.bytes.length, recordFile: patch.recordFile });
    }
    await writeSynced(path.join(staging, MANIFEST_NAME), manifestText);
    onProgress({ task: 'extensions', label: 'Installing extensions', done: loaded.length, total: loaded.length });

    const finalDir = path.join(out, id);
    const same = async () => {
      const installedManifest = await readIfExists(path.join(finalDir, MANIFEST_NAME));
      if (!installedManifest || installedManifest.toString() !== manifestText) return false;
      for (const file of installed) {
        const existing = await readIfExists(path.join(finalDir, file.target));
        if (!existing || sha256(existing) !== file.sha256) return false;
        const a = await readIfExists(path.join(finalDir, file.recordFile));
        const b = await readIfExists(path.join(staging, file.recordFile));
        if (!a || !b || !a.equals(b)) return false;
      }
      return true;
    };
    let exists = true;
    try { await fs.lstat(finalDir); } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
    if (!exists) {
      await fs.rename(staging, finalDir);
    } else if (await same()) {
      await fs.rm(staging, { recursive: true, force: true }); // already installed identically
    } else {
      // A damaged earlier install of this id: set it aside, then move the new one in.
      const aside = path.join(out, `.old-${id}-${process.pid}-${randomBytes(4).toString('hex')}`);
      await fs.rename(finalDir, aside);
      await fs.rename(staging, finalDir);
      await fs.rm(aside, { recursive: true, force: true });
    }
    const link = path.join(out, `.current-${process.pid}-${randomBytes(4).toString('hex')}`);
    await fs.symlink(id, link);
    try { await fs.rename(link, path.join(out, 'current')); } catch (error) {
      await fs.rm(link, { force: true });
      throw new PatchError('INSTALL', `cannot switch ${path.join(out, 'current')}: ${error.code ?? error.message}`);
    }
    return { patchset: id, dir: finalDir, current: path.join(out, 'current'), files: installed.map(({ recordFile, ...rest }) => rest) };
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function parseArgs(argv) {
  const options = { json: false };
  const valued = new Set(['media', 'patches', 'out', 'patchset']);
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--json') options.json = true;
    else if (flag.startsWith('--') && valued.has(flag.slice(2))) {
      if (i + 1 >= argv.length) throw new PatchError('USAGE', `${flag} needs a value`);
      options[flag.slice(2)] = argv[++i];
    } else throw new PatchError('USAGE', `unknown argument ${flag}`);
  }
  for (const required of ['media', 'patches', 'out']) if (!options[required]) throw new PatchError('USAGE', `--${required} is required`);
  return options;
}

export async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
    const emit = event => options.json && console.log(JSON.stringify({ event: 'progress', ...event }));
    const result = await installPatchSet({
      media: options.media, patches: options.patches, out: options.out, patchset: options.patchset,
      onProgress: event => (options.json ? emit(event) : console.error(event.label)),
    });
    if (options.json) console.log(JSON.stringify({ event: 'done', ...result }));
    else {
      for (const file of result.files) console.log(`${file.target}: ${file.bytes} bytes, contents sha256 ${file.decompressedSha256}`);
      console.log(`Installed patch set ${result.patchset} at ${result.dir}; ${result.current} now points to it.`);
    }
    return 0;
  } catch (error) {
    const code = error instanceof PatchError ? error.code : 'ERROR';
    if (options?.json) console.log(JSON.stringify({ event: 'problem', code, message: error.message }));
    else console.error(`patcher: ${code}: ${error.message}`);
    return code === 'USAGE' ? 2 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
