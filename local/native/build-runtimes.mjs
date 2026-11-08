#!/usr/bin/env node
// Builds the pinned, relocatable native runtimes into .local/runtimes/.
//
//   node local/native/build-runtimes.mjs [build] [--only node,python,postgres,valkey,git,envs]
//                                         [--force] [--out DIR] [--work DIR]
//   node local/native/build-runtimes.mjs lock [houdini|dash|snowflake ...]
//
// Everything is downloaded from the official source in runtimes.json, checked
// against its pinned SHA-256 before extraction, and built in the work
// directory (default .local/runtimes-build). A component whose recorded
// inputs hash matches is skipped. Run with the system Node (22+), macOS arm64.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm, rename, readdir, stat, copyFile, chmod, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const RECIPE = 'build-runtimes.mjs/1';

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith('--') ? args.shift() : 'build';
function option(name) { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; }
const force = args.includes('--force');
const out = path.resolve(option('--out') ?? path.join(repo, '.local/runtimes'));
const work = path.resolve(option('--work') ?? path.join(repo, '.local/runtimes-build'));
const only = option('--only')?.split(',') ?? null;
const config = JSON.parse(await readFile(path.join(here, 'runtimes.json'), 'utf8'));
const jobs = String(os.availableParallelism());
const buildEnv = {
  ...process.env,
  MACOSX_DEPLOYMENT_TARGET: config.deploymentTarget,
  SOURCE_DATE_EPOCH: '1793000000',
  CFLAGS: '-O2 -g0',
  PYTHONDONTWRITEBYTECODE: '1',
};
delete buildEnv.PYTHONPATH;

function log(...a) { console.log(`[runtimes ${new Date().toISOString().slice(11, 19)}]`, ...a); }
function run(cmd, cmdArgs, opts = {}) {
  log('$', cmd, ...cmdArgs.map(a => (a.includes(' ') ? JSON.stringify(a) : a)).slice(0, 14));
  const r = spawnSync(cmd, cmdArgs, { stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', env: opts.env ?? buildEnv, cwd: opts.cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.slice(0, 3).join(' ')} failed (${r.status ?? r.signal})`);
  return r.stdout;
}
const sha256File = file => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(file).on('data', c => hash.update(c)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
});
const inputsHash = value => createHash('sha256').update(RECIPE + JSON.stringify(value)).digest('hex').slice(0, 16);

async function fetchVerified(url, fileName, sha256) {
  const dir = path.join(work, 'downloads');
  await mkdir(dir, { recursive: true });
  const dest = path.join(dir, fileName);
  if (existsSync(dest) && await sha256File(dest) === sha256) return dest;
  log('download', url);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const partial = `${dest}.partial`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(partial));
  const actual = await sha256File(partial);
  if (actual !== sha256) { await rm(partial); throw new Error(`SHA-256 mismatch for ${url}: expected ${sha256}, got ${actual}`); }
  await rename(partial, dest);
  return dest;
}

