import { states, validateFixtures, projectAtSnapshot, projectForClick, waitForArrival } from './model.mjs';

const work = document.createElement('button');
const toolbar = document.createElement('div');
toolbar.id = 'cp-bridge-toolbar';
toolbar.innerHTML = '<strong>Claude Penguin · bridge lab</strong><a href="/#/login">Exit experiment</a>';
work.id = 'cp-work';
work.textContent = 'Work · bridge lab';
work.setAttribute('aria-expanded', 'true');
const panel = document.createElement('aside');
panel.id = 'cp-bridge-panel';
panel.setAttribute('aria-label', 'Puffle bridge experiment');
panel.innerHTML = `<button class="cp-close" aria-label="Close work panel">×</button>
  <h2>Your Igloos</h2><small>Game bridge experiment</small>
  <p class="cp-notice">Two fixture igloos. Animation controls are simulated states; no coding agent is connected.</p>
  <p id="cp-connection" role="status">Loading fixture mappings…</p>
  <div id="cp-projects"></div><button id="cp-town" disabled>Visit Town</button>
  <p class="cp-location" id="cp-location">Waiting for the game.</p>
  <section id="cp-puffle" hidden><h3 id="cp-puffle-name"></h3><p id="cp-selection"></p>
    <div class="cp-states"></div><p id="cp-animation" role="status">Click a puffle in its igloo to select it.</p>
  </section><p class="cp-evidence" id="cp-evidence">Log in as bridgecheck using the disposable local password.</p>`;
document.body.append(toolbar, work, panel);
let fixtures, snapshot, selected, configuring = false, navigating = false, pollRunning = false;
let lastError = '', lastConnection = '';
const statusByProject = new Map();
const el = id => document.getElementById(id);
function showPanel(show) { panel.hidden = !show; work.setAttribute('aria-expanded', String(show)); }
work.onclick = () => showPanel(panel.hidden);
panel.querySelector('.cp-close').onclick = () => showPanel(false);

function call(name, ...args) {
  const player = document.querySelector('ruffle-object, ruffle-embed, ruffle-player');
  if (!player?.ruffle) throw new Error('Waiting for the game client.');
  const result = player.ruffle(1).callExternalInterface(name, ...args);
  if (!result || typeof result !== 'object') throw new Error('Waiting for the client bridge. Build the extension and log in.');
  if (!result.ok) throw Object.assign(new Error(result.error || 'The game is not ready for this action.'), { code: result.error });
  return result;
}
function connection(message) {
  if (message !== lastConnection) el('cp-connection').textContent = lastConnection = message;
}
function render() {
  const live = snapshot?.ok && snapshot.configured && snapshot.playerId === fixtures?.visitor.penguinId;
  const current = projectAtSnapshot(fixtures, snapshot);
  panel.querySelectorAll('.cp-project, #cp-town').forEach(button => { button.disabled = !live || navigating; });
  el('cp-location').textContent = live ? (current ? `In ${current.name} · owner ${current.ownerId} · mapped layout ${current.iglooId}` : `On the island · room ${snapshot.roomId}`) : 'Waiting for a verified game session.';
  const canAnimate = !navigating && current?.projectId === selected?.projectId && snapshot?.puffles?.some(puffle => puffle.id === selected.puffleId);
  panel.querySelectorAll('[data-state]').forEach(button => {
    button.disabled = !canAnimate;
    button.setAttribute('aria-pressed', String(statusByProject.get(selected?.projectId) === button.dataset.state));
  });
  const attention = [...statusByProject.values()].filter(state => state === 'needs-you').length;
  work.textContent = attention ? `Work · ${attention} simulated alert` : 'Work · bridge lab';
}
function report(error) {
  const message = error.message || String(error);
  if (lastError !== message) { el('cp-evidence').textContent = message; lastError = message; }
}
async function navigate(project) {
  if (navigating) return;
  try {
    navigating = true;
    render();
    call(project ? 'cpBridgeJoinIgloo' : 'cpBridgeJoinRoom', project ? project.ownerId : 100);
    snapshot = null;
    render();
    el('cp-evidence').textContent = `Requested ${project?.name ?? 'Town'}; waiting for the game to confirm arrival.`;
    // The client request is not proof of arrival. Keep actions disabled until a fresh snapshot.
    snapshot = await waitForArrival(() => call('cpBridgeSnapshot'), fixtures, project);
    el('cp-evidence').textContent = `Game confirmed ${project?.name ?? 'Town'} (room ${snapshot.roomId}).`;
    showPanel(false);
  } catch (error) { report(error); } finally { navigating = false; render(); }
}
el('cp-town').onclick = () => navigate(null);
for (const [state, text] of Object.entries(states)) {
  const button = document.createElement('button');
  button.textContent = text;
  button.dataset.state = state;
  button.disabled = true;
  button.onclick = () => {
    try {
      snapshot = call('cpBridgeSnapshot');
      const current = projectAtSnapshot(fixtures, snapshot);
      if (!selected || current?.projectId !== selected.projectId || !snapshot.puffles?.some(p => p.id === selected.puffleId)) throw new Error('Return to this puffle’s igloo before changing its animation.');
      call('cpBridgeAnimate', selected.puffleId, state);
      statusByProject.set(selected.projectId, state);
      el('cp-animation').textContent = `Last simulated cue: ${text}. This plays once; the panel remembers the cue while you travel.`;
      render();
    } catch (error) { report(error); }
  };
  panel.querySelector('.cp-states').append(button);
}

