import { statusLabels, targetKey, resolveTarget, targetForFixture, controlsForWorker, nextSnapshotRevision, terminalDimensions } from './ui-model.mjs';

const panel = document.createElement('section');
panel.id = 'cp-agent-panel';
panel.setAttribute('aria-label', 'Claude Code puffle session');
panel.hidden = true;
document.body.classList.add('cp-agent-mode');
panel.innerHTML = `<header class="cp-agent-header"><button id="cp-agent-back" aria-label="Back to puffle" hidden>‹</button><h2 id="cp-agent-title">Your puffle</h2><button id="cp-agent-close" aria-label="Close agent panel">×</button></header>
  <p id="cp-agent-connection" role="status" hidden>Connecting…</p>
  <p id="cp-agent-error" role="alert" hidden></p>
  <div id="cp-agent-list" aria-label="Registered puffle sessions" hidden></div>
  <p id="cp-agent-missing" hidden></p>
  <form id="cp-register-form" class="cp-agent-form" hidden>
    <h3>A home for your project</h3><p>Connect a repository to Atlas's igloo.</p>
    <label>Repository path<input id="cp-repo-path" name="path" placeholder="/Users/you/Projects/my-repository" autocomplete="off" required></label>
    <label>Igloo name<input id="cp-project-name" name="name" placeholder="My project" maxlength="80" required></label>
    <button type="submit" class="cp-primary">Connect repository</button>
    <small>One project and one puffle for now.</small>
  </form>
  <form id="cp-create-form" class="cp-agent-form" hidden>
    <h3>Meet your puffle!</h3><p id="cp-create-project"></p>
    <label>Puffle name<input id="cp-worker-name" name="name" value="Atlas" maxlength="80" required></label>
    <button type="submit" class="cp-primary">Create puffle session</button>
  </form>
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
      <div id="cp-view-changes" role="tabpanel" aria-labelledby="cp-tab-changes" hidden><div class="cp-changes-heading"><h3>Changes</h3><button id="cp-refresh-diff" aria-label="Refresh changes">↻</button></div><p id="cp-diff-summary">Review your project's changes here.</p><pre id="cp-diff"></pre><div id="cp-untracked"></div></div>
      <div id="cp-view-history" role="tabpanel" aria-labelledby="cp-tab-history" hidden><h3>Task journal</h3><p>Finished turns still need your review.</p><ol id="cp-history"></ol></div>
    </div>
  </div>`;
document.body.append(panel);
const el = id => document.getElementById(id);
let snapshot = { projects: [], workers: [] }, selected = null, requestedFixture = null;
let connected = false, token = '', socket, epoch = 0, retryDelay = 500, retryTimer;
let busy = false, currentView = 'task', term, fit, terminalObserver, terminalReady = false, attachedKey = '', lastSize = '';
let selectedOnce = false, diffFor = '', initialTerminalError = '';
let lastRevision = -1, errorKind = '', nativeReturnFixture = null;

