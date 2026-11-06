// Shared fixtures for engine tests: isolated Git configuration, disposable
// repositories, and fake PTYs. No media, Docker, or Claude credentials needed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGit } from './git-policy.mjs';
import { ProvisionError } from './game.mjs';

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

/**
 * An in-memory stand-in for createGameProvisioner (game.mjs) that mirrors the
 * provisioning service and the owned p#cpadopt handler: marked owners, a
 * recorded ID that is only verified and never recreated (MISSING), usernames
 * held by any account (USERNAME_TAKEN), locked empty igloos, verification of
 * the exact recorded puffle set, and adoption receipts. `db.visitorId = null`
 * means no visitor account exists; `db.taken` holds usernames of other
 * accounts. `fake.fail[op]` (a function or ProvisionError) injects one
 * failure; `fake.before[op]` runs a check at call time. `fake.purchase` plays
 * the visitor's purchase against the game, as the browser overlay would.
 */
export function fakeGame({ visitorId = 107, filtered = ['Badword'], visitorUsername = 'bridgecheck', coins = 5000 } = {}) {
  const db = { visitorId, nextVisitor: 300, owners: [], nextOwner: 201, nextIgloo: 9, nextPuffle: 31, taken: new Set(),
    filtered: new Set(filtered.map(name => name.toLowerCase())), receipts: [], coins, online: new Set() };
  const calls = [];
  const fake = { db, calls, fail: {}, before: {}, visitorUsername };
  const title = name => name.slice(0, 1).toUpperCase() + name.slice(1).toLowerCase();
  const prices = { 1006: 800, 1007: 800 };
  const catalog = new Map([...Array.from({ length: 10 }, (_, type) => [`${type}/0`, type]), ['0/1006', 1006], ['8/1007', 1007]]);
  async function step(op, args) {
    calls.push([op, args]);
    await fake.before[op]?.(args);
    const failure = fake.fail[op];
    if (failure) { delete fake.fail[op]; throw typeof failure === 'function' ? failure(args) : failure; }
  }
  fake.ensureVisitor = async (args = {}) => {
    await step('visitor', args);
    const recorded = args.penguinId ?? null;
    if (recorded !== null) {
      if (db.visitorId === null) throw new ProvisionError(`No ${visitorUsername} account exists.`, 'MISSING');
      if (db.visitorId !== recorded) throw new ProvisionError(`The ${visitorUsername} visitor has game ID ${db.visitorId}, not the recorded ${recorded}. Refusing to remap it; repair the visitor record explicitly.`, 'MISMATCH');
      return { penguinId: recorded, username: visitorUsername, created: false };
    }
    const created = db.visitorId === null;
    if (created) db.visitorId = db.nextVisitor++;
    return { penguinId: db.visitorId, username: visitorUsername, created };
  };
  fake.ensureOwner = async args => {
    await step('owner', args);
    const marked = db.owners.filter(item => item.marker === args.marker);
    if (marked.length > 1) throw new ProvisionError('Several accounts carry this marker.', 'MISMATCH');
    let [owner] = marked;
    if (owner) {
      if (owner.username !== args.username) throw new ProvisionError('marker mismatch', 'MISMATCH');
      if (args.ownerId && owner.ownerId !== args.ownerId) throw new ProvisionError(`The marked owner has game ID ${owner.ownerId}, not the recorded ${args.ownerId}. Nothing was remapped.`, 'MISMATCH');
      return { ownerId: owner.ownerId, created: false };
    }
    if (args.ownerId) throw new ProvisionError(`Game ID ${args.ownerId} no longer carries this project's ownership marker.`, 'MISSING');
    if (db.taken.has(args.username) || db.owners.some(item => item.username === args.username)) throw new ProvisionError('taken', 'USERNAME_TAKEN');
    owner = { ...args, ownerId: db.nextOwner++, iglooId: null, pets: [], locked: true };
    db.owners.push(owner);
    return { ownerId: owner.ownerId, created: true };
  };
  fake.prepareIgloo = async args => {
    await step('igloo', args);
    const owner = db.owners.find(item => item.ownerId === args.ownerId && item.username === args.username && item.password === args.password);
    if (!owner) throw new ProvisionError('The managed credentials logged in as a different penguin.', 'MISMATCH');
    db.online.add(owner.ownerId);
    try {
      owner.iglooId ??= db.nextIgloo++;
      if (args.recorded?.iglooId && args.recorded.iglooId !== owner.iglooId) throw new ProvisionError('The managed owner\'s active igloo changed from the recorded layout.', 'MISMATCH');
      return { iglooId: owner.iglooId, roomId: owner.ownerId + 2000 };
    } finally { db.online.delete(owner.ownerId); }
  };
  fake.verifyOwners = async mappings => {
    await step('verify', mappings);
    return mappings.map(mapping => {
      const owner = db.owners.find(item => item.marker === mapping.marker);
      const problems = [];
      if (!owner || owner.ownerId !== mapping.ownerId || owner.iglooId !== mapping.iglooId || !owner.locked) problems.push('The managed mapping changed.');
      const recorded = new Map((mapping.puffles ?? []).map(item => [item.puffleId, item]));
      for (const [id, item] of recorded) {
        const pet = owner?.pets.find(entry => entry.id === id);
        if (!pet || pet.name !== item.name || pet.puffleType !== item.puffleType || pet.backyard) problems.push(`Recorded puffle ${id} changed.`);
      }
      const unrecorded = (owner?.pets ?? []).filter(pet => !recorded.has(pet.id))
        .map(pet => ({ puffleId: pet.id, adoptionId: db.receipts.find(item => item.puffleId === pet.id)?.adoptionId ?? null }));
      if (unrecorded.length) problems.push('The owner has puffles this project has not recorded.');
      return { key: mapping.key, ok: !problems.length, problems, unrecorded };
    });
  };
  fake.readReceipts = async ids => {
    await step('receipts', ids);
    return db.receipts.filter(item => ids.includes(item.adoptionId)).map(item => ({ ...item }));
  };
  /**
   * The visitor's purchase as the world server handles it: `published` is the
   * engine's current publication. Returns the overlay's reply shape.
   */
  fake.purchase = (published, { adoptionId, typeId, subtypeId = 0, name }) => {
    const reservation = published?.adoptions?.find(item => item.adoptionId === adoptionId);
    const stored = db.receipts.find(item => item.adoptionId === adoptionId);
    if (!reservation) return { ok: false, code: 'unknown-adoption' };
    const puffleType = catalog.get(`${typeId}/${subtypeId}`);
    if (puffleType === undefined) return { ok: false, code: 'unknown-puffle' };
    if (!/^[A-Za-z]{1,12}$/.test(name) || db.filtered.has(name.toLowerCase())) return { ok: false, code: '441' };
    const owner = db.owners.find(item => item.ownerId === reservation.ownerId);
    const reply = receipt => ({ ok: true, adoptionId, puffleId: receipt.puffleId, typeId, subtypeId, name: receipt.name, coins: db.coins, cost: receipt.cost, createdAt: receipt.createdAt, ownerId: receipt.ownerId });
    if (stored) {
      if (stored.ownerId !== owner.ownerId || stored.puffleType !== puffleType || stored.name !== title(name)) return { ok: false, code: 'conflict' };
      return reply(stored);
    }
    if (reservation.expiresAt * 1000 <= Date.now()) return { ok: false, code: 'expired' };
    if (db.online.has(owner.ownerId)) return { ok: false, code: 'owner-online' };
    const cost = prices[puffleType] ?? 400;
    if (db.coins < cost) return { ok: false, code: '401' };
    if (owner.pets.filter(pet => !pet.backyard).length >= 10) return { ok: false, code: '440' };
    db.coins -= cost;
    const pet = { id: db.nextPuffle++, name: title(name), puffleType, backyard: false };
    owner.pets.push(pet);
    const receipt = { adoptionId, visitorId: db.visitorId, ownerId: owner.ownerId, puffleId: pet.id, puffleType, name: pet.name, cost, coinsAfter: db.coins, createdAt: Math.floor(Date.now() / 1000) };
    db.receipts.push(receipt);
    return reply(receipt);
  };
  fake.close = () => { fake.closed = true; };
  return fake;
}

