export const states = Object.freeze({
  working: 'Working', 'needs-you': 'Needs you', ready: 'Ready for review',
  interrupted: 'Interrupted', failed: 'Failed',
});

// The overlay contract this browser speaks, and the identity bounds bridge.as
// enforces (`version`, `maxGameId`, `maxProjects`). bridge.test.mjs checks that
// both sides agree; change them together and rebuild the overlay.
export const BRIDGE_CONTRACT_VERSION = 4;
export const MAX_GAME_ID = 999999999;
export const MAX_MAPPINGS = 32;

const positiveId = value => Number.isSafeInteger(value) && value > 0;
// Visitor, owner, room, and puffle IDs reach the overlay, which refuses a whole
// configuration for one out-of-range ID. Checking its bound here excludes only
// that mapping. Layout (igloo) IDs stay in the browser.
const gameId = value => positiveId(value) && value <= MAX_GAME_ID;
const gameIds = item => ['ownerId', 'roomId', 'puffleId'].every(key => gameId(item[key])) && positiveId(item.iglooId);
const label = value => typeof value === 'string' && value.length > 0 && value.length <= 80;

export function validateFixtures(input) {
  if (input?.version !== 1 || input.kind !== 'game-bridge-fixture' ||
      input.visitor?.username !== 'bridgecheck' || !gameId(input.visitor.penguinId) ||
      !Array.isArray(input.projects) || input.projects.length !== 2) throw new Error('Invalid bridge fixture manifest.');
  const seen = { projectId: new Set(), ownerId: new Set(), iglooId: new Set(), puffleId: new Set() };
  const projects = input.projects.map(project => {
    if (!/^bridge-(alpha|beta)$/.test(project.projectId) || !label(project.name) || !label(project.puffleName) || !gameIds(project) ||
        project.roomId !== project.ownerId + 2000 || project.ownerId === input.visitor.penguinId) {
      throw new Error('Invalid project/igloo/puffle mapping.');
    }
    for (const key of Object.keys(seen)) {
      if (seen[key].has(project[key])) throw new Error(`Duplicate fixture ${key}.`);
      seen[key].add(project[key]);
    }
    // Explicit projection keeps future private engine fields out of the browser.
    return Object.fromEntries(['projectId', 'name', 'ownerId', 'iglooId', 'roomId', 'puffleId', 'puffleName'].map(key => [key, project[key]]));
  });
  return { version: 1, kind: input.kind, visitor: { username: input.visitor.username, penguinId: input.visitor.penguinId }, projects };
}

export function projectAtSnapshot(fixtures, snapshot) {
  if (!fixtures || snapshot?.ok !== true || snapshot.playerId !== fixtures.visitor.penguinId || !snapshot.configured) return null;
  return fixtures.projects.find(project => project.ownerId === snapshot.ownerId && project.roomId === snapshot.roomId) ?? null;
}

export function projectForClick(fixtures, snapshot, event) {
  const project = projectAtSnapshot(fixtures, snapshot);
  if (!project || event?.type !== 'puffle-click' || event.projectId !== project.projectId ||
      event.ownerId !== project.ownerId || event.puffleId !== project.puffleId ||
      !snapshot.puffles?.some(puffle => puffle.id === project.puffleId)) return null;
  return project;
}

export const mappingChanged = () => Object.assign(new Error('Your igloo list changed. Choose a destination again.'), { code: 'mapping-changed' });

// `generation` pins arrival to the overlay configuration that authorized travel;
// `current` lets the caller abandon travel when the browser's mappings change.
export async function waitForArrival(readSnapshot, fixtures, project, { timeout = 15000, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, generation, current = () => true } = {}) {
  const deadline = now() + timeout;
  while (now() < deadline) {
    await pause(250);
    if (!current()) throw mappingChanged();
    let next;
    try { next = readSnapshot(); }
    catch (error) { if (error.code === 'room-not-ready') continue; throw error; }
    if (generation !== undefined && next.generation !== generation) throw mappingChanged();
    if (next.ok && next.configured && next.playerId === fixtures.visitor.penguinId &&
        next.roomId === (project?.roomId ?? 100) &&
        (!project || (next.ownerId === project.ownerId && next.puffles?.some(puffle => puffle.id === project.puffleId)))) return next;
  }
  throw new Error('Travel did not confirm within 15 seconds. Check the game, then try again.');
}

// ------------------------------------------------------------ agent mode mappings
// Agent mode derives game mappings from the host engine snapshot, never from the
// Alpha/Beta fixture manifest. Only `ready` mappings for a verified visitor are
// usable. The result has the validated-fixture shape, so the room, click, and
// arrival helpers above are shared, with the project UUID as `projectId`.

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const mappingKeys = ['projectId', 'name', 'ownerId', 'iglooId', 'roomId', 'puffleId', 'puffleName'];

