import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { assertGitVersion, assertReadPolicy, createGit, ensureEmptyHooksDir, inspectBaseline, parseGitVersion } from './git-policy.mjs';
import { createWorktree, listWorktrees } from './workspace.mjs';
import { sandbox } from './testing.mjs';

const hasLfs = (() => { try { execFileSync('git-lfs', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Set inherited variables for one test, as if the engine had been started with them. */
function inheritEnv(t, values) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

/** A tree in `repo` whose only file is a .gitattributes assigning `filter=<driver>` to every path. */
function attributesTree(s, repo, driver) {
  const file = path.join(s.dir, `${driver}-attributes`);
  fs.writeFileSync(file, `* filter=${driver}\n`);
  const blob = s.git(repo, 'hash-object', '-w', file).trim();
  return execFileSync('git', ['mktree'], { cwd: repo, env: s.env, input: `100644 blob ${blob}\t.gitattributes\n`, encoding: 'utf8' }).trim();
}

/** A stand-in Git binary: a shell script that ignores its arguments. */
function fakeBinary(s, name, body) {
  const file = path.join(s.dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

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
  await assert.rejects(createWorktree(other.policyGit, setupWorktree(other, repo)), /cannot establish the effective hook and filter policy/);
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

test('config-defined hooks are refused before anything is created and on later policy checks', async t => {
  for (const event of ['post-checkout', 'reference-transaction']) {
    const s = sandbox(t);
    const source = s.repo('source');
    const sentinel = path.join(s.dir, `${event}-ran`);
    s.git(source, 'config', 'hook.probe.event', event);
    s.git(source, 'config', 'hook.probe.command', `touch ${sentinel}`);
    const reservation = setupWorktree(s, source);
    await assert.rejects(createWorktree(s.policyGit, reservation), /hook\.probe\.(command|event)[^]*core\.hooksPath does not disable/);
    assert.equal(fs.existsSync(sentinel), false, `${event} config hook must not run`);
    assert.equal(fs.existsSync(reservation.workspacePath), false);
    assert.equal(s.git(source, 'branch', '--list', reservation.branch).trim(), '', 'no branch is created after a policy refusal');
  }

  const s = sandbox(t);
  const source = s.repo('source');
  const reservation = setupWorktree(s, source);
  await createWorktree(s.policyGit, reservation);
  fs.appendFileSync(s.globalConfig, `[hook "late"]\n\tevent = post-index-change\n\tcommand = touch ${path.join(s.dir, 'late-ran')}\n`);
  await assert.rejects(assertReadPolicy(s.policyGit, reservation.workspacePath, [reservation.baseline]), /hook\.late\.(command|event)/);

  // A conditional include that matches only in the engine worktree (its branch) must not add hooks either.
  const other = sandbox(t);
  const repo = other.repo('source');
  const included = path.join(other.dir, 'branch-only.gitconfig');
  fs.writeFileSync(included, `[hook "branchonly"]\n\tevent = post-checkout\n\tcommand = touch ${path.join(other.dir, 'branch-hook-ran')}\n`);
  fs.appendFileSync(other.globalConfig, `[includeIf "onbranch:claude-penguin/**"]\n\tpath = ${included}\n`);
  await assert.rejects(createWorktree(other.policyGit, setupWorktree(other, repo)), /changes Git hook, filter, or attribute settings/);
  assert.equal(fs.existsSync(path.join(other.dir, 'branch-hook-ran')), false);
});

test('attr.tree is refused because checkout would read attributes the baseline check never saw', async t => {
  const s = sandbox(t);
  const source = s.repo('source', { 'a.txt': 'a\n' });
  s.git(source, 'update-ref', 'refs/probe/attrs', attributesTree(s, source, 'evil'));
  const sentinel = path.join(s.dir, 'attr-tree-smudge-ran');
  s.git(source, 'config', 'attr.tree', 'refs/probe/attrs');
  s.git(source, 'config', 'filter.evil.smudge', `touch ${sentinel}; cat`);
  const reservation = setupWorktree(s, source);
  await assert.rejects(createWorktree(s.policyGit, reservation), /attr\.tree/);
  assert.equal(fs.existsSync(sentinel), false, 'the attr.tree filter must not run');
  assert.equal(fs.existsSync(reservation.workspacePath), false);

  const other = sandbox(t);
  const repo = other.repo('source');
  const included = path.join(other.dir, 'attr-tree.gitconfig');
  fs.writeFileSync(included, '[attr]\n\ttree = HEAD\n');
  fs.appendFileSync(other.globalConfig, `[includeIf "onbranch:claude-penguin/**"]\n\tpath = ${included}\n`);
  await assert.rejects(createWorktree(other.policyGit, setupWorktree(other, repo)), /changes Git hook, filter, or attribute settings/);
});

test('every inherited GIT_* variable is stripped; only the explicit gitEnv and policy variables reach Git', async t => {
  const s = sandbox(t);
  const source = s.repo('source', { '.gitattributes': '*.txt filter=custom\n', 'a.txt': 'a\n' });
  const sentinel = path.join(s.dir, 'smudge-ran');
  s.git(source, 'config', 'filter.custom.smudge', `touch ${sentinel}; cat`);
  const emptyConfig = path.join(s.dir, 'empty.gitconfig');
  fs.writeFileSync(emptyConfig, '');
  const elsewhere = s.repo('elsewhere');
  const inherited = { GIT_DIR: path.join(elsewhere, '.git'), GIT_WORK_TREE: elsewhere, GIT_CONFIG: emptyConfig, GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_PARAMETERS: "'core.hookspath'='/tmp'", GIT_ATTR_SOURCE: 'HEAD', GIT_ALLOW_PROTOCOL: 'file', GIT_SOME_FUTURE_SETTING: '1' };
  inheritEnv(t, inherited);
  const git = createGit({ hooksDir: path.join(s.dir, 'empty-hooks'), env: s.gitEnv });
  const policyKeys = ['GIT_NO_LAZY_FETCH', 'GIT_LFS_SKIP_SMUDGE', 'GIT_TERMINAL_PROMPT', 'GIT_OPTIONAL_LOCKS', 'GIT_ASKPASS', 'GIT_PAGER', 'GIT_EDITOR'];
  assert.deepEqual(Object.keys(git.env).filter(key => key.startsWith('GIT_')).sort(), [...policyKeys, ...Object.keys(s.gitEnv)].sort());
  assert.equal(git.env.GIT_CONFIG_GLOBAL, s.globalConfig, 'the explicit gitEnv wins over the parent environment');
  // With GIT_CONFIG inherited, `git config` would read only the empty file and miss the custom driver.
  await assert.rejects(createWorktree(git, setupWorktree(s, source)), /filter=custom/);
  assert.equal(fs.existsSync(sentinel), false);
});

test('an inherited GIT_ATTR_SOURCE cannot make checkout use attributes the baseline check never saw', async t => {
  const s = sandbox(t);
  const source = s.repo('source', { 'a.txt': 'a\n' });
  const sentinel = path.join(s.dir, 'attr-source-smudge-ran');
  s.git(source, 'config', 'filter.evil.smudge', `touch ${sentinel}; cat`);
  inheritEnv(t, { GIT_ATTR_SOURCE: attributesTree(s, source, 'evil') });
  const git = createGit({ hooksDir: path.join(s.dir, 'empty-hooks'), env: s.gitEnv });
  await createWorktree(git, setupWorktree(s, source)).catch(() => {});
  assert.equal(fs.existsSync(sentinel), false, 'the filter named only by GIT_ATTR_SOURCE must not run');
});

test('transports stay disabled even when user configuration or the environment allows a protocol', async t => {
  const s = sandbox(t);
  const upstream = s.repo('upstream');
  // The sandbox's global configuration sets protocol.file.allow=always.
  assert.match(s.git(s.dir, 'ls-remote', `file://${upstream}`), /refs\/heads\/dev/, 'the fixture itself allows file://');
  await assert.rejects(s.policyGit.raw(s.dir, ['ls-remote', `file://${upstream}`]), /transport 'file' not allowed/);
  inheritEnv(t, { GIT_ALLOW_PROTOCOL: 'file' });
  const git = createGit({ hooksDir: path.join(s.dir, 'empty-hooks'), env: s.gitEnv });
  await assert.rejects(git.raw(s.dir, ['ls-remote', `file://${upstream}`]), /transport 'file' not allowed/);
});

test('a repository alias named lfs never runs when git-lfs is missing from PATH', async t => {
  const s = sandbox(t);
  const source = s.repo('source', { '.gitattributes': '*.bin filter=lfs\n', 'a.bin': 'data\n' });
  const sentinel = path.join(s.dir, 'alias-ran');
  s.git(source, 'config', 'filter.lfs.clean', 'git-lfs clean -- %f');
  s.git(source, 'config', 'filter.lfs.smudge', 'git-lfs smudge -- %f');
  s.git(source, 'config', 'filter.lfs.process', 'git-lfs filter-process');
  s.git(source, 'config', 'alias.lfs', '!echo ran > "$CP_ALIAS_SENTINEL"; echo git-lfs/3.9.9');
  // Keep the fixture's Git, but exclude all installed helpers from both search paths.
  const binary = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const emptyBin = path.join(s.dir, 'empty-bin');
  fs.mkdirSync(emptyBin);
  const env = { ...s.gitEnv, PATH: emptyBin, GIT_EXEC_PATH: emptyBin, CP_ALIAS_SENTINEL: sentinel };
  const git = createGit({ hooksDir: path.join(s.dir, 'empty-hooks'), binary, env });
  await assert.rejects(createWorktree(git, setupWorktree(s, source)), /Unsupported Git filter command[^]*filter=lfs/);
  assert.equal(fs.existsSync(sentinel), false, 'the repository alias must not execute');
});

test('a timeout stops the whole Git process group, not only the direct child', async t => {
  const s = sandbox(t);
  const sentinel = path.join(s.dir, 'grandchild-survived');
  const binary = fakeBinary(s, 'slow-git', '(sleep 1; touch "$CP_TEST_SENTINEL") &\nexec sleep 5');
  const git = createGit({ hooksDir: path.join(s.dir, 'empty-hooks'), env: { CP_TEST_SENTINEL: sentinel }, binary });
  await assert.rejects(git.raw(s.dir, ['worktree'], { timeout: 300 }), /timed out/);
  await pause(1500);
  assert.equal(fs.existsSync(sentinel), false, 'the checkout child must not continue as an orphan');
});

test('a normal Git exit leaves no process from its group behind', async t => {
  const s = sandbox(t);
  const sentinel = path.join(s.dir, 'straggler-survived');
  const binary = fakeBinary(s, 'quick-git', '(sleep 1; touch "$CP_TEST_SENTINEL") </dev/null >/dev/null 2>&1 &\nexit 0');
  const git = createGit({ hooksDir: path.join(s.dir, 'empty-hooks'), env: { CP_TEST_SENTINEL: sentinel }, binary });
  await git.raw(s.dir, ['status']);
  await pause(1500);
  assert.equal(fs.existsSync(sentinel), false);
});

test('engine exit stops running Git process groups', async t => {
  const s = sandbox(t);
  const sentinel = path.join(s.dir, 'orphan-survived');
  const binary = fakeBinary(s, 'slow-git', '(sleep 1; touch "$CP_TEST_SENTINEL") &\nexec sleep 5');
  const started = path.join(s.dir, 'started');
  const script = `import fs from 'node:fs'; import { createGit } from ${JSON.stringify(new URL('./git-policy.mjs', import.meta.url).href)};
    const git = createGit({ hooksDir: ${JSON.stringify(path.join(s.dir, 'empty-hooks'))}, env: { CP_TEST_SENTINEL: ${JSON.stringify(sentinel)} }, binary: ${JSON.stringify(binary)} });
    git.raw(${JSON.stringify(s.dir)}, ['worktree'], { timeout: 60000 }).catch(() => {});
    setTimeout(() => { fs.writeFileSync(${JSON.stringify(started)}, ''); process.exit(0); }, 300);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
  await new Promise(resolve => child.on('close', resolve));
  assert.equal(fs.existsSync(started), true, 'the engine stand-in reached its exit');
  await pause(1500);
  assert.equal(fs.existsSync(sentinel), false, 'Git children must not outlive the engine');
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
