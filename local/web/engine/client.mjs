import { setupChooser, copyButton } from './chooser.mjs';
import { statusLabels, targetKey, resolveTarget, targetForProject, controlsForWorker, nextSnapshotRevision, terminalDimensions } from './ui-model.mjs';

const panel = document.createElement('section');
panel.id = 'cp-agent-panel';
panel.setAttribute('aria-label', 'Claude Code puffle session');
panel.hidden = true;
document.body.classList.add('cp-agent-mode');
panel.innerHTML = `<header class="cp-agent-header"><button id="cp-agent-back" aria-label="Back to puffle" hidden>‹</button><h2 id="cp-agent-title">Your puffle</h2><button id="cp-agent-close" aria-label="Close agent panel">×</button></header>
  <p id="cp-agent-connection" role="status" hidden>Connecting…</p>
  <p id="cp-agent-error" role="alert" hidden></p>
  <div id="cp-chooser" hidden>
    <div class="cp-chooser-heading"><strong id="cp-project-count"></strong><button id="cp-add-project" class="cp-primary">Add project</button></div>
    <p id="cp-visitor-problem" hidden></p>
    <form id="cp-register-form" class="cp-agent-form" hidden>
      <label>Repository path<input id="cp-repo-path" autocomplete="off" placeholder="/Users/you/Projects/my-repository" required></label>
      <label>Project name<input id="cp-project-name" maxlength="30" placeholder="Repository name"></label>
      <small>Each project gets its own igloo. Adopt up to 10 puffles for it at the Pet Shop; each puffle works from the latest commit. Uncommitted work stays in the source checkout.</small>
      <button type="submit" class="cp-primary">Create project igloo</button>
    </form>
    <div id="cp-agent-list" aria-label="Registered projects"></div><div id="cp-travel"></div>
  </div>
  <p id="cp-agent-missing" hidden></p>
  <section id="cp-archive" class="cp-agent-form" hidden><h3>Archived conversation</h3>
    <p>Continue this conversation manually in its original folder.</p><pre id="cp-archive-details"></pre>
    <div id="cp-resume"></div><h4>Task journal</h4><ol id="cp-archive-history"></ol></section>
  <div id="cp-session" hidden>
    <aside class="cp-puffle-card">
      <div class="cp-puffle-portrait"><img src="/engine/art/puffle-blue.svg" alt="Blue puffle" width="152" height="152"></div>
      <strong id="cp-agent-status"></strong><p id="cp-agent-home"></p>
      <button id="cp-agent-start" class="cp-primary">Start session</button>
      <button id="cp-tab-terminal" aria-controls="cp-view-terminal">Open Claude</button>
    </aside>
    <div class="cp-card-main">
      <nav class="cp-agent-tabs" role="tablist" aria-label="Puffle notebook">
        <button role="tab" id="cp-tab-task" aria-controls="cp-view-task" aria-selected="true">Task</button>
        <button role="tab" id="cp-tab-changes" aria-controls="cp-view-changes" aria-selected="false">Changes</button>
        <button role="tab" id="cp-tab-history" aria-controls="cp-view-history" aria-selected="false">Journal</button>
      </nav>
      <div id="cp-view-task" role="tabpanel" aria-labelledby="cp-tab-task">
        <p id="cp-agent-activity" role="status"></p>
        <form id="cp-task-form"><label for="cp-task-text">What shall we work on?</label><textarea id="cp-task-text" rows="4" placeholder="Give your puffle a task…" maxlength="20000"></textarea><button type="submit" class="cp-primary" id="cp-task-submit">Send task</button></form>
        <p class="cp-away-note">Explore the island. Your puffle stays on the job.</p>
      </div>
      <div id="cp-view-terminal" aria-labelledby="cp-tab-terminal" hidden>
        <p id="cp-terminal-status" role="status">Waiting for the terminal…</p>
        <div id="cp-terminal-host" aria-label="Claude Code terminal"></div>
        <div class="cp-terminal-footer"><span>Answer Claude's questions and permissions here.</span><button id="cp-agent-interrupt">Interrupt turn</button><button id="cp-agent-stop">Stop session</button></div>
        <details id="cp-session-details"><summary>Session details</summary><p id="cp-agent-project"></p><p id="cp-agent-session-id"></p><p id="cp-agent-runtime-activity"></p></details>
      </div>
      <div id="cp-view-changes" role="tabpanel" aria-labelledby="cp-tab-changes" hidden><div class="cp-changes-heading"><h3>Changes</h3><button id="cp-refresh-diff" aria-label="Refresh changes">↻</button></div><p id="cp-diff-summary">Review your project's changes here.</p><pre id="cp-diff-details"></pre><div id="cp-copy"></div><pre id="cp-diff"></pre><div id="cp-untracked"></div></div>
      <div id="cp-view-history" role="tabpanel" aria-labelledby="cp-tab-history" hidden><h3>Task journal</h3><p>Finished turns still need your review.</p><ol id="cp-history"></ol></div>
    </div>
  </div>`;
