export const states = Object.freeze({
  working: 'Working', 'needs-you': 'Needs you', ready: 'Ready for review',
  interrupted: 'Interrupted', failed: 'Failed',
});

const positiveId = value => Number.isSafeInteger(value) && value > 0;
const label = value => typeof value === 'string' && value.length > 0 && value.length <= 80;

export function validateFixtures(input) {
  if (input?.version !== 1 || input.kind !== 'game-bridge-fixture' ||
      input.visitor?.username !== 'bridgecheck' || !positiveId(input.visitor.penguinId) ||
      !Array.isArray(input.projects) || input.projects.length !== 2) throw new Error('Invalid bridge fixture manifest.');
  const seen = { projectId: new Set(), ownerId: new Set(), iglooId: new Set(), puffleId: new Set() };
  const projects = input.projects.map(project => {
    if (!/^bridge-(alpha|beta)$/.test(project.projectId) || !label(project.name) || !label(project.puffleName) ||
        !['ownerId', 'iglooId', 'roomId', 'puffleId'].every(key => positiveId(project[key])) ||
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

export async function waitForArrival(readSnapshot, fixtures, project, { timeout = 15000, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const deadline = now() + timeout;
  while (now() < deadline) {
    await pause(250);
    let next;
    try { next = readSnapshot(); }
    catch (error) { if (error.code === 'room-not-ready') continue; throw error; }
    if (next.ok && next.configured && next.playerId === fixtures.visitor.penguinId &&
        next.roomId === (project?.roomId ?? 100) &&
        (!project || (next.ownerId === project.ownerId && next.puffles?.some(puffle => puffle.id === project.puffleId)))) return next;
  }
  throw new Error('Travel did not confirm within 15 seconds. Check the game, then try again.');
}
