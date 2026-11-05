import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { agentMappings, mappingKey, flashConfiguration, selectionForClick, activeMappingsFor, needsConfiguration } from '../web/bridge/model.mjs';
import { nativeMenuState, allowedNativeAction } from '../web/bridge/native-menu.mjs';
import { engineSnapshot, PROJECT_A, PROJECT_B, PRIVATE } from '../web/bridge/testing.mjs';

// bridge.as deliberately uses the common ES3 subset. This harness verifies the
// adapter's identity/state decisions; the live Ruffle check verifies AVM1 itself.
const source = readFileSync(new URL('./bridge.as', import.meta.url), 'utf8');

function fixture() {
  const context = vm.createContext({});
  vm.runInContext(`
    var events = [], navigations = [], animations = [];
    var playerId = 107, roomId = 2105, ownerId = 105, roomReady = true, inIgloo = true, gameRoom;
    var originalPress = function() { events.push({type:'original'}); };
    var puffle = {id:4, clip:{_visible:true, _x:200, _y:200, onPress:originalPress}, _artClip:{_totalframes:35}};
    var shell = {
      getMyPlayerId:function(){return playerId;}, getCurrentRoomId:function(){return roomId;},
      // The newer IglooContext uses getIglooPlayerID, not the legacy stored igloo object.
      getPlayerIglooObject:function(){return undefined;}, getIglooPlayerID:function(){return ownerId;},
      getCurrentGameRoomId:function(){return gameRoom;}, getRoomNameById:function(){return 'town';},
      sendJoinPlayerIgloo:function(id){navigations.push(id);}, sendJoinRoom:function(name){navigations.push(name);},
      hideCount:0, hideTriggers:function(){this.hideCount++;}, showTriggers:function(){this.hideCount--;}
    };
    var engine = {
      isRoomReady:function(){return roomReady;}, isInAnIgloo:function(){return inIgloo;},
      puffleManager:{_puffles:[puffle],getPuffleByID:function(id){return id==4?puffle:undefined;},
        updatePuffleFrameByID:function(id,frame){animations.push({id:id,frame:frame});}}
    };
    function Clip(parent, name) { this._parent=parent; this._name=name; this.depth=0; this._visible=true; }
    Clip.prototype.getNextHighestDepth=function(){return ++this.depth;};
    Clip.prototype.createEmptyMovieClip=function(name){var clip=new Clip(this,name);this[name]=clip;return clip;};
    Clip.prototype.removeMovieClip=function(){if(this._parent)delete this._parent[this._name];this.removed=true;};
    Clip.prototype.createTextField=function(name){this[name]={text:'',setTextFormat:function(){},setNewTextFormat:function(){}};};
    Clip.prototype.lineStyle=Clip.prototype.beginFill=Clip.prototype.moveTo=Clip.prototype.lineTo=Clip.prototype.curveTo=Clip.prototype.endFill=function(){};
    var TextFormat=function(){};
    var MovieClipLoader=function(){};
    MovieClipLoader.prototype.addListener=function(listener){this.listener=listener;};
    MovieClipLoader.prototype.loadClip=function(url,clip){clip.url=url;clip._width=366;clip._height=319;this.listener.onLoadInit(clip);};
    var Selection={setFocus:function(value){this.focus=value;}};
    var ui={interface_mc:new Clip(null,'interface'),is_quick_keys_active:true,widgets:false,
      getWidgetsActive:function(){return this.widgets;},setWidgetsActive:function(value){this.widgets=value;},
      stopQuickKeys:function(){this.is_quick_keys_active=false;},startQuickKeys:function(){this.is_quick_keys_active=true;}};
    var _global = {getCurrentShell:function(){return shell;},getCurrentEngine:function(){return engine;},getCurrentInterface:function(){return ui;}};
    var flash = {external:{ExternalInterface:{addCallback:function(){},call:function(name,event){events.push(event);}}}};
    var setInterval=function(){return 1;},clearInterval=function(){};
  ` + source, context);
  return expression => vm.runInContext(expression, context);
}

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

test('overlay source stays in the AVM1-compatible subset and documents every callback', () => {
  // The harness runs on V8; this guards against syntax JPEXS cannot compile to AVM1.
  const code = source.replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/\/\/[^\n]*/g, '');
  for (const pattern of [/=>/, /`/, /\blet\b/, /\bconst\b/, /\?\./, /\?\?/, /\.\.\./, /\bclass\b/, /\bof\b/, /'/]) {
    assert.doesNotMatch(code, pattern);
  }
  const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  const callbacks = [...source.matchAll(/addCallback\("(\w+)"/g)].map(match => match[1]);
  assert.equal(callbacks.length, 8);
  for (const name of callbacks) assert.match(readme, new RegExp('`' + name + '\\('));
  assert.match(source, /emit\(\{type:"ready", version:2\}\)/);
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
      assert.equal(result.version, 2);
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