document.body.append(panel);
const el = id => document.getElementById(id);
let snapshot = { projects: [], workers: [] }, selected = null, choosing = true, destinations = [];
let connected = false, token = '', socket, epoch = 0, retryDelay = 500, retryTimer;
let busy = false, currentView = 'task', term, fit, terminalObserver, terminalReady = false, attachedKey = '', lastSize = '';
let selectionRevision = 0, diffRequest = 0;
const drafts = new Map();
let diffFor = '', initialTerminalError = '';
let lastRevision = -1, errorKind = '', nativeReturn = null;

function announce() { window.dispatchEvent(new CustomEvent('cp-engine-state', { detail: { connected, snapshot } })); }
function error(message = '', kind = 'action') {
  errorKind = message ? kind : '';
  el('cp-agent-error').hidden = !message;
  el('cp-agent-error').textContent = message;
}
function visibility(open) {
  if (!open) nativeReturn = null;
  panel.hidden = !open;
  window.dispatchEvent(new CustomEvent('cp-engine-visibility', { detail: { open } }));
}
function disposeTerminal() {
  terminalObserver?.disconnect();
  terminalObserver = null;
  term?.dispose();
  term = null;
  fit = null;
  el('cp-terminal-host').replaceChildren();
}
function select(target) {
  if (targetKey(target) !== targetKey(selected)) {
    selectionRevision++;
    error();
    if (selected?.workerId) drafts.set(selected.workerId, el('cp-task-text').value);
    if (attachedKey) send({ type: 'detach' });
    nativeReturn = null;
    terminalReady = false;
    attachedKey = '';
    lastSize = '';
    diffFor = '';
    el('cp-task-text').value = drafts.get(target?.workerId) ?? '';
    el('cp-diff-summary').textContent = '';
    el('cp-diff-details').textContent = '';
    el('cp-copy').replaceChildren();
    el('cp-diff').textContent = '';
    el('cp-untracked').replaceChildren();
    disposeTerminal();
  }
  selected = target;
  window.dispatchEvent(new CustomEvent('cp-engine-selection', { detail: selected }));
  render();
}
// Game routing names a project UUID and, when a puffle was clicked, its worker.
// There is no fixture lookup and no fallback to another project's worker.
window.ClaudePenguinEngine = {
  select,
  setDestinations(ids) { if (ids.join() !== destinations.join()) { destinations = ids; render(); } },
  open(target, view = 'task') { choosing = false; select(target); visibility(true); showView(view); },
  openList() { select(null); this.openIgloos(); },
  openIgloos() { choosing = true; nativeReturn = null; visibility(true); showView('task'); },
  toggle() { if (panel.hidden) { visibility(true); showView('task'); } else this.close(); },
  close() { visibility(false); },
  openForProject(projectId, workerId = null, view = 'task') {
    if (!snapshot.projects.some(project => project.id === projectId)) {
      this.openList();
      error('This project is no longer registered.');
      return;
    }
    const target = targetForProject(snapshot, projectId, workerId ?? null) ?? { projectId, workerId: workerId ?? null };
    this.open(target, view);
  },
  async handleNativeAction({ projectId, workerId, action: actionName, text } = {}) {
    const target = targetForProject(snapshot, projectId, workerId ?? null);
    const resolved = resolveTarget(snapshot, target);
    try {
      if (!workerId || !target || !resolved) throw new Error('This puffle has no connected session.');
      if (actionName === 'terminal' || actionName === 'changes') {
        this.open(target, actionName);
        nativeReturn = { ...target };
        return true;
      }
      const controls = controlsForWorker(connected, resolved, true);
      if (!['start', 'submit', 'interrupt'].includes(actionName) || !controls[actionName]) throw new Error('That action is not available for this puffle right now.');
      await action(actionName, { ...target, ...(actionName === 'submit' ? { text } : {}) });
      return true;
    } catch (problem) {
      if (targetKey(selected) === targetKey(target)) { this.openForProject(projectId, workerId ?? null); error(problem.message); }
      return false;
    }
  },
  openView(view, target) { this.open(target ?? selected, view); },
  getState() { return { connected, snapshot }; },
  /** Engine actions for the in-game adoption flow (web/bridge/adoption.mjs). */
  request(name, values) {
    if (!['adopt', 'adoptionResult', 'cancelAdoption', 'reconcile'].includes(name)) return Promise.reject(new Error('Unknown adoption action.'));
    return engineRequest(name, values);
  },
};
el('cp-agent-close').onclick = () => visibility(false);

