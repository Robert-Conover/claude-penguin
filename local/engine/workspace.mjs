// Project identity, naming, persistent engine-owned worktrees, workspace
// validation, and review data. All Git calls go through git-policy.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitError, PolicyError, TIMEOUTS, assertReadPolicy, inspectBaseline, splitNul } from './git-policy.mjs';

export const MAX_PROJECTS = 32;
const MAX_DIFF = 200000;
const MAX_UNTRACKED = 20;
const MAX_FILE = 32000;
const PUFFLE_SUGGESTIONS = ['Atlas', 'Comet', 'Nova', 'Pixel', 'Juniper', 'Echo', 'Maple', 'Orbit', 'Pebble', 'Biscuit', 'Clover', 'Marble',
  'Sprocket', 'Willow', 'Domino', 'Rocket', 'Sunny', 'Quill', 'Basil', 'Indigo', 'Fable', 'Tango', 'Ziggy', 'Bramble', 'Puddle', 'Cosmo',
  'Hazel', 'Mosaic', 'Nimbus', 'Ripple', 'Saffron', 'Topaz'];

function invalid(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

// ---------------------------------------------------------------- naming

const PROJECT_CHARS = /^[A-Za-z0-9 ._-]+$/;
const ALNUM = /[A-Za-z0-9]/;

export function projectNameProblem(name) {
  if (typeof name !== 'string' || !name.length) return 'Enter a project name.';
  if (name.length > 30) return 'Project names can be at most 30 characters.';
  if (!PROJECT_CHARS.test(name)) return 'Project names may use only letters, digits, single spaces, hyphens, underscores, and periods.';
  if (!ALNUM.test(name[0]) || !ALNUM.test(name.at(-1))) return 'Project names must begin and end with a letter or digit.';
  if (name.includes('  ')) return 'Project names cannot contain repeated spaces.';
  return null;
}

export function validateProjectName(name) {
  const problem = projectNameProblem(name);
  if (problem) throw invalid(problem);
  return name;
}

export function defaultProjectName(basename) {
  let name = String(basename ?? '').replace(/[^A-Za-z0-9 ._-]+/g, ' ').replace(/\s+/g, ' ');
  const trimEdges = value => value.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9]+$/, '');
  name = trimEdges(trimEdges(name).slice(0, 30));
  return projectNameProblem(name) ? 'Project' : name;
}

export function validatePuffleName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z]{1,12}$/.test(name)) throw invalid('Puffle names must be 1 to 12 letters (A–Z) with no spaces or digits.');
  return name;
}

export function suggestPuffleName(used = []) {
  const taken = new Set(used.map(name => String(name).toLowerCase()));
  return PUFFLE_SUGGESTIONS.find(name => !taken.has(name.toLowerCase())) ?? null;
}

export function repoFolderName(basename) {
  const name = String(basename ?? '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
  return !name || /^\.+$/.test(name) ? 'repo' : name;
}

export const workerBranch = (projectId, workerId) => `claude-penguin/${projectId}/${workerId}`;

export function shellQuote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }

// ---------------------------------------------------------------- identity

const realpath = value => fs.realpathSync.native(value);

export function samePath(left, right) { return Boolean(left && right) && left === right; }

