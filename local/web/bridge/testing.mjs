// Test-only engine snapshots shaped like the Stage 2 engine contract: a verified
// visitor plus `project.game` mappings. Private fields are present on purpose so
// tests can prove they never reach the overlay. Not served by the web server.
export const PROJECT_A = '0f8a3c1e-2b4d-4e6f-8a9b-1c2d3e4f5a6b';
export const PROJECT_B = '7d6c5b4a-3e2f-4a1b-9c8d-7e6f5a4b3c2d';
export const PROJECT_C = '11111111-2222-4333-8444-555555555555';
export const PRIVATE = /private|\/Users\/|sessionId|sourcePath|workspace|token|verifiedAt|fixtureId|worker-/;

const game = (ownerId, puffleId, puffleName, extra = {}) => ({ source: 'managed', status: 'ready', ownerId, iglooId: puffleId,
  roomId: ownerId + 2000, puffleId, puffleName, fixtureId: null, verifiedAt: '2026-11-04T12:00:00.000Z', ...extra });
const worker = (id, projectId, name, status, extra = {}) => ({ id, projectId, name, status, sessionId: `private-session-${id}`,
  activity: `private activity ${id}`, established: true, running: true, recoveryBlocked: false, updatedAt: '2026-11-04T12:00:00.000Z',
  taskHistory: [{ prompt: 'private task' }], workspace: { kind: 'worktree', path: `/Users/private/worktrees/${id}`, state: 'ready' }, ...extra });

export function engineSnapshot({ visitor = true, projects = ['a', 'b', 'c'] } = {}) {
  const all = {
    a: { id: PROJECT_A, name: 'Atlas Repo', sourcePath: '/Users/private/atlas', sourceAvailable: true, legacy: false,
      setup: { phase: 'ready' }, activeWorkerId: 'worker-a', game: game(105, 4, 'Atlas') },
    b: { id: PROJECT_B, name: 'Comet Repo', sourcePath: '/Users/private/comet', sourceAvailable: true, legacy: true,
      setup: { phase: 'ready' }, activeWorkerId: 'worker-b', game: game(106, 5, 'Comet', { source: 'legacy-fixture', fixtureId: 'bridge-beta' }) },
    c: { id: PROJECT_C, name: 'Pending Repo', sourcePath: '/Users/private/pending', sourceAvailable: true, legacy: false,
      setup: { phase: 'provisioning' }, activeWorkerId: 'worker-c', game: game(108, 6, 'Nova', { status: 'provisioning' }) },
  };
  const workers = { a: worker('worker-a', PROJECT_A, 'Atlas', 'working'), b: worker('worker-b', PROJECT_B, 'Comet', 'needs-you'),
    c: worker('worker-c', PROJECT_C, 'Nova', 'review') };
  return {
    revision: 7, limits: { maxProjects: 32 }, worktreeRoot: '/Users/private/.claude-penguin/worktrees',
    visitor: visitor ? { penguinId: 107, username: 'bridgecheck', verifiedAt: '2026-11-04T12:00:00.000Z' } : null,
    projects: projects.map(key => all[key]),
    workers: projects.map(key => workers[key]),
    archivedWorkers: [{ id: 'worker-old', projectId: PROJECT_A, sessionId: 'private-archived-session', originalPath: '/Users/private/atlas' }],
  };
}
