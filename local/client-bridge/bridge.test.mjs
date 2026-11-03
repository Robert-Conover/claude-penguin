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
    var playerId = 107, roomId = 2105, ownerId = 105, roomReady = true, inIgloo = true;
    var originalPress = function() { events.push({type:'original'}); };
    var puffle = {id:4, clip:{_visible:true, _x:200, _y:200, onPress:originalPress}, _artClip:{_totalframes:35}};
    var shell = {
      getMyPlayerId:function(){return playerId;}, getCurrentRoomId:function(){return roomId;},
      // The newer IglooContext uses getIglooPlayerID, not the legacy stored igloo object.
      getPlayerIglooObject:function(){return undefined;}, getIglooPlayerID:function(){return ownerId;},
      getCurrentGameRoomId:function(){return undefined;}, getRoomNameById:function(){return 'town';},
      sendJoinPlayerIgloo:function(id){navigations.push(id);}, sendJoinRoom:function(name){navigations.push(name);}
    };
    var engine = {
      isRoomReady:function(){return roomReady;}, isInAnIgloo:function(){return inIgloo;},
      puffleManager:{_puffles:[puffle],getPuffleByID:function(id){return id==4?puffle:undefined;},
        updatePuffleFrameByID:function(id,frame){animations.push({id:id,frame:frame});}}
    };
    var _global = {getCurrentShell:function(){return shell;},getCurrentEngine:function(){return engine;}};
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
