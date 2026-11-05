// Host-owned game provisioning adapter.
//
// Database work runs in the dedicated `provision` Compose service
// (local/game_provision.py) with a structured JSON request on stdin, so the
// database password stays inside the container network and managed-owner
// credentials never appear in command arguments. Igloo creation and puffle
// adoption use the owner's ordinary game session on the loopback login/world
// ports. The engine never authenticates as the shared `bridgecheck` visitor.
import path from 'node:path';
import { spawn as spawnProcess } from 'node:child_process';
import { GameProtocolError, worldSession } from './game-protocol.mjs';

export const VISITOR_USERNAME = 'bridgecheck';
export const MANAGED_USERNAME = /^cp[a-z0-9]{10}$/;
const MAX_OUTPUT = 256 * 1024;
const ROOM_OFFSET = 2000;
const COOLDOWN_MS = 1100; // Houdini's g#gm and j#jp cooldowns are one second per penguin, across reconnects.
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Error codes: UNAVAILABLE (stack not running; retry later), USERNAME_TAKEN
 * (pick another generated username), NAME_REJECTED (the game refused the
 * puffle name; correct it and retry), MISMATCH (recorded identities disagree
 * with the game; needs repair), FAILED (anything else).
 */
export class ProvisionError extends Error {
  constructor(message, code = 'FAILED') { super(message); this.code = code; }
}

/** Python's str.title() for the 1–12 ASCII letters the engine accepts. */
export const titleCase = name => name.slice(0, 1).toUpperCase() + name.slice(1).toLowerCase();

const positive = value => Number.isSafeInteger(value) && value > 0;
const asId = value => { const number = Number(value); return /^\d+$/.test(String(value)) && positive(number) ? number : null; };

function protocolFailure(error) {
  if (error instanceof ProvisionError) return error;
  if (error instanceof GameProtocolError) return new ProvisionError(error.message, error.code === 'MISMATCH' ? 'MISMATCH' : error.code === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'FAILED');
  return new ProvisionError(`Game session failed: ${error.message}`);
}

async function listPuffles(world) {
  world.xt('p#pgu');
  return (await world.waitXt('pgu')).filter(Boolean).map(raw => {
    const fields = raw.split('|');
    if (fields.length < 9 || !asId(fields[0])) throw new ProvisionError('The game returned incomplete puffle data.');
    return { id: asId(fields[0]), parent: fields[1], name: fields[3] };
  });
}

/**
 * Within an authenticated owner session: reconcile or adopt the one blue
 * puffle, create/load the owner's igloo, enter it, and confirm the puffle is
 * in that igloo. `recorded` holds identities saved by an earlier attempt.
 */
