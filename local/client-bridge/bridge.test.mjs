import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { agentMappings, mappingKey, flashConfiguration, selectionForClick, activeMappingsFor, needsConfiguration } from '../web/bridge/model.mjs';
import * as contract from '../web/bridge/model.mjs';
import { nativeMenuState, allowedNativeAction } from '../web/bridge/native-menu.mjs';
import { engineSnapshot, overlayDouble, PROJECT_A, PROJECT_B, PRIVATE } from '../web/bridge/testing.mjs';

// bridge.as deliberately uses the common ES3 subset. This harness verifies the
// adapter's identity/state decisions; the live Ruffle check verifies AVM1 itself.
const source = readFileSync(new URL('./bridge.as', import.meta.url), 'utf8');

const fixture = () => overlayDouble().run;

const configure = 'cpBridge.configure(107,[{projectId:"one",ownerId:105,puffleId:4},{projectId:"two",ownerId:106,puffleId:5}])';

test('only the configured visitor and current mapped puffle can animate', () => {
  const run = fixture();
  assert.equal(run('cpBridge.animate(4,"working").error'), 'not-configured');
  assert.equal(run(configure + '.ok'), true);
  assert.equal(run('cpBridge.animate(5,"working").error'), 'unknown-puffle');
  assert.equal(run('cpBridge.animate(4,"constructor").error'), 'unknown-state');
  assert.equal(run('cpBridge.animate(4,"working").ok'), true);
  assert.equal(run('animations.length'), 1);
  assert.equal(run('animations[0].frame'), 27);
  assert.equal(run('playerId=1;cpBridge.animate(4,"working").error'), 'visitor-mismatch');
  assert.equal(run('cpBridge.joinIgloo(106).error'), 'visitor-mismatch');
  assert.equal(run('animations.length'), 1);
  assert.equal(run('navigations.length'), 0);
});

test('a loading or stale igloo cannot be used for travel, clicks, or animation', () => {
  const run = fixture();
  run(configure);
  assert.equal(run('roomReady=false;cpBridge.joinIgloo(106).error'), 'room-not-ready');
  assert.equal(run('cpBridge.animate(4,"ready").error'), 'room-not-ready');
  run('cpBridge.tick();puffle.clip.onPress()');
  assert.equal(run('events[events.length-1].type'), 'original');
  assert.equal(run('roomReady=true;roomId=2106;cpBridge.snapshot().ok'), false);
  assert.equal(run('navigations.length'), 0);
  assert.equal(run('animations.length'), 0);
});

test('real mapped clip emits its identity and restores the ordinary handler on departure', () => {
  const run = fixture();
  run(configure);
  run('cpBridge.tick();puffle.clip.onPress()');
  assert.equal(run('events[events.length-1].type'), 'puffle-click');
  assert.equal(run('events[events.length-1].ownerId'), 105);
  assert.equal(run('events[events.length-1].puffleId'), 4);
  assert.equal(run('events[events.length-1].projectId'), 'one');
  run('roomId=100;inIgloo=false;cpBridge.tick()');
  assert.equal(run('puffle.clip.onPress === originalPress'), true);
});

test('project configuration rejects duplicate ownership and invalid identifiers', () => {
  const run = fixture();
  assert.equal(run('cpBridge.configure(107,[{projectId:"one",ownerId:107,puffleId:4}]).ok'), false);
  assert.equal(run('cpBridge.configure(107,[{projectId:"one",ownerId:105,puffleId:4},{projectId:"two",ownerId:105,puffleId:5}]).ok'), false);
  assert.equal(run('cpBridge.configure(107,[{projectId:"one",ownerId:105,puffleId:4.5}]).ok'), false);
  assert.equal(run('cpBridge.configure(107,[{projectId:"one",ownerId:105,puffleId:4},{projectId:"one",ownerId:106,puffleId:5}]).ok'), false, 'duplicate project identity');
  assert.equal(run('cpBridge.configure(0,[]).ok'), false, 'an empty neighborhood still needs a verified visitor');
  assert.equal(run('cpBridge.configure(107,{length:0}).ok'), false);
  assert.equal(run('cpBridge.configured'), false);
  assert.equal(run('cpBridge.generation'), 0, 'rejected configurations do not advance the generation');
});

