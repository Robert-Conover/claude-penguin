import { freshSnapshot } from './model.mjs';

// Flash receives only display state and the mapped project UUID. Host paths,
// session IDs, worker IDs, terminal contents, and tokens stay in the browser.
export const nativeMenuFields = Object.freeze(['enabled', 'connected', 'projectId', 'name', 'projectName', 'status',
  'activity', 'canStart', 'canSubmit', 'running', 'attention']);
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

export function nativeMenuState(engineState, mappings, target) {
  const state = engineState?.snapshot;
  const resolved = resolveSelection(state, mappings, target);
  const worker = resolved?.worker;
  const project = resolved?.project;
  const connected = engineState?.connected === true;
  const status = typeof worker?.status === 'string' ? worker.status : 'offline';
  const activity = !connected ? 'Your puffle is waiting for the local runtime.' : !worker ? 'Choose a puffle to see what it is doing.' : ({
    starting: 'Waking up…', idle: 'Ready for a new task!', working: 'Working on your task…',
    'needs-you': 'Open Claude to check what your puffle needs.',
    review: 'The turn ended. Take a look at the changes.',
    interrupted: 'Taking a break. You can pick up where you left off.',
    failed: 'Something went wrong. Open Claude to take a look.',
    offline: 'Start your puffle when you are ready.',
  })[status] ?? 'Open Claude to check on your puffle.';
  const workspaceReady = (worker?.workspace?.state ?? 'ready') === 'ready';
  return { enabled: true, connected, projectId: project?.id ?? '',
    name: worker?.name ?? 'Your Puffles', projectName: project?.name ?? '', status, activity,
    canStart: Boolean(connected && worker && workspaceReady && !worker.running && !worker.recoveryBlocked),
    canSubmit: Boolean(connected && worker && worker.running && worker.established && ['idle', 'review', 'interrupted'].includes(status)),
    running: worker?.running === true,
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
  if (!state.projectId || event.projectId !== state.projectId) return false;
  if (['terminal', 'changes'].includes(event.action)) return true;
  if (!state.connected) return false;
  if (event.action === 'start') return state.canStart;
  if (event.action === 'interrupt') return state.running;
  return event.action === 'submit' && state.canSubmit && typeof event.text === 'string' && event.text.trim().length > 0 && event.text.length <= 20000;
}
