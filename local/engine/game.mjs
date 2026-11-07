// Host-owned game provisioning adapter.
//
// Database work runs in the dedicated `provision` Compose service
// (local/game_provision.py) with a structured JSON request on stdin, so the
// database password stays inside the container network and managed-owner
// credentials never appear in command arguments. Igloo creation uses the
// owner's ordinary game session on the loopback login/world ports. Puffles are
// adopted only by the visitor's own purchase (local/project_adoption.py); the
// engine reads their receipts here. The engine never authenticates as the
// fixture visitor.
import path from 'node:path';
import { spawn as spawnProcess } from 'node:child_process';
import { GameProtocolError, worldSession } from './game-protocol.mjs';

export const VISITOR_USERNAME = 'bridgecheck';
// `adoptcheck` is the marked test visitor for mutating adoption checks
// (CP_ENGINE_VISITOR=adoptcheck with a dedicated CP_ENGINE_STATE_DIR).
export const VISITOR_USERNAMES = Object.freeze(['bridgecheck', 'adoptcheck']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MANAGED_USERNAME = /^cp[a-z0-9]{10}$/;
const MAX_OUTPUT = 256 * 1024;
const ROOM_OFFSET = 2000;
const COOLDOWN_MS = 1100; // Houdini's g#gm and j#jp cooldowns are one second per penguin, across reconnects.
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Error codes: UNAVAILABLE (stack not running; retry later), USERNAME_TAKEN
 * (pick another generated username), NAME_REJECTED (the game refused the
 * puffle name; correct it and retry), MISMATCH (recorded identities disagree
 * with the game; needs repair), MISSING (a recorded visitor or owner no longer
 * exists as recorded; needs repair, never recreated), FAILED (anything else).
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

/**
 * Within an authenticated owner session: create or load the owner's igloo,
 * enter it, and confirm the room. No puffle is adopted here. `recorded` holds
 * the igloo ID saved by an earlier attempt.
 */
export async function prepareOwnerIgloo(world, { ownerId, recorded = {} }) {
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
  return { iglooId, roomId };
}

const validReceipt = item => UUID.test(item?.adoption_id ?? '') && typeof item.name === 'string'
  && ['visitor_id', 'owner_id', 'penguin_puffle_id', 'puffle_id', 'cost', 'coins_after', 'created_at'].every(key => Number.isSafeInteger(item[key]));
const receiptFields = item => ({ adoptionId: item.adoption_id, visitorId: item.visitor_id, ownerId: item.owner_id,
  puffleId: item.penguin_puffle_id, puffleType: item.puffle_id, name: item.name, cost: item.cost, coinsAfter: item.coins_after, createdAt: item.created_at });

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
  loginPort = 6112, worldPort = 9875, timeoutMs = 15000, seedTimeoutMs = 120000, env = process.env, visitorUsername = VISITOR_USERNAME } = {}) {
  if (!VISITOR_USERNAMES.includes(visitorUsername)) throw new ProvisionError(`The visitor must be one of ${VISITOR_USERNAMES.join(', ')}.`);
  const children = new Set();
  // The fixture visitor password travels in the stdin request like owner
  // credentials, so neither the Compose process nor the container gets it as
  // an environment variable. Unset, the service applies its own default.
  const visitorPassword = env.CLUB_PENGUIN_TEST_PASSWORD || null;
  const composeEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'CLUB_PENGUIN_TEST_PASSWORD'));
  const lastSession = new Map();
  let closed = false;

  function runSeed(request, { secrets = [] } = {}) {
    if (closed) return Promise.reject(new ProvisionError('The engine is stopping.', 'UNAVAILABLE'));
    const redact = text => secrets.filter(Boolean).reduce((value, secret) => value.split(secret).join('[redacted]'), text);
    return new Promise((resolve, reject) => {
      // Only fixed arguments: requests and credentials travel on stdin.
      const args = ['run', '--rm', '--no-deps', '-T', 'provision'];
      let child;
      try { child = spawn(compose, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: composeEnv }); }
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
    // SCHEMA: the world server has not yet recorded the adoption schema that honors settlements.
    const code = { USERNAME_TAKEN: 'USERNAME_TAKEN', MISMATCH: 'MISMATCH', MISSING: 'MISSING', UNAVAILABLE: 'UNAVAILABLE', SCHEMA: 'UNAVAILABLE' }[result.code] ?? 'FAILED';
    return new ProvisionError(String(result.error ?? 'The provisioning service refused the request.').slice(0, 500), code);
  }

  /** With a recorded `penguinId` the service only verifies that visitor and never creates one. */
  async function ensureVisitor({ penguinId = null } = {}) {
    const recorded = positive(penguinId) ? penguinId : null;
    const result = await runSeed({ op: 'visitor', username: visitorUsername, penguinId: recorded, ...(visitorPassword ? { password: visitorPassword } : {}) }, { secrets: [visitorPassword] });
    if (result.status !== 'ok') throw seedFailure(result);
    if (result.username !== visitorUsername || !positive(result.penguinId)) throw new ProvisionError('The provisioning service returned an unexpected visitor identity.', 'MISMATCH');
    if (recorded !== null && result.penguinId !== recorded) throw new ProvisionError(`The ${visitorUsername} visitor has game ID ${result.penguinId}, not the recorded ${recorded}.`, 'MISMATCH');
    return { penguinId: result.penguinId, username: result.username, created: Boolean(result.created) };
  }

  /** With a recorded `ownerId` the service only verifies that owner and never creates another. */
  async function ensureOwner({ marker, username, password, nickname, ownerId = null }) {
    if (!MANAGED_USERNAME.test(username)) throw new ProvisionError('Refusing a username outside the managed-owner namespace.');
    const recorded = positive(ownerId) ? ownerId : null;
    const result = await runSeed({ op: 'owner', marker, username, password, nickname, ownerId: recorded }, { secrets: [password] });
    if (result.status !== 'ok') throw seedFailure(result);
    if (!positive(result.ownerId)) throw new ProvisionError('The provisioning service returned an invalid owner ID.');
    if (recorded !== null && result.ownerId !== recorded) throw new ProvisionError(`The managed owner has game ID ${result.ownerId}, not the recorded ${recorded}.`, 'MISMATCH');
    return { ownerId: result.ownerId, created: Boolean(result.created) };
  }

  async function prepareIgloo({ username, password, ownerId, recorded }) {
    if (!MANAGED_USERNAME.test(username) || VISITOR_USERNAMES.includes(username)) throw new ProvisionError('Refusing to authenticate as a non-managed account.');
    const wait = COOLDOWN_MS - (Date.now() - (lastSession.get(ownerId) ?? 0));
    if (wait > 0) await pause(wait);
    let world;
    try {
      const opened = await session({ username, password, loginPort, worldPort, timeoutMs });
      world = opened.world;
      if (opened.penguinId !== ownerId) throw new ProvisionError('The managed credentials logged in as a different penguin.', 'MISMATCH');
      return await prepareOwnerIgloo(world, { ownerId, recorded });
    } catch (error) { throw protocolFailure(error); }
    finally { world?.close(); lastSession.set(ownerId, Date.now()); }
  }

  /**
   * Database-side verification of complete owner/layout/puffle mappings,
   * batched in one service run. A managed mapping lists its recorded puffles;
   * the result names any unrecorded puffle with its adoption receipt ID.
   */
  async function verifyOwners(mappings) {
    if (!mappings.length) return [];
    for (const mapping of mappings) if (!Object.hasOwn(mapping, 'fixtureId') && !MANAGED_USERNAME.test(mapping.username)) throw new ProvisionError('Refusing to verify a non-managed account.');
    const result = await runSeed({ op: 'verify', mappings });
    if (result.status !== 'ok' || !Array.isArray(result.results)) throw seedFailure(result);
    return result.results.map(item => ({ key: item.key, ok: item.ok === true, problems: Array.isArray(item.problems) ? item.problems.map(String).slice(0, 10) : [],
      unrecorded: Array.isArray(item.unrecorded) ? item.unrecorded.filter(entry => positive(entry?.puffleId))
        .map(entry => ({ puffleId: entry.puffleId, adoptionId: UUID.test(entry.adoptionId ?? '') ? entry.adoptionId : null })).slice(0, 20) : [] }));
  }

  /** Read-only: stored project-adoption receipts for these adoption IDs. */
  async function readReceipts(adoptionIds) {
    if (!adoptionIds.length) return [];
    if (adoptionIds.length > 256 || !adoptionIds.every(id => UUID.test(id))) throw new ProvisionError('Invalid adoption IDs.');
    const result = await runSeed({ op: 'receipts', adoptionIds });
    if (result.status !== 'ok' || !Array.isArray(result.receipts)) throw seedFailure(result);
    return result.receipts.filter(item => validReceipt(item) && adoptionIds.includes(item.adoption_id)).map(receiptFields);
  }

  /**
   * Settle expired adoptions in the game database (project_adoption.settle).
   * Each result arrived after its transaction committed: `charged` carries the
   * receipt, `not-charged` the settlement time (Unix seconds). `open`,
   * `conflict` and `unknown-visitor` wrote nothing. A failure, a timeout or a
   * missing or malformed result decides nothing; repeating a request is safe.
   */
  async function settleAdoptions(adoptions) {
    if (!adoptions.length) return [];
    if (adoptions.length > 256 || new Set(adoptions.map(item => item.adoptionId)).size !== adoptions.length
        || !adoptions.every(item => UUID.test(item.adoptionId ?? '') && positive(item.visitorId) && positive(item.ownerId) && positive(item.expiresAt))) {
      throw new ProvisionError('Invalid adoptions to settle.');
    }
    const result = await runSeed({ op: 'settle', adoptions: adoptions.map(({ adoptionId, visitorId, ownerId, expiresAt }) => ({ adoptionId, visitorId, ownerId, expiresAt })) });
    if (result.status !== 'ok' || !Array.isArray(result.results)) throw seedFailure(result);
    const settled = [];
    for (const item of result.results) {
      const asked = adoptions.find(entry => entry.adoptionId === item?.adoptionId);
      if (!asked || settled.some(entry => entry.adoptionId === asked.adoptionId)) continue;
      if (item.outcome === 'charged' && validReceipt(item.receipt) && item.receipt.adoption_id === asked.adoptionId) {
        settled.push({ adoptionId: asked.adoptionId, outcome: 'charged', receipt: receiptFields(item.receipt) });
      } else if (item.outcome === 'not-charged' && item.settlement?.adoption_id === asked.adoptionId && item.settlement.visitor_id === asked.visitorId
          && item.settlement.owner_id === asked.ownerId && positive(item.settlement.settled_at)) {
        settled.push({ adoptionId: asked.adoptionId, outcome: 'not-charged', settledAt: item.settlement.settled_at, created: item.created === true });
      } else if (['open', 'conflict', 'unknown-visitor'].includes(item.outcome)) {
        settled.push({ adoptionId: asked.adoptionId, outcome: item.outcome });
      }
    }
    return settled;
  }

  function close() {
    closed = true;
    for (const child of children) child.kill('SIGTERM');
  }

  return { visitorUsername, ensureVisitor, ensureOwner, prepareIgloo, verifyOwners, readReceipts, settleAdoptions, close };
}
