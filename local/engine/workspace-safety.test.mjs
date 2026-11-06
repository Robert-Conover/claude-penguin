import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorktree, inspectWorkspace, listWorktrees, prepareWorktreeRoot, reviewWorkspace } from './workspace.mjs';
import { sandbox } from './testing.mjs';

/** A source repository with one engine worktree at `<sandbox>/root/leaf`. */
async function worktree(s, files) {
  const source = s.repo('source', files);
  const baseline = s.git(source, 'rev-parse', 'HEAD').trim();
  fs.mkdirSync(path.join(s.dir, 'root'), { recursive: true });
  const reservation = { sourcePath: source, workspacePath: path.join(s.dir, 'root', 'leaf'), branch: 'claude-penguin/p/w', baseline, workerId: 'w' };
  await createWorktree(s.policyGit, reservation);
  const admin = s.git(reservation.workspacePath, 'rev-parse', '--path-format=absolute', '--git-dir').trim();
  return { source, reservation, admin, project: { sourcePath: source, commonDir: fs.realpathSync.native(path.join(source, '.git')) },
    workspace: { path: reservation.workspacePath, baseCommit: baseline, branch: reservation.branch } };
}

async function review(s, w) {
  const inspection = await inspectWorkspace(s.policyGit, w.project, w.workspace);
  assert.equal(inspection.repair, null);
  return reviewWorkspace(s.policyGit, { sourcePath: w.source, workspace: w.workspace, inspection });
}

test('a retry refuses an interrupted checkout instead of adopting it, and removes nothing', async t => {
  const interruptions = {
    'missing index': w => fs.rmSync(path.join(w.admin, 'index')),
    'stale index.lock': w => fs.writeFileSync(path.join(w.admin, 'index.lock'), ''),
    'unfilled tracked files': w => fs.rmSync(path.join(w.workspace.path, 'b', 'two.txt')),
  };
  for (const [name, interrupt] of Object.entries(interruptions)) {
    const s = sandbox(t);
    const w = await worktree(s, { 'a/one.txt': 'one\n', 'b/two.txt': 'two\n' });
    interrupt(w);
    await assert.rejects(createWorktree(s.policyGit, w.reservation), error => {
      assert.match(error.message, /incomplete[^]*not adopted or removed/, name);
      assert.match(error.message, /worktree remove --force --force/, `${name}: manual guidance`);
      return true;
    });
    assert.equal(fs.existsSync(path.join(w.workspace.path, 'a', 'one.txt')), true, `${name}: the folder is kept`);
    assert.equal(fs.existsSync(w.admin), true, `${name}: Git's worktree metadata is kept`);
    assert.ok((await listWorktrees(s.policyGit, w.source)).some(entry => entry.realPath === w.workspace.path), `${name}: still registered`);
    // The suggested manual cleanup, then a retry, produces a complete worktree on the kept branch.
    s.git(w.source, 'worktree', 'remove', '--force', '--force', w.workspace.path);
    assert.deepEqual(await createWorktree(s.policyGit, w.reservation), { reconciled: true }, `${name}: retry after cleanup`);
    assert.equal(fs.readFileSync(path.join(w.workspace.path, 'b', 'two.txt'), 'utf8'), 'two\n');
    assert.equal(s.git(w.workspace.path, 'status', '--porcelain').trim(), '', `${name}: the new checkout is clean`);
  }
  const s = sandbox(t);
  const w = await worktree(s);
  assert.deepEqual(await createWorktree(s.policyGit, w.reservation), { reconciled: true }, 'a complete checkout is still adopted');
});

test('untracked previews skip links, FIFOs, and binaries, cap file size, and show at most 20 files', async t => {
  const s = sandbox(t);
  const w = await worktree(s);
  const cwd = w.workspace.path;
  const secret = path.join(s.dir, 'outside-secret.txt');
  fs.writeFileSync(secret, 'OUTSIDE-SECRET-CONTENT\n');
  fs.symlinkSync(secret, path.join(cwd, 'a-symlink.txt'));
  fs.linkSync(secret, path.join(cwd, 'a-hardlink.txt'));
  execFileSync('mkfifo', [path.join(cwd, 'a-fifo')]);
  fs.writeFileSync(path.join(cwd, 'a-binary.bin'), Buffer.from([0x50, 0x00, 0x4e, 0x47]));
  fs.writeFileSync(path.join(cwd, 'a-big.txt'), 'x'.repeat(40000));
  fs.writeFileSync(path.join(cwd, 'a-text.txt'), 'plain\n');
  for (let index = 0; index < 25; index++) fs.writeFileSync(path.join(cwd, `z-${String(index).padStart(2, '0')}.txt`), `${index}\n`);
  const changes = await review(s, w);
  const byPath = Object.fromEntries(changes.untracked.map(item => [item.path, item]));
  assert.equal(changes.untracked.length, 20);
  assert.equal(changes.truncated, true, 'more than 20 untracked files marks the review truncated');
  assert.match(byPath['a-symlink.txt'].skipped, /Not a regular file/);
  assert.match(byPath['a-hardlink.txt'].skipped ?? '', /hard link/i);
  assert.equal(changes.untrackedListed, 30, 'the FIFO is not listed by Git');
  assert.equal(changes.untrackedListTruncated, false);
  assert.equal(byPath['a-fifo']?.content, undefined, 'a FIFO is never read');
  assert.equal(byPath['a-binary.bin'].skipped, 'Binary file.');
  assert.equal(byPath['a-big.txt'].content.length, 32000);
  assert.equal(byPath['a-big.txt'].truncated, true);
  assert.equal(byPath['a-text.txt'].content, 'plain\n');
  assert.equal(JSON.stringify(changes).includes('OUTSIDE-SECRET-CONTENT'), false, 'nothing outside the worktree is previewed');
});

