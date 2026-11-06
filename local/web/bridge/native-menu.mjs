import { freshSnapshot } from './model.mjs';

// Flash receives only display state and the mapped project UUID. Host paths,
// session IDs, worker IDs, terminal contents, and tokens stay in the browser.
export const nativeMenuFields = Object.freeze(['enabled', 'connected', 'projectId', 'name', 'projectName', 'status',
  'activity', 'draftSlot', 'readOnly', 'canStart', 'canSubmit', 'running', 'attention']);
const attentionStates = ['needs-you', 'review', 'failed'];

// Resolves an explicit selection. The project must be mapped in the overlay's
// current configuration, and the worker must be that project's active worker.
export function resolveSelection(engineSnapshot, mappings, target) {
  if (!target?.projectId || !target.workerId || !mappings?.projects.some(item => item.projectId === target.projectId)) return null;
  const project = engineSnapshot?.projects?.find(item => item.id === target.projectId);
  if (!project || project.game?.status !== 'ready' || project.activeWorkerId !== target.workerId) return null;
  const worker = engineSnapshot.workers?.find(item => item.id === target.workerId && item.projectId === project.id);
  return worker ? { project, worker } : null;
}

export function attentionTotal(engineSnapshot) {
  return (engineSnapshot?.workers ?? []).filter(item => attentionStates.includes(item.status)).length;
}

// Page-local display handles keep drafts keyed to workers without exposing host identities to Flash.
const slots = new Map();
function slotForWorker(id) {
  if (!slots.has(id)) slots.set(id, slots.size + 1);
  return slots.get(id);
}

export function nativeMenuState(engineState, mappings, target) {
  const state = engineState?.snapshot;
  const resolved = resolveSelection(state, mappings, target);
  const project = state?.projects?.find(item => item.id === target?.projectId);
  const worker = state?.workers?.find(item => item.projectId === project?.id && item.id === target?.workerId && item.id === project.activeWorkerId);
  const archive = state?.archivedWorkers?.find(item => item.projectId === project?.id &&
    (item.id === target?.workerId || (!target?.workerId && !project.activeWorkerId)));
  const known = Boolean(worker || archive || (project && !target.workerId && !project.activeWorkerId));
  const connected = engineState?.connected === true;
  const status = archive ? 'archived' : worker?.inspection?.repair || project?.game?.status === 'repair' ? 'needs-repair'
    : project?.sourceAvailable === false ? 'source-unavailable' : project?.setup?.phase === 'failed' ? 'setup-failed'
    : project && project.setup?.phase !== 'ready' ? 'setup' : worker?.status ?? 'offline';
  const readOnly = !resolved || Boolean(archive);
  const activity = !connected ? 'Your puffle is waiting for the local runtime.' : ({
    archived: 'Open Your Igloos to read the archived conversation.', setup: 'Open Your Igloos for setup progress.',
    'setup-failed': 'Open Your Igloos to check setup and retry.', 'needs-repair': 'Open Your Igloos for the failed check and recovery steps.',
    'source-unavailable': 'Restore the original checkout. See Your Igloos for its location.',
    starting: 'Waking up…', idle: 'Ready for a new task!', working: 'Working on your task…',
    'needs-you': 'Open Claude to check what your puffle needs.',
    review: 'The turn ended. Take a look at the changes.',
    interrupted: 'Taking a break. You can pick up where you left off.',
    failed: 'Something went wrong. Open Claude to take a look.',
    offline: 'Start your puffle when you are ready.',
  })[status] ?? 'Open Claude to check on your puffle.';
  const workspaceReady = (worker?.workspace?.state ?? 'ready') === 'ready';
  return { enabled: true, connected, projectId: known ? project.id : '',
    name: archive?.name ?? worker?.name ?? project?.game?.puffleName ?? 'Your Puffles', projectName: project?.name ?? '', status, activity,
    draftSlot: worker ? slotForWorker(worker.id) : 0, readOnly,
    canStart: Boolean(connected && !readOnly && worker && workspaceReady && !worker.running && !worker.recoveryBlocked),
    canSubmit: Boolean(connected && !readOnly && worker && worker.running && worker.established && ['idle', 'review', 'interrupted'].includes(status)),
    running: !readOnly && worker?.running === true,
    // Attention is aggregated across every active worker, not only the selection.
    attention: attentionTotal(state) };
}

// `context` carries the overlay mappings and configuration generation the
// browser last applied, the fresh game snapshot, engine state, and selection.
export function allowedNativeAction({ mappings, game, generation, engineState, target } = {}, event) {
  if (!mappings || !game?.ok || !game.configured || game.playerId !== mappings.visitor.penguinId || event?.type !== 'agent-menu-action') return false;
  if (['work', 'igloos'].includes(event.action)) return true;
  // Project actions require the current overlay generation and an explicit match.
  if (!freshSnapshot(mappings, game, generation) || event.generation !== generation) return false;
  const state = nativeMenuState(engineState, mappings, target);
  if (state.readOnly || !state.projectId || event.projectId !== state.projectId || event.draftSlot !== state.draftSlot) return false;
  if (['terminal', 'changes'].includes(event.action)) return true;
  if (!state.connected) return false;
  if (event.action === 'start') return state.canStart;
  if (event.action === 'interrupt') return state.running;
  return event.action === 'submit' && state.canSubmit && typeof event.text === 'string' && event.text.trim().length > 0 && event.text.length <= 20000;
}
