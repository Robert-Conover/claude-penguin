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

// ------------------------------------------------------------ app mode: sign-in and Git
// Names only. The engine never sends credential values.
const SIGN_IN_METHODS = {
  login: 'Claude will use the sign-in you make with /login inside Claude Code.',
  'api-key': 'Claude will use an Anthropic API key from your shell environment (Claude Code asks once before using it).',
  'auth-token': 'Claude will use an auth token from your shell environment.',
  'oauth-token': 'Claude will use a long-lived OAuth token from your shell environment.',
  bedrock: 'Claude will use Amazon Bedrock, selected by your shell environment.',
  vertex: 'Claude will use Google Vertex AI, selected by your shell environment.',
  foundry: 'Claude will use Microsoft Foundry, selected by your shell environment.',
  profile: 'Claude will use the Anthropic profile named in your shell environment.',
  federation: 'Claude will use federation credentials from your shell environment.',
};

export function describeSignIn(signIn) {
  if (!signIn || typeof signIn.method !== 'string') return null;
  const text = SIGN_IN_METHODS[signIn.method] ?? `Claude will use the sign-in method "${signIn.method}".`;
  const names = Array.isArray(signIn.overriddenBy) ? signIn.overriddenBy.filter(name => typeof name === 'string') : [];
  if (signIn.method === 'login' || !names.length) return { text, overridden: false, help: null };
  return {
    text: `${text} This overrides the app's /login.`, overridden: true,
    help: `To use /login instead, remove ${names.join(', ')} from your shell profile (for example, unset it in ~/.zprofile or ~/.zshrc), then restart Claude Penguin. Or keep it and sign in another way.`,
  };
}

export function describeGit(git) {
  if (!git || typeof git.source !== 'string') return null;
  if (git.source === 'user') return `Git: Claude uses your Git${git.path ? ` (${git.path})` : ''}.`;
  if (git.source === 'bundled') return 'Git: Claude uses the Git bundled with the app, because no working Git was found on your PATH.';
  return 'Git: Claude cannot find Git. Install the Xcode Command Line Tools or Git, then restart Claude Penguin.';
}

/** The page may offer Finder/editor actions only inside the macOS app's web view. */
export function hostHandler(win = globalThis.window) { return win?.webkit?.messageHandlers?.claudePenguinHost ?? null; }
export function hostMessage(type, path) { return ['reveal', 'openInEditor'].includes(type) && typeof path === 'string' && path.startsWith('/') ? { type, path } : null; }