function send(message) {
  if (!connected || socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}
function fitTerminal() {
  if (!term || !fit || panel.hidden || currentView !== 'terminal' || !terminalReady) return;
  let size;
  try { size = terminalDimensions(fit.proposeDimensions()); } catch { return; }
  if (!size) return;
  if (term.cols !== size.cols || term.rows !== size.rows) term.resize(size.cols, size.rows);
  if (!selected || !connected || !resolveTarget(snapshot, selected)?.worker.running) return;
  const key = `${size.cols}x${size.rows}`;
  if (key !== lastSize) {
    if (send({ type: 'resize', ...selected, attachment: selectionRevision, ...size })) lastSize = key;
  }
}
function initializeTerminal() {
  if (term || initialTerminalError) return;
  if (!window.Terminal || !window.FitAddon?.FitAddon) {
    initialTerminalError = 'The terminal library did not load. Reload the page after checking the local runtime.';
    return;
  }
  term = new window.Terminal({
    cols: 120, rows: 32, fontSize: 13, cursorBlink: true, scrollback: 5000,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    theme: { background: '#102637', foreground: '#e8f4f8', cursor: '#f8d986', selectionBackground: '#466b83' },
    macOptionIsMeta: true, allowProposedApi: true,
  });
  fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el('cp-terminal-host'));
  if (term.textarea) term.textarea.setAttribute('aria-label', 'Claude Code terminal input');
  const terminal = term;
  term.onData(data => {
    if (term !== terminal) return;
    if (controlsForWorker(connected, resolveTarget(snapshot, selected), terminalReady).input) {
      fitTerminal();
      send({ type: 'input', ...selected, attachment: selectionRevision, data });
    }
  });
  terminalObserver = new ResizeObserver(fitTerminal);
  terminalObserver.observe(el('cp-terminal-host'));
}
function attachTerminal() {
  const resolved = resolveTarget(snapshot, selected);
  if (!connected || !resolved || !term) return;
  const key = targetKey(selected);
  if (attachedKey !== key) {
    terminalReady = false;
    attachedKey = key;
    lastSize = '';
    send({ type: 'attach', ...selected, attachment: selectionRevision });
  }
}
function applySnapshot(next) {
  if (!Array.isArray(next?.projects) || !Array.isArray(next?.workers)) throw new Error('Invalid runtime snapshot.');
  const revision = nextSnapshotRevision(lastRevision, next.revision);
  if (revision === null) return;
  lastRevision = revision;
  snapshot = next;
  if (selected && !selected.workerId) {
    const target = targetForProject(snapshot, selected.projectId);
    if (target) select(target);
  }
  if (selected && !snapshot.projects.some(project => project.id === selected.projectId)) select(null);
  if (selected && !resolveTarget(snapshot, selected)) { terminalReady = false; attachedKey = ''; }
  render();
  announce();
}
const renderChooser = setupChooser({ el, action, report: error,
  getState: () => ({ snapshot }),
  openWork(projectId, workerId, view) {
    if (view === 'archive') return window.ClaudePenguinEngine.openForProject(projectId, workerId);
    select({ projectId, workerId });
    window.dispatchEvent(new Event('cp-open-work'));
  },
  visit(projectId) { window.dispatchEvent(new CustomEvent('cp-visit', { detail: projectId })); },
});

function renderHistory(list, records = []) {
  list.replaceChildren();
  for (const item of [...records].reverse()) {
    const row = document.createElement('li');
    const time = item.at || item.createdAt || item.startedAt;
    const title = item.prompt || item.text || item.event || item.type || item.status || 'Session event';
    row.textContent = [time && new Date(time).toLocaleString(), title, item.status !== title && item.status].filter(Boolean).join(' · ');
    list.append(row);
  }
  if (!records.length) { const item = document.createElement('li'); item.textContent = 'No tasks recorded.'; list.append(item); }
}

