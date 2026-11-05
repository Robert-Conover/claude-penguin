// Shared fixtures for engine tests: isolated Git configuration, disposable
// repositories, and fake PTYs. No media, Docker, or Claude credentials needed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGit } from './git-policy.mjs';

/** A private temp folder (outside any repository) with its own Git global config. */
export function sandbox(t, prefix = 'penguin-') {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    // Engine worktrees are locked; unlock nothing, just remove the disposable tree.
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const globalConfig = path.join(dir, 'gitconfig');
  fs.writeFileSync(globalConfig, '[user]\n\tname = Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = dev\n[protocol "file"]\n\tallow = always\n[uploadpack]\n\tallowFilter = true\n');
  const gitEnv = { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' };
  const env = { ...process.env, ...gitEnv };
  for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG_PARAMETERS|CONFIG_COUNT)$/.test(key)) delete env[key];
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  function repo(name, files = { 'hello.txt': 'hello\n' }) {
    const root = path.join(dir, name);
    fs.mkdirSync(root, { recursive: true });
    git(root, 'init', '-q');
    for (const [file, contents] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), contents);
    }
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'fixture');
    return fs.realpathSync.native(root);
  }
  const hooksDir = path.join(dir, 'empty-hooks');
  fs.mkdirSync(hooksDir, { mode: 0o700 });
  const policyGit = createGit({ hooksDir, env: gitEnv });
  return { dir, gitEnv, env, git, repo, globalConfig, policyGit, cleanup: fn => cleanups.push(fn) };
}

export class FakePty {
  static nextPid = 99999000;
  pid = FakePty.nextPid++;
  writes = [];
  kills = [];
  onData(callback) { this.dataCallback = callback; }
  onExit(callback) { this.exitCallback = callback; }
  write(data) { this.writes.push(data); }
  resize(cols, rows) { this.size = { cols, rows }; }
  data(data) { this.dataCallback(data); }
  exit(exitCode = 0) { this.exitCallback({ exitCode }); }
  kill(signal) { this.kills.push(signal); queueMicrotask(() => this.exit()); }
}

/** Snapshot the parts of a source checkout that engine setup must never change. */
export function checkoutFingerprint(s, root) {
  const gitDir = path.join(root, '.git');
  const read = file => { try { return fs.readFileSync(file).toString('base64'); } catch { return null; } };
  return {
    head: s.git(root, 'rev-parse', 'HEAD').trim(), symbolic: s.git(root, 'symbolic-ref', '-q', 'HEAD').trim(),
    index: read(path.join(gitDir, 'index')), status: s.git(root, 'status', '--porcelain=v1', '--ignored', '--untracked-files=all'),
    files: Object.fromEntries(fs.readdirSync(root, { recursive: true }).filter(file => !file.startsWith('.git' + path.sep) && file !== '.git')
      .filter(file => fs.lstatSync(path.join(root, file)).isFile()).sort().map(file => [file, read(path.join(root, file))])),
  };
}

/** A v1 single-project state matching the shape written by the previous milestone. */
export function legacyState(sourcePath) {
  return { version: 1, revision: 79,
    projects: [{ id: 'e7c554c7-88e3-4c1f-9125-3261283a4393', name: 'Puffle Test', path: sourcePath, fixtureId: 'bridge-alpha',
      createdAt: '2026-11-03T21:43:40.950Z', ownerId: 105, iglooId: 4, roomId: 2105, puffleId: 4 }],
    workers: [{ id: '34a60f4a-0c2b-4ab8-af20-c3156de19ffd', projectId: 'e7c554c7-88e3-4c1f-9125-3261283a4393', name: 'Atlas',
      sessionId: 'c6b60407-ead8-4488-b8cb-281936dca777', status: 'interrupted', activity: 'stopped', established: true, cols: 101, rows: 20,
      createdAt: '2026-11-03T21:43:50.761Z', updatedAt: '2026-11-03T23:04:44.571Z', pid: null, baseCommit: 'dc4eefbdb2af3038c1298490e06538096444e4b8',
      dirtyAtStart: false, exitCode: 143, taskHistory: [
        { id: 't1', prompt: 'first', startedAt: '2026-11-03T21:50:00.000Z', status: 'turn-ended', endedAt: '2026-11-03T21:51:00.000Z' },
        { id: 't2', prompt: 'unfinished', startedAt: '2026-11-03T22:50:00.000Z', status: 'working' }] }] };
}

