import { freshSnapshot, puffleForSlot } from './model.mjs';

// Flash receives only display state, the mapped project UUID, and page-local
// draft slots. Host paths, session IDs, worker IDs, terminal contents, and
// tokens stay in the browser.
export const nativeMenuFields = Object.freeze(['enabled', 'connected', 'projectId', 'name', 'projectName', 'status',
  'activity', 'draftSlot', 'readOnly', 'canStart', 'canSubmit', 'running', 'attention', 'color', 'roster', 'alerts']);
export const rosterFields = Object.freeze(['slot', 'name', 'color', 'status', 'task', 'selected']);
export const alertFields = Object.freeze(['projectId', 'slot', 'name', 'color', 'projectName', 'status']);
const attentionStates = ['needs-you', 'review', 'failed'];
const MAX_ALERTS = 20;
const short = { starting: 'Waking up', idle: 'Ready', working: 'Working', 'needs-you': 'Needs you', review: 'Ready for review',
  interrupted: 'Taking a break', failed: 'Needs recovery', offline: 'Taking a break', queued: 'Queued', setup: 'Setting up',
  'setup-failed': 'Setup failed', 'needs-repair': 'Needs repair', 'source-unavailable': 'Source missing', archived: 'Archived' };

/** The worker the mapping binds to this puffle slot, if the engine still reports it in that project. */
function workerForSlot(engineSnapshot, mappings, projectId, slot) {
  const found = puffleForSlot(mappings, projectId, slot);
  if (!found?.puffle.workerId) return null;
  return engineSnapshot?.workers?.find(item => item.id === found.puffle.workerId && item.projectId === projectId) ?? null;
}

// Resolves an explicit selection. The project must be mapped in the overlay's
// current configuration, and the worker must be one of that project's mapped
// puffles. Nothing else is substituted.
export function resolveSelection(engineSnapshot, mappings, target) {
  if (!target?.projectId || !target.workerId) return null;
  const mapped = mappings?.projects.find(item => item.projectId === target.projectId);
  const puffle = mapped?.puffles.find(item => item.workerId === target.workerId);
  if (!puffle) return null;
  const project = engineSnapshot?.projects?.find(item => item.id === target.projectId);
  if (!project || project.game?.status !== 'ready') return null;
  const worker = engineSnapshot.workers?.find(item => item.id === target.workerId && item.projectId === project.id);
  return worker ? { project, worker, puffle } : null;
}

export function attentionTotal(engineSnapshot) {
  return (engineSnapshot?.workers ?? []).filter(item => attentionStates.includes(item.status) || item.setup?.phase === 'failed').length;
}

function workerStatus(project, worker) {
  if (worker?.inspection?.repair || project?.game?.status === 'repair') return 'needs-repair';
  if (project?.sourceAvailable === false) return 'source-unavailable';
  if (project?.setup?.phase === 'failed' || worker?.setup?.phase === 'failed') return 'setup-failed';
  if (project && project.setup?.phase !== 'ready' && project.setup?.phase !== 'needs-worker') return 'setup';
  if (worker && worker.workspace?.state !== 'ready') return 'setup';
  return worker?.status ?? 'offline';
}

const currentTask = worker => {
  const task = worker?.taskHistory?.at(-1);
  return typeof task?.prompt === 'string' ? task.prompt.replace(/\s+/g, ' ').slice(0, 60) : '';
};

/** Every mapped puffle in the selected igloo, for the card's roster. */
function roster(engineSnapshot, mappings, project, selectedWorkerId) {
  const mapped = mappings?.projects.find(item => item.projectId === project?.id);
  return (mapped?.puffles ?? []).map(puffle => {
    const worker = puffle.workerId ? engineSnapshot.workers?.find(item => item.id === puffle.workerId && item.projectId === project.id) : null;
    const status = puffle.workerId && !worker ? 'offline' : workerStatus(project, worker);
    return { slot: puffle.slot, name: puffle.name.slice(0, 16), color: puffle.color ?? 'blue', status: short[status] ?? 'Waiting',
      task: currentTask(worker), selected: Boolean(worker && worker.id === selectedWorkerId) };
  });
}