function render() {
  const resolved = resolveTarget(snapshot, selected);
  const worker = resolved?.worker;
  const controls = controlsForWorker(connected, resolved, terminalReady);
  el('cp-agent-connection').hidden = connected;
  el('cp-agent-connection').textContent = 'Your puffle is offline. Waiting for the local runtime…';
  const archived = snapshot.archivedWorkers?.find(item => item.projectId === selected?.projectId && item.id === selected?.workerId);
  const project = snapshot.projects.find(item => item.id === selected?.projectId);
  el('cp-agent-title').textContent = choosing ? 'Your Igloos' : worker ? (currentView === 'terminal' ? worker.name + ' · Claude' : worker.name) : archived?.name ?? project?.name ?? 'Your puffle';
  el('cp-chooser').hidden = !choosing;
  if (choosing) renderChooser({ snapshot, connected, busy, destinations });
  el('cp-agent-missing').hidden = choosing || Boolean(worker || archived);
  el('cp-agent-missing').textContent = project?.setup?.error || project?.setup?.step || (project && !selected?.workerId
    ? 'Click a puffle in this igloo, or choose one in Your Igloos.' : 'This puffle has no active session. Open Your Igloos to manage this project.');
  el('cp-archive').hidden = choosing || !archived;
  if (!choosing && archived) {
    el('cp-archive-details').textContent = [archived.originalPath, 'Session ' + archived.sessionId, archived.resumeCommand].filter(Boolean).join('\n');
    el('cp-resume').replaceChildren(copyButton('Copy resume command', archived.resumeCommand, error));
    renderHistory(el('cp-archive-history'), archived.taskHistory);
  }
  el('cp-session').hidden = choosing || !resolved;
  el('cp-agent-start').disabled = !controls.start || busy;
  el('cp-agent-start').hidden = Boolean(worker?.running);
  el('cp-tab-terminal').disabled = !resolved;
  panel.dataset.attention = String(Boolean(worker && ['needs-you', 'failed'].includes(worker.status)));
  panel.dataset.view = currentView;
  el('cp-agent-interrupt').disabled = !controls.interrupt || busy;
  el('cp-agent-stop').disabled = !controls.stop || busy;
  el('cp-task-submit').disabled = !controls.submit || busy;
  el('cp-task-text').disabled = !controls.submit || busy;
  el('cp-refresh-diff').disabled = !controls.diff || busy;
  if (choosing || !worker) return;
  el('cp-agent-status').textContent = statusLabels[worker.status] ?? 'Unknown state';
  el('cp-agent-status').dataset.state = worker.status;
  el('cp-agent-home').textContent = resolved.project.name;
  el('cp-agent-runtime-activity').textContent = worker.activity || worker.detail || '';
  el('cp-agent-activity').textContent = !connected ? 'Reconnect to give your puffle a task.' : worker.queued ? worker.activity : !worker.running ? 'Start your puffle when you are ready.' : ({ starting: 'Waking up… Open Claude for any setup questions.', idle: 'Ready for your next idea!', working: 'On the job! You can keep exploring.', 'needs-you': 'Your puffle needs you. Open Claude to answer.', review: 'A turn has ended. Check Claude and review the changes.', interrupted: 'The turn was interrupted. Check Claude before continuing.', failed: 'Something went wrong. Open Claude to take a look.' })[worker.status] ?? 'Open Claude to see what is happening.';
  el('cp-agent-project').textContent = `${resolved.project.name} · ${resolved.project.sourcePath}`;
  el('cp-agent-session-id').textContent = `Session ${worker.sessionId}`;
  el('cp-agent-start').textContent = worker.queued ? 'Queued…' : worker.established ? 'Resume session' : 'Start session';
  el('cp-terminal-status').textContent = initialTerminalError || (!connected ? 'Disconnected. Displayed terminal output may be stale.' : !terminalReady ? 'Attaching to the session terminal…' : !worker.running ? 'Session process is stopped. Start or resume to continue.' : worker.status === 'needs-you' ? 'Claude needs a response. Use the terminal below.' : 'Connected to the live session terminal.');
  renderHistory(el('cp-history'), worker.taskHistory);
  if (worker.inspection?.repair) el('cp-agent-activity').textContent = worker.inspection.repair;
  if (worker.outsideWorkspace) el('cp-agent-activity').textContent += worker.outsideWorkspace.nestedRepository ? ' Claude is inside a nested repository.' : ' Claude is outside this worktree.';
  initializeTerminal();
  if (term) term.options.disableStdin = !controls.input;
  attachTerminal();
}