export async function prepareOwnerIgloo(world, { ownerId, requestedName, recorded = {} }) {
  const pets = await listPuffles(world);
  const expectedName = recorded.puffleName ?? titleCase(requestedName);
  let puffle;
  if (recorded.puffleId) {
    if (pets.length !== 1 || pets[0].id !== recorded.puffleId || pets[0].name !== recorded.puffleName) {
      throw new ProvisionError('The managed owner\'s puffles no longer match the recorded puffle. Nothing was changed; repair the game mapping explicitly.', 'MISMATCH');
    }
    puffle = pets[0];
  } else if (pets.length === 0) {
    world.xt('p#checkpufflename', requestedName);
    const [, ok] = await world.waitXt('checkpufflename');
    if (ok !== '1') throw new ProvisionError(`The game rejected the puffle name "${requestedName}". Choose another name and retry.`, 'NAME_REJECTED');
    world.xt('p#pn', 0, requestedName, 0); // Blue puffle, no subtype.
    let adoption;
    try { adoption = await world.waitXt('pn'); }
    catch (error) {
      if (error.gameError === 441) throw new ProvisionError(`The game rejected the puffle name "${requestedName}" during adoption. Choose another name and retry.`, 'NAME_REJECTED');
      if (error.gameError === 401) throw new ProvisionError('The managed owner does not have enough coins to adopt a puffle.');
      throw error;
    }
    const fields = String(adoption[1] ?? '').split('|');
    if (!asId(fields[0]) || !fields[3]) throw new ProvisionError('The game returned an incomplete adoption response.');
    puffle = { id: asId(fields[0]), parent: fields[1], name: fields[3] };
  } else if (pets.length === 1 && pets[0].name === expectedName) {
    puffle = pets[0]; // An earlier attempt adopted it before its result was recorded.
  } else {
    throw new ProvisionError('The managed owner has puffles that do not match this project. Nothing was adopted; repair the game mapping explicitly.', 'MISMATCH');
  }
  if (puffle.parent !== '0') throw new ProvisionError('The managed puffle is not the expected blue puffle.', 'MISMATCH');

  world.xt('g#gm', ownerId);
  const details = await world.waitXt('gm');
  if (details[0] !== String(ownerId)) throw new ProvisionError('The igloo response belongs to another player.', 'MISMATCH');
  const layout = String(details[1] ?? '').split(':', 10);
  const iglooId = asId(layout[0]);
  if (!iglooId || layout.length < 9) throw new ProvisionError('The game returned an incomplete igloo layout.');
  if (recorded.iglooId && recorded.iglooId !== iglooId) throw new ProvisionError('The managed owner\'s active igloo changed from the recorded layout.', 'MISMATCH');
  if (layout[3] !== '1') throw new ProvisionError('The managed igloo is open in the game database. Managed igloos must stay locked; repair it explicitly.', 'MISMATCH');

  const roomId = ownerId + ROOM_OFFSET;
  world.xt('j#jp', ownerId, 'igloo');
  const entered = await world.waitXt('jp');
  if (entered[0] !== String(roomId) || entered.at(-1) !== 'igloo') throw new ProvisionError('The game entered the wrong igloo room.', 'MISMATCH');
  const joined = await world.waitXt('jr');
  if (joined[0] !== String(roomId)) throw new ProvisionError('The joined room does not match the managed owner.', 'MISMATCH');
  world.xt('p#pg', ownerId, 'igloo');
  const present = (await world.waitXt('pg')).slice(1).filter(Boolean).map(raw => raw.split('|'));
  if (!present.some(fields => asId(fields[0]) === puffle.id && fields[3] === puffle.name)) {
    throw new ProvisionError('The adopted puffle is not in the managed igloo.', 'MISMATCH');
  }
  return { iglooId, roomId, puffleId: puffle.id, puffleName: puffle.name };
}

function lastJson(text) {
  for (const line of text.trim().split('\n').reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try { return JSON.parse(line); } catch { /* try the previous line */ }
  }
  return null;
}

/**
 * Real provisioner. `spawn` and `session` are injectable for tests.
 */