/** The actual mapped puffles that need permission, an answer, recovery, or review, across every igloo. */
function alerts(engineSnapshot, mappings) {
  const result = [];
  for (const mapped of mappings?.projects ?? []) {
    const project = engineSnapshot?.projects?.find(item => item.id === mapped.projectId);
    for (const puffle of mapped.puffles) {
      const worker = puffle.workerId ? engineSnapshot.workers?.find(item => item.id === puffle.workerId && item.projectId === mapped.projectId) : null;
      if (!worker) continue;
      const status = workerStatus(project, worker);
      if (!attentionStates.includes(status) && status !== 'setup-failed' && status !== 'needs-repair') continue;
      result.push({ projectId: mapped.projectId, slot: puffle.slot, name: puffle.name.slice(0, 16), color: puffle.color ?? 'blue', projectName: mapped.name.slice(0, 30), status: short[status] });
    }
  }
  return result.slice(0, MAX_ALERTS);
}

export function nativeMenuState(engineState, mappings, target) {
  const state = engineState?.snapshot;
  const resolved = resolveSelection(state, mappings, target);
  const project = state?.projects?.find(item => item.id === target?.projectId);
  const worker = state?.workers?.find(item => item.projectId === project?.id && item.id === target?.workerId);
  // A legacy igloo whose only conversation is archived shows it read-only when its fixture puffle is clicked.
  const archive = state?.archivedWorkers?.find(item => item.projectId === project?.id && (item.id === target?.workerId ||
    (!target?.workerId && project.legacy && !state.workers?.some(other => other.projectId === project.id))));
  const known = Boolean(worker || archive || (project && !target.workerId));
  const connected = engineState?.connected === true;
  const status = archive ? 'archived' : workerStatus(project, worker);
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
    queued: 'Waiting for a free session slot. It starts on its own.',
  })[status] ?? 'Open Claude to check on your puffle.';
  const workspaceReady = (worker?.workspace?.state ?? 'ready') === 'ready';
  return { enabled: true, connected, projectId: known ? project.id : '',
    name: archive?.name ?? worker?.name ?? project?.game?.puffleName ?? 'Your Puffles', projectName: project?.name ?? '', status, activity,
    draftSlot: resolved ? resolved.puffle.slot : 0, readOnly,
    canStart: Boolean(connected && !readOnly && worker && workspaceReady && !worker.running && !worker.queued && !worker.recoveryBlocked),
    canSubmit: Boolean(connected && !readOnly && worker && worker.running && worker.established && ['idle', 'review', 'interrupted'].includes(status)),
    running: !readOnly && worker?.running === true,
    // Attention is aggregated across every active worker, not only the selection.
    attention: attentionTotal(state),
    color: resolved?.puffle.color ?? 'blue',
    roster: project ? roster(state, mappings, project, worker?.id) : [],
    alerts: alerts(state, mappings) };
}

/** The selection a roster or attention row names: a mapped puffle with a worker. */
export function selectionForSlot(engineSnapshot, mappings, projectId, slot) {
  const worker = workerForSlot(engineSnapshot, mappings, projectId, slot);
  return worker ? { projectId, workerId: worker.id } : null;
}

// `context` carries the overlay mappings and configuration generation the
// browser last applied, the fresh game snapshot, engine state, and selection.
export function allowedNativeAction({ mappings, game, generation, engineState, target } = {}, event) {
  if (!mappings || !game?.ok || !game.configured || game.playerId !== mappings.visitor.penguinId || event?.type !== 'agent-menu-action') return false;
  if (['work', 'igloos'].includes(event.action)) return true;
  // Everything else requires the current overlay generation and an explicit match.
  if (!freshSnapshot(mappings, game, generation) || event.generation !== generation) return false;
  if (event.action === 'select') return Boolean(selectionForSlot(engineState?.snapshot, mappings, event.projectId, event.draftSlot));
  const state = nativeMenuState(engineState, mappings, target);
  if (state.readOnly || !state.projectId || event.projectId !== state.projectId || event.draftSlot !== state.draftSlot) return false;
  if (['terminal', 'changes'].includes(event.action)) return true;
  if (!state.connected) return false;
  if (event.action === 'start') return state.canStart;
  if (event.action === 'interrupt') return state.running;
  return event.action === 'submit' && state.canSubmit && typeof event.text === 'string' && event.text.trim().length > 0 && event.text.length <= 20000;
}