/** One authenticated engine action, without the panel's busy state. */
async function engineRequest(name, values = {}) {
  if (!connected) throw new Error('Wait for the local runtime connection.');
  const currentEpoch = epoch;
  const response = await fetch('/engine/action', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: name, ...values }), signal: AbortSignal.timeout(30000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'The runtime rejected the action.');
  if (currentEpoch === epoch && body.snapshot) applySnapshot(body.snapshot);
  return body.result;
}

async function action(name, values = {}) {
  const mutation = name !== 'diff';
  if (!connected || (mutation && busy)) throw new Error('Wait for the local runtime connection.');
  const currentEpoch = epoch;
  if (mutation) busy = true;
  error();
  render();
  try {
    const response = await fetch('/engine/action', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: name, ...values }), signal: AbortSignal.timeout(30000),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'The runtime rejected the action.');
    if (currentEpoch !== epoch) throw new Error('The runtime connection changed. Check the refreshed session before continuing.');
    if (body.snapshot) applySnapshot(body.snapshot);
    return body.result;
  } finally { if (mutation) busy = false; render(); }
}
function run(actionName) {
  const target = selected && { ...selected };
  if (!resolveTarget(snapshot, target)) return;
  const revision = selectionRevision;
  action(actionName, target).catch(problem => { if (revision === selectionRevision) error(problem.message); });
}
el('cp-agent-start').onclick = () => { showView('terminal'); run('start'); };
el('cp-agent-interrupt').onclick = () => run('interrupt');
el('cp-agent-stop').onclick = () => run('stop');
el('cp-task-form').onsubmit = async event => {
  event.preventDefault();
  const text = el('cp-task-text').value.trim();
  const target = selected && { ...selected };
  if (!text || !controlsForWorker(connected, resolveTarget(snapshot, target), terminalReady).submit) return;
  try {
    await action('submit', { ...target, text });
    if (targetKey(target) === targetKey(selected) && el('cp-task-text').value.trim() === text) el('cp-task-text').value = '';
    if (drafts.get(target.workerId)?.trim() === text) drafts.delete(target.workerId);
  } catch (problem) { if (targetKey(target) === targetKey(selected)) error(problem.message); }
};

async function refreshDiff() {
  const target = selected && { ...selected };
  if (!resolveTarget(snapshot, target)) return;
  const revision = selectionRevision;
  const key = targetKey(target);
  const request = ++diffRequest;
  el('cp-diff-summary').textContent = 'Reading current repository changes…';
  try {
    const result = await action('diff', target);
    if (revision !== selectionRevision || request !== diffRequest) return;
    diffFor = key;
    el('cp-diff-summary').textContent = 'Changes include commits and current edits since the baseline. A completed turn still needs verification. Stop the session before changing branches outside the engine.';
    el('cp-diff-details').textContent = [
      'Source checkout  ' + result.sourcePath, 'Worktree  ' + result.worktreePath,
      'Branch  ' + (result.branch ?? 'Detached HEAD'), 'Expected branch  ' + result.expectedBranch,
      'Baseline  ' + result.baseCommit, 'HEAD  ' + result.head, 'Merge base  ' + (result.mergeBase ?? 'No shared history'),
      result.dirty ? 'Worktree has uncommitted changes.' : 'Worktree is clean.',
      'Untracked paths listed  ' + result.untrackedListed + (result.untrackedListTruncated ? ' or more (listing truncated)' : ''),
      ...(result.warnings ?? []).map(item => item.message), result.truncated && 'Large changes or previews have been shortened.',
    ].filter(Boolean).join('\n');
    el('cp-copy').replaceChildren(copyButton('Copy path', result.worktreePath, error), copyButton('Copy branch', result.branch, error));
    el('cp-diff').textContent = [result.status, result.diff].filter(Boolean).join('\n\n') || 'No tracked changes.';
    el('cp-untracked').replaceChildren();
    for (const file of result.untracked ?? []) {
      const section = document.createElement('section');
      const title = document.createElement('h4');
      title.textContent = typeof file === 'string' ? file : file.path;
      const content = document.createElement('pre');
      content.textContent = typeof file === 'string' ? 'Untracked file' : file.content ?? (file.skipped ? `Preview skipped: ${file.skipped}` : 'Untracked file');
      section.append(title, content);
      if (file.truncated) { const note = document.createElement('p'); note.textContent = 'Preview truncated.'; section.append(note); }
      el('cp-untracked').append(section);
    }
  } catch (problem) { if (revision === selectionRevision && request === diffRequest) error(problem.message); }
}
el('cp-refresh-diff').onclick = refreshDiff;
function showView(view) {
  if (!['task', 'terminal', 'changes', 'history'].includes(view)) return;
  currentView = view;
  panel.dataset.view = view;
  el('cp-agent-back').hidden = view === 'task';
  for (const candidate of ['task', 'terminal', 'changes', 'history']) {
    el(`cp-view-${candidate}`).hidden = candidate !== view;
    if (candidate !== 'terminal') el(`cp-tab-${candidate}`).setAttribute('aria-selected', String(candidate === view));
  }
  render();
  if (view === 'terminal') requestAnimationFrame(fitTerminal);
  if (view === 'changes' && diffFor !== targetKey(selected)) refreshDiff();
}
el('cp-agent-back').onclick = () => {
  const target = nativeReturn;
  if (!target) return showView('task');
  visibility(false);
  const event = new CustomEvent('cp-engine-native-return', { detail: { ...target }, cancelable: true });
  window.dispatchEvent(event);
  // A missing or unready game bridge leaves the ordinary task card available.
  if (!event.defaultPrevented) window.ClaudePenguinEngine.openForProject(target.projectId, target.workerId);
};
for (const view of ['task', 'terminal', 'changes', 'history']) el(`cp-tab-${view}`).onclick = () => {
  if (view === 'task' && nativeReturn) return el('cp-agent-back').onclick();
  showView(view);
};