const nativePayload = '{enabled:true,connected:true,projectId:"one",name:"Atlas",projectName:"My repository",status:"idle",activity:"Ready",canStart:false,canSubmit:true,running:true,attention:0}';

test('native menu preserves modal state, submits only its explicit mapped fixture, and keeps private data out', () => {
  const run = fixture();
  run(configure);
  assert.equal(run('cpBridge.setAgentMenu(' + nativePayload + ').hudReady'), true);
  assert.equal(run('cpBridge.snapshot().nativeMenuReady'), true);
  assert.equal(run('cpBridge.showAgentMenu().menuVisible'), true);
  assert.equal(run('ui.is_quick_keys_active'), false);
  assert.equal(run('ui.widgets'), true);
  assert.equal(run('shell.hideCount'), 1);
  assert.equal(run('cpBridge.agentMenu.card.portrait.url'), '/engine/art/puffle-blue.png');
  assert.equal(run('cpBridge.agentMenu.card.taskInput.type'), 'input');
  run('cpBridge.agentMenu.card.taskInput.text="Fix the greeting";cpBridge.agentMenu.card.sendButton.onRelease()');
  assert.equal(run('events[events.length-1].action'), 'submit');
  assert.equal(run('events[events.length-1].projectId'), 'one');
  assert.equal(run('events[events.length-1].text'), 'Fix the greeting');
  assert.equal(run('cpBridge.menuAction("submit").error'), 'awaiting-task-event');
  run('cpBridge.tick()');
  assert.equal(run('cpBridge.agentMenu.card.sendButton.allowed'), false, 'polling cannot re-enable a submitted task before a real event');
  assert.deepEqual(JSON.parse(run('JSON.stringify(Object.keys(events[events.length-1]).sort())')), ['action', 'generation', 'projectId', 'text', 'type']);
  assert.equal(run('events[events.length-1].generation'), 1);
  assert.equal(run('cpBridge.menuAction("terminal").menuVisible'), false);
  assert.equal(run('ui.is_quick_keys_active'), true);
  assert.equal(run('ui.widgets'), false);
  assert.equal(run('shell.hideCount'), 0);
});

test('native controls fail closed for disconnected, stale, or mismatched sessions', () => {
  const run = fixture();
  run(configure + ';cpBridge.setAgentMenu(' + nativePayload + ');cpBridge.showAgentMenu()');
  assert.equal(run('cpBridge.menuAction("start").error'), 'session-not-startable');
  assert.equal(run('cpBridge.setAgentMenu({enabled:true,projectId:"missing"}).error'), 'unknown-project');
  run('var disconnected=' + nativePayload + ';disconnected.connected=false;cpBridge.setAgentMenu(disconnected)');
  assert.equal(run('cpBridge.agentMenu.card.sendButton.allowed'), false);
  assert.equal(run('cpBridge.agentMenu.card.taskInput.type'), 'dynamic');
  assert.equal(run('cpBridge.menuAction("submit").error'), 'runtime-disconnected');
  run('playerId=999;cpBridge.tick()');
  assert.equal(run('cpBridge.agentMenu==undefined && cpBridge.agentHUD==undefined'), true);
  assert.equal(run('ui.is_quick_keys_active'), true);
  assert.equal(run('cpBridge.menuAction("terminal").error'), 'visitor-mismatch');
});

