export const states = Object.freeze({
  working: 'Working', 'needs-you': 'Needs you', ready: 'Ready for review',
  interrupted: 'Interrupted', failed: 'Failed',
});

// The overlay contract this browser speaks, and the identity bounds bridge.as
// enforces (`version`, `maxGameId`, `maxProjects`, `maxPuffles`).
// bridge.test.mjs checks that both sides agree; change them together and
// rebuild the overlay. Version 5: each project maps a set of up to ten
// puffles, each with its own page-local draft slot.
export const BRIDGE_CONTRACT_VERSION = 5;
export const MAX_GAME_ID = 999999999;
export const MAX_MAPPINGS = 32;
export const MAX_PUFFLES = 10;

const positiveId = value => Number.isSafeInteger(value) && value > 0;
// Visitor, owner, room, and puffle IDs reach the overlay, which refuses a whole
// configuration for one out-of-range ID. Checking its bound here excludes only
// that mapping. Layout (igloo) IDs stay in the browser.
const gameId = value => positiveId(value) && value <= MAX_GAME_ID;
const destinationIds = item => ['ownerId', 'roomId'].every(key => gameId(item[key])) && positiveId(item.iglooId);
const label = value => typeof value === 'string' && value.length > 0 && value.length <= 80;

// Page-local draft slots: stable small numbers per worker (or per unbound
// fixture puffle), so Flash never receives worker or session identities.
const slots = new Map();
export function slotFor(key) {
  if (!slots.has(key)) slots.set(key, slots.size + 1);
  return slots.get(key);
}

export function validateFixtures(input) {
  if (input?.version !== 1 || input.kind !== 'game-bridge-fixture' ||
      input.visitor?.username !== 'bridgecheck' || !gameId(input.visitor.penguinId) ||
      !Array.isArray(input.projects) || input.projects.length !== 2) throw new Error('Invalid bridge fixture manifest.');
  const seen = { projectId: new Set(), ownerId: new Set(), iglooId: new Set(), puffleId: new Set() };
  const projects = input.projects.map(project => {
    if (!/^bridge-(alpha|beta)$/.test(project.projectId) || !label(project.name) || !label(project.puffleName) || !destinationIds(project) ||
        !gameId(project.puffleId) || project.roomId !== project.ownerId + 2000 || project.ownerId === input.visitor.penguinId) {
      throw new Error('Invalid project/igloo/puffle mapping.');
    }
    for (const key of Object.keys(seen)) {
      if (seen[key].has(project[key])) throw new Error(`Duplicate fixture ${key}.`);
      seen[key].add(project[key]);
    }
    // Explicit projection keeps future private engine fields out of the browser.
    return { ...Object.fromEntries(['projectId', 'name', 'ownerId', 'iglooId', 'roomId', 'puffleId', 'puffleName'].map(key => [key, project[key]])),
      puffles: [{ puffleId: project.puffleId, name: project.puffleName, slot: slotFor(`fixture:${project.puffleId}`), workerId: null, color: 'blue' }] };
  });
  return { version: 1, kind: input.kind, visitor: { username: input.visitor.username, penguinId: input.visitor.penguinId }, projects };
}

export function projectAtSnapshot(mappings, snapshot) {
  if (!mappings || snapshot?.ok !== true || snapshot.playerId !== mappings.visitor.penguinId || !snapshot.configured) return null;
  return mappings.projects.find(project => project.ownerId === snapshot.ownerId && project.roomId === snapshot.roomId) ?? null;
}

/** The exact mapped project and puffle a real click names, rendered in the current room. */
export function puffleForClick(mappings, snapshot, event) {
  const project = projectAtSnapshot(mappings, snapshot);
  if (!project || event?.type !== 'puffle-click' || event.projectId !== project.projectId || event.ownerId !== project.ownerId) return null;
  const puffle = project.puffles.find(item => item.puffleId === event.puffleId);
  if (!puffle || (event.slot !== undefined && event.slot !== puffle.slot) || !snapshot.puffles?.some(item => item.id === puffle.puffleId)) return null;
  return { project, puffle };
}

export function projectForClick(mappings, snapshot, event) {
  return puffleForClick(mappings, snapshot, event)?.project ?? null;
}

export const mappingChanged = () => Object.assign(new Error('Your igloo list changed. Choose a destination again.'), { code: 'mapping-changed' });