function disconnect(message) {
  connected = false;
  terminalReady = false;
  attachedKey = '';
  lastSize = '';
  if (term) term.options.disableStdin = true;
  render();
  announce();
  if (message) error(message, 'connection');
}
async function connect() {
  clearTimeout(retryTimer);
  const generation = ++epoch;
  lastRevision = -1;
  disconnect();
  try {
    const response = await fetch('/engine/bootstrap', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('The local agent runtime is unavailable.');
    const bootstrap = await response.json();
    if (generation !== epoch) return;
    if (typeof bootstrap.token !== 'string' || !bootstrap.token) throw new Error('The runtime did not provide a browser session.');
    token = bootstrap.token;
    applySnapshot(bootstrap.snapshot);
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/engine/ws`);
    socket = ws;
    ws.onopen = () => { if (generation === epoch) ws.send(JSON.stringify({ type: 'auth', token })); };
    ws.onmessage = ({ data }) => {
      if (generation !== epoch) return;
      try {
        const message = JSON.parse(data);
        if (message.type === 'snapshot') {
          if (!connected && errorKind === 'connection') error();
          connected = true;
          retryDelay = 500;
          applySnapshot(message.snapshot);
        } else if (message.type === 'terminal.snapshot' && targetKey(message) === targetKey(selected) && attachedKey === targetKey(selected) && message.attachment === selectionRevision) {
          initializeTerminal();
          if (!term) return render();
          terminalReady = false;
          term.reset();
          if (Number.isInteger(message.cols) && Number.isInteger(message.rows)) term.resize(message.cols, message.rows);
          const terminal = term;
          term.write(message.data || '', () => {
            if (term !== terminal || generation !== epoch || targetKey(message) !== targetKey(selected)) return;
            terminalReady = true;
            render();
            fitTerminal();
          });
        } else if (message.type === 'terminal' && targetKey(message) === targetKey(selected) && attachedKey === targetKey(selected) && message.attachment === selectionRevision) {
          term?.write(message.data || '');
        } else if (message.type === 'error' && (!message.workerId || (targetKey(message) === targetKey(selected) && message.attachment === selectionRevision))) error(message.error || message.message || 'The runtime rejected a terminal action.');
      } catch (problem) { error(problem.message); }
    };
    ws.onerror = () => { /* onclose owns reconnect, including failed handshakes. */ };
    ws.onclose = () => {
      if (generation !== epoch) return;
      disconnect();
      retryTimer = setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 5000);
    };
  } catch (problem) {
    if (generation !== epoch) return;
    disconnect(problem.message);
    retryTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 5000);
  }
}
window.addEventListener('beforeunload', () => { clearTimeout(retryTimer); epoch++; socket?.close(); });
render();
connect();