test('native menu closes on travel, respects existing game menus, and leaves simulation opt-in', () => {
  const run = fixture();
  run(configure);
  assert.equal(run('cpBridge.showAgentMenu().error'), 'agent-menu-disabled');
  run('cpBridge.setAgentMenu(' + nativePayload + ');ui.widgets=true');
  assert.equal(run('cpBridge.showAgentMenu().error'), 'close-game-menu-first');
  run('ui.widgets=false;ui.is_quick_keys_active=false;shell.hideCount=2;cpBridge.showAgentMenu()');
  run('roomReady=false;cpBridge.tick()');
  assert.equal(run('cpBridge.agentMenu==undefined && cpBridge.agentHUD==undefined'), true);
  assert.equal(run('ui.is_quick_keys_active'), false, 'do not enable quick keys that were already disabled');
  assert.equal(run('shell.hideCount'), 2, 'preserve the existing trigger hide count');
  run('roomReady=true;cpBridge.tick();cpBridge.agentHUD.igloosButton.onRelease()');
  assert.equal(run('events[events.length-1].action'), 'igloos');
  run('cpBridge.setAgentMenu({enabled:false})');
  assert.equal(run('cpBridge.agentHUD==undefined'), true);
  assert.equal(run('cpBridge.animate(4,"working").ok'), true, 'legacy simulation remains available');
});


test('native submission waits for a lifecycle change and can recover without inventing working status', () => {
  const run = fixture();
  run(configure + ';cpBridge.setAgentMenu(' + nativePayload + ');cpBridge.showAgentMenu()');
  run('cpBridge.agentMenu.card.taskInput.text="A real instruction";cpBridge.menuAction("submit")');
  assert.equal(run('cpBridge.agentData.status'), 'idle', 'submission is not proof that Claude started work');
  run('var working=' + nativePayload + ';working.status="working";working.canSubmit=false;cpBridge.setAgentMenu(working)');
  assert.equal(run('cpBridge.agentSubmitPending'), false);
  assert.equal(run('cpBridge.agentMenu.card.taskInput.text'), '');
  assert.equal(run('cpBridge.agentMenu.card.sendButton.allowed'), false);
  run('cpBridge.setAgentMenu(' + nativePayload + ')');
  assert.equal(run('cpBridge.agentMenu.card.sendButton.allowed'), true);
  run('cpBridge.agentMenu.card.taskInput.text="Try again";cpBridge.menuAction("submit");cpBridge.hideAgentMenu();cpBridge.showAgentMenu()');
  assert.equal(run('cpBridge.agentSubmitPending'), false, 'closing for an error or explicit follow-up permits recovery');
});


test('native task drafts survive closing and terminal handoff without crossing fixture identities', () => {
  const run = fixture();
  run(configure + ';cpBridge.setAgentMenu(' + nativePayload + ');cpBridge.showAgentMenu()');
  run('cpBridge.agentMenu.card.taskInput.text="Atlas draft";cpBridge.menuAction("terminal");cpBridge.showAgentMenu()');
  assert.equal(run('cpBridge.agentMenu.card.taskInput.text'), 'Atlas draft');
  run('var second=' + nativePayload + ';second.projectId="two";cpBridge.setAgentMenu(second);cpBridge.showAgentMenu()');
  assert.equal(run('cpBridge.agentMenu.card.taskInput.text'), '', 'different puffle must not inherit the draft');
  run('cpBridge.agentMenu.card.taskInput.text="Comet draft";cpBridge.menuAction("close");cpBridge.setAgentMenu(' + nativePayload + ');cpBridge.showAgentMenu()');
  assert.equal(run('cpBridge.agentMenu.card.taskInput.text'), 'Atlas draft');
  run('cpBridge.menuAction("submit");cpBridge.menuAction("changes")');
  run('var working=' + nativePayload + ';working.status="working";working.canSubmit=false;cpBridge.setAgentMenu(working);cpBridge.showAgentMenu()');
  assert.equal(run('cpBridge.agentMenu.card.taskInput.text'), '', 'real working event clears the matching submitted draft even while hidden');
  run('cpBridge.setAgentMenu(second);cpBridge.showAgentMenu()');
  assert.equal(run('cpBridge.agentMenu.card.taskInput.text'), 'Comet draft');
});

