// Test-only engine snapshots shaped like the Stage 2 engine contract: a verified
// visitor plus `project.game` mappings. Private fields are present on purpose so
// tests can prove they never reach the overlay. Not served by the web server.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export const PROJECT_A = '0f8a3c1e-2b4d-4e6f-8a9b-1c2d3e4f5a6b';
export const PROJECT_B = '7d6c5b4a-3e2f-4a1b-9c8d-7e6f5a4b3c2d';
export const PROJECT_C = '11111111-2222-4333-8444-555555555555';
export const PRIVATE = /private|\/Users\/|sessionId|sourcePath|workspace|token|verifiedAt|fixtureId|worker-/;

const game = (ownerId, puffleId, puffleName, extra = {}) => ({ source: 'managed', status: 'ready', ownerId, iglooId: puffleId,
  roomId: ownerId + 2000, puffleId, puffleName, fixtureId: null, verifiedAt: '2026-11-04T12:00:00.000Z', ...extra });
const worker = (id, projectId, name, status, extra = {}) => ({ id, projectId, name, status, sessionId: `private-session-${id}`,
  activity: `private activity ${id}`, established: true, running: true, recoveryBlocked: false, updatedAt: '2026-11-04T12:00:00.000Z',
  taskHistory: [{ prompt: 'private task' }], workspace: { kind: 'worktree', path: `/Users/private/worktrees/${id}`, state: 'ready' }, ...extra });

export function engineSnapshot({ visitor = true, projects = ['a', 'b', 'c'] } = {}) {
  const all = {
    a: { id: PROJECT_A, name: 'Atlas Repo', sourcePath: '/Users/private/atlas', sourceAvailable: true, legacy: false,
      setup: { phase: 'ready' }, activeWorkerId: 'worker-a', game: game(105, 4, 'Atlas') },
    b: { id: PROJECT_B, name: 'Comet Repo', sourcePath: '/Users/private/comet', sourceAvailable: true, legacy: true,
      setup: { phase: 'ready' }, activeWorkerId: 'worker-b', game: game(106, 5, 'Comet', { source: 'legacy-fixture', fixtureId: 'bridge-beta' }) },
    c: { id: PROJECT_C, name: 'Pending Repo', sourcePath: '/Users/private/pending', sourceAvailable: true, legacy: false,
      setup: { phase: 'provisioning' }, activeWorkerId: 'worker-c', game: game(108, 6, 'Nova', { status: 'provisioning' }) },
  };
  const workers = { a: worker('worker-a', PROJECT_A, 'Atlas', 'working'), b: worker('worker-b', PROJECT_B, 'Comet', 'needs-you'),
    c: worker('worker-c', PROJECT_C, 'Nova', 'review') };
  return {
    revision: 7, limits: { maxProjects: 32 }, worktreeRoot: '/Users/private/.claude-penguin/worktrees',
    visitor: visitor ? { penguinId: 107, username: 'bridgecheck', verifiedAt: '2026-11-04T12:00:00.000Z' } : null,
    projects: projects.map(key => all[key]),
    workers: projects.map(key => workers[key]),
    archivedWorkers: [{ id: 'worker-old', projectId: PROJECT_A, sessionId: 'private-archived-session', originalPath: '/Users/private/atlas' }],
  };
}

// ------------------------------------------------------------ overlay double
// Runs the real `client-bridge/bridge.as` (its shared ES3 subset) against narrow
// game doubles: a shell, engine, and interface with one puffle (4) in owner
// 105's igloo, and the visitor 107 logged in. This checks identity and state
// decisions; it does not emulate AVM1 or Ruffle.
export const bridgeSource = () => readFileSync(new URL('../../client-bridge/bridge.as', import.meta.url), 'utf8');

const gameDoubles = `
  var events = [], navigations = [], animations = [], callbacks = {};
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
  var flash = {external:{ExternalInterface:{
    addCallback:function(name,target,fn){callbacks[name]={target:target,fn:fn};},
    call:function(name,event){events.push(event);if(hostReceive)hostReceive(JSON.stringify(event));}}}};
  var setInterval=function(){return 1;},clearInterval=function(){};
`;

// `run` evaluates inside the overlay; `read` copies a value out as JSON.
// `callExternalInterface` mirrors Ruffle's player API: it invokes a registered
// callback with copied arguments and returns a copied result. `receive` gets
// each event the overlay sends to `window.ClaudePenguinBridge.receive`.
export function overlayDouble({ source = bridgeSource(), receive } = {}) {
  const context = vm.createContext({ hostReceive: receive ? json => receive(JSON.parse(json)) : undefined });
  vm.runInContext(gameDoubles + source, context);
  const run = expression => vm.runInContext(expression, context);
  const read = expression => {
    const json = run('JSON.stringify(' + expression + ')');
    return json === undefined ? undefined : JSON.parse(json);
  };
  const callExternalInterface = (name, ...args) => {
    context.__cpArguments = JSON.stringify(args);
    const json = run(`(function(){var entry=callbacks[${JSON.stringify(name)}];if(!entry)return undefined;` +
      'return JSON.stringify(entry.fn.apply(entry.target, JSON.parse(__cpArguments)));})()');
    return json === undefined ? null : JSON.parse(json);
  };
  return { run, read, callExternalInterface };
}