function announce() { window.dispatchEvent(new CustomEvent('cp-engine-state', { detail: { connected, snapshot } })); }
function error(message = '', kind = 'action') {
  errorKind = message ? kind : '';
  el('cp-agent-error').hidden = !message;
  el('cp-agent-error').textContent = message;
}
function visibility(open) {
  if (!open) nativeReturnFixture = null;
  panel.hidden = !open;
  window.dispatchEvent(new CustomEvent('cp-engine-visibility', { detail: { open } }));
  if (open) showView('task');
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
  selectedOnce = true;
  if (targetKey(target) !== targetKey(selected)) {
    nativeReturnFixture = null;
    terminalReady = false;
    attachedKey = '';
    lastSize = '';
    diffFor = '';
    el('cp-task-text').value = '';
    el('cp-diff').textContent = '';
    el('cp-untracked').replaceChildren();
    disposeTerminal();
  }
  selected = target;
  requestedFixture = null;
  render();
}
window.ClaudePenguinEngine = {
  open(target, view = 'task') { nativeReturnFixture = null; if (target) select(target); visibility(true); showView(view); render(); },
  toggle() { visibility(panel.hidden); render(); },
  close() { visibility(false); },
  openForFixture(fixtureId, view = 'task') {
    nativeReturnFixture = null;
    requestedFixture = fixtureId;
    selectedOnce = true;
    const target = targetForFixture(snapshot, fixtureId);
    if (target) select(target);
    else {
      selected = null;
      terminalReady = false;
      attachedKey = '';
      disposeTerminal();
    }
    visibility(true);
    showView(view);
    render();
  },
  async handleNativeAction({ fixtureId, action: actionName, text } = {}) {
    const target = targetForFixture(snapshot, fixtureId);
    const resolved = resolveTarget(snapshot, target);
    try {
      if (!target || !resolved) throw new Error('This puffle has no connected session.');
      if (actionName === 'terminal' || actionName === 'changes') {
        this.open(target, actionName);
        nativeReturnFixture = fixtureId;
        return true;
      }
      const controls = controlsForWorker(connected, resolved, true);
      if (!['start', 'submit', 'interrupt'].includes(actionName) || !controls[actionName]) throw new Error('That action is not available for this puffle right now.');
      await action(actionName, { ...target, ...(actionName === 'submit' ? { text } : {}) });
      return true;
    } catch (problem) {
      this.openForFixture(fixtureId);
      error(problem.message);
      return false;
    }
  },
  openView(view, target) { nativeReturnFixture = null; if (target) select(target); visibility(true); showView(view); render(); },
  getState() { return { connected, snapshot }; },
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
    if (send({ type: 'resize', ...selected, ...size })) lastSize = key;
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
  term.onData(data => {
    if (controlsForWorker(connected, resolveTarget(snapshot, selected), terminalReady).input) {
      fitTerminal();
      send({ type: 'input', ...selected, data });
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
    send({ type: 'attach', ...selected });
  }
}
function applySnapshot(next) {
  if (!Array.isArray(next?.projects) || !Array.isArray(next?.workers)) throw new Error('Invalid runtime snapshot.');
  const revision = nextSnapshotRevision(lastRevision, next.revision);
  if (revision === null) return;
  lastRevision = revision;
  snapshot = next;
  if (!selectedOnce && snapshot.workers.length === 1) {
    const worker = snapshot.workers[0];
    selected = { projectId: worker.projectId, workerId: worker.id };
    selectedOnce = true;
  }
  if (requestedFixture && !selected) {
    const target = targetForFixture(snapshot, requestedFixture);
    if (target) select(target);
  }
  if (selected && !resolveTarget(snapshot, selected)) { terminalReady = false; attachedKey = ''; }
  render();
  announce();
}
function render() {
  const resolved = resolveTarget(snapshot, selected);
  const worker = resolved?.worker;
  const controls = controlsForWorker(connected, resolved, terminalReady);
  el('cp-agent-connection').hidden = connected;
  el('cp-agent-connection').textContent = 'Your puffle is offline. Waiting for the local runtime…';
  el('cp-agent-title').textContent = worker ? (currentView === 'terminal' ? `${worker.name} · Claude` : worker.name) : 'Your puffle';
  const list = el('cp-agent-list');
  list.replaceChildren();
  for (const item of snapshot.workers) {
    const project = snapshot.projects.find(candidate => candidate.id === item.projectId);
    if (!project) continue;
    const button = document.createElement('button');
    button.className = 'cp-agent-select';
    button.textContent = `${item.name} · ${project.name} · ${statusLabels[item.status] ?? 'Unknown state'}`;
    button.setAttribute('aria-pressed', String(targetKey(selected) === `${project.id}/${item.id}`));
    button.onclick = () => { error(); select({ projectId: project.id, workerId: item.id }); };
    list.append(button);
  }
  list.hidden = Boolean(resolved) && snapshot.workers.length <= 1 || snapshot.workers.length === 0;
  const projectWithoutWorker = snapshot.projects.find(project => !snapshot.workers.some(item => item.projectId === project.id));
  const fixtureUnavailable = requestedFixture && requestedFixture !== 'bridge-alpha' && !targetForFixture(snapshot, requestedFixture);
  const missing = selected && !resolved;
  el('cp-agent-missing').hidden = !missing && !fixtureUnavailable;
  el('cp-agent-missing').textContent = missing ? 'This selected project or session is unavailable. Choose an existing puffle explicitly to continue.' : 'This puffle has no connected session. The first version connects Atlas in Bridge Alpha.';
  el('cp-register-form').hidden = snapshot.projects.length > 0 || Boolean(fixtureUnavailable);
  el('cp-create-form').hidden = !projectWithoutWorker || Boolean(fixtureUnavailable) || Boolean(missing);
  if (projectWithoutWorker) el('cp-create-project').textContent = `${projectWithoutWorker.name} · ${projectWithoutWorker.path}`;
  panel.querySelectorAll('#cp-register-form button, #cp-create-form button').forEach(button => { button.disabled = !connected || busy; });
  el('cp-session').hidden = !resolved;
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
  if (!worker) return;
  el('cp-agent-status').textContent = statusLabels[worker.status] ?? 'Unknown state';
  el('cp-agent-status').dataset.state = worker.status;
  el('cp-agent-home').textContent = resolved.project.name;
  el('cp-agent-runtime-activity').textContent = worker.activity || worker.detail || '';
  el('cp-agent-activity').textContent = !connected ? 'Reconnect to give your puffle a task.' : !worker.running ? 'Start your puffle when you are ready.' : ({ starting: 'Waking up… Open Claude for any setup questions.', idle: 'Ready for your next idea!', working: 'On the job! You can keep exploring.', 'needs-you': 'Your puffle needs you. Open Claude to answer.', review: 'A turn has ended. Check Claude and review the changes.', interrupted: 'The turn was interrupted. Check Claude before continuing.', failed: 'Something went wrong. Open Claude to take a look.' })[worker.status] ?? 'Open Claude to see what is happening.';
  el('cp-agent-project').textContent = `${resolved.project.name} · ${resolved.project.path}`;
  el('cp-agent-session-id').textContent = `Session ${worker.sessionId}`;
  el('cp-agent-start').textContent = worker.established ? 'Resume session' : 'Start session';
  el('cp-terminal-status').textContent = initialTerminalError || (!connected ? 'Disconnected. Displayed terminal output may be stale.' : !terminalReady ? 'Attaching to the session terminal…' : !worker.running ? 'Session process is stopped. Start or resume to continue.' : worker.status === 'needs-you' ? 'Claude needs a response. Use the terminal below.' : 'Connected to the live session terminal.');
  const history = el('cp-history');
  history.replaceChildren();
  for (const item of [...(worker.taskHistory ?? worker.history ?? [])].reverse()) {
    const row = document.createElement('li');
    const time = item.at || item.createdAt || item.startedAt;
    const title = item.prompt || item.text || item.event || item.type || item.status || 'Session event';
    row.textContent = `${time ? new Date(time).toLocaleString() + ' · ' : ''}${title}${item.status && item.status !== title ? ` · ${item.status}` : ''}`;
    history.append(row);
  }
  if (!history.childElementCount) { const item = document.createElement('li'); item.textContent = 'No tasks have been submitted in this session yet.'; history.append(item); }
  initializeTerminal();
  if (term) term.options.disableStdin = !controls.input;
  attachTerminal();
}

async function action(name, values = {}) {
  if (!connected || busy) throw new Error('Wait for the local runtime connection.');
  const currentEpoch = epoch;
  busy = true;
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
  } finally { busy = false; render(); }
}
function run(actionName) {
  const target = selected && { ...selected };
  if (!resolveTarget(snapshot, target)) return;
  action(actionName, target).catch(problem => error(problem.message));
}
el('cp-agent-start').onclick = () => { showView('terminal'); run('start'); };
el('cp-agent-interrupt').onclick = () => run('interrupt');
el('cp-agent-stop').onclick = () => run('stop');
el('cp-register-form').onsubmit = async event => {
  event.preventDefault();
  try {
    await action('register', { path: el('cp-repo-path').value.trim(), name: el('cp-project-name').value.trim(), fixtureId: 'bridge-alpha' });
  } catch (problem) { error(problem.message); }
};
el('cp-create-form').onsubmit = async event => {
  event.preventDefault();
  const project = snapshot.projects.find(item => !snapshot.workers.some(worker => worker.projectId === item.id));
  if (!project) return error('The selected repository is no longer available.');
  try {
    const result = await action('create', { projectId: project.id, name: el('cp-worker-name').value.trim() });
    const created = result?.worker ?? result;
    if (created?.id) select({ projectId: project.id, workerId: created.id });
  } catch (problem) { error(problem.message); }
};
el('cp-task-form').onsubmit = async event => {
  event.preventDefault();
  const text = el('cp-task-text').value.trim();
  const target = selected && { ...selected };
  if (!text || !controlsForWorker(connected, resolveTarget(snapshot, target), terminalReady).submit) return;
  try {
    await action('submit', { ...target, text });
    if (targetKey(target) === targetKey(selected)) el('cp-task-text').value = '';
  } catch (problem) { error(problem.message); }
};

async function refreshDiff() {
  const target = selected && { ...selected };
  if (!resolveTarget(snapshot, target)) return;
  const key = targetKey(target);
  el('cp-diff-summary').textContent = 'Reading current repository changes…';
  try {
    const result = await action('diff', target);
    if (key !== targetKey(selected)) return;
    diffFor = key;
    el('cp-diff-summary').textContent = `Changes since this puffle was created.${result.dirtyAtStart ? ' Includes edits that were already in the repository.' : ''}${result.truncated ? ' Large changes have been shortened.' : ''}`;
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
  } catch (problem) { if (key === targetKey(selected)) error(problem.message); }
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
  const fixtureId = nativeReturnFixture;
  if (!fixtureId) return showView('task');
  visibility(false);
  const event = new CustomEvent('cp-engine-native-return', { detail: { fixtureId }, cancelable: true });
  window.dispatchEvent(event);
  // A missing or unready game bridge leaves the ordinary task card available.
  if (!event.defaultPrevented) window.ClaudePenguinEngine.openForFixture(fixtureId);
};
for (const view of ['task', 'terminal', 'changes', 'history']) el(`cp-tab-${view}`).onclick = () => {
  if (view === 'task' && nativeReturnFixture) return el('cp-agent-back').onclick();
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
        } else if (message.type === 'terminal.snapshot' && targetKey(message) === targetKey(selected) && attachedKey === targetKey(selected)) {
          initializeTerminal();
          if (!term) return render();
          terminalReady = false;
          term.reset();
          if (Number.isInteger(message.cols) && Number.isInteger(message.rows)) term.resize(message.cols, message.rows);
          term.write(message.data || '', () => {
            if (generation !== epoch || targetKey(message) !== targetKey(selected)) return;
            terminalReady = true;
            render();
            fitTerminal();
          });
        } else if (message.type === 'terminal' && targetKey(message) === targetKey(selected) && attachedKey === targetKey(selected)) {
          term?.write(message.data || '');
        } else if (message.type === 'error') error(message.error || message.message || 'The runtime rejected a terminal action.');
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