export function createGameProvisioner({ root, compose = path.join(root, 'local/compose'), spawn = spawnProcess, session = worldSession,
  loginPort = 6112, worldPort = 9875, timeoutMs = 15000, seedTimeoutMs = 120000 } = {}) {
  const children = new Set();
  const lastSession = new Map();
  let closed = false;

  function runSeed(request, { passTestPassword = false, secrets = [] } = {}) {
    if (closed) return Promise.reject(new ProvisionError('The engine is stopping.', 'UNAVAILABLE'));
    const redact = text => secrets.filter(Boolean).reduce((value, secret) => value.split(secret).join('[redacted]'), text);
    return new Promise((resolve, reject) => {
      // Only fixed arguments: requests and credentials travel on stdin.
      const args = ['run', '--rm', '--no-deps', '-T', ...(passTestPassword ? ['-e', 'CLUB_PENGUIN_TEST_PASSWORD'] : []), 'provision'];
      let child;
      try { child = spawn(compose, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: process.env }); }
      catch (error) { reject(new ProvisionError(`Could not run the provisioning service: ${error.message}`, 'UNAVAILABLE')); return; }
      children.add(child);
      let stdout = '', stderr = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), seedTimeoutMs);
      child.stdout.on('data', chunk => { if (stdout.length < MAX_OUTPUT) stdout += chunk; });
      child.stderr.on('data', chunk => { if (stderr.length < MAX_OUTPUT) stderr += chunk; });
      child.on('error', error => { clearTimeout(timer); children.delete(child); reject(new ProvisionError(`Could not run the provisioning service (${error.code ?? error.message}). Run ./local/start first.`, 'UNAVAILABLE')); });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        children.delete(child);
        const result = lastJson(stdout);
        if (result && typeof result === 'object') { resolve(result); return; }
        const detail = redact(stderr.trim().split('\n').at(-1) ?? '').slice(0, 300);
        reject(new ProvisionError(`The provisioning service failed (${signal ? `signal ${signal}` : `exit ${code}`})${detail ? `: ${detail}` : ''}. Check that ./local/start has completed.`, 'UNAVAILABLE'));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(request));
    });
  }

  function seedFailure(result) {
    const code = { USERNAME_TAKEN: 'USERNAME_TAKEN', MISMATCH: 'MISMATCH', UNAVAILABLE: 'UNAVAILABLE' }[result.code] ?? 'FAILED';
    return new ProvisionError(String(result.error ?? 'The provisioning service refused the request.').slice(0, 500), code);
  }

  async function ensureVisitor() {
    const result = await runSeed({ op: 'visitor' }, { passTestPassword: true });
    if (result.status !== 'ok') throw seedFailure(result);
    if (result.username !== VISITOR_USERNAME || !positive(result.penguinId)) throw new ProvisionError('The provisioning service returned an unexpected visitor identity.', 'MISMATCH');
    return { penguinId: result.penguinId, username: result.username, created: Boolean(result.created) };
  }

  async function ensureOwner({ marker, username, password, nickname }) {
    if (!MANAGED_USERNAME.test(username)) throw new ProvisionError('Refusing a username outside the managed-owner namespace.');
    const result = await runSeed({ op: 'owner', marker, username, password, nickname }, { secrets: [password] });
    if (result.status !== 'ok') throw seedFailure(result);
    if (!positive(result.ownerId)) throw new ProvisionError('The provisioning service returned an invalid owner ID.');
    return { ownerId: result.ownerId, created: Boolean(result.created) };
  }

  async function prepareIgloo({ username, password, ownerId, requestedName, recorded }) {
    if (!MANAGED_USERNAME.test(username) || username === VISITOR_USERNAME) throw new ProvisionError('Refusing to authenticate as a non-managed account.');
    const wait = COOLDOWN_MS - (Date.now() - (lastSession.get(ownerId) ?? 0));
    if (wait > 0) await pause(wait);
    let world;
    try {
      const opened = await session({ username, password, loginPort, worldPort, timeoutMs });
      world = opened.world;
      if (opened.penguinId !== ownerId) throw new ProvisionError('The managed credentials logged in as a different penguin.', 'MISMATCH');
      return await prepareOwnerIgloo(world, { ownerId, requestedName, recorded });
    } catch (error) { throw protocolFailure(error); }
    finally { world?.close(); lastSession.set(ownerId, Date.now()); }
  }

  /** Database-side verification of complete owner/layout/puffle mappings, batched in one service run. */
  async function verifyOwners(mappings) {
    if (!mappings.length) return [];
    for (const mapping of mappings) if (!MANAGED_USERNAME.test(mapping.username)) throw new ProvisionError('Refusing to verify a non-managed account.');
    const result = await runSeed({ op: 'verify', mappings });
    if (result.status !== 'ok' || !Array.isArray(result.results)) throw seedFailure(result);
    return result.results.map(item => ({ key: item.key, ok: item.ok === true, problems: Array.isArray(item.problems) ? item.problems.map(String).slice(0, 10) : [] }));
  }

  function close() {
    closed = true;
    for (const child of children) child.kill('SIGTERM');
  }

  return { ensureVisitor, ensureOwner, prepareIgloo, verifyOwners, close };
}
