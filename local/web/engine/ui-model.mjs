export const statusLabels = Object.freeze({
  starting: 'Starting', idle: 'Ready for a task', working: 'Working',
  'needs-you': 'Needs you', review: 'Ready for review · turn ended',
  interrupted: 'Interrupted', failed: 'Failed', stopped: 'Stopped', offline: 'Stopped',
  setup: 'Setting up', 'needs-repair': 'Needs repair', queued: 'Queued for a free session slot',
});

export const targetKey = target => target ? `${target.projectId}/${target.workerId}` : '';

export function terminalDimensions(proposed) {
  if (!Number.isFinite(proposed?.cols) || !Number.isFinite(proposed?.rows)) return null;
  return { cols: Math.max(40, Math.min(300, Math.floor(proposed.cols))), rows: Math.max(10, Math.min(100, Math.floor(proposed.rows))) };
}

export function nextSnapshotRevision(previous, incoming) {
  if (!Number.isSafeInteger(incoming) || incoming < 0) return previous;
  return incoming < previous ? null : incoming;
}

// An explicit target never falls back to another project or worker. A project
// holds up to ten active workers (snapshot.workers lists only active ones).
export function resolveTarget(snapshot, target) {
  if (!target) return null;
  const project = snapshot?.projects?.find(item => item.id === target.projectId);
  const worker = snapshot?.workers?.find(item => item.id === target.workerId && item.projectId === target.projectId);
  return project && worker ? { project, worker } : null;
}

// Routes a project UUID and an explicit worker to that worker. Without a named
// worker there is no target: nothing picks one of the project's puffles.
export function targetForProject(snapshot, projectId, workerId = null) {
  if (workerId === null) return null;
  const project = snapshot?.projects?.find(item => item.id === projectId);
  const worker = project && snapshot.workers?.find(item => item.id === workerId && item.projectId === project.id);
  return worker ? { projectId: project.id, workerId: worker.id } : null;
}

export function attentionCount(snapshot) {
  return (snapshot?.workers ?? []).filter(worker => ['needs-you', 'review', 'failed'].includes(worker.status)).length;
}

export function animationForStatus(status) {
  return ({ working: 'working', 'needs-you': 'needs-you', review: 'ready', interrupted: 'interrupted', failed: 'failed' })[status] ?? null;
}

export function controlsForWorker(connected, resolved, terminalReady) {
  const worker = resolved?.worker;
  const ready = Boolean(connected && worker);
  return {
    start: ready && !worker.running && !worker.queued && worker.workspace?.state === 'ready' && !worker.recoveryBlocked,
    interrupt: ready && worker.running,
    // Stop also withdraws a queued start.
    stop: ready && (worker.running || worker.queued === true),
    submit: ready && worker.running && terminalReady && ['idle', 'review', 'interrupted'].includes(worker.status),
    input: ready && worker.running && terminalReady,
    diff: ready,
  };
}