async function extract(archive, name, sha256) {
  // Verify again immediately before extracting, into a fresh empty directory.
  if (await sha256File(archive) !== sha256) throw new Error(`${archive}: SHA-256 mismatch before extraction`);
  const dir = path.join(work, 'src', name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  run('tar', ['-xf', archive, '-C', dir]);
  const entries = await readdir(dir);
  return entries.length === 1 ? path.join(dir, entries[0]) : dir;
}

async function dirSize(dir) {
  const text = run('du', ['-sk', dir], { capture: true });
  return Number(text.split(/\s/)[0]) * 1024;
}

async function readManifest() {
  try { return JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8')); }
  catch { return { schema: 1, platform: config.platform, components: {} }; }
}
async function writeManifest(manifest) {
  manifest.deploymentTarget = config.deploymentTarget;
  await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

async function install(name, stage) {
  await mkdir(out, { recursive: true });
  const target = path.join(out, name);
  await rm(target, { recursive: true, force: true });
  await rename(stage, target);
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}
const isMachO = file => {
  const r = spawnSync('file', ['-b', file], { encoding: 'utf8' });
  return /Mach-O/.test(r.stdout);
};
const adhocSign = file => run('codesign', ['--force', '-s', '-', file], { capture: true });

// ---------------------------------------------------------------- components

async function buildNode() {
  const c = config.node;
  const archive = await fetchVerified(c.url, path.basename(c.url), c.sha256);
  const src = await extract(archive, 'node', c.sha256);
  const stage = path.join(work, 'stage', 'node');
  await rm(stage, { recursive: true, force: true });
  await mkdir(path.join(stage, 'bin'), { recursive: true });
  await copyFile(path.join(src, 'bin/node'), path.join(stage, 'bin/node'));
  await chmod(path.join(stage, 'bin/node'), 0o755);
  await copyFile(path.join(src, 'LICENSE'), path.join(stage, 'LICENSE'));
  await install('node', stage);
  return { version: c.version, source: c.url, sourceSha256: c.sha256, license: c.license };
}

async function buildPython(py) {
  const archive = await fetchVerified(py.url, py.file, py.sha256);
  const src = await extract(archive, py.id, py.sha256);
  const stage = path.join(work, 'stage', py.id);
  await rm(stage, { recursive: true, force: true });
  await mkdir(path.dirname(stage), { recursive: true });
  await rename(src, stage);
  // Drop what a server never imports: the test suite and the GUI/demo modules.
  const lib = path.join(stage, 'lib', `python${py.version.split('.').slice(0, 2).join('.')}`);
  for (const sub of ['test', 'idlelib', 'turtledemo', 'tkinter', 'lib2to3', 'config-' + py.version.split('.').slice(0, 2).join('.') + '-darwin']) {
    await rm(path.join(lib, sub), { recursive: true, force: true });
  }
  await rm(path.join(stage, 'share'), { recursive: true, force: true });
  // Ship complete bytecode keyed to nothing that changes on copy and recording no build path,
  // so a read-only (signed) install never needs to write __pycache__.
  const bin = path.join(stage, 'bin/python3');
  const cleanup = spawnSync('find', [stage, '-name', '__pycache__', '-type', 'd', '-prune', '-exec', 'rm', '-rf', '{}', '+']);
  if (cleanup.status !== 0) throw new Error('could not clear __pycache__');
  run(bin, ['-I', '-B', '-m', 'compileall', '-q', '-j', '0', '--invalidation-mode', 'unchecked-hash', '-s', lib, lib]);
  await install(py.id, stage);
  return { version: py.version, release: py.release, source: py.url, sourceSha256: py.sha256, license: py.license };
}

async function buildPostgres() {
  const c = config.postgres;
  const archive = await fetchVerified(c.url, path.basename(c.url), c.sha256);
  const src = await extract(archive, 'postgres', c.sha256);
  const prefix = `${config.installPrefix}/postgres`;
  const destdir = path.join(work, 'destdir-postgres');
  await rm(destdir, { recursive: true, force: true });
  run('./configure', [`--prefix=${prefix}`, ...c.configure], { cwd: src });
  run('make', ['-j', jobs], { cwd: src });
  run('make', ['install', `DESTDIR=${destdir}`], { cwd: src });
  const stage = path.join(work, 'stage', 'postgres');
  await rm(stage, { recursive: true, force: true });
  await mkdir(path.dirname(stage), { recursive: true });
  await rename(path.join(destdir, prefix), stage);
  // Prune: keep only what the app runs and what migration backups need.
  const keep = new Set(c.keepBinaries);
  for (const bin of await readdir(path.join(stage, 'bin'))) if (!keep.has(bin)) await rm(path.join(stage, 'bin', bin));
  for (const sub of ['include', 'lib/pkgconfig', 'lib/pgxs']) await rm(path.join(stage, sub), { recursive: true, force: true });
  await rm(path.join(stage, 'share/doc'), { recursive: true, force: true });
  await rm(path.join(stage, 'share/man'), { recursive: true, force: true });
  for await (const file of walk(stage)) if (file.endsWith('.a')) await rm(file);
  // Make every Mach-O reference to the install prefix relative to the file itself.
  for await (const file of walk(stage)) {
    if (!isMachO(file)) continue;
    const deps = run('otool', ['-L', file], { capture: true }).split('\n').slice(1).map(l => l.trim().split(' ')[0]).filter(d => d.startsWith(prefix));
    const name = path.basename(file);
    const rel = d => `@loader_path/${path.relative(path.dirname(file), path.join(stage, path.relative(prefix, d))) }`;
    const edits = [];
    for (const d of deps) {
      if (d === `${prefix}/lib/${name}` && file.endsWith('.dylib')) edits.push(['-id', `@rpath/${name}`]);
      else edits.push(['-change', d, rel(d)]);
    }
    for (const edit of edits) run('install_name_tool', [...edit, file], { capture: true });
    // Strip local symbols/debug info, then re-sign (any edit invalidates the signature).
    spawnSync('strip', ['-x', file], { stdio: 'ignore' });
    adhocSign(file);
  }
  await install('postgres', stage);
  return { version: c.version, source: c.url, sourceSha256: c.sha256, license: c.license, configure: c.configure };
}

async function buildValkey() {
  const c = config.valkey;
  const archive = await fetchVerified(c.url, c.file, c.sha256);
  const src = await extract(archive, 'valkey', c.sha256);
  run('make', ['-j', jobs, 'CC=cc', ...c.make], { cwd: src });
  const stage = path.join(work, 'stage', 'valkey');
  await rm(stage, { recursive: true, force: true });
  await mkdir(path.join(stage, 'bin'), { recursive: true });
  for (const bin of ['valkey-server', 'valkey-cli']) {
    const dest = path.join(stage, 'bin', bin);
    await copyFile(path.join(src, 'src', bin), dest);
    await chmod(dest, 0o755);
    spawnSync('strip', ['-x', dest], { stdio: 'ignore' });
    adhocSign(dest);
  }
  await copyFile(path.join(src, 'COPYING'), path.join(stage, 'COPYING'));
  await install('valkey', stage);
  return { version: c.version, source: c.url, sourceSha256: c.sha256, license: c.license, make: c.make };
}

async function buildGit() {
  const c = config.git;
  const archive = await fetchVerified(c.url, path.basename(c.url), c.sha256);
  const src = await extract(archive, 'git', c.sha256);
  const prefix = `${config.installPrefix}/git`;
  const destdir = path.join(work, 'destdir-git');
  await rm(destdir, { recursive: true, force: true });
  const flags = [`prefix=${prefix}`, ...c.make, `DESTDIR=${destdir}`];
  run('make', ['-j', jobs, ...flags, 'all'], { cwd: src });
  run('make', [...flags, 'install'], { cwd: src });
  const stage = path.join(work, 'stage', 'git');
  await rm(stage, { recursive: true, force: true });
  await mkdir(path.dirname(stage), { recursive: true });
  await rename(path.join(destdir, prefix), stage);
  for (const sub of ['share/man', 'share/doc', 'share/locale']) await rm(path.join(stage, sub), { recursive: true, force: true });
  await copyFile(path.join(src, 'COPYING'), path.join(stage, 'COPYING'));
  for await (const file of walk(stage)) {
    if (!isMachO(file)) continue;
    spawnSync('strip', ['-x', file], { stdio: 'ignore' });
    adhocSign(file);
  }
  await install('git', stage);
  // An entry point for PATH: a directory holding only `git`.
  const only = path.join(work, 'stage', 'git-only');
  await rm(only, { recursive: true, force: true });
  await mkdir(only, { recursive: true });
  await writeFile(path.join(only, 'git'), [
    '#!/bin/sh',
    '# Entry point so a PATH holding only this directory finds the bundled Git.',
    'case "$0" in */*) here=${0%/*} ;; *) here=. ;; esac',
    'root=$(cd "$here/../git/bin" && pwd -P) || exit 127',
    'exec "$root/git" "$@"',
    '',
  ].join('\n'), { mode: 0o755 });
  await install('git-only', only);
  return { version: c.version, source: c.url, sourceSha256: c.sha256, license: c.license, make: c.make };
}

function envPaths(id) { return { stage: path.join(work, 'stage', 'envs', id), dest: path.join(out, 'envs', id) }; }

function pythonFor(id) {
  const py = config.pythons.find(p => p.id === id);
  return { py, bin: path.join(out, id, 'bin/python3') };
}

async function buildPythonEnv(id) {
  const spec = config.envs[id];
  const { py, bin } = pythonFor(spec.python);
  const requirements = path.join(here, spec.requirements);
  const { stage, dest } = envPaths(id);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  const pipArgs = ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-compile', '--no-deps', '--require-hashes',
    '--only-binary=:all:', ...(spec.sdist.length ? [`--no-binary=${spec.sdist.join(',')}`] : []),
    '--target', stage, '-r', requirements];
  run(bin, pipArgs, { env: { ...buildEnv, PIP_NO_CACHE_DIR: '1' } });
  await rm(path.join(stage, 'bin'), { recursive: true, force: true });
  for await (const file of walk(stage)) {
    if (file.endsWith('__pycache__')) continue;
    if (file.endsWith('.so') || file.endsWith('.dylib')) {
      spawnSync('strip', ['-S', '-x', file], { stdio: 'ignore' }); // drop debug-map paths of the build directory
      // Vendor wheels carry the rpath of their CI machine (e.g. Pillow's libjpeg); @loader_path ones are kept.
      const rpaths = run('sh', ['-c', `otool -l "${file}" | awk '/LC_RPATH/{r=1} r&&/ path /{print $2; r=0}'`], { capture: true }).split('\n').filter(p => p.startsWith('/'));
      for (const rp of new Set(rpaths)) run('install_name_tool', ['-delete_rpath', rp, file], { capture: true });
      adhocSign(file);
    }
  }
  // Precompile without the build path in the code objects, keyed to nothing that changes on copy.
  run(bin, ['-I', '-m', 'compileall', '-q', '-j', '0', '--invalidation-mode', 'unchecked-hash', '-s', stage, stage]);
  await mkdir(path.dirname(dest), { recursive: true });
  await rm(dest, { recursive: true, force: true });
  await rename(stage, dest);
  const lockHash = await sha256File(requirements);
  return { python: spec.python, pythonVersion: py.version, requirements: spec.requirements, requirementsSha256: lockHash, sdistBuilds: spec.sdist };
}

// ---------------------------------------------------------------- lock files

async function lock(ids) {
  for (const id of ids) {
    const spec = config.envs[id];
    const { bin } = pythonFor(spec.python);
    const input = path.join(here, 'requirements', `${id}.in`);
    const report = path.join(work, `${id}-report.json`);
    await mkdir(work, { recursive: true });
    run(bin, ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', '--dry-run', '--ignore-installed', '--no-deps', '--only-binary=:all:',
      ...(spec.sdist.length ? [`--no-binary=${spec.sdist.join(',')}`] : []),
      '--target', path.join(work, 'lock-target'), '--report', report, '--quiet', '-r', input], { env: { ...buildEnv, PIP_NO_CACHE_DIR: '1' } });
    const items = JSON.parse(await readFile(report, 'utf8')).install;
    const lines = [
      `# Generated by: node local/native/build-runtimes.mjs lock ${id}`,
      `# Interpreter: CPython ${config.pythons.find(p => p.id === spec.python).version} (python-build-standalone), macOS arm64.`,
      `# Input: local/native/requirements/${id}.in (derived from local/dependency-snapshots; see local/native/README.md for deviations).`,
      '# Hashes cover the exact wheel (or, for the sdist-built packages, the source archive) pip resolved; install with --require-hashes --no-deps.',
      '',
    ];
    for (const item of items.sort((a, b) => a.metadata.name.toLowerCase().localeCompare(b.metadata.name.toLowerCase()))) {
      const hash = item.download_info.archive_info.hashes?.sha256;
      if (!hash) throw new Error(`${item.metadata.name}: no sha256 in pip report`);
      lines.push(`${item.metadata.name}==${item.metadata.version} \\`, `    --hash=sha256:${hash}`);
    }
    await writeFile(path.join(here, 'requirements', `${id}.txt`), lines.join('\n') + '\n');
    log(`wrote requirements/${id}.txt (${items.length} packages)`);
  }
}

// ---------------------------------------------------------------- driver

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('The native runtimes are built on macOS arm64 only.');
  if (command === 'lock') {
    const ids = args.filter(a => !a.startsWith('--') && a !== option('--out') && a !== option('--work'));
    return lock(ids.length ? ids : Object.keys(config.envs));
  }
  const manifest = await readManifest();
  const plan = [];
  plan.push(['node', config.node, buildNode]);
  for (const py of config.pythons) plan.push([py.id, py, () => buildPython(py)]);
  plan.push(['postgres', config.postgres, buildPostgres], ['valkey', config.valkey, buildValkey], ['git', config.git, buildGit]);
  const pythonHashes = Object.fromEntries(config.pythons.map(p => [p.id, inputsHash(p)]));
  for (const id of Object.keys(config.envs)) {
    const spec = config.envs[id];
    const lockText = await readFile(path.join(here, spec.requirements), 'utf8').catch(() => null);
    if (lockText === null) { log(`skip env ${id}: ${spec.requirements} is missing (run: lock ${id})`); continue; }
    plan.push([`envs/${id}`, { spec, lockText, python: pythonHashes[spec.python] }, () => buildPythonEnv(id)]);
  }
  const wanted = name => !only || only.includes(name) || only.includes(name.split('/')[0]);
  for (const [name, input, build] of plan) {
    if (!wanted(name)) continue;
    const hash = inputsHash(input) + (name === 'git' ? '' : '');
    const entry = manifest.components[name];
    const present = existsSync(path.join(out, name)) && (name !== 'git' || existsSync(path.join(out, 'git-only/git')));
    if (!force && present && entry?.inputsHash === hash) { log(`${name}: up to date (${entry.version ?? entry.pythonVersion})`); continue; }
    log(`${name}: building`);
    const started = Date.now();
    const info = await build();
    manifest.components[name] = { ...info, inputsHash: hash, sizeBytes: await dirSize(path.join(out, name)), buildSeconds: Math.round((Date.now() - started) / 1000) };
    if (name === 'git') manifest.components['git-only'] = { version: info.version, note: 'PATH entry point; delegates to ../git/bin/git', inputsHash: hash, sizeBytes: await dirSize(path.join(out, 'git-only')) };
    await writeManifest(manifest);
    log(`${name}: done in ${manifest.components[name].buildSeconds}s`);
  }
  manifest.totalBytes = await dirSize(out);
  await writeManifest(manifest);
  log(`runtimes at ${out}: ${(manifest.totalBytes / 1048576).toFixed(0)} MiB`);
}

main().catch(error => { console.error(error.message); process.exit(1); });
