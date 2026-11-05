import { BRIDGE_CONTRACT_VERSION, states, validateFixtures, projectAtSnapshot, projectForClick, waitForArrival, agentMappings, mappingKey,
  flashConfiguration, freshSnapshot, selectionForClick, roomAnimation, activeMappingsFor, needsConfiguration } from './model.mjs';
import { nativeMenuState, allowedNativeAction, attentionTotal } from './native-menu.mjs';

const agentMode = window.CP_AGENT_MODE === true;
const work = document.createElement('button');
const toolbar = document.createElement('div');
toolbar.id = 'cp-bridge-toolbar';
toolbar.innerHTML = agentMode ? '<strong>Claude Penguin · live sessions</strong><button id="cp-igloos">Your Igloos</button><a href="/#/login">Exit experiment</a>' : '<strong>Claude Penguin · bridge lab</strong><a href="/#/login">Exit experiment</a>';
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
  <div id="cp-projects"></div><p id="cp-empty" hidden></p><button id="cp-town" disabled>Visit Town</button>
  <p class="cp-location" id="cp-location">Waiting for the game.</p>
  <section id="cp-puffle" hidden><h3 id="cp-puffle-name"></h3><p id="cp-selection"></p>
    <div class="cp-states"></div><p id="cp-animation" role="status">Click a puffle in its igloo to select it.</p>
  </section><p class="cp-evidence" id="cp-evidence">Log in as bridgecheck using the disposable local password.</p>`;
document.body.append(toolbar, work, panel);
if (agentMode) {
  document.body.classList.add('cp-agent-mode');
  panel.querySelector('small').textContent = 'Project destinations';
  panel.querySelector('.cp-notice').textContent = 'Choose an igloo to visit your puffles.';
  panel.querySelector('.cp-states').hidden = true;
  panel.hidden = true;
  work.setAttribute('aria-expanded', 'false');
}

// `mappings` is what the browser wants the overlay to know: the validated
// fixture manifest on the bridge lab, or ready engine mappings in agent mode.
// `configured` is what the overlay was last told and the generation it
// returned. Routing uses only `activeMappings()`, which is null while the two
// differ, so controls prepared against an older mapping fail closed.
let mappings = null, desiredKey = '', configured = null, configError = '';
let snapshot, selected, selection = null, configuring = false, navigating = false, pollRunning = false, pollQueued = false;
let lastError = '', lastConnection = '';
let engineState = window.ClaudePenguinEngine?.getState() ?? { connected: false, snapshot: { projects: [], workers: [] } };
let lastAnimation = '';
let nativeMenuReady = false;
const statusByProject = new Map();
const el = id => document.getElementById(id);
const activeMappings = () => activeMappingsFor(desiredKey, configured);
const currentGeneration = () => configured?.generation;
function showPanel(show) {
  panel.hidden = !show;
  if (!agentMode) work.setAttribute('aria-expanded', String(show));
  else if (show) { hideNativeMenu(); window.ClaudePenguinEngine?.close(); }
}
work.onclick = () => agentMode ? openWork() : showPanel(panel.hidden);
panel.querySelector('.cp-close').onclick = () => showPanel(false);
if (agentMode) {
  const engine = window.ClaudePenguinEngine;
  for (const id of ['cp-town', 'cp-location', 'cp-connection', 'cp-empty', 'cp-evidence']) el('cp-travel').append(el(id));
  el('cp-evidence').textContent = '';
  el('cp-igloos').onclick = () => engine.openIgloos();
  window.addEventListener('cp-open-work', openWork);
  window.addEventListener('cp-visit', event => navigate(event.detail));
  window.addEventListener('cp-engine-selection', event => { selection = event.detail; syncNativeMenu(); });
  window.addEventListener('cp-engine-state', ({ detail }) => {
    engineState = detail;
    // Reconfiguration happens in the next poll; until then everything is stale.
    if (updateMappings()) { schedulePoll(); render(); return; }
    render(); syncAnimation(); syncNativeMenu();
  });
  window.addEventListener('cp-engine-visibility', ({ detail }) => {
    work.setAttribute('aria-expanded', String(detail.open));
    if (detail.open) { panel.hidden = true; hideNativeMenu(); }
  });
  window.addEventListener('cp-engine-native-return', event => {
    if (!selection || event.detail?.projectId !== selection.projectId || event.detail?.workerId !== selection.workerId) return;
    event.preventDefault();
    openWork();
  });
}

// Returns true when the mapping set changed and the overlay needs reconfiguring.
function updateMappings() {
  if (!agentMode) return false;
  const next = engineState.connected ? agentMappings(engineState.snapshot) : null;
  const key = mappingKey(next);
  // The key is empty only without a verified visitor. Equal keys keep the
  // overlay configuration; only the rejected-mapping note may change.
  if (key === desiredKey) { mappings = next; return false; }
  mappings = next;
  desiredKey = key;
  invalidate();
  return true;
}
// Mapping changes discard every room-derived decision until a fresh snapshot.
function invalidate() {
  snapshot = null;
  lastAnimation = '';
}
function schedulePoll() {
  if (pollQueued) return;
  pollQueued = true;
  setTimeout(() => { pollQueued = false; poll(); }, 0);
}

function hideNativeMenu() {
  if (nativeMenuReady) try { call('cpBridgeHideAgentMenu'); } catch { /* Room is changing. */ }
}
function syncNativeMenu() {
  if (!agentMode) return;
  const active = activeMappings();
  // A pending reconfiguration keeps the HUD; the next poll sends the new state.
  if (!active && mappings && !configError) return;
  try {
    const result = call('cpBridgeSetAgentMenu', active ? nativeMenuState(engineState, active, selection) : { enabled: false });
    nativeMenuReady = Boolean(active) && result.nativeMenu === true && result.hudReady === true;
  } catch { nativeMenuReady = false; }
  document.body.classList.toggle('cp-native-agent-menu', nativeMenuReady);
}
// The panel's selection is authoritative. Work opens the selected puffle's
// native card, or the browser card for exactly that project and worker when the
// game cannot show it. With nothing selected it asks the browser card for its
// list, so the card's own earlier choice never stands in. Never picks a worker.
function openWork() {
  const engine = window.ClaudePenguinEngine;
  const target = selection ? { ...selection } : null;
  syncNativeMenu();
  const state = nativeMenuState(engineState, activeMappings(), target);
  if (target && nativeMenuReady && state.projectId === target.projectId) {
    try {
      panel.hidden = true;
      engine?.close();
      call('cpBridgeShowAgentMenu');
      return;
    } catch { /* Keep the browser card available when the game menu cannot open. */ }
  }
  if (target) engine?.openForProject(target.projectId, target.workerId);
  else engine?.openList();
}

const outOfDate = () => Object.assign(new Error('The client bridge is out of date. Run python3 local/client-bridge/build.py, then reload.'), { code: 'contract-mismatch' });
// Every result of the current contract carries its version, refusals included.
// A missing or different version is refused before the answer is interpreted.
function call(name, ...args) {
  const player = document.querySelector('ruffle-object, ruffle-embed, ruffle-player');
  if (!player?.ruffle) throw new Error('Waiting for the game client.');
  const result = player.ruffle(1).callExternalInterface(name, ...args);
  if (!result || typeof result !== 'object') throw new Error('Waiting for the client bridge. Build the extension and log in.');
  if (result.version !== BRIDGE_CONTRACT_VERSION) throw outOfDate();
  if (!result.ok) throw Object.assign(new Error(result.error || 'The game is not ready for this action.'), { code: result.error });
  return result;
}
function connection(message) {
  if (message !== lastConnection) el('cp-connection').textContent = lastConnection = message;
}
function buildProjects() {
  const list = el('cp-projects');
  list.replaceChildren();
  for (const project of mappings?.projects ?? []) {
    const button = document.createElement('button');
    button.className = 'cp-project';
    button.dataset.projectId = project.projectId;
    button.disabled = true;
    const name = document.createElement('strong');
    name.className = 'cp-project-name';
    name.textContent = project.name;
    button.append(name);
    const caption = document.createElement('span');
    caption.textContent = `${project.puffleName} · 1 fixture puffle`;
    button.append(caption);
    button.onclick = () => navigate(project.projectId);
    list.append(button);
  }
}
function render() {
  const active = activeMappings();
  const live = freshSnapshot(active, snapshot, currentGeneration());
  const current = live ? projectAtSnapshot(active, snapshot) : null;
  panel.querySelectorAll('.cp-project, #cp-town').forEach(button => { button.disabled = !live || navigating; });
  el('cp-location').textContent = live ? (current ? `In ${current.name} · owner ${current.ownerId} · mapped layout ${current.iglooId}` : `On the island · room ${snapshot.roomId}`) : 'Waiting for a verified game session.';
  // An unmapped igloo (for example in an empty neighborhood) has no current project.
  const canAnimate = Boolean(selected && current) && !navigating && current.projectId === selected.projectId && snapshot.puffles?.some(puffle => puffle.id === selected.puffleId);
  panel.querySelectorAll('[data-state]').forEach(button => {
    button.disabled = !canAnimate;
    button.setAttribute('aria-pressed', String(statusByProject.get(selected?.projectId) === button.dataset.state));
  });
  if (agentMode) {
    el('cp-town').disabled = !live || navigating;
    window.ClaudePenguinEngine.setDestinations(live && !navigating ? active.projects.map(item => item.projectId) : []);
    const engineSnapshot = engineState.snapshot;
    el('cp-location').textContent = navigating ? 'On our way…' : live ? (current ? `You are in ${current.name}.` : 'You are exploring the island.') : 'Log in as bridgecheck to visit your igloos.';
    const attention = attentionTotal(engineSnapshot);
    work.textContent = !engineState.connected ? 'Work · offline' : attention ? `Work · ${attention} need attention` : 'Work';
    const rejected = mappings?.rejected?.length ?? 0;
    el('cp-empty').hidden = !mappings || (mappings.projects.length > 0 && !rejected);
    el('cp-empty').textContent = [mappings && !mappings.projects.length ? 'No project igloos yet. You can still explore the island.' : '',
      rejected ? `${rejected} project igloo${rejected === 1 ? '' : 's'} could not be mapped and stay hidden.` : ''].filter(Boolean).join(' ');
  } else {
    const attention = [...statusByProject.values()].filter(state => state === 'needs-you').length;
    work.textContent = attention ? `Work · ${attention} simulated alert` : 'Work · bridge lab';
  }
}

// Animates only the mapped puffle in the current room, from its own worker.
function syncAnimation() {
  if (!agentMode) return;
  const active = activeMappings();
  const cue = engineState.connected && !navigating && freshSnapshot(active, snapshot, currentGeneration()) ? roomAnimation(active, snapshot, engineState.snapshot) : null;
  if (!cue) { lastAnimation = ''; return; }
  if (cue.identity === lastAnimation) return;
  try {
    call('cpBridgeAnimate', cue.puffleId, cue.cue);
    lastAnimation = cue.identity;
  } catch { /* A room can disappear between snapshot and animation; the next poll verifies it again. */ }
}
function report(error) {
  const message = error.message || String(error);
  if (lastError !== message) { el('cp-evidence').textContent = message; lastError = message; }
}
async function navigate(projectId) {
  if (navigating) return;
  try {
    const active = activeMappings();
    const project = projectId ? active?.projects.find(item => item.projectId === projectId) : null;
    if (projectId && !project) throw new Error('That igloo is no longer available. Choose a destination again.');
    // Travel requires a fresh snapshot of the current configuration generation.
    snapshot = call('cpBridgeSnapshot');
    const generation = currentGeneration();
    if (!freshSnapshot(active, snapshot, generation)) throw new Error('The game is still updating your igloo list. Try again in a moment.');
    const key = desiredKey;
    navigating = true;
    lastAnimation = '';
    render();
    call(project ? 'cpBridgeJoinIgloo' : 'cpBridgeJoinRoom', project ? project.ownerId : 100);
    snapshot = null;
    render();
    el('cp-evidence').textContent = `Requested ${project?.name ?? 'Town'}; waiting for the game to confirm arrival.`;
    // The client request is not proof of arrival. Keep actions disabled until a fresh snapshot.
    snapshot = await waitForArrival(() => call('cpBridgeSnapshot'), active, project, { generation, current: () => desiredKey === key });
    el('cp-evidence').textContent = `Game confirmed ${project?.name ?? 'Town'} (room ${snapshot.roomId}).`;
    showPanel(false);
    if (agentMode) window.ClaudePenguinEngine.close();
  } catch (error) {
    if (error.code === 'mapping-changed') snapshot = null;
    report(error);
  } finally { navigating = false; render(); if (agentMode) schedulePoll(); }
}
el('cp-town').onclick = () => navigate(null);
for (const [state, text] of agentMode ? [] : Object.entries(states)) {
  const button = document.createElement('button');
  button.textContent = text;
  button.dataset.state = state;
  button.disabled = true;
  button.onclick = () => {
    try {
      snapshot = call('cpBridgeSnapshot');
      const current = projectAtSnapshot(mappings, snapshot);
      if (!selected || current?.projectId !== selected.projectId || !snapshot.puffles?.some(p => p.id === selected.puffleId)) throw new Error('Return to this puffle’s igloo before changing its animation.');
      call('cpBridgeAnimate', selected.puffleId, state);
      statusByProject.set(selected.projectId, state);
      el('cp-animation').textContent = `Last simulated cue: ${text}. This plays once; the panel remembers the cue while you travel.`;
      render();
    } catch (error) { report(error); }
  };
  panel.querySelector('.cp-states').append(button);
}

// Native HUD and card actions. One the browser refuses (stale generation,
// travel, no explicit selection, or engine rules) is reported back so the
// overlay releases a task it did not send; the overlay keeps the draft.
function nativeAction(event) {
  let allowed = false;
  try {
    snapshot = call('cpBridgeSnapshot');
    const context = { mappings: activeMappings(), game: snapshot, generation: currentGeneration(), engineState, target: selection };
    allowed = !navigating && allowedNativeAction(context, event);
  } catch (error) { report(error); }
  if (!allowed) {
    try { call('cpBridgeRejectAgentAction', String(event.action), typeof event.projectId === 'string' ? event.projectId : '', event.draftSlot ?? 0); }
    catch { /* The overlay is not ready; closing the card also releases the task. */ }
    return;
  }
  if (event.action === 'work') openWork();
  else if (event.action === 'igloos') window.ClaudePenguinEngine.openIgloos();
  else window.ClaudePenguinEngine?.handleNativeAction({ projectId: selection.projectId, workerId: selection.workerId, action: event.action, text: event.text });
}
window.addEventListener('claude-penguin-bridge', ({ detail }) => {
  try {
    const event = typeof detail === 'string' ? JSON.parse(detail) : detail;
    if (agentMode && event?.type === 'agent-menu-action') return nativeAction(event);
    if (event?.type !== 'puffle-click') return;
    // A click is accepted only against a fresh snapshot of the current generation.
    snapshot = call('cpBridgeSnapshot');
    if (navigating) return;
    const active = activeMappings();
    const generation = currentGeneration();
    if (agentMode) {
      const target = selectionForClick(active, snapshot, generation, event, engineState.snapshot);
      if (!target) return;
      window.ClaudePenguinEngine.select(target);
      showPanel(false);
      openWork();
      return;
    }
    const project = freshSnapshot(active, snapshot, generation) && event.generation === generation ? projectForClick(active, snapshot, event) : null;
    if (!project) return;
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

function forgetSession() {
  snapshot = null;
  statusByProject.clear();
  selected = null;
  el('cp-puffle').hidden = true;
}
// Applies the browser's mappings to the overlay when the overlay reports a
// different generation (including an overlay that was never configured).
// More mappings than the overlay accepts throw here, so nothing is sent and the
// error stays visible until the mapping set changes.
function reconfigure() {
  if (configuring) return;
  configuring = true;
  try {
    const config = flashConfiguration(mappings);
    const result = call('cpBridgeConfigure', config.visitorId, config.projects);
    if (!Number.isSafeInteger(result.generation)) throw outOfDate();
    configured = { key: desiredKey, generation: result.generation, mappings };
    configError = '';
  } catch (error) {
    configError = error.message;
    throw error;
  } finally { configuring = false; }
}
async function poll() {
  if (pollRunning || navigating) return;
  if (!mappings) {
    if (agentMode) {
      // Without a verified visitor no project mapping is usable. Clear the overlay's
      // hooks if it still holds an earlier configuration.
      try {
        if (configured?.mappings) {
          const result = call('cpBridgeConfigure', configured.mappings.visitor.penguinId, []);
          configured = { key: '', generation: result.generation, mappings: null };
        }
      } catch { /* The overlay is not ready; nothing is routed without mappings. */ }
      forgetSession();
      connection(engineState.connected ? 'The local runtime has not verified the bridgecheck game visitor yet.' : 'Waiting for the local runtime…');
      render();
      syncNativeMenu();
    }
    return;
  }
  pollRunning = true;
  try {
    snapshot = call('cpBridgeSnapshot');
    if (snapshot.playerId !== mappings.visitor.penguinId) {
      if (selection) window.ClaudePenguinEngine.select(null);
      forgetSession();
      connection(`Log in as ${mappings.visitor.username}. This experiment is restricted to its ${agentMode ? 'verified visitor' : 'fixture session'}.`);
    } else {
      if (needsConfiguration(desiredKey, configured, snapshot)) {
        reconfigure();
        snapshot = call('cpBridgeSnapshot');
      }
      connection(agentMode ? 'Bridge connected · game visitor verified' : 'Bridge connected · fixture session verified');
    }
    lastError = '';
  } catch (error) {
    snapshot = null;
    if (error.code === 'visitor-mismatch') {
      if (selection) window.ClaudePenguinEngine.select(null);
      forgetSession();
      // The overlay still holds an earlier visitor; apply the newly verified one.
      // The next poll checks the logged-in player against it before routing.
      if (configured?.mappings?.visitor.penguinId !== mappings.visitor.penguinId) try { reconfigure(); } catch { /* Reported next poll. */ }
    }
    connection(error.message);
  }
  finally { pollRunning = false; render(); syncAnimation(); syncNativeMenu(); }
}
try {
  if (agentMode) {
    // Agent mode never reads the Alpha/Beta fixture manifest.
    updateMappings();
    render();
  } else {
    const response = await fetch('/bridge/fixtures.json');
    if (!response.ok) throw new Error('Create the experiment fixtures with ./local/bridge-fixtures, then reload.');
    mappings = validateFixtures(await response.json());
    desiredKey = mappingKey(mappings);
    buildProjects();
  }
  await poll();
  setInterval(poll, 1000);
} catch (error) { connection(error.message); }