/** A publisher that records the last payload, for tests that play purchases. */
export function memoryPublisher() {
  const publisher = { payload: null, updates: 0, closed: false };
  publisher.update = payload => { publisher.payload = structuredClone(payload); publisher.updates++; return true; };
  publisher.close = () => { publisher.closed = true; };
  return publisher;
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
export function legacyState(sourcePath, { baseCommit = 'dc4eefbdb2af3038c1298490e06538096444e4b8' } = {}) {
  return { version: 1, revision: 79,
    projects: [{ id: 'e7c554c7-88e3-4c1f-9125-3261283a4393', name: 'Puffle Test', path: sourcePath, fixtureId: 'bridge-alpha',
      createdAt: '2026-11-03T21:43:40.950Z', ownerId: 105, iglooId: 4, roomId: 2105, puffleId: 4 }],
    workers: [{ id: '34a60f4a-0c2b-4ab8-af20-c3156de19ffd', projectId: 'e7c554c7-88e3-4c1f-9125-3261283a4393', name: 'Atlas',
      sessionId: 'c6b60407-ead8-4488-b8cb-281936dca777', status: 'interrupted', activity: 'stopped', established: true, cols: 101, rows: 20,
      createdAt: '2026-11-03T21:43:50.761Z', updatedAt: '2026-11-03T23:04:44.571Z', pid: null, baseCommit,
      dirtyAtStart: false, exitCode: 143, taskHistory: [
        { id: 't1', prompt: 'first', startedAt: '2026-11-03T21:50:00.000Z', status: 'turn-ended', endedAt: '2026-11-03T21:51:00.000Z' },
        { id: 't2', prompt: 'unfinished', startedAt: '2026-11-03T22:50:00.000Z', status: 'working' }] }] };
}