const uuidA = '0f8a3c1e-2b4d-4e6f-8a9b-1c2d3e4f5a6b';
const uuidB = '7d6c5b4a-3e2f-4a1b-9c8d-7e6f5a4b3c2d';

test('a verified visitor with zero projects is an empty neighborhood: Town works, igloo travel and puffle hooks do not', () => {
  const run = fixture();
  assert.equal(run('cpBridge.configure(107,[]).ok'), true);
  assert.equal(run('cpBridge.configured'), true);
  assert.equal(run('cpBridge.snapshot().generation'), 1);
  assert.equal(run('cpBridge.joinIgloo(105).error'), 'unknown-project');
  assert.equal(run('roomId=100;inIgloo=false;cpBridge.joinRoom(100).ok'), true);
  run('roomId=2105;inIgloo=true;cpBridge.tick();puffle.clip.onPress()');
  assert.equal(run('events[events.length-1].type'), 'original', 'unmapped puffles keep the game handler');
  assert.equal(run('cpBridge.setAgentMenu({enabled:true,connected:true,projectId:"",attention:2}).hudReady'), true);
  assert.equal(run('cpBridge.agentHUD.workButton.label.text'), 'Work (2)');
  run('cpBridge.showAgentMenu()');
  assert.equal(run('cpBridge.agentMenu==undefined'), true, 'no project card without a selection');
  assert.equal(run('events[events.length-1].action'), 'work');
  assert.equal(run('events[events.length-1].generation'), 1);
  assert.equal(run('events[events.length-1].projectId'), undefined);
});

test('reconfiguration replaces mappings without reload, advances the generation, and drops stale hooks and cards', () => {
  const run = fixture();
  assert.equal(run('cpBridge.configure(107,[]).generation'), 1);
  // Dynamic addition: the project UUID maps to the current igloo.
  assert.equal(run(`cpBridge.configure(107,[{projectId:"${uuidA}",ownerId:105,puffleId:4}]).generation`), 2);
  run('cpBridge.tick();puffle.clip.onPress()');
  assert.equal(run('events[events.length-1].type'), 'puffle-click');
  assert.equal(run('events[events.length-1].projectId'), uuidA);
  assert.equal(run('events[events.length-1].generation'), 2);
  assert.equal(run(`cpBridge.setAgentMenu({enabled:true,connected:true,projectId:"${uuidA}",name:"Atlas",status:"idle",canSubmit:true,running:true}).ok`), true);
  assert.equal(run('cpBridge.showAgentMenu().menuVisible'), true);
  // Same igloo, reassigned to another project: the hook is replaced and the old card closes.
  assert.equal(run(`cpBridge.configure(107,[{projectId:"${uuidB}",ownerId:105,puffleId:4}]).generation`), 3);
  assert.equal(run('puffle.clip.onPress === originalPress'), true, 'configure restores handlers before re-hooking');
  assert.equal(run('cpBridge.agentMenu==undefined'), true);
  assert.equal(run('cpBridge.agentData.projectId'), '');
  assert.equal(run('ui.is_quick_keys_active && !ui.widgets && shell.hideCount === 0'), true);
  run('cpBridge.tick();puffle.clip.onPress()');
  assert.equal(run('events[events.length-1].projectId'), uuidB);
  assert.equal(run('events[events.length-1].generation'), 3);
  // Removal: the hook goes back to the original handler on the next tick.
  run('cpBridge.configure(107,[]);cpBridge.tick();puffle.clip.onPress()');
  assert.equal(run('events[events.length-1].type'), 'original');
  assert.equal(run('cpBridge.animate(4,"working").error'), 'unknown-puffle');
});

