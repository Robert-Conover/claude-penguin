// Drives the real panel.mjs (and, in agent mode, the real engine/client.mjs)
// against a minimal DOM double, the real bootstrap.js receive path, and the real
// bridge.as overlay running on game doubles. Each page imports fresh module
// instances; browser globals are replaced per page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { engineSnapshot, overlayDouble, PROJECT_A, PROJECT_B, PRIVATE } from './testing.mjs';

// ------------------------------------------------------------ DOM double
const VOID = new Set(['input', 'img', 'br', 'hr']);
const camel = name => name.replace(/-(\w)/g, (_, letter) => letter.toUpperCase());

class Text {
  constructor(data) { this.nodeType = 3; this.data = String(data); this.parentNode = null; }
  get textContent() { return this.data; }
}

class Element {
  constructor(tag) {
    Object.assign(this, { nodeType: 1, tagName: tag.toUpperCase(), childNodes: [], parentNode: null, attributes: {},
      dataset: {}, id: '', className: '', hidden: false, disabled: false });
  }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  get childElementCount() { return this.children.length; }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    const set = list => { this.className = [...new Set(list)].join(' '); };
    return {
      contains: name => names().includes(name),
      add: (...added) => set([...names(), ...added]),
      remove: (...removed) => set(names().filter(name => !removed.includes(name))),
      toggle: (name, force = !names().includes(name)) => { set(force ? [...names(), name] : names().filter(item => item !== name)); return force; },
    };
  }
  get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(String(value ?? '')); }
  set innerHTML(html) { this.replaceChildren(...parse(html)); }
  setAttribute(name, value) {
    value = String(value);
    if (name === 'id') this.id = value;
    else if (name === 'class') this.className = value;
    else if (name === 'hidden' || name === 'disabled') this[name] = true;
    else if (name === 'value') this.value = value;
    else if (name.startsWith('data-')) this.dataset[camel(name.slice(5))] = value;
    else this.attributes[name] = value;
  }
  getAttribute(name) {
    if (name === 'id') return this.id || null;
    if (name === 'class') return this.className || null;
    if (name === 'hidden' || name === 'disabled') return this[name] ? '' : null;
    if (name.startsWith('data-')) return this.dataset[camel(name.slice(5))] ?? null;
    return this.attributes[name] ?? null;
  }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  append(...nodes) {
    for (let node of nodes) {
      if (!(node instanceof Element || node instanceof Text)) node = new Text(node);
      if (node.parentNode) node.parentNode.childNodes = node.parentNode.childNodes.filter(child => child !== node);
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  * descendants() { for (const child of this.children) { yield child; yield* child.descendants(); } }
  querySelectorAll(selector) { const matches = matcher(selector); return [...this.descendants()].filter(matches); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

// Supports the selectors the pages use: tag, #id, .class, [attribute], compound
// forms, descendant combinators, and comma lists.
function compound(text) {
  const parts = text.match(/^[a-z][\w-]*|#[\w-]+|\.[\w-]+|\[[\w-]+\]/gi) ?? [];
  if (parts.join('') !== text) throw new Error(`Unsupported selector: ${text}`);
  return element => parts.every(part => part[0] === '#' ? element.id === part.slice(1)
    : part[0] === '.' ? element.classList.contains(part.slice(1))
      : part[0] === '[' ? element.hasAttribute(part.slice(1, -1)) : element.tagName === part.toUpperCase());
}
function matcher(selector) {
  const chains = selector.split(',').map(item => item.trim().split(/\s+/).map(compound));
  return element => chains.some(chain => {
    if (!chain.at(-1)(element)) return false;
    let index = chain.length - 2;
    for (let node = element.parentNode; node && index >= 0; node = node.parentNode) if (chain[index](node)) index--;
    return index < 0;
  });
}
function parse(html) {
  const root = new Element('template');
  let current = root;
  const token = /<\/([\w-]+)\s*>|<([\w-]+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*>|([^<]+)/y;
  while (token.lastIndex < html.length) {
    const match = token.exec(html);
    if (!match) throw new Error(`Unsupported markup near: ${html.slice(token.lastIndex, token.lastIndex + 40)}`);
    const [, close, open, attributes, text] = match;
    if (close) {
      if (current.tagName !== close.toUpperCase()) throw new Error(`Unbalanced </${close}>`);
      current = current.parentNode;
    } else if (open) {
      const element = new Element(open);
      for (const [, name, value] of attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) element.setAttribute(name, value ?? '');
      current.append(element);
      if (!VOID.has(open.toLowerCase())) current = element;
    } else current.append(text);
  }
  if (current !== root) throw new Error('Unclosed element');
  const nodes = [...root.childNodes];
  root.replaceChildren();
  return nodes;
}
function createDocument() {
  const body = new Element('body');
  return {
    body, createElement: tag => new Element(tag),
    getElementById: id => [...body.descendants()].find(element => element.id === id) ?? null,
    querySelector: selector => body.querySelector(selector),
    querySelectorAll: selector => body.querySelectorAll(selector),
  };
}

// ------------------------------------------------------------ page double
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const reply = body => ({ ok: true, json: async () => JSON.parse(JSON.stringify(body)) });
const labManifest = () => ({ version: 1, kind: 'game-bridge-fixture', visitor: { username: 'bridgecheck', penguinId: 107 }, projects: [
  { projectId: 'bridge-alpha', name: 'Alpha', ownerId: 105, iglooId: 4, roomId: 2105, puffleId: 4, puffleName: 'Atlas' },
  { projectId: 'bridge-beta', name: 'Beta', ownerId: 106, iglooId: 5, roomId: 2106, puffleId: 5, puffleName: 'Comet' },
] });
let pages = 0;

// `transform` rewrites each overlay result, standing in for an older overlay
// build; `prepare` runs inside the overlay before the panel loads.
async function openPage({ agentMode = true, snapshot = engineSnapshot(), transform = result => result, prepare = '' } = {}) {
  const page = ++pages;
  const document = createDocument();
  const window = new EventTarget();
  const location = { origin: 'http://localhost:8081', protocol: 'http:', host: 'localhost:8081' };
  Object.assign(window, { RufflePlayer: { config: {} }, location }, agentMode ? { CP_AGENT_MODE: true } : {});
  Object.assign(globalThis, { window, document, location });
  // The real opt-in bootstrap delivers overlay events to the panel.
  new Function('window', readFileSync(new URL('./bootstrap.js', import.meta.url), 'utf8'))(window);
  const overlay = overlayDouble({ receive: event => window.ClaudePenguinBridge.receive(event) });
  if (prepare) overlay.run(prepare);
  const calls = [];
  const player = document.createElement('ruffle-player');
  player.ruffle = () => ({ callExternalInterface(name, ...args) {
    calls.push({ name, args });
    return transform(overlay.callExternalInterface(name, ...args));
  } });
  document.body.append(player);

  const actions = [], sockets = [];
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/engine/bootstrap') return reply({ token: 'private-browser-token', snapshot });
    if (url === '/engine/action') { actions.push(JSON.parse(options.body)); return reply({ result: {} }); }
    if (url === '/bridge/fixtures.json') return reply(labManifest());
    throw new Error(`Unexpected request ${url}`);
  };
  globalThis.WebSocket = class {
    static OPEN = 1;
    constructor(url) { Object.assign(this, { url, readyState: 1, sent: [] }); sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() {}
  };
  const publish = next => sockets.at(-1).onmessage({ data: JSON.stringify({ type: 'snapshot', snapshot: next }) });
  if (agentMode) {
    await import(`../engine/client.mjs?page=${page}`);
    while (!sockets.length) await flush();
    publish(snapshot);
  }
  const intervals = [];
  const setInterval = globalThis.setInterval;
  globalThis.setInterval = callback => { intervals.push(callback); return 0; };
  try { await import(`./panel.mjs?page=${page}`); } finally { globalThis.setInterval = setInterval; }
  return {
    window, document, overlay, calls, actions, publish, socket:sockets[0],
    el: id => document.getElementById(id),
    poll: () => intervals[0](),
    clickPuffle: () => overlay.run('cpBridge.tick(); puffle.clip.onPress()'),
    flush: async () => { await flush(); await flush(); },
  };
}
const idle = (projects = ['a', 'b', 'c']) => {
  const snapshot = engineSnapshot({ projects });
  snapshot.workers[0].status = 'idle';
  return snapshot;
};
const card = 'cpBridge.agentMenu.card';

// ------------------------------------------------------------ Work routing
test('Work opens the panel selection, not the browser card’s earlier choice', async () => {
  const page = await openPage();
  const engine = page.window.ClaudePenguinEngine;
  // The browser card is used for Comet Repo, then closed.
  engine.openForProject(PROJECT_B, 'worker-b');
  assert.equal(page.el('cp-agent-title').textContent, 'Comet');
  page.el('cp-agent-close').onclick();
  // Atlas's puffle opens its native card; the browser card is not involved.
  page.clickPuffle();
  assert.equal(page.overlay.read('cpBridge.agentMenuProject'), PROJECT_A);
  assert.equal(page.el('cp-agent-panel').hidden, true);
  // A game menu now blocks the native card, so Work falls back to the browser card.
  page.overlay.run('cpBridge.hideAgentMenu(); ui.widgets = true');
  page.el('cp-work').onclick();
  assert.equal(page.overlay.read('cpBridge.agentMenu == undefined'), true);
  assert.equal(page.el('cp-agent-panel').hidden, false);
  assert.equal(page.el('cp-agent-title').textContent, 'Atlas', 'the clicked puffle, never the earlier browser selection');
  assert.equal(page.el('cp-agent-home').textContent, 'Atlas Repo');
  await page.flush();
});

test('Work with no puffle selected asks the browser card for its list and drops the card’s own choice', async () => {
  const page = await openPage();
  page.window.ClaudePenguinEngine.openForProject(PROJECT_B, 'worker-b');
  page.el('cp-agent-close').onclick();
  page.clickPuffle();
  // Another penguin logs in, so the panel forgets its selection.
  page.overlay.run('playerId = 999');
  await page.poll();
  page.overlay.run('playerId = 107');
  await page.poll();
  assert.equal(page.el('cp-connection').textContent, 'Bridge connected · game visitor verified');
  page.el('cp-work').onclick();
  assert.equal(page.el('cp-agent-panel').hidden, false);
  assert.equal(page.el('cp-session').hidden, true, 'no puffle session is preselected');
  assert.equal(page.el('cp-agent-title').textContent, 'Your Igloos');
  assert.equal(page.el('cp-agent-list').hidden, false, 'the puffle list is shown for an explicit choice');
  await page.flush();
});

// ------------------------------------------------------------ refused native actions
test('a native task the browser refuses as stale is released with its draft and a notice', async () => {
  const page = await openPage({ snapshot: idle() });
  page.clickPuffle();
  assert.equal(page.overlay.read(card + '.sendButton.allowed'), true);
  // Nova's igloo becomes ready. Until the next poll reconfigures, card actions are stale.
  const next = idle();
  next.revision = 8;
  next.projects[2].game.status = 'ready';
  page.publish(next);
  page.overlay.run(card + '.taskInput.text = "Fix the greeting"; ' + card + '.sendButton.onRelease()');
  assert.equal(page.actions.length, 0, 'the stale task never reaches the engine');
  assert.equal(page.overlay.read('cpBridge.agentSubmitPending'), false, 'the overlay learns the task was not sent');
  assert.equal(page.overlay.read(card + '.sendButton.allowed'), true);
  assert.equal(page.overlay.read(card + '.taskInput.text'), 'Fix the greeting', 'the draft stays');
  assert.match(page.overlay.read(card + '.taskLabel.text'), /not sent/i);
  // After reconfiguration the same card sends the task to the engine.
  await page.flush();
  assert.equal(page.overlay.read('cpBridge.generation'), 2);
  page.overlay.run(card + '.sendButton.onRelease()');
  await page.flush();
  assert.deepEqual(page.actions.map(item => [item.action, item.projectId, item.workerId, item.text]),
    [['submit', PROJECT_A, 'worker-a', 'Fix the greeting']]);
  assert.doesNotMatch(JSON.stringify(page.calls), PRIVATE);
});

// ------------------------------------------------------------ mapping bounds
test('a mapping outside the overlay ID range is hidden alone; the other igloos still configure', async () => {
  const snapshot = engineSnapshot();
  Object.assign(snapshot.projects[1].game, { ownerId: 1_000_000_000, roomId: 1_000_002_000 });
  const page = await openPage({ snapshot });
  assert.equal(page.overlay.read('cpBridge.configured'), true);
  assert.deepEqual(page.overlay.read('cpBridge.projects').map(item => item.projectId), [PROJECT_A]);
  assert.equal(page.el('cp-connection').textContent, 'Bridge connected · game visitor verified');
  assert.match(page.el('cp-empty').textContent, /1 project igloo could not be mapped/);
  page.clickPuffle();
  assert.equal(page.overlay.read('cpBridge.agentMenuProject'), PROJECT_A);
  await page.flush();
});

test('more ready igloos than the overlay accepts are refused explicitly, never configured or truncated', async () => {
  const many = count => ({ ...engineSnapshot({ projects: [] }), revision: 7 + 33 - count, projects: Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, name: `Project ${index}`, activeWorkerId: null,
    game: { status: 'ready', ownerId: 200 + index, iglooId: 500 + index, roomId: 2200 + index, puffleId: 900 + index, puffleName: 'Atlas' } })) });
  const page = await openPage({ snapshot: many(33) });
  assert.equal(page.calls.filter(item => item.name === 'cpBridgeConfigure').length, 0);
  assert.equal(page.overlay.read('cpBridge.configured'), false);
  assert.match(page.el('cp-connection').textContent, /33 project igloos.*at most 32/);
  assert.equal(page.overlay.read('cpBridge.agentHUD == undefined'), true, 'the native HUD stays off');
  // One fewer project configures without a reload.
  page.publish(many(32));
  await page.flush();
  assert.equal(page.overlay.read('cpBridge.projects.length'), 32);
  assert.equal(page.el('cp-connection').textContent, 'Bridge connected · game visitor verified');
});

// ------------------------------------------------------------ contract version
test('an older overlay’s refusal is reported as a contract mismatch, not interpreted as game state', async () => {
  const page = await openPage({ transform: result => result && { ...result, version: 2 }, prepare: 'roomReady = false' });
  assert.match(page.el('cp-connection').textContent, /out of date/);
  await page.flush();
});

test('an overlay result without a contract version is refused before configuration', async () => {
  const page = await openPage({ transform: result => { if (result) delete result.version; return result; } });
  assert.match(page.el('cp-connection').textContent, /out of date/);
  assert.equal(page.calls.some(item => item.name === 'cpBridgeConfigure'), false);
  await page.flush();
});

// ------------------------------------------------------------ bridge lab
test('bridge lab still configures fixture IDs, accepts real clicks, and labels cues as simulated', async () => {
  const page = await openPage({ agentMode: false });
  assert.deepEqual(page.overlay.read('cpBridge.projects').map(item => item.projectId), ['bridge-alpha', 'bridge-beta']);
  assert.equal(page.el('cp-connection').textContent, 'Bridge connected · fixture session verified');
  page.clickPuffle();
  assert.equal(page.el('cp-bridge-panel').hidden, false);
  assert.equal(page.el('cp-selection').textContent, 'Alpha · puffle 4');
  const cue = state => page.document.querySelectorAll('[data-state]').find(button => button.dataset.state === state);
  cue('needs-you').onclick();
  assert.deepEqual(page.overlay.read('animations'), [{ id: 4, frame: 29 }]);
  assert.match(page.el('cp-animation').textContent, /^Last simulated cue: Needs you\./);
  assert.equal(page.el('cp-work').textContent, 'Work · 1 simulated alert');
  assert.equal(page.overlay.read('events[events.length-1].simulated'), true);
});

test('Add project validates both names and creates only on the newly registered project', async () => {
  const page = await openPage();
  page.el('cp-igloos').onclick();
  page.el('cp-add-project').onclick();
  assert.equal(page.el('cp-worker-name').value, 'Pixel');
  page.el('cp-repo-path').value = '/repos/--Moon  Base!';
  page.el('cp-repo-path').oninput();
  assert.equal(page.el('cp-project-name').value, 'Moon Base');
  const submit = () => page.el('cp-register-form').onsubmit({ preventDefault() {} });
  page.el('cp-project-name').value = ' Moon';
  await submit();
  assert.match(page.el('cp-agent-error').textContent, /begin and end/);
  page.el('cp-project-name').value = 'Moon Base';
  page.el('cp-worker-name').value = 'Pip1';
  await submit();
  assert.match(page.el('cp-agent-error').textContent, /1 to 12/);
  assert.deepEqual(page.actions, []);
  const actions = [];
  globalThis.fetch = async (_url, {body}) => {
    const request = JSON.parse(body);
    actions.push(request);
    return reply({ result: { id: request.action === 'register' ? 'returned-project' : 'returned-worker' } });
  };
  page.el('cp-worker-name').value = 'Pip';
  await submit();
  assert.deepEqual(actions, [{action: 'register', path:'/repos/--Moon  Base!', name:'Moon Base'}, {action:'create', projectId:'returned-project', name:'Pip'}]);
});

test('archive is read-only and creating the replacement is an explicit choice', async () => {
  const snapshot = engineSnapshot();
  const project = snapshot.projects[0];
  Object.assign(project, { legacy:true, activeWorkerId:null, setup:{phase:'needs-worker'} });
  snapshot.workers.shift();
  Object.assign(snapshot.archivedWorkers[0], {name:'Atlas', resumeCommand:'manual resume', taskHistory:[{prompt:'old task'}]});
  const page = await openPage({snapshot});
  page.clickPuffle();
  assert.equal(page.overlay.read(card + '.status.text'), 'Archived');
  for (const button of ['startButton','sendButton','interruptButton','terminalButton']) assert.equal(page.overlay.read(card + '.' + button + '._visible'), false);
  page.el('cp-igloos').onclick();
  const old = page.el('cp-agent-list').children[0];
  await old.querySelectorAll('button').find(b=>b.textContent==='View archive').onclick();
  assert.equal(page.el('cp-session').hidden,true);
  assert.match(page.el('cp-archive-details').textContent,/manual resume/);
  assert.match(page.el('cp-archive-history').textContent,/old task/);
  assert.deepEqual(page.actions, []);
  page.el('cp-igloos').onclick();
  await page.el('cp-agent-list').children[0].querySelectorAll('button').find(b=>b.textContent==='Create isolated Atlas').onclick();
  assert.deepEqual(page.actions, [{action:'create',projectId:PROJECT_A,name:'Atlas'}]);
});

test('a selected project gains only its own active worker; replacement drafts and stale actions are isolated', async () => {
  const snapshot = idle();
  snapshot.projects[0].activeWorkerId = null;
  snapshot.workers.shift();
  const page = await openPage({snapshot});
  page.clickPuffle();
  page.publish({...idle(), revision:8});
  page.el('cp-work').onclick();
  page.overlay.run(card + '.taskInput.text = "Comet must never see this draft"');
  const oldSlot = page.overlay.read('cpBridge.agentData.draftSlot');
  assert.ok(oldSlot > 0);
  const replacement = idle();
  replacement.revision = 9;
  replacement.projects[0].activeWorkerId = replacement.workers[0].id = 'replacement';
  page.publish(replacement);
  page.clickPuffle();
  assert.notEqual(page.overlay.read('cpBridge.agentData.draftSlot'), oldSlot);
  assert.equal(page.overlay.read(card + '.taskInput.text'), '');
  page.window.ClaudePenguinBridge.receive({type:'agent-menu-action',action:'submit',projectId:PROJECT_A,draftSlot:oldSlot,generation:1,text:'old'});
  assert.deepEqual(page.actions, []);
});

test('project rows surface visitor and setup errors and keep the corrected name bound to the failed project', async () => {
  const snapshot = idle();
  snapshot.visitor = null;
  snapshot.visitorProblem = 'Visitor 107 is missing.';
  snapshot.projects[1].setup = {phase:'failed',error:'Houdini rejected the name.',retryable:true,correction:'puffleName'};
  const page = await openPage({snapshot});
  page.el('cp-igloos').onclick();
  assert.match(page.el('cp-visitor-problem').textContent,/Visitor 107/);
  const row = page.el('cp-agent-list').children[1];
  assert.match(row.textContent,/Houdini rejected the name/);
  row.querySelector('input').value = 'Maple';
  await row.querySelectorAll('button').find(b=>b.textContent==='Retry').onclick();
  assert.deepEqual(page.actions,[{action:'retry',projectId:PROJECT_B,puffleName:'Maple'}]);
});

test('switching workers restores their browser drafts and drops old diff, terminal replay and output', async () => {
  const page = await openPage({snapshot:idle()});
  const engine = page.window.ClaudePenguinEngine;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  page.window.FitAddon = {FitAddon: class {}};
  const output = [];
  page.window.Terminal = class {
    options = {};
    loadAddon() {} open() {} onData() {} dispose() {} reset() {}
    write(data, done) { output.push(data); done?.(); }
  };
  engine.openForProject(PROJECT_A, 'worker-a');
  page.el('cp-task-text').value = 'Atlas only';
  const targetA = page.socket.sent.find(m => m.type === 'attach');
  let finish;
  globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
  page.el('cp-tab-changes').onclick();
  engine.openForProject(PROJECT_B, 'worker-b');
  assert.equal(page.el('cp-task-text').value, '');
  page.el('cp-task-text').value = 'Comet only';
  engine.openForProject(PROJECT_A, 'worker-a');
  assert.equal(page.el('cp-task-text').value, 'Atlas only');
  finish(reply({result:{diff:'stale diff', untracked:[]}}));
  await page.flush();
  assert.equal(page.el('cp-diff').textContent,'');
  const deliver = message => page.socket.onmessage({data:JSON.stringify(message)});
  deliver({...targetA,type:'terminal.snapshot',data:'old screen'});
  deliver({...targetA,type:'terminal',data:'old chunk'});
  deliver({...targetA,type:'error',error:'old attach failed'});
  assert.deepEqual(output,[]);
  assert.equal(page.el('cp-agent-error').hidden,true);
  deliver({...page.socket.sent.at(-1),type:'terminal.snapshot',data:'current screen'});
  assert.deepEqual(output,['current screen']);
});

test('native card displays setup, repair and source availability without leaking diagnostics to Flash', async () => {
  for (const [phase, game, sourceAvailable, expected] of [
    ['preparing','provisioning',true,'Setting up'], ['failed','repair',true,'Needs repair'],
    ['ready','ready',false,'Source unavailable'], ['failed','failed',true,'Setup failed'],
  ]) {
    const snapshot = idle();
    Object.assign(snapshot.projects[0], {setup:{phase, error:'/Users/private/detail'}, sourceAvailable});
    snapshot.projects[0].game.status = game;
    const page = await openPage({snapshot});
    page.el('cp-igloos').onclick();
    await page.el('cp-agent-list').children[0].querySelectorAll('button').find(b=>b.textContent==='Open work').onclick();
    assert.equal(page.overlay.read(card + '.status.text'), expected);
    assert.doesNotMatch(JSON.stringify(page.calls), PRIVATE);
    await page.flush();
  }
});
