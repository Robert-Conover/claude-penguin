import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createWorktree, defaultProjectName, identifyRepository, prepareWorktreeRoot, projectNameProblem, repoFolderName,
  reserveWorkspacePath, resolveWorktreeRoot, suggestPuffleName, validateProjectName, validatePuffleName,
} from './workspace.mjs';
import { sandbox } from './testing.mjs';

test('project names follow the shared game-safe rules before any nickname is assigned', () => {
  for (const name of ['Atlas', 'claude-penguin', 'My Project 2', 'a.b_c-d', 'X', 'A'.repeat(30)]) assert.equal(projectNameProblem(name), null, name);
  for (const name of ['100%', 'A|B', 'a:b', ' leading', 'trailing ', 'two  spaces', 'tab\tname', 'new\nline', '', 'A'.repeat(31),
    '-dash', 'dot.', 'emoji🐧', 'percent%20', 'semi;colon', 'x\u0000y']) {
    assert.throws(() => validateProjectName(name), /Project names|Enter a project name/, JSON.stringify(name));
  }
});

test('repository basenames become valid default project names', () => {
  assert.equal(defaultProjectName('claude-penguin'), 'claude-penguin');
  assert.equal(defaultProjectName('my  repo!!'), 'my repo');
  assert.equal(defaultProjectName('--hidden--'), 'hidden');
  assert.equal(defaultProjectName('%%%'), 'Project');
  assert.equal(defaultProjectName(''), 'Project');
  const long = defaultProjectName('a'.repeat(29) + ' bcdefgh');
  assert.equal(long, 'a'.repeat(29));
  assert.equal(projectNameProblem(defaultProjectName('x'.repeat(28) + '-.yy')), null);
});

test('puffle names are 1–12 letters and suggestions avoid used names', () => {
  for (const name of ['Atlas', 'a', 'ABCDEFGHIJKL']) assert.equal(validatePuffleName(name), name);
  for (const name of ['', 'Atlas2', 'Two Words', 'ABCDEFGHIJKLM', 'Émile', 'at-las']) assert.throws(() => validatePuffleName(name), /1 to 12 letters/);
  assert.equal(suggestPuffleName([]), 'Atlas');
  assert.equal(suggestPuffleName(['atlas', 'Comet']), 'Nova');
});

test('worktree leaf names are sanitized and never empty', () => {
  assert.equal(repoFolderName('my repo (copy)'), 'my-repo--copy-');
  assert.equal(repoFolderName('naïve'), 'na-ve');
  assert.equal(repoFolderName(''), 'repo');
  assert.equal(repoFolderName('..'), 'repo');
  assert.equal(repoFolderName('ok.name_1-2'), 'ok.name_1-2');
});

test('the worktree root defaults under the home folder, must be absolute, and is refused inside Git', async t => {
  const s = sandbox(t);
  assert.equal(resolveWorktreeRoot(undefined, '/Users/example'), '/Users/example/.claude-penguin/worktrees');
  assert.throws(() => resolveWorktreeRoot('relative/root'), /absolute/);
  const repo = s.repo('host');
  await assert.rejects(prepareWorktreeRoot(s.policyGit, path.join(repo, 'nested', 'worktrees')), /inside a Git repository/);
  assert.equal(fs.existsSync(path.join(repo, 'nested')), false, 'nothing is created inside the repository');
  const spaced = path.join(s.dir, 'Parent With Spaces', 'Penguin Worktrees');
  const root = await prepareWorktreeRoot(s.policyGit, spaced);
  assert.equal(root, fs.realpathSync.native(spaced));
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.dirname(root)).mode & 0o777, 0o700);
  const leaf = reserveWorkspacePath(root, '11111111-1111-4111-8111-111111111111', '/some/where/My Repo');
  assert.equal(leaf, path.join(root, '11111111-1111-4111-8111-111111111111', 'My-Repo'));
  assert.equal(fs.statSync(path.dirname(leaf)).mode & 0o777, 0o700);
});

test('repository identity is canonical: symlinks and linked worktrees share one identity; equal basenames do not', async t => {
  const s = sandbox(t);
  const first = s.repo('one/app');
  const second = s.repo('two/app');
  const alias = path.join(s.dir, 'alias');
  fs.symlinkSync(first, alias);
  const linked = path.join(s.dir, 'linked');
  s.git(first, 'worktree', 'add', '-q', '-b', 'side', linked);
  const a = await identifyRepository(s.policyGit, first);
  assert.equal((await identifyRepository(s.policyGit, alias)).commonDir, a.commonDir);
  assert.equal((await identifyRepository(s.policyGit, path.join(first, '.'))).sourcePath, a.sourcePath);
  const fromLinked = await identifyRepository(s.policyGit, linked);
  assert.equal(fromLinked.commonDir, a.commonDir);
  assert.equal(fromLinked.sourcePath, fs.realpathSync.native(linked), 'the registered checkout remains the display path');
  assert.notEqual((await identifyRepository(s.policyGit, second)).commonDir, a.commonDir);
  const empty = path.join(s.dir, 'empty');
  fs.mkdirSync(empty);
  s.git(empty, 'init', '-q');
  await assert.rejects(identifyRepository(s.policyGit, empty), /at least one commit/);
  const bare = path.join(s.dir, 'bare.git');
  s.git(s.dir, 'init', '-q', '--bare', bare);
  await assert.rejects(identifyRepository(s.policyGit, bare), /Bare repositories/);
  await assert.rejects(identifyRepository(s.policyGit, 'relative'), /absolute/);
  await assert.rejects(identifyRepository(s.policyGit, path.join(s.dir, 'missing')), /does not exist/);
});

test('worktree reconciliation adopts only an exact reservation and never removes conflicts', async t => {
  const s = sandbox(t);
  const source = s.repo('source');
  const baseline = s.git(source, 'rev-parse', 'HEAD').trim();
  const root = path.join(s.dir, 'root');
  fs.mkdirSync(root);
  const reservation = { sourcePath: source, workspacePath: path.join(root, 'leaf'), branch: 'claude-penguin/p/w', baseline, workerId: 'w' };
  await createWorktree(s.policyGit, reservation);
  assert.deepEqual(await createWorktree(s.policyGit, reservation), { reconciled: true });
  assert.equal(s.git(source, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 2, 'no duplicate worktree');

  const occupied = { ...reservation, workspacePath: path.join(root, 'occupied'), branch: 'claude-penguin/p/other' };
  fs.mkdirSync(occupied.workspacePath);
  fs.writeFileSync(path.join(occupied.workspacePath, 'keep.txt'), 'mine');
  await assert.rejects(createWorktree(s.policyGit, occupied), /not the reserved worktree/);
  assert.equal(fs.readFileSync(path.join(occupied.workspacePath, 'keep.txt'), 'utf8'), 'mine');

  fs.writeFileSync(path.join(source, 'hello.txt'), 'moved\n');
  s.git(source, 'commit', '-qam', 'moved');
  s.git(source, 'branch', 'claude-penguin/p/moved');
  await assert.rejects(createWorktree(s.policyGit, { ...reservation, workspacePath: path.join(root, 'moved'), branch: 'claude-penguin/p/moved' }), /different commit/);
  assert.equal(s.git(source, 'rev-parse', 'claude-penguin/p/moved').trim(), s.git(source, 'rev-parse', 'HEAD').trim(), 'conflicting branch is untouched');
});