test('a very large untracked tree truncates the listing instead of failing review', async t => {
  const s = sandbox(t);
  const w = await worktree(s);
  // 24,000 paths of about 780 bytes each: more than 16 MiB of `ls-files -z` output (within macOS PATH_MAX).
  const segment = letter => letter.repeat(200);
  let count = 0;
  for (let dir = 0; dir < 48; dir++) {
    const leaf = path.join(w.workspace.path, 'node_modules', segment('a'), `${dir}-${segment('b')}`, segment('c'));
    fs.mkdirSync(leaf, { recursive: true });
    for (let file = 0; file < 500; file++, count++) fs.writeFileSync(path.join(leaf, `${file}-${'d'.repeat(150)}.js`), '');
  }
  const changes = await review(s, w);
  assert.equal(changes.truncated, true);
  assert.equal(changes.untrackedListTruncated, true);
  assert.ok(changes.untrackedListed > 0 && changes.untrackedListed < count, `listed ${changes.untrackedListed} of ${count}`);
  assert.equal(changes.untracked.length, 20);
  assert.equal(changes.dirty, true);
  for (const item of changes.untracked) assert.match(item.path, /^node_modules\/a{200}\/\d+-b{200}\/c{200}\/\d+-d{150}\.js$/, 'no partial entry is kept');
});

test('diff.external, diff driver commands, and textconv never run during review', async t => {
  const s = sandbox(t);
  const w = await worktree(s, { '.gitattributes': '*.txt diff=probe\n', 'a.txt': 'a\n' });
  const marks = ['external', 'command', 'textconv'].map(name => path.join(s.dir, `${name}-ran`));
  s.git(w.source, 'config', 'diff.external', `sh -c 'touch ${marks[0]}'`);
  s.git(w.source, 'config', 'diff.probe.command', `sh -c 'touch ${marks[1]}'`);
  s.git(w.source, 'config', 'diff.probe.textconv', `sh -c 'touch ${marks[2]}; cat "$1"' --`);
  fs.writeFileSync(path.join(w.workspace.path, 'a.txt'), 'changed\n');
  const changes = await review(s, w);
  assert.match(changes.diff, /\+changed/);
  assert.deepEqual(marks.map(mark => fs.existsSync(mark)), [false, false, false]);
});

test('a worktree root Git cannot classify (a stale or malformed .git file above it) is refused', async t => {
  const s = sandbox(t);
  for (const [name, contents] of [['stale', 'gitdir: /nonexistent/.git/worktrees/gone\n'], ['malformed', 'not a gitfile\n']]) {
    const host = path.join(s.dir, name);
    fs.mkdirSync(host);
    fs.writeFileSync(path.join(host, '.git'), contents);
    await assert.rejects(prepareWorktreeRoot(s.policyGit, path.join(host, 'worktrees')), /could not confirm[^]*outside every Git repository/, name);
    assert.equal(fs.existsSync(path.join(host, 'worktrees')), false, `${name}: nothing is created`);
  }
  assert.equal(await prepareWorktreeRoot(s.policyGit, path.join(s.dir, 'plain', 'worktrees')), path.join(s.dir, 'plain', 'worktrees'));
});

test('hard workspace failures include manual repair guidance that works', async t => {
  const s = sandbox(t);
  const w = await worktree(s);
  const dotGit = path.join(w.workspace.path, '.git');
  fs.rmSync(dotGit);
  let inspection = await inspectWorkspace(s.policyGit, w.project, w.workspace);
  assert.match(inspection.repair, /no longer a Git checkout/);
  assert.match(inspection.repair, /git -C '[^']+' worktree repair '[^']+'/);
  assert.match(inspection.repair, /does not repair worktrees automatically/);
  assert.equal(fs.existsSync(dotGit), false, 'inspection changes nothing');
  // Git 2.54 rewrites the missing .git file but still exits 1 after reporting it as broken.
  try { s.git(w.source, 'worktree', 'repair', w.workspace.path); } catch (error) { assert.match(error.stderr, /\.git file broken/); }
  assert.equal((await inspectWorkspace(s.policyGit, w.project, w.workspace)).repair, null, 'the suggested command repairs it');

  fs.writeFileSync(path.join(w.admin, 'gitdir'), '/elsewhere/.git\n');
  inspection = await inspectWorkspace(s.policyGit, w.project, w.workspace);
  assert.match(inspection.repair, /no longer lists this worktree/);
  assert.match(inspection.repair, /git -C '[^']+' worktree repair '[^']+'/);
  s.git(w.source, 'worktree', 'repair', w.workspace.path);
  assert.equal((await inspectWorkspace(s.policyGit, w.project, w.workspace)).repair, null, 'the suggested command repairs it');
});
