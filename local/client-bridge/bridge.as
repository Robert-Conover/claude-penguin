// Opt-in, fixture-only experiment. These states do not represent a running agent.
// Added as a separate DoAction; none of the original client's actions are changed.
if (_global.__claudePenguinBridge == undefined) {
    _global.__claudePenguinBridge = {version:1, visitorId:0, projects:[], configured:false};
}
var cpBridge = _global.__claudePenguinBridge;
cpBridge.validId = function(value) {
    return typeof value == "number" && !isNaN(value) && value > 0 && value < 1000000000 && Math.floor(value) == value;
};
cpBridge.fail = function(reason) {
    return {ok:false, error:reason, version:1};
};
cpBridge.emit = function(event) {
    flash.external.ExternalInterface.call("window.ClaudePenguinBridge.receive", event);
};
cpBridge.configure = function(visitorId, projects) {
    if (!this.validId(visitorId) || !(projects instanceof Array) || projects.length < 1 || projects.length > 32) {
        return this.fail("invalid-configuration");
    }
    var checked = [];
    var owners = {};
    var puffles = {};
    for (var i = 0; i < projects.length; i++) {
        var project = projects[i];
        if (!this.validId(project.ownerId) || !this.validId(project.puffleId) || project.ownerId == visitorId ||
            typeof project.projectId != "string" || project.projectId.length < 1 || project.projectId.length > 100 ||
            owners[project.ownerId] || puffles[project.puffleId]) {
            return this.fail("invalid-project");
        }
        owners[project.ownerId] = true;
        puffles[project.puffleId] = true;
        checked.push({ownerId:project.ownerId, puffleId:project.puffleId, projectId:project.projectId});
    }
    this.projects = checked;
    this.visitorId = visitorId;
    this.configured = true;
    return {ok:true, version:1};
};
cpBridge.snapshot = function() {
    var shell = _global.getCurrentShell();
    var engine = _global.getCurrentEngine();
    var playerId = Number(shell.getMyPlayerId());
    var roomId = Number(shell.getCurrentRoomId());
    var ready = this.validId(playerId) && this.validId(roomId) && engine.isRoomReady() == true;
    var ownerId = 0;
    if (ready && engine.isInAnIgloo()) {
        ownerId = Number(shell.getIglooPlayerID());
        ready = this.validId(ownerId) && roomId == ownerId + 2000;
    }
    var result = {ok:ready, version:1, configured:this.configured, playerId:0, roomId:0, ownerId:0, puffles:[]};
    if (!ready) {
        result.error = "room-not-ready";
        return result;
    }
    result.playerId = playerId;
    result.roomId = roomId;
    result.ownerId = ownerId;
    if (this.configured && playerId != this.visitorId) {
        result.ok = false;
        result.error = "visitor-mismatch";
        return result;
    }
    if (ownerId > 0) {
        var puffles = engine.puffleManager._puffles;
        for (var i = 0; i < puffles.length; i++) {
            var puffle = puffles[i];
            if (puffle.clip._visible && puffle._artClip._totalframes > 1) {
                result.puffles.push({id:puffle.id, x:puffle.clip._x, y:puffle.clip._y});
            }
        }
    }
    return result;
};
cpBridge.mapping = function(ownerId, puffleId) {
    for (var i = 0; i < this.projects.length; i++) {
        var project = this.projects[i];
        if (project.ownerId == ownerId && (puffleId == undefined || project.puffleId == puffleId)) return project;
    }
    return null;
};
cpBridge.authorized = function() {
    var result = this.snapshot();
    if (!this.configured) return this.fail("not-configured");
    if (!result.ok) return result;
    if (result.playerId != this.visitorId) return this.fail("visitor-mismatch");
    return result;
};
cpBridge.joinIgloo = function(ownerId) {
    var current = this.authorized();
    if (!current.ok) return current;
    if (!this.validId(ownerId) || !this.mapping(ownerId)) return this.fail("unknown-project");
    if (_global.getCurrentShell().getCurrentGameRoomId() != undefined) return this.fail("leave-minigame-first");
    _global.getCurrentShell().sendJoinPlayerIgloo(ownerId);
    return {ok:true, requestedOwnerId:ownerId};
};
cpBridge.joinRoom = function(roomId) {
    var current = this.authorized();
    if (!current.ok) return current;
    // The experiment has one island destination: Town. Existing in-game travel stays intact.
    if (roomId != 100) return this.fail("unknown-room");
    var shell = _global.getCurrentShell();
    if (shell.getCurrentGameRoomId() != undefined) return this.fail("leave-minigame-first");
    shell.sendJoinRoom(shell.getRoomNameById(roomId), 0, 0);
    return {ok:true, requestedRoomId:roomId};
};
cpBridge.animate = function(puffleId, state) {
    var current = this.authorized();
    if (!current.ok) return current;
    if (!this.validId(puffleId) || !this.mapping(current.ownerId, puffleId)) return this.fail("unknown-puffle");
    var frames = {working:27, ready:28, interrupted:25, failed:33};
    frames["needs-you"] = 29;
    if (typeof state != "string" || frames[state] == undefined || typeof frames[state] != "number") return this.fail("unknown-state");
    var engine = _global.getCurrentEngine();
    var puffle = engine.puffleManager.getPuffleByID(puffleId);
    if (puffle == undefined || !puffle.clip._visible || puffle._artClip._totalframes < 2) return this.fail("puffle-not-ready");
    engine.puffleManager.updatePuffleFrameByID(puffleId, frames[state]);
    this.emit({type:"animation", ownerId:current.ownerId, puffleId:puffleId, state:state, simulated:true});
    return {ok:true, state:state, simulated:true};
};
cpBridge.tick = function() {
    var current = this.authorized();
    var engine = _global.getCurrentEngine();
    var puffles = engine.puffleManager._puffles;
    for (var i = 0; i < puffles.length; i++) {
        var puffle = puffles[i];
        var clip = puffle.clip;
        var project = current.ok ? this.mapping(current.ownerId, puffle.id) : null;
        if (project && clip._visible && puffle._artClip._totalframes > 1) {
            if (!clip.__cpBridgeHook) {
                clip.__cpBridgePreviousPress = clip.onPress;
                clip.__cpBridgeHook = true;
                clip.__cpBridgePuffleId = puffle.id;
                clip.__cpBridgeOwnerId = project.ownerId;
                clip.onPress = function() {
                    var bridge = _global.__claudePenguinBridge;
                    var snapshot = bridge.authorized();
                    var mapping = bridge.mapping(snapshot.ownerId, this.__cpBridgePuffleId);
                    if (snapshot.ok && mapping && snapshot.ownerId == this.__cpBridgeOwnerId) {
                        bridge.emit({type:"puffle-click", ownerId:snapshot.ownerId, puffleId:this.__cpBridgePuffleId, projectId:mapping.projectId});
                    }
                };
            }
        } else if (clip.__cpBridgeHook) {
            clip.onPress = clip.__cpBridgePreviousPress;
            delete clip.__cpBridgePreviousPress;
            delete clip.__cpBridgeHook;
            delete clip.__cpBridgePuffleId;
            delete clip.__cpBridgeOwnerId;
        }
    }
};
flash.external.ExternalInterface.addCallback("cpBridgeConfigure", cpBridge, cpBridge.configure);
flash.external.ExternalInterface.addCallback("cpBridgeSnapshot", cpBridge, cpBridge.snapshot);
flash.external.ExternalInterface.addCallback("cpBridgeJoinIgloo", cpBridge, cpBridge.joinIgloo);
flash.external.ExternalInterface.addCallback("cpBridgeJoinRoom", cpBridge, cpBridge.joinRoom);
flash.external.ExternalInterface.addCallback("cpBridgeAnimate", cpBridge, cpBridge.animate);
clearInterval(cpBridge.timer);
cpBridge.timer = setInterval(cpBridge, "tick", 250);
cpBridge.emit({type:"ready", version:1});
