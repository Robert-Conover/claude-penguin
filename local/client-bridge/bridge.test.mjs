import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

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
  assert.equal(run('cpBridge.configured'), false);
});

const nativePayload = '{enabled:true,connected:true,fixtureId:"one",name:"Atlas",projectName:"My repository",status:"idle",activity:"Ready",canStart:false,canSubmit:true,running:true,attention:0}';

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
  assert.equal(run('events[events.length-1].fixtureId'), 'one');
  assert.equal(run('events[events.length-1].text'), 'Fix the greeting');
  assert.equal(run('cpBridge.menuAction("submit").error'), 'awaiting-task-event');
  run('cpBridge.tick()');
  assert.equal(run('cpBridge.agentMenu.card.sendButton.allowed'), false, 'polling cannot re-enable a submitted task before a real event');
  assert.deepEqual(JSON.parse(run('JSON.stringify(Object.keys(events[events.length-1]).sort())')), ['action', 'fixtureId', 'text', 'type']);
  assert.equal(run('cpBridge.menuAction("terminal").menuVisible'), false);
  assert.equal(run('ui.is_quick_keys_active'), true);
  assert.equal(run('ui.widgets'), false);
  assert.equal(run('shell.hideCount'), 0);
});

test('native controls fail closed for disconnected, stale, or mismatched sessions', () => {
  const run = fixture();
  run(configure + ';cpBridge.setAgentMenu(' + nativePayload + ');cpBridge.showAgentMenu()');
  assert.equal(run('cpBridge.menuAction("start").error'), 'session-not-startable');
  assert.equal(run('cpBridge.setAgentMenu({enabled:true,fixtureId:"missing"}).error'), 'unknown-project');
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
  run('var second=' + nativePayload + ';second.fixtureId="two";cpBridge.setAgentMenu(second);cpBridge.showAgentMenu()');
  assert.equal(run('cpBridge.agentMenu.card.taskInput.text'), '', 'different puffle must not inherit the draft');
  run('cpBridge.agentMenu.card.taskInput.text="Comet draft";cpBridge.menuAction("close");cpBridge.setAgentMenu(' + nativePayload + ');cpBridge.showAgentMenu()');
  assert.equal(run('cpBridge.agentMenu.card.taskInput.text'), 'Atlas draft');
  run('cpBridge.menuAction("submit");cpBridge.menuAction("changes")');
  run('var working=' + nativePayload + ';working.status="working";working.canSubmit=false;cpBridge.setAgentMenu(working);cpBridge.showAgentMenu()');
  assert.equal(run('cpBridge.agentMenu.card.taskInput.text'), '', 'real working event clears the matching submitted draft even while hidden');
  run('cpBridge.setAgentMenu(second);cpBridge.showAgentMenu()');
  assert.equal(run('cpBridge.agentMenu.card.taskInput.text'), 'Comet draft');
});