test('a card for a project that stays mapped survives reconfiguration and reports the new generation', () => {
  const run = fixture();
  run(`cpBridge.configure(107,[{projectId:"${uuidA}",ownerId:105,puffleId:4}])`);
  run(`cpBridge.setAgentMenu({enabled:true,connected:true,projectId:"${uuidA}",name:"Atlas",status:"idle",canStart:true});cpBridge.showAgentMenu()`);
  run(`cpBridge.configure(107,[{projectId:"${uuidA}",ownerId:105,puffleId:4},{projectId:"${uuidB}",ownerId:106,puffleId:5}])`);
  assert.equal(run('cpBridge.agentMenu!=undefined'), true);
  run('cpBridge.menuAction("start")');
  assert.equal(run('events[events.length-1].action'), 'start');
  assert.equal(run('events[events.length-1].generation'), 2);
});

test('a native action the browser refuses releases a pending task, keeps its draft, and says it was not sent', () => {
  const run = fixture();
  run(configure + ';cpBridge.setAgentMenu(' + nativePayload + ');cpBridge.showAgentMenu()');
  run('cpBridge.agentMenu.card.taskInput.text="Fix the greeting";cpBridge.menuAction("submit")');
  assert.equal(run('cpBridge.agentSubmitPending'), true);
  assert.equal(run('cpBridge.rejectAgentAction("submit","two").ok'), true);
  assert.equal(run('cpBridge.agentSubmitPending'), true, 'another project’s refusal does not release this task');
  assert.equal(run('cpBridge.rejectAgentAction("submit","one").ok'), true);
  assert.equal(run('cpBridge.agentSubmitPending'), false);
  assert.equal(run('cpBridge.agentMenu.card.sendButton.allowed'), true, 'Send follows the host-reported state again');
  assert.equal(run('cpBridge.agentMenu.card.taskInput.text'), 'Fix the greeting');
  run('cpBridge.tick()');
  assert.match(run('cpBridge.agentMenu.card.taskLabel.text'), /not sent/i, 'the notice survives polling');
  // The unsent text is no longer treated as submitted, so a later working state keeps it.
  run('var working=' + nativePayload + ';working.status="working";working.canSubmit=false;cpBridge.setAgentMenu(working)');
  assert.equal(run('cpBridge.agentMenu.card.taskInput.text'), 'Fix the greeting');
  // Sending again or closing the card clears the notice.
  run('cpBridge.setAgentMenu(' + nativePayload + ');cpBridge.menuAction("submit");cpBridge.tick()');
  assert.equal(run('cpBridge.agentMenu.card.taskLabel.text'), 'Give Atlas a task');
  run('cpBridge.rejectAgentAction("submit","one");cpBridge.hideAgentMenu();cpBridge.showAgentMenu()');
  assert.equal(run('cpBridge.agentMenu.card.taskLabel.text'), 'Give Atlas a task');
  assert.equal(run('cpBridge.agentMenu.card.taskInput.text'), 'Fix the greeting', 'the draft survives closing');
  // Refusing a project action while no card is open changes nothing.
  run('cpBridge.hideAgentMenu()');
  assert.equal(run('cpBridge.rejectAgentAction("start","one").menuVisible'), false);
  assert.equal(run('cpBridge.rejectAgentAction(1,"one").error'), 'invalid-rejection');
});

test('overlay and browser share the contract version and identity bounds', () => {
  const overlay = overlayDouble();
  assert.ok(Number.isSafeInteger(contract.BRIDGE_CONTRACT_VERSION), 'the browser exports its contract version');
  assert.deepEqual(overlay.read('events[0]'), { type: 'ready', version: contract.BRIDGE_CONTRACT_VERSION });
  assert.equal(overlay.read('cpBridge.version'), contract.BRIDGE_CONTRACT_VERSION);
  assert.equal(overlay.read('cpBridge.maxGameId'), contract.MAX_GAME_ID);
  assert.equal(overlay.read('cpBridge.maxProjects'), contract.MAX_MAPPINGS);
  const configure = projects => overlay.callExternalInterface('cpBridgeConfigure', 107, projects);
  const mapping = index => ({ projectId: 'p' + index, ownerId: 200 + index, puffleId: 900 + index });
  assert.equal(configure([{ projectId: 'edge', ownerId: contract.MAX_GAME_ID - 2000, puffleId: contract.MAX_GAME_ID }]).ok, true);
  assert.equal(configure([{ projectId: 'over', ownerId: contract.MAX_GAME_ID + 1, puffleId: 4 }]).error, 'invalid-project');
  assert.equal(configure(Array.from({ length: contract.MAX_MAPPINGS }, (_, index) => mapping(index))).ok, true);
  assert.equal(configure(Array.from({ length: contract.MAX_MAPPINGS + 1 }, (_, index) => mapping(index))).error, 'invalid-configuration');
});

