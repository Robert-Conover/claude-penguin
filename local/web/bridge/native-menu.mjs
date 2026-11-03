// Flash receives only display state and fixture identity. Host paths, session IDs,
// terminal contents, and authentication tokens stay in the browser/runtime layer.
export function nativeMenuState(engineState) {
  const state = engineState?.snapshot;
  const worker = state?.workers?.length === 1 ? state.workers[0] : null;
  const project = worker && state.projects?.find(item => item.id === worker.projectId);
  const connected = engineState?.connected === true;
  const status = worker?.status ?? 'offline';
  const activity = !connected ? 'Your puffle is waiting for the local runtime.' : ({
    starting: 'Waking up…', idle: 'Ready for a new task!', working: 'Working on your task…',
    'needs-you': 'Open Claude to check what your puffle needs.',
    review: 'The turn ended. Take a look at the changes.',
    interrupted: 'Taking a break. You can pick up where you left off.',
    failed: 'Something went wrong. Open Claude to take a look.',
    offline: 'Start your puffle when you are ready.',
  })[status] ?? 'Open Claude to check on your puffle.';
  return { enabled: true, connected, fixtureId: project?.fixtureId ?? '',
    name: worker?.name ?? 'Your Puffles', projectName: project?.name ?? '', status, activity,
    established: worker?.established === true, running: worker?.running === true,
    canStart: Boolean(connected && project && !worker.running && !worker.recoveryBlocked),
    canSubmit: Boolean(connected && project && worker.running && worker.established && ['idle', 'review', 'interrupted'].includes(status)),
    attention: (state?.workers ?? []).filter(item => ['needs-you', 'review', 'failed'].includes(item.status)).length };
}

export function allowedNativeAction(fixtures, game, engineState, event) {
  if (!fixtures || !game?.ok || !game.configured || game.playerId !== fixtures.visitor.penguinId || event?.type !== 'agent-menu-action') return false;
  if (['work', 'igloos'].includes(event.action)) return true;
  const state = nativeMenuState(engineState);
  if (!state.fixtureId || event.fixtureId !== state.fixtureId || !fixtures.projects.some(item => item.projectId === event.fixtureId)) return false;
  if (['terminal', 'changes'].includes(event.action)) return true;
  if (!state.connected) return false;
  if (event.action === 'start') return state.canStart;
  if (event.action === 'interrupt') return state.running;
  return event.action === 'submit' && state.canSubmit && typeof event.text === 'string' && event.text.trim().length > 0 && event.text.length <= 20000;
}
