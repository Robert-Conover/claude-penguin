import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertGitVersion, assertReadPolicy, ensureEmptyHooksDir, inspectBaseline, parseGitVersion } from './git-policy.mjs';
import { createWorktree, listWorktrees } from './workspace.mjs';
import { sandbox } from './testing.mjs';

const hasLfs = (() => { try { execFileSync('git-lfs', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

function setupWorktree(s, source, name = 'wt') {
  const baseline = s.git(source, 'rev-parse', 'HEAD').trim();
  const workspacePath = path.join(s.dir, 'worktrees', name);
  fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
  return { sourcePath: source, workspacePath, branch: `claude-penguin/test/${name}`, baseline, workerId: name };
}

test('Git 2.48 or newer is required, with upgrade guidance for older versions', () => {
  assert.deepEqual(parseGitVersion('git version 2.54.0 (Apple Git-157)'), [2, 54, 0]);
  assert.deepEqual(assertGitVersion('git version 2.48.0'), [2, 48, 0]);
  assert.deepEqual(assertGitVersion('git version 3.0'), [3, 0, 0]);
  for (const old of ['git version 2.47.2', 'git version 2.39.5 (Apple Git-154)', 'something else']) {
    assert.throws(() => assertGitVersion(old), /requires Git 2\.48 or newer/);
  }
});

test('the empty hooks directory must stay private and empty', t => {
  const s = sandbox(t);
  const dir = path.join(s.dir, 'hooks');
  assert.equal(ensureEmptyHooksDir(dir), fs.realpathSync.native(dir));
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  fs.writeFileSync(path.join(dir, 'post-checkout'), '#!/bin/sh\n');
  assert.throws(() => ensureEmptyHooksDir(dir), /contains files/);
});

test('custom clean, smudge, and process filters are rejected before they can execute', async t => {
  for (const variable of ['clean', 'smudge', 'process']) {
    const s = sandbox(t);
    const sentinel = path.join(s.dir, `${variable}-ran`);
    const source = s.repo('source', { '.gitattributes': '*.txt filter=custom\n', 'a.txt': 'a\n' });
    s.git(source, 'config', `filter.custom.${variable}`, `touch ${sentinel}; cat`);
    const reservation = setupWorktree(s, source);
    await assert.rejects(createWorktree(s.policyGit, reservation), /Unsupported Git filter command[^]*a\.txt \(filter=custom\)/);
    assert.equal(fs.existsSync(sentinel), false, `${variable} filter must not run`);
    assert.equal(fs.existsSync(reservation.workspacePath), false);
    assert.equal(s.git(source, 'branch', '--list', reservation.branch).trim(), '', 'no branch is created after a policy refusal');
  }
});

test('a driver merely named lfs with a different command is custom', async t => {
  const s = sandbox(t);
  const sentinel = path.join(s.dir, 'fake-lfs-ran');
  const source = s.repo('source', { '.gitattributes': '*.bin filter=lfs\n', 'a.bin': 'data\n' });
  s.git(source, 'config', 'filter.lfs.smudge', `touch ${sentinel}; cat`);
  await assert.rejects(createWorktree(s.policyGit, setupWorktree(s, source)), /filter=lfs/);
  assert.equal(fs.existsSync(sentinel), false);
});

test('attributes naming a driver without commands, and unused custom drivers, are inert at checkout', async t => {
  const s = sandbox(t);
  const source = s.repo('source', { '.gitattributes': '*.txt filter=nothing\n', 'a.txt': 'a\n' });
  s.git(source, 'config', 'filter.unused.clean', 'false');
  const reservation = setupWorktree(s, source);
  await createWorktree(s.policyGit, reservation);
  assert.equal(fs.readFileSync(path.join(reservation.workspacePath, 'a.txt'), 'utf8'), 'a\n');
});

test('user attributes are included when inspecting the baseline', async t => {
  const s = sandbox(t);
  const sentinel = path.join(s.dir, 'user-attr-ran');
  const source = s.repo('source', { 'a.txt': 'a\n' });
  const attributes = path.join(s.dir, 'user-attributes');
  fs.writeFileSync(attributes, '*.txt filter=userdriver\n');
  fs.appendFileSync(s.globalConfig, `[core]\n\tattributesFile = ${attributes}\n[filter "userdriver"]\n\tsmudge = touch ${sentinel}; cat\n`);
  await assert.rejects(createWorktree(s.policyGit, setupWorktree(s, source)), /filter=userdriver/);
  assert.equal(fs.existsSync(sentinel), false);
});

test('repository hooks do not run during worktree creation and the worktree is locked', async t => {
  const s = sandbox(t);
  const source = s.repo('source');
  const sentinel = path.join(s.dir, 'hook-ran');
  const hook = path.join(source, '.git/hooks/post-checkout');
  fs.writeFileSync(hook, `#!/bin/sh\ntouch ${sentinel}\n`, { mode: 0o755 });
  s.git(source, 'config', 'core.hooksPath', path.join(source, '.git/hooks'));
  const reservation = setupWorktree(s, source);
  await createWorktree(s.policyGit, reservation);
  assert.equal(fs.existsSync(sentinel), false);
  const entry = (await listWorktrees(s.policyGit, source)).find(item => item.realPath === fs.realpathSync.native(reservation.workspacePath));
  assert.match(String(entry.locked), /Claude Penguin worker wt/);
  assert.equal(entry.branch, `refs/heads/${reservation.branch}`);
  assert.throws(() => s.git(source, 'worktree', 'remove', reservation.workspacePath), /locked/);
  assert.equal(s.git(reservation.workspacePath, 'config', '--default', 'none', '--get', `branch.${reservation.branch}.remote`).trim(), 'none', '--no-track leaves no upstream');
});

test('repository-local includeIf is refused, and conditional filter configuration elsewhere fails clearly', async t => {
  const s = sandbox(t);
  const source = s.repo('source');
  s.git(source, 'config', 'includeIf.gitdir:/nowhere/.path', '/nonexistent');
  await assert.rejects(createWorktree(s.policyGit, setupWorktree(s, source)), /repository's own configuration uses conditional includes/);

  const other = sandbox(t);
  const repo = other.repo('source');
  const included = path.join(other.dir, 'conditional.gitconfig');
  fs.writeFileSync(included, '[filter "conditional"]\n\tsmudge = cat\n');
  fs.appendFileSync(other.globalConfig, `[includeIf "gitdir:${other.dir}/"]\n\tpath = ${included}\n`);
  await assert.rejects(createWorktree(other.policyGit, setupWorktree(other, repo)), /cannot establish the effective filter policy/);
  fs.writeFileSync(included, '[core]\n\tautocrlf = false\n');
  await createWorktree(other.policyGit, setupWorktree(other, repo, 'harmless'));
});

test('missing partial-clone objects fail explicitly without lazy fetching', async t => {
  const s = sandbox(t);
  const upstream = s.repo('upstream', { 'big.txt': 'large content\n', 'small.txt': 'small\n' });
  const clone = path.join(s.dir, 'partial');
  s.git(s.dir, 'clone', '-q', '--no-checkout', '--filter=blob:none', `file://${upstream}`, clone);
  const blob = s.git(upstream, 'rev-parse', 'HEAD:big.txt').trim();
  const missing = () => { try { execFileSync('git', ['cat-file', '-e', blob], { cwd: clone, env: { ...s.env, GIT_NO_LAZY_FETCH: '1' }, stdio: 'ignore' }); return false; } catch { return true; } };
  assert.equal(missing(), true);
  const reservation = setupWorktree(s, clone);
  await assert.rejects(createWorktree(s.policyGit, reservation), error => { assert.match(error.message, /Git worktree failed/); assert.match(error.stderr, /promisor|missing|unable to read|lazy/i); return true; });
  assert.equal(missing(), true, 'the engine did not fetch the missing blob');
});

test('read policy is revalidated when configuration or attributes change after checkout', async t => {
  const s = sandbox(t);
  const source = s.repo('source', { 'a.txt': 'a\n' });
  const reservation = setupWorktree(s, source);
  await createWorktree(s.policyGit, reservation);
  await assertReadPolicy(s.policyGit, reservation.workspacePath, [reservation.baseline]);
  const sentinel = path.join(s.dir, 'late-filter-ran');
  s.git(source, 'config', 'filter.late.clean', `touch ${sentinel}; cat`);
  await assertReadPolicy(s.policyGit, reservation.workspacePath, [reservation.baseline]);
  fs.writeFileSync(path.join(reservation.workspacePath, '.gitattributes'), 'a.txt filter=late\n');
  await assert.rejects(assertReadPolicy(s.policyGit, reservation.workspacePath, [reservation.baseline]), /filter=late/);
  assert.equal(fs.existsSync(sentinel), false);
});

test('the standard installed LFS driver runs in skip mode and leaves pointers', { skip: !hasLfs && 'git-lfs is not installed' }, async t => {
  const s = sandbox(t);
  fs.appendFileSync(s.globalConfig, '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n');
  const source = s.repo('source', { '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n', 'asset.bin': 'binary payload\n' });
  const pointer = s.git(source, 'cat-file', '-p', 'HEAD:asset.bin');
  assert.match(pointer, /^version https:\/\/git-lfs/);
  const reservation = setupWorktree(s, source);
  assert.deepEqual(await inspectBaseline(s.policyGit, source, reservation.baseline), { paths: 2, lfsPaths: 1 });
  // Remove the local LFS object so a real smudge would have to fetch it.
  fs.rmSync(path.join(source, '.git/lfs/objects'), { recursive: true, force: true });
  await createWorktree(s.policyGit, reservation);
  assert.match(fs.readFileSync(path.join(reservation.workspacePath, 'asset.bin'), 'utf8'), /^version https:\/\/git-lfs/);
});