// `generation` pins arrival to the overlay configuration that authorized travel;
// `current` lets the caller abandon travel when the browser's mappings change.
// An igloo with puffles is reached once at least one of them renders; an
// empty project igloo once its room is confirmed.
export async function waitForArrival(readSnapshot, mappings, project, { timeout = 15000, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, generation, current = () => true, puffleId } = {}) {
  const deadline = now() + timeout;
  while (now() < deadline) {
    await pause(250);
    if (!current()) throw mappingChanged();
    let next;
    try { next = readSnapshot(); }
    catch (error) { if (error.code === 'room-not-ready') continue; throw error; }
    if (generation !== undefined && next.generation !== generation) throw mappingChanged();
    const rendered = id => next.puffles?.some(puffle => puffle.id === id);
    const puffles = project?.puffles ?? [];
    if (next.ok && next.configured && next.playerId === mappings.visitor.penguinId &&
        next.roomId === (project?.roomId ?? 100) &&
        (!project || (next.ownerId === project.ownerId &&
          (puffleId !== undefined ? rendered(puffleId) : !puffles.length || puffles.some(puffle => rendered(puffle.puffleId)))))) return next;
  }
  throw new Error('Travel did not confirm within 15 seconds. Check the game, then try again.');
}

// ------------------------------------------------------------ agent mode mappings
// Agent mode derives game mappings from the host engine snapshot, never from the
// Alpha/Beta fixture manifest. Only `ready` mappings for a verified visitor are
// usable. Each mapping lists the puffles bound to that project's workers.

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const mappingKeys = ['projectId', 'name', 'ownerId', 'iglooId', 'roomId'];
const puffleKeys = ['puffleId', 'name', 'slot', 'workerId', 'color'];

export function agentMappings(engineSnapshot) {
  const visitor = engineSnapshot?.visitor;
  if (!visitor || !gameId(visitor.penguinId) || !label(visitor.username) || typeof visitor.verifiedAt !== 'string' || !visitor.verifiedAt) return null;
  const candidates = [];
  const rejected = [];
  const workers = (Array.isArray(engineSnapshot.workers) ? engineSnapshot.workers : []).filter(worker => worker?.puffle && positiveId(worker.puffle.puffleId));
  for (const project of Array.isArray(engineSnapshot.projects) ? engineSnapshot.projects : []) {
    const game = project?.game;
    if (!game || game.status !== 'ready') continue;
    const puffles = workers.filter(worker => worker.projectId === project.id).map(worker => ({ puffleId: worker.puffle.puffleId,
      name: worker.name, slot: slotFor(`worker:${worker.id}`), workerId: worker.id, color: worker.puffle.color ?? 'blue' }));
    // A migrated legacy fixture shows its puffle even before its isolated worker exists.
    if (game.source === 'legacy-fixture' && positiveId(game.puffleId) && !puffles.some(item => item.puffleId === game.puffleId)) {
      puffles.push({ puffleId: game.puffleId, name: game.puffleName, slot: slotFor(`fixture:${game.puffleId}`), workerId: null, color: 'blue' });
    }
    const candidate = { projectId: project.id, name: project.name, ownerId: game.ownerId, iglooId: game.iglooId, roomId: game.roomId,
      puffles: puffles.sort((a, b) => a.puffleId - b.puffleId) };
    if (!uuid(candidate.projectId) || !label(candidate.name) || !destinationIds(candidate) || candidate.roomId !== candidate.ownerId + 2000 ||
        candidate.ownerId === visitor.penguinId || candidate.puffles.length > MAX_PUFFLES ||
        !candidate.puffles.every(puffle => gameId(puffle.puffleId) && label(puffle.name))) {
      rejected.push({ projectId: uuid(project.id) ? project.id : null, reason: 'invalid-mapping' });
      continue;
    }
    candidates.push(candidate);
  }
  // A shared game identity is ambiguous. Exclude every claimant rather than
  // choosing whichever project happens to come first.
  const conflicts = new Set();
  for (const key of ['projectId', 'ownerId', 'iglooId', 'roomId']) {
    const counts = new Map();
    for (const item of candidates) counts.set(item[key], (counts.get(item[key]) ?? 0) + 1);
    for (const item of candidates) if (counts.get(item[key]) > 1) conflicts.add(item);
  }
  const puffleCounts = new Map();
  for (const item of candidates) for (const puffle of item.puffles) puffleCounts.set(puffle.puffleId, (puffleCounts.get(puffle.puffleId) ?? 0) + 1);
  for (const item of candidates) if (item.puffles.some(puffle => puffleCounts.get(puffle.puffleId) > 1)) conflicts.add(item);
  for (const item of conflicts) rejected.push({ projectId: item.projectId, reason: 'duplicate-game-identity' });
  // Explicit projection keeps paths, session IDs, and setup detail out of the mapping.
  const projects = candidates.filter(item => !conflicts.has(item))
    .map(item => ({ ...Object.fromEntries(mappingKeys.map(key => [key, item[key]])),
      puffles: item.puffles.map(puffle => Object.fromEntries(puffleKeys.map(key => [key, puffle[key]]))) }))
    .sort((a, b) => a.ownerId - b.ownerId);
  return { version: 1, kind: 'agent-mappings', visitor: { username: visitor.username, penguinId: visitor.penguinId }, projects, rejected };
}