test('every callback result carries the contract version, refusals included', () => {
  const overlay = overlayDouble();
  const used = new Set();
  const call = (name, ...args) => { used.add(name); return overlay.callExternalInterface(name, ...args); };
  const results = [
    call('cpBridgeSnapshot'), call('cpBridgeJoinIgloo', 105), call('cpBridgeAnimate', 4, 'working'),
    call('cpBridgeSetAgentMenu', null), call('cpBridgeShowAgentMenu'), call('cpBridgeHideAgentMenu'),
    call('cpBridgeConfigure', 0, []), call('cpBridgeConfigure', 107, [{ projectId: 'one', ownerId: 105, puffleId: 4 }]),
    call('cpBridgeJoinIgloo', 105), call('cpBridgeJoinRoom', 1), call('cpBridgeJoinRoom', 100), call('cpBridgeAnimate', 4, 'working'),
    call('cpBridgeSetAgentMenu', { enabled: true, connected: true, projectId: 'missing' }),
    call('cpBridgeSetAgentMenu', { enabled: true, connected: true, projectId: 'one' }), call('cpBridgeShowAgentMenu'),
    call('cpBridgeRejectAgentAction', 'submit', 'one'), call('cpBridgeRejectAgentAction', 1, 'one'), call('cpBridgeHideAgentMenu'),
    call('cpBridgeSetAgentMenu', { enabled: false }),
  ];
  for (const result of results) assert.equal(result?.version, contract.BRIDGE_CONTRACT_VERSION, JSON.stringify(result));
  assert.ok(results.some(result => result.ok) && results.some(result => !result.ok));
  assert.deepEqual([...used].sort(), overlay.read('(function(){var names=[];for(var name in callbacks)names.push(name);return names;})()').sort(),
    'every registered callback is covered');
});