window.addEventListener('claude-penguin-bridge', ({ detail }) => {
  try {
    const event = typeof detail === 'string' ? JSON.parse(detail) : detail;
    if (event?.type !== 'puffle-click') return;
    snapshot = call('cpBridgeSnapshot');
    const project = projectForClick(fixtures, snapshot, event);
    if (!project || navigating) return;
    selected = project;
    el('cp-puffle').hidden = false;
    el('cp-puffle-name').textContent = project.puffleName;
    el('cp-selection').textContent = `${project.name} · puffle ${project.puffleId}`;
    el('cp-evidence').textContent = `Real game click received: owner ${event.ownerId}, puffle ${event.puffleId}.`;
    el('cp-animation').textContent = statusByProject.has(project.projectId) ? `Last simulated cue: ${states[statusByProject.get(project.projectId)]}. Choose a state to replay it.` : 'Choose a simulated state to exercise the game animation.';
    showPanel(true);
    render();
  } catch (error) { report(error); }
});

async function poll() {
  if (!fixtures || pollRunning || navigating) return;
  pollRunning = true;
  try {
    snapshot = call('cpBridgeSnapshot');
    if (snapshot.playerId !== fixtures.visitor.penguinId) {
      snapshot = null;
      statusByProject.clear();
      selected = null;
      el('cp-puffle').hidden = true;
      connection('Log in as bridgecheck. This experiment is restricted to its fixture session.');
    } else {
      if (!snapshot.configured && !configuring) {
        configuring = true;
        try { call('cpBridgeConfigure', fixtures.visitor.penguinId, fixtures.projects); }
        finally { configuring = false; }
        snapshot = call('cpBridgeSnapshot');
      }
      connection('Bridge connected · fixture session verified');
    }
    lastError = '';
  } catch (error) {
    snapshot = null;
    if (error.code === 'visitor-mismatch') { statusByProject.clear(); selected = null; el('cp-puffle').hidden = true; }
    connection(error.message);
  }
  finally { pollRunning = false; render(); }
}
try {
  const response = await fetch('/bridge/fixtures.json');
  if (!response.ok) throw new Error('Create the experiment fixtures with ./local/bridge-fixtures, then reload.');
  fixtures = validateFixtures(await response.json());
  for (const project of fixtures.projects) {
    const button = document.createElement('button');
    button.className = 'cp-project';
    button.disabled = true;
    button.append(document.createTextNode(project.name));
    const caption = document.createElement('span');
    caption.textContent = `${project.puffleName} · 1 fixture puffle`;
    button.append(caption);
    button.onclick = () => navigate(project);
    el('cp-projects').append(button);
  }
  await poll();
  setInterval(poll, 1000);
} catch (error) { connection(error.message); }