export function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Identify a non-bare repository with at least one commit by its canonical common directory. */
export async function identifyRepository(git, input) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) throw invalid('Repository path must be absolute.');
  let real;
  try { real = realpath(input); } catch { throw invalid('That repository path does not exist.'); }
  if (!fs.statSync(real).isDirectory()) throw invalid('The repository path must be a folder.');
  let bare;
  try { bare = await git.line(real, ['rev-parse', '--is-bare-repository']); }
  catch { throw invalid('That folder is not inside a Git repository.'); }
  if (bare === 'true') throw invalid('Bare repositories are not supported. Register a checkout with a working tree.');
  const [top, common] = (await git.text(real, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'])).split('\n');
  if (!top || !common) throw invalid('That folder is not inside a Git working tree.');
  const head = await git.raw(real, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { allowExit: [0, 1] });
  if (head.code !== 0) throw invalid('The repository needs at least one commit before a puffle can work in it.');
  return { sourcePath: realpath(top), commonDir: realpath(common), head: head.stdout.toString('utf8').trim() };
}

// ---------------------------------------------------------------- worktree root

export function resolveWorktreeRoot(value = process.env.CP_ENGINE_WORKTREE_ROOT, home = os.homedir()) {
  if (value === undefined || value === '') return path.join(home, '.claude-penguin', 'worktrees');
  if (!path.isAbsolute(value)) throw invalid('CP_ENGINE_WORKTREE_ROOT must be an absolute path.');
  return path.resolve(value);
}

async function enclosingRepository(git, dir) {
  let probe = dir;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const result = await git.raw(probe, ['rev-parse', '--path-format=absolute', '--git-dir'], { allowExit: [0, 128] });
  return result.code === 0 ? result.stdout.toString('utf8').trim() : null;
}

/** Create the root privately and refuse locations inside any Git repository. */
export async function prepareWorktreeRoot(git, root) {
  const before = await enclosingRepository(git, root);
  if (before) throw new PolicyError(`The worktree root ${root} is inside a Git repository (${before}). Worktrees must live outside every checkout so projects do not inherit another repository's instructions. Set CP_ENGINE_WORKTREE_ROOT to a folder outside Git.`);
  const missing = [];
  for (let probe = root; !fs.existsSync(probe); probe = path.dirname(probe)) missing.unshift(probe);
  for (const dir of missing) { try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  const real = realpath(root);
  if (!fs.statSync(real).isDirectory()) throw new PolicyError(`The worktree root is not a folder: ${root}`);
  if (missing.length) fs.chmodSync(real, 0o700);
  const after = await enclosingRepository(git, real);
  if (after) throw new PolicyError(`The worktree root ${real} is inside a Git repository (${after}). Set CP_ENGINE_WORKTREE_ROOT to a folder outside Git.`);
  return real;
}

/** Reserve the private parent `<root>/<worker-id>` and return the canonical leaf path (which must not exist yet). */
export function reserveWorkspacePath(root, workerId, sourcePath) {
  const parent = path.join(root, workerId);
  try { fs.mkdirSync(parent, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const real = realpath(parent);
  if (!fs.lstatSync(real).isDirectory()) throw new PolicyError(`The reserved worker folder is not a folder: ${parent}`);
  fs.chmodSync(real, 0o700);
  return path.join(real, repoFolderName(path.basename(sourcePath)));
}

// ---------------------------------------------------------------- worktrees

export async function listWorktrees(git, cwd) {
  const fields = (await git.raw(cwd, ['worktree', 'list', '--porcelain', '-z'])).stdout.toString('utf8').split('\0');
  const entries = [];
  let current = null;
  for (const field of fields) {
    if (!field) { if (current) entries.push(current); current = null; continue; }
    const space = field.indexOf(' ');
    const key = space < 0 ? field : field.slice(0, space);
    const value = space < 0 ? '' : field.slice(space + 1);
    if (key === 'worktree') { if (current) entries.push(current); current = { path: value }; }
    else if (current) {
      if (key === 'HEAD') current.head = value;
      else if (key === 'branch') current.branch = value;
      else if (key === 'detached') current.detached = true;
      else if (key === 'locked') current.locked = value || true;
      else if (key === 'prunable') current.prunable = value || true;
      else if (key === 'bare') current.bare = true;
    }
  }
  if (current) entries.push(current);
  for (const entry of entries) { try { entry.realPath = realpath(entry.path); } catch { entry.realPath = null; } }
  return entries;
}

async function branchCommit(git, cwd, branch) {
  const result = await git.raw(cwd, ['rev-parse', '-q', '--verify', `refs/heads/${branch}^{commit}`], { allowExit: [0, 1] });
  return result.code === 0 ? result.stdout.toString('utf8').trim() : null;
}

/**
 * Create the reserved worktree, or reconcile a previous attempt that matches
 * the reservation exactly. Conflicting resources are never deleted or adopted.
 */
export async function createWorktree(git, { sourcePath, workspacePath, branch, baseline, workerId, onProgress = () => {} }) {
  const reason = `Claude Penguin worker ${workerId}`;
  const ref = `refs/heads/${branch}`;
  const existing = (await listWorktrees(git, sourcePath)).find(entry => entry.path === workspacePath || entry.realPath === workspacePath);
  if (existing) {
    if (existing.branch !== ref || existing.head !== baseline) throw new PolicyError(`A worktree already exists at ${workspacePath} but does not match this reservation (expected ${branch} at ${baseline.slice(0, 12)}). It was not adopted or removed; inspect it manually.`);
    if (!existing.locked) await git.raw(sourcePath, ['worktree', 'lock', '--reason', reason, workspacePath]);
    onProgress('Reconciled the reserved worktree from an earlier attempt.');
    return { reconciled: true };
  }
  if (fs.existsSync(workspacePath)) throw new PolicyError(`${workspacePath} already exists and is not the reserved worktree. It was not adopted or removed; move it aside, then retry.`);
  const branchHead = await branchCommit(git, sourcePath, branch);
  if (branchHead && branchHead !== baseline) throw new PolicyError(`Branch ${branch} already exists at a different commit. It was not reset; inspect it manually.`);
  onProgress('Inspecting baseline attributes and filters.');
  await inspectBaseline(git, sourcePath, baseline);
  onProgress('Checking out the worktree.');
  const args = branchHead
    ? ['worktree', 'add', '--lock', '--reason', reason, workspacePath, branch]
    : ['worktree', 'add', '--no-track', '--lock', '--reason', reason, '-b', branch, workspacePath, baseline];
  await git.raw(sourcePath, args, { timeout: TIMEOUTS.worktree, maxBuffer: 4 * 1024 * 1024 });
  return { reconciled: Boolean(branchHead) };
}

/** Hard failures need repair; warnings permit operation. Never falls back to the source checkout. */
export async function inspectWorkspace(git, { commonDir }, workspace) {
  const result = { repair: null, warnings: [], branch: null, head: null, locked: false, descendsFromBaseline: null };
  const repair = message => { result.repair = message; return result; };
  if (!workspace?.path) return repair('This worker has no recorded worktree.');
  let real;
  try { real = realpath(workspace.path); } catch { return repair(`The worktree folder is missing: ${workspace.path}`); }
  let top, common;
  try { [top, common] = (await git.text(real, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'])).split('\n'); }
  catch { return repair(`The worktree folder is no longer a Git checkout: ${workspace.path}`); }
  try { top = realpath(top); common = realpath(common); } catch { return repair('The worktree Git metadata cannot be resolved.'); }
  if (top !== workspace.path || real !== workspace.path) return repair(`The worktree's Git top level (${top}) differs from the recorded path.`);
  if (common !== commonDir) return repair('The worktree now belongs to a different repository.');
  const entry = (await listWorktrees(git, real)).find(item => item.realPath === workspace.path);
  if (!entry) return repair('Git no longer lists this worktree. It may have been pruned or moved.');
  const base = await git.raw(real, ['cat-file', '-e', `${workspace.baseCommit}^{commit}`], { allowExit: [0, 1, 128] });
  if (base.code !== 0) return repair(`The baseline commit ${workspace.baseCommit.slice(0, 12)} is unavailable in this repository.`);
  result.head = entry.head ?? null;
  result.branch = entry.branch?.replace(/^refs\/heads\//, '') ?? null;
  result.locked = Boolean(entry.locked);
  if (entry.detached || !entry.branch) result.warnings.push({ code: 'detached', message: 'HEAD is detached in this worktree.' });
  else if (result.branch !== workspace.branch) result.warnings.push({ code: 'branch', message: `The worktree is on ${result.branch}, not ${workspace.branch}.` });
  if (!entry.locked) result.warnings.push({ code: 'unlocked', message: 'The worktree is unlocked, so ordinary Git pruning could remove it.' });
  if (result.head) {
    const ancestor = await git.raw(real, ['merge-base', '--is-ancestor', workspace.baseCommit, result.head], { allowExit: [0, 1] });
    result.descendsFromBaseline = ancestor.code === 0;
    if (!result.descendsFromBaseline) result.warnings.push({ code: 'history', message: 'HEAD no longer descends from the baseline. Review still compares against the original baseline.' });
  }
  return result;
}

export async function sourceDirty(git, sourcePath) {
  await assertReadPolicy(git, sourcePath);
  const status = await git.raw(sourcePath, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all'], { timeout: TIMEOUTS.status, maxBuffer: 64 * 1024 * 1024 });
  return status.stdout.length > 0;
}

function previewUntracked(root, names) {
  const untracked = [];
  for (const name of names.slice(0, MAX_UNTRACKED)) {
    const full = path.resolve(root, name);
    const item = { path: name };
    untracked.push(item);
    try {
      const stats = fs.lstatSync(full);
      if (!stats.isFile() || !inside(root, realpath(full))) { item.skipped = 'Not a regular file inside this worktree.'; continue; }
      item.size = stats.size;
      const fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.dev !== stats.dev || opened.ino !== stats.ino) { item.skipped = 'File changed while opening it; request changes again.'; continue; }
        const bytes = Buffer.alloc(Math.min(stats.size, MAX_FILE));
        const prefix = bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, 0));
        if (prefix.includes(0)) item.skipped = 'Binary file.';
        else item.content = prefix.toString('utf8');
        item.truncated = stats.size > MAX_FILE;
      } finally { fs.closeSync(fd); }
    } catch (error) { item.skipped = `Unavailable: ${error.code ?? 'read error'}`; }
  }
  return untracked;
}

/** Cumulative committed and uncommitted changes since the immutable baseline. */
export async function reviewWorkspace(git, { sourcePath, workspace, inspection }) {
  const cwd = workspace.path;
  await assertReadPolicy(git, cwd, [workspace.baseCommit]);
  const diffResult = await git.raw(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', workspace.baseCommit, '--'],
    { timeout: TIMEOUTS.diff, maxBuffer: MAX_DIFF, truncate: true });
  const status = (await git.raw(cwd, ['status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=dirty'],
    { timeout: TIMEOUTS.status, maxBuffer: MAX_DIFF, truncate: true }));
  const names = splitNul((await git.raw(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], { timeout: TIMEOUTS.status, maxBuffer: 16 * 1024 * 1024 })).stdout);
  let mergeBase = null;
  if (inspection.head) {
    const result = await git.raw(cwd, ['merge-base', workspace.baseCommit, inspection.head], { allowExit: [0, 1] });
    mergeBase = result.code === 0 ? result.stdout.toString('utf8').trim() : null;
  }
  let commitsSinceBaseline = null;
  if (inspection.descendsFromBaseline) commitsSinceBaseline = Number(await git.line(cwd, ['rev-list', '--count', `${workspace.baseCommit}..${inspection.head}`]));
  return {
    diff: diffResult.stdout.toString('utf8'), status: status.stdout.toString('utf8'), untracked: previewUntracked(cwd, names),
    truncated: diffResult.truncated || status.truncated || names.length > MAX_UNTRACKED,
    sourcePath, worktreePath: cwd, branch: inspection.branch, expectedBranch: workspace.branch,
    baseCommit: workspace.baseCommit, head: inspection.head, mergeBase, sharedHistory: Boolean(mergeBase),
    commitsSinceBaseline, dirty: status.stdout.length > 0 || names.length > 0, warnings: inspection.warnings,
    sourceDirtyAtCreation: Boolean(workspace.sourceDirtyAtCreation),
    note: 'Changes since the baseline recorded when this worktree was created. External Git operations do not move the baseline; stop the session before manipulating this branch outside Claude Penguin.',
  };
}

export { GitError, PolicyError };