export function agentMappings(engineSnapshot) {
  const visitor = engineSnapshot?.visitor;
  if (!visitor || !gameId(visitor.penguinId) || !label(visitor.username) || typeof visitor.verifiedAt !== 'string' || !visitor.verifiedAt) return null;
  const candidates = [];
  const rejected = [];
  for (const project of Array.isArray(engineSnapshot.projects) ? engineSnapshot.projects : []) {
    const game = project?.game;
    if (!game || game.status !== 'ready') continue;
    const candidate = { projectId: project.id, name: project.name, ownerId: game.ownerId, iglooId: game.iglooId,
      roomId: game.roomId, puffleId: game.puffleId, puffleName: game.puffleName };
    if (!uuid(candidate.projectId) || !label(candidate.name) || !label(candidate.puffleName) || !gameIds(candidate) ||
        candidate.roomId !== candidate.ownerId + 2000 || candidate.ownerId === visitor.penguinId) {
      rejected.push({ projectId: uuid(project.id) ? project.id : null, reason: 'invalid-mapping' });
      continue;
    }
    candidates.push(candidate);
  }
  // A shared game identity is ambiguous. Exclude every claimant rather than
  // choosing whichever project happens to come first.
  const conflicts = new Set();
  for (const key of ['projectId', 'ownerId', 'iglooId', 'roomId', 'puffleId']) {
    const counts = new Map();
    for (const item of candidates) counts.set(item[key], (counts.get(item[key]) ?? 0) + 1);
    for (const item of candidates) if (counts.get(item[key]) > 1) conflicts.add(item);
  }
  for (const item of conflicts) rejected.push({ projectId: item.projectId, reason: 'duplicate-game-identity' });
  // Explicit projection keeps paths, session IDs, and setup detail out of the mapping.
  const projects = candidates.filter(item => !conflicts.has(item))
    .map(item => Object.fromEntries(mappingKeys.map(key => [key, item[key]])))
    .sort((a, b) => a.ownerId - b.ownerId);
  return { version: 1, kind: 'agent-mappings', visitor: { username: visitor.username, penguinId: visitor.penguinId }, projects, rejected };
}

// Identity of everything the overlay and panel depend on. A different key means
// existing controls are stale and the overlay must be reconfigured.
export function mappingKey(mappings) {
  if (!mappings) return '';
  return JSON.stringify([mappings.visitor.penguinId, mappings.projects.map(project => mappingKeys.map(key => project[key]))]);
}

// Exactly what `cpBridgeConfigure` receives: public game IDs and the mapping
// identity. Display names travel separately through the bounded menu payload.
// More mappings than the overlay accepts are refused, never truncated, so no
// project silently disappears from the neighborhood.
export function flashConfiguration(mappings) {
  if (!mappings) return null;
  const count = mappings.projects.length;
  if (count > MAX_MAPPINGS) {
    throw Object.assign(new Error(`${count} project igloos are ready, but the game can show at most ${MAX_MAPPINGS}, so none are shown.`), { code: 'too-many-projects' });
  }
  return { visitorId: mappings.visitor.penguinId,
    projects: mappings.projects.map(project => ({ projectId: project.projectId, ownerId: project.ownerId, puffleId: project.puffleId })) };
}

// `configured` is `{ key, generation, mappings }` from the last successful
// `cpBridgeConfigure`. Routing may use its mappings only while they are still
// the desired ones; otherwise every control is stale until reconfiguration.
export function activeMappingsFor(desiredKey, configured) {
  return configured && configured.key === desiredKey ? configured.mappings : null;
}
// Reconfigure after a mapping change, or whenever the overlay reports a different
// generation (never configured, or reset), e.g. after an engine reconnect.
export function needsConfiguration(desiredKey, configured, snapshot) {
  return !snapshot?.configured || !configured || configured.key !== desiredKey || snapshot.generation !== configured.generation;
}

// An overlay snapshot authorizes actions only for the configuration generation
// the browser last applied, so controls prepared against older mappings fail.
export function freshSnapshot(mappings, snapshot, generation) {
  return Boolean(mappings && snapshot?.ok === true && snapshot.configured === true &&
    snapshot.playerId === mappings.visitor.penguinId && Number.isSafeInteger(generation) && snapshot.generation === generation);
}

// Resolves a click to its exact project and that project's active worker. Never
// falls back to another worker; `workerId` is null when the project has none.
export function selectionForClick(mappings, snapshot, generation, event, engineSnapshot) {
  if (!freshSnapshot(mappings, snapshot, generation) || event?.generation !== generation) return null;
  const project = projectForClick(mappings, snapshot, event);
  if (!project) return null;
  const engineProject = engineSnapshot?.projects?.find(item => item.id === project.projectId);
  const game = engineProject?.game;
  if (game?.status !== 'ready' || game.ownerId !== project.ownerId || game.puffleId !== project.puffleId) return null;
  const workerId = engineProject.activeWorkerId;
  const worker = workerId ? engineSnapshot.workers?.find(item => item.id === workerId && item.projectId === project.projectId) : null;
  return { projectId: project.projectId, workerId: worker ? worker.id : null };
}

// The one mapped puffle in the current room, and the cue its active worker's
// host-reported state selects. Other projects' workers never animate here.
const cues = { working: 'working', 'needs-you': 'needs-you', review: 'ready', interrupted: 'interrupted', failed: 'failed' };
export function roomAnimation(mappings, snapshot, engineSnapshot) {
  const current = projectAtSnapshot(mappings, snapshot);
  if (!current || !snapshot.puffles?.some(puffle => puffle.id === current.puffleId)) return null;
  const project = engineSnapshot?.projects?.find(item => item.id === current.projectId);
  const worker = project?.activeWorkerId && engineSnapshot.workers?.find(item => item.id === project.activeWorkerId && item.projectId === project.id);
  const cue = worker && cues[worker.status];
  if (!cue) return null;
  return { puffleId: current.puffleId, cue, identity: `${project.id}/${worker.id}/${worker.status}/${worker.updatedAt}/${snapshot.roomId}/${snapshot.generation}` };
}