// Identity of everything the overlay and panel depend on. A different key means
// existing controls are stale and the overlay must be reconfigured.
export function mappingKey(mappings) {
  if (!mappings) return '';
  return JSON.stringify([mappings.visitor.penguinId, mappings.projects.map(project => [...mappingKeys.map(key => project[key]),
    project.puffles.map(puffle => puffleKeys.map(key => puffle[key]))])]);
}

// Exactly what `cpBridgeConfigure` receives: public game IDs, the project UUID,
// and each puffle's draft slot. Display names travel separately through the
// bounded menu payload. More mappings than the overlay accepts are refused,
// never truncated, so no project silently disappears from the neighborhood.
export function flashConfiguration(mappings) {
  if (!mappings) return null;
  const count = mappings.projects.length;
  if (count > MAX_MAPPINGS) {
    throw Object.assign(new Error(`${count} project igloos are ready, but the game can show at most ${MAX_MAPPINGS}, so none are shown.`), { code: 'too-many-projects' });
  }
  return { visitorId: mappings.visitor.penguinId,
    projects: mappings.projects.map(project => ({ projectId: project.projectId, ownerId: project.ownerId,
      puffles: project.puffles.map(puffle => ({ puffleId: puffle.puffleId, slot: puffle.slot })) })) };
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

/** The mapped project and puffle that a draft slot names, or null. */
export function puffleForSlot(mappings, projectId, slot) {
  const project = mappings?.projects.find(item => item.projectId === projectId);
  const puffle = project?.puffles.find(item => item.slot === slot);
  return project && puffle ? { project, puffle } : null;
}

// Resolves a click to its exact project and the worker bound to that puffle.
// Never falls back to another worker; `workerId` is null for a fixture puffle
// that has no isolated worker yet.
export function selectionForClick(mappings, snapshot, generation, event, engineSnapshot) {
  if (!freshSnapshot(mappings, snapshot, generation) || event?.generation !== generation) return null;
  const found = puffleForClick(mappings, snapshot, event);
  if (!found) return null;
  const engineProject = engineSnapshot?.projects?.find(item => item.id === found.project.projectId);
  if (engineProject?.game?.status !== 'ready' || engineProject.game.ownerId !== found.project.ownerId) return null;
  const worker = found.puffle.workerId ? engineSnapshot.workers?.find(item => item.id === found.puffle.workerId && item.projectId === found.project.projectId
    && item.puffle?.puffleId === found.puffle.puffleId) : null;
  if (found.puffle.workerId && !worker) return null;
  return { projectId: found.project.projectId, workerId: worker ? worker.id : null };
}

// Each mapped puffle in the current room, and the cue its own worker's
// host-reported state selects. Other projects' workers never animate here.
const cues = { working: 'working', 'needs-you': 'needs-you', review: 'ready', interrupted: 'interrupted', failed: 'failed' };
export function roomAnimations(mappings, snapshot, engineSnapshot) {
  const current = projectAtSnapshot(mappings, snapshot);
  if (!current) return [];
  const result = [];
  for (const puffle of current.puffles) {
    if (!puffle.workerId || !snapshot.puffles?.some(item => item.id === puffle.puffleId)) continue;
    const worker = engineSnapshot?.workers?.find(item => item.id === puffle.workerId && item.projectId === current.projectId);
    const cue = worker && cues[worker.status];
    if (!cue) continue;
    result.push({ puffleId: puffle.puffleId, cue, identity: `${current.projectId}/${worker.id}/${worker.status}/${worker.updatedAt}/${snapshot.roomId}/${snapshot.generation}` });
  }
  return result;
}