// The harness runs on V8, so it accepts syntax and library calls that JPEXS
// cannot compile or AVM1 does not provide. Strings and comments are blanked
// first. Returns the names of every rule the source breaks. Not detected:
// destructuring assignment without `var`, a regex literal after `)`, and
// library calls outside the lists below. `.indexOf(` is refused for every
// receiver because the guard cannot tell an Array (no indexOf in AS2) from a
// String (which has one); compare with a loop or `substr` instead.
function es3Violations(text) {
  const code = text.replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
  const rules = {
    arrow: /=>/, template: /`/, let: /\blet\b/, const: /\bconst\b/, 'optional chaining': /\?\./, 'nullish coalescing': /\?\?/,
    spread: /\.\.\./, class: /\bclass\b/, 'for-of': /\bof\b/, 'single quote': /'/, exponent: /\*\*/,
    'regex literal': /(?:^|[=(,:[!&|?{};]|\breturn|\btypeof)\s*\/(?![/*])/m,
    'optional catch binding': /\bcatch\s*\{/,
    'default parameter': /\bfunction\b[^(]*\([^)]*=/,
    destructuring: /\bvar\s*[[{]|\bfunction\b[^(]*\(\s*[[{]/,
    'generator or async': /\bfunction\s*\*|\b(?:async|await|yield)\b/,
    'numeric literal form': /\d_\d|\b0[bBoO]\d/,
    'ES5+ global': /\b(?:JSON|Symbol|Promise|Map|Set|WeakMap|WeakSet|Proxy|Reflect)\b/,
    'ES5+ static method': /\bObject\s*\.\s*(?!registerClass\b)\w|\bArray\s*\.\s*(?:isArray|from|of)\b|\bNumber\s*\.\s*is\w|\bDate\s*\.\s*now\b/,
    'ES5+ instance method': /\.\s*(?:indexOf|lastIndexOf|some|every|forEach|map|filter|reduce|reduceRight|find|findIndex|includes|fill|flat|flatMap|trim|trimStart|trimEnd|padStart|padEnd|startsWith|endsWith|repeat|bind|toISOString)\s*\(/,
  };
  const found = Object.entries(rules).filter(([, pattern]) => pattern.test(code)).map(([name]) => name);
  if (objectMemberViolation(code)) found.push('object literal member');
  return found;
}
// ES3 object literal members are `key: value` with an identifier, string, or
// number key. This rejects shorthand properties, computed keys, accessors, and
// methods. A `{` counts as a literal only after `= ( , : [ ? ! & |` or `return`;
// any other brace is treated as a block and left unchecked.
function objectMemberViolation(code) {
  const tokens = code.match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|""|\.\.\.|\S/g) ?? [];
  const stack = [];
  let expectKey = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (stack.at(-1) === 'object' && expectKey) {
      expectKey = false;
      const key = /^(?:[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|"")$/.test(token) && tokens[index + 1] === ':';
      if (token !== '}' && !key) return true;
    }
    if (token === '{') {
      const literal = /^(?:[=(,:[?!&|]|return)$/.test(tokens[index - 1] ?? '');
      stack.push(literal ? 'object' : 'block');
      expectKey = literal;
    } else if (token === '(' || token === '[') stack.push(token);
    else if (token === '}' || token === ')' || token === ']') stack.pop();
    else if (token === ',' && stack.at(-1) === 'object') expectKey = true;
  }
  return false;
}

test('ES3 guard rejects constructs outside the AVM1 subset and accepts the overlay', () => {
  assert.deepEqual(es3Violations(source), []);
  const outside = {
    'shorthand property': 'var v = 1; var o = {v};',
    'default parameter': 'cpBridge.f = function(a = 1) { return a; };',
    'destructuring': 'var {visitorId} = cpBridge;',
    'regex literal': 'var ok = /^[0-9a-f-]+$/.test("ab");',
    'exponent': 'var n = 2 ** 3;',
    'optional catch binding': 'try { n = 1; } catch { n = 2; }',
    'computed key': 'var k = "a"; var c = {[k]: 1};',
    'getter in literal': 'var g = { get x() { return 1; } };',
    'setter in literal': 'var g = { set x(value) { this.y = value; } };',
    'method shorthand': 'var g = { run() { return 1; } };',
    'Array#indexOf': 'var index = cpBridge.projects.indexOf(1);',
    'Array#some': 'var hit = cpBridge.projects.some(function(p){ return p.ownerId == 1; });',
    'Object.keys': 'var keys = Object.keys({a:1});',
    'JSON': 'var text = JSON.stringify([]);',
    'String#trim': 'var t = " x ".trim();',
  };
  for (const [name, snippet] of Object.entries(outside)) {
    assert.notDeepEqual(es3Violations(source + '\n' + snippet + '\n'), [], name);
  }
});

test('overlay source documents every callback', () => {
  const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  const callbacks = [...source.matchAll(/addCallback\("(\w+)"/g)].map(match => match[1]);
  assert.equal(callbacks.length, 9);
  for (const name of callbacks) assert.ok(readme.includes('`' + name + '('), `README.md documents ${name}`);
});

// Drives the overlay with the browser's own mapping functions, crossing the
// boundary as JSON exactly as ExternalInterface would.
test('browser mapping flow: empty neighborhood, dynamic addition, UUID routing, and stale-control rejection', () => {
  const run = fixture();
  const read = expression => JSON.parse(run('JSON.stringify(' + expression + ')'));
  const sent = [];
  let configured = null;
  const reconcile = engine => {
    const mappings = agentMappings(engine);
    const key = mappingKey(mappings);
    const game = read('cpBridge.snapshot()');
    if (needsConfiguration(key, configured, game)) {
      const config = flashConfiguration(mappings);
      sent.push(config);
      const result = read('cpBridge.configure(' + config.visitorId + ',' + JSON.stringify(config.projects) + ')');
      assert.equal(result.ok, true);
      assert.equal(result.version, contract.BRIDGE_CONTRACT_VERSION);
      configured = { key, generation: result.generation, mappings };
    }
    return key;
  };
  const lastEvent = () => read('events[events.length-1]');

  let engine = engineSnapshot({ projects: [] });
  let key = reconcile(engine);
  assert.equal(configured.generation, 1);
  assert.equal(read('cpBridge.joinIgloo(105)').error, 'unknown-project');
  run('cpBridge.tick();puffle.clip.onPress()');
  assert.equal(lastEvent().type, 'original');

  // The engine finishes provisioning Atlas Repo; no page reload.
  engine = engineSnapshot({ projects: ['a', 'c'] });
  const pendingKey = mappingKey(agentMappings(engine));
  assert.equal(activeMappingsFor(pendingKey, configured), null, 'controls are stale before reconfiguration');
  key = reconcile(engine);
  assert.equal(configured.generation, 2);
  assert.equal(read('cpBridge.joinIgloo(105)').ok, true);
  run('cpBridge.tick();puffle.clip.onPress()');
  const click = lastEvent();
  assert.deepEqual(click, { type: 'puffle-click', ownerId: 105, puffleId: 4, projectId: PROJECT_A, generation: 2 });
  const selection = selectionForClick(activeMappingsFor(key, configured), read('cpBridge.snapshot()'), configured.generation, click, engine);
  assert.deepEqual(selection, { projectId: PROJECT_A, workerId: 'worker-a' });

  const engineState = { connected: true, snapshot: engine };
  const menu = nativeMenuState(engineState, configured.mappings, selection);
  sent.push(menu);
  assert.equal(read('cpBridge.setAgentMenu(' + JSON.stringify(menu) + ')').hudReady, true);
  run('cpBridge.showAgentMenu();cpBridge.menuAction("interrupt")');
  const interrupt = lastEvent();
  const context = () => ({ mappings: activeMappingsFor(key, configured), game: read('cpBridge.snapshot()'), generation: configured.generation, engineState, target: selection });
  assert.equal(allowedNativeAction(context(), interrupt), true);

  // Comet Repo arrives. The open card's earlier event is stale until reconfigured, and after.
  engine = engineSnapshot({ projects: ['a', 'b', 'c'] });
  const nextKey = mappingKey(agentMappings(engine));
  assert.equal(allowedNativeAction({ ...context(), mappings: activeMappingsFor(nextKey, configured) }, interrupt), false);
  key = reconcile(engine);
  assert.equal(configured.generation, 3);
  assert.equal(allowedNativeAction(context(), interrupt), false, 'generation 2 event after generation 3 configuration');
  assert.equal(selectionForClick(activeMappingsFor(key, configured), read('cpBridge.snapshot()'), configured.generation, click, engine), null);
  assert.equal(read('cpBridge.agentMenu != undefined'), true, 'a still-mapped card stays open');
  run('cpBridge.menuAction("interrupt")');
  assert.equal(allowedNativeAction(context(), lastEvent()), true);
  assert.equal(read('cpBridge.joinIgloo(106)').ok, true, `Comet Repo (${PROJECT_B}) is reachable without reload`);

  // A reconnect that repeats the same snapshot does not reconfigure.
  reconcile(structuredClone(engine));
  assert.equal(configured.generation, 3);
  // Nothing private crossed into Flash.
  assert.doesNotMatch(JSON.stringify(sent), PRIVATE);
  assert.doesNotMatch(JSON.stringify(read('events')), PRIVATE);
});
