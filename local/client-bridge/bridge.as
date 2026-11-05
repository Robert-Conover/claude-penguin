// Opt-in game bridge. Native menus display host-reported state; animation alone is not execution.
// Added as a separate DoAction; none of the original client's actions are changed.
if (_global.__claudePenguinBridge == undefined) {
    _global.__claudePenguinBridge = {version:2, visitorId:0, projects:[], configured:false, generation:0};
}
var cpBridge = _global.__claudePenguinBridge;
cpBridge.version = 2;
if (typeof cpBridge.generation != "number") cpBridge.generation = 0;
cpBridge.validId = function(value) {
    return typeof value == "number" && !isNaN(value) && value > 0 && value < 1000000000 && Math.floor(value) == value;
};
cpBridge.fail = function(reason) {
    return {ok:false, error:reason, version:2};
};
cpBridge.emit = function(event) {
    flash.external.ExternalInterface.call("window.ClaudePenguinBridge.receive", event);
};
// Each successful configuration replaces every mapping and advances the
// generation. Hooks, snapshots, and events carry it so the browser can reject
// controls prepared against an older mapping. An empty list is a valid empty
// neighborhood for the verified visitor.
cpBridge.configure = function(visitorId, projects) {
    if (!this.validId(visitorId) || !(projects instanceof Array) || projects.length > 32) {
        return this.fail("invalid-configuration");
    }
    var checked = [];
    var owners = {};
    var puffles = {};
    var ids = {};
    for (var i = 0; i < projects.length; i++) {
        var project = projects[i];
        if (!this.validId(project.ownerId) || !this.validId(project.puffleId) || project.ownerId == visitorId ||
            typeof project.projectId != "string" || project.projectId.length < 1 || project.projectId.length > 100 ||
            owners[project.ownerId] || puffles[project.puffleId] || ids["id:" + project.projectId]) {
            return this.fail("invalid-project");
        }
        owners[project.ownerId] = true;
        puffles[project.puffleId] = true;
        ids["id:" + project.projectId] = true;
        checked.push({ownerId:project.ownerId, puffleId:project.puffleId, projectId:project.projectId});
    }
    this.projects = checked;
    this.visitorId = visitorId;
    this.configured = true;
    this.generation = this.generation + 1;
    // Drop every existing click hook; tick re-attaches only currently mapped puffles.
    this.unhookAll();
    if (this.agentData.projectId != undefined && this.agentData.projectId != "" && !this.menuMapping(this.agentData.projectId)) {
        this.hideAgentMenu();
        this.agentData.projectId = "";
    }
    return {ok:true, version:2, generation:this.generation};
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
    var result = {ok:ready, version:2, configured:this.configured, generation:this.generation, playerId:0, roomId:0, ownerId:0, puffles:[], nativeMenuReady:this.agentHUD != undefined};
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
// The coding menu is drawn in the existing AVM1 display list. Host credentials,
// repository paths, terminal bytes, and Claude session IDs never enter Flash.
cpBridge.menuText = function(value, fallback, limit) {
    return typeof value == "string" ? value.substr(0, limit) : fallback;
};
cpBridge.menuMapping = function(projectId) {
    for (var i = 0; i < this.projects.length; i++) {
        if (this.projects[i].projectId == projectId) return this.projects[i];
    }
    return null;
};
cpBridge.roundBox = function(mc, x, y, w, h, radius, fill, stroke, weight, alpha) {
    mc.lineStyle(weight, stroke, 100);
    mc.beginFill(fill, alpha == undefined ? 100 : alpha);
    mc.moveTo(x + radius, y);
    mc.lineTo(x + w - radius, y);
    mc.curveTo(x + w, y, x + w, y + radius);
    mc.lineTo(x + w, y + h - radius);
    mc.curveTo(x + w, y + h, x + w - radius, y + h);
    mc.lineTo(x + radius, y + h);
    mc.curveTo(x, y + h, x, y + h - radius);
    mc.lineTo(x, y + radius);
    mc.curveTo(x, y, x + radius, y);
    mc.endFill();
};
cpBridge.textField = function(mc, name, text, x, y, w, h, size, color, bold, align) {
    mc.createTextField(name, mc.getNextHighestDepth(), x, y, w, h);
    var field = mc[name];
    var format = new TextFormat();
    format.font = "Arial";
    format.size = size;
    format.color = color;
    format.bold = bold;
    format.align = align == undefined ? "left" : align;
    field.setNewTextFormat(format);
    field.text = text;
    field.setTextFormat(format);
    field.selectable = false;
    field.wordWrap = true;
    return field;
};
cpBridge.menuButton = function(parent, name, label, action, x, y, width, height) {
    var button = parent.createEmptyMovieClip(name, parent.getNextHighestDepth());
    button._x = x;
    button._y = y;
    this.roundBox(button, 0, 0, width, height, 12, 0x0575BC, 0x003858, 2);
    this.roundBox(button, 2, 2, width - 4, height - 4, 10, 0x168BD0, 0x7DDCF6, 1);
    this.textField(button, "label", label, 3, Math.floor((height - 21) / 2), width - 6, 22, 14, 0xFFFFFF, true, "center");
    button.label.wordWrap = false;
    button.action = action;
    button.allowed = true;
    button.onRelease = function() {
        if (this.allowed) _global.__claudePenguinBridge.menuAction(this.action);
    };
    button.onRollOver = function() { if (this.allowed) this._alpha = 85; };
    button.onRollOut = function() { this._alpha = this.allowed ? 100 : 45; };
    return button;
};
cpBridge.enableMenuButton = function(button, enabled) {
    button.allowed = enabled;
    button.useHandCursor = enabled;
    button._alpha = enabled ? 100 : 45;
};
cpBridge.menuResult = function() {
    return {ok:true, nativeMenu:this.agentHUD != undefined, hudReady:this.agentHUD != undefined, menuVisible:this.agentMenu != undefined};
};
cpBridge.setAgentMenu = function(payload) {
    if (payload == undefined || typeof payload != "object" || typeof payload.enabled != "boolean") return this.fail("invalid-agent-menu");
    if (!payload.enabled) {
        this.hideAgentMenu();
        if (this.agentHUD != undefined) this.agentHUD.removeMovieClip();
        this.agentHUD = undefined;
        this.agentData = {enabled:false};
        return this.menuResult();
    }
    var projectId = this.menuText(payload.projectId, "", 100);
    if (projectId != "" && !this.menuMapping(projectId)) return this.fail("unknown-project");
    if (this.agentData.projectId != projectId) this.hideAgentMenu();
    this.agentData = {enabled:true, connected:payload.connected == true, projectId:projectId,
        name:this.menuText(payload.name, "Your puffle", 80), projectName:this.menuText(payload.projectName, "Your igloo", 80),
        status:this.menuText(payload.status, "offline", 30), activity:this.menuText(payload.activity, "", 160),
        canStart:payload.canStart == true, canSubmit:payload.canSubmit == true, running:payload.running == true,
        attention:typeof payload.attention == "number" ? Math.max(0, Math.min(99, Math.floor(payload.attention))) : 0};
    this.syncAgentMenu();
    return this.menuResult();
};
cpBridge.hideAgentMenu = function() {
    this.agentSubmitPending = false;
    if (this.agentMenu != undefined) {
        this.agentDrafts["project:" + this.agentMenuProject] = this.agentMenu.card.taskInput.text;
        Selection.setFocus(null);
        this.agentMenu.removeMovieClip();
        this.agentMenu = undefined;
        var ui = this.agentInterface;
        var shell = this.agentShell;
        if (ui != undefined) {
            ui.setWidgetsActive(this.agentPreviousWidgets == true);
            if (this.agentPreviousQuickKeys == true) ui.startQuickKeys();
        }
        // The shell resets its reference count on some room transitions.
        if (shell != undefined && shell.hideCount > this.agentPreviousTriggerCount) shell.showTriggers();
        this.agentInterface = undefined;
        this.agentShell = undefined;
    }
    return this.menuResult();
};
cpBridge.showAgentMenu = function() {
    var current = this.authorized();
    if (!current.ok) return current;
    if (this.agentData.enabled != true) return this.fail("agent-menu-disabled");
    var shell = _global.getCurrentShell();
    var ui = _global.getCurrentInterface();
    if (shell.getCurrentGameRoomId() != undefined) return this.fail("leave-minigame-first");
    if (ui == undefined || ui.interface_mc == undefined) return this.fail("interface-not-ready");
    if (!this.menuMapping(this.agentData.projectId)) {
        this.emit({type:"agent-menu-action", action:"work", generation:this.generation});
        return this.menuResult();
    }
    if (this.agentMenu != undefined) { this.syncAgentMenu(); return this.menuResult(); }
    if (ui.getWidgetsActive() == true) return this.fail("close-game-menu-first");
    this.agentPreviousWidgets = ui.getWidgetsActive();
    this.agentPreviousQuickKeys = ui.is_quick_keys_active;
    this.agentPreviousTriggerCount = Number(shell.hideCount);
    if (isNaN(this.agentPreviousTriggerCount)) this.agentPreviousTriggerCount = 0;
    this.agentInterface = ui;
    this.agentShell = shell;
    ui.stopQuickKeys();
    ui.setWidgetsActive(true);
    shell.hideTriggers();
    var menu = ui.interface_mc.createEmptyMovieClip("__cpAgentMenu", ui.interface_mc.getNextHighestDepth());
    this.agentMenu = menu;
    this.agentMenuRoom = current.roomId;
    this.agentMenuProject = this.agentData.projectId;
    var shield = menu.createEmptyMovieClip("shield", menu.getNextHighestDepth());
    this.roundBox(shield, 0, 0, 760, 480, 0, 0x002849, 0x002849, 0, 18);
    shield.onPress = function() {};
    shield.useHandCursor = false;
    var card = menu.createEmptyMovieClip("card", menu.getNextHighestDepth());
    card._x = 160;
    card._y = 62;
    this.roundBox(card, -3, -3, 446, 356, 24, 0xFFFFFF, 0x003858, 2);
    this.roundBox(card, 0, 0, 440, 350, 22, 0x087AC1, 0x79DEFF, 3);
    this.roundBox(card, 8, 8, 424, 334, 17, 0x087AC1, 0x005B9F, 1);
    this.textField(card, "title", "", 22, 12, 350, 30, 23, 0x001A2B, false);
    this.textField(card, "project", "", 23, 43, 365, 22, 13, 0xFFFFFF, false);
    this.menuButton(card, "closeButton", "X", "close", 400, 12, 27, 27);
    this.roundBox(card, 20, 72, 400, 65, 12, 0xF5FBFE, 0x00538E, 2);
    var portrait = card.createEmptyMovieClip("portrait", card.getNextHighestDepth());
    portrait._x = 30;
    portrait._y = 78;
    var loader = new MovieClipLoader();
    var listener = {};
    listener.onLoadInit = function(clip) {
        var scale = Math.min(65 / clip._width, 54 / clip._height) * 100;
        clip._xscale = scale;
        clip._yscale = scale;
    };
    loader.addListener(listener);
    loader.loadClip("/engine/art/puffle-blue.png", portrait);
    menu.portraitLoader = loader;
    this.textField(card, "status", "", 105, 80, 305, 24, 17, 0x003B67, true);
    this.textField(card, "activity", "", 105, 104, 305, 31, 11, 0x254356, false);
    this.textField(card, "taskLabel", "Give your puffle a task", 22, 146, 395, 25, 16, 0xFFFFFF, true);
    this.roundBox(card, 20, 175, 400, 62, 9, 0xFFFFFF, 0x00497C, 2);
    var draft = this.agentDrafts["project:" + this.agentMenuProject];
    var input = this.textField(card, "taskInput", typeof draft == "string" ? draft : "", 28, 181, 384, 50, 14, 0x183950, false);
    input.type = "input";
    input.selectable = true;
    input.multiline = true;
    input.maxChars = 20000;
    input.wordWrap = true;
    this.menuButton(card, "startButton", "Start / Resume", "start", 20, 248, 147, 32);
    this.menuButton(card, "interruptButton", "Interrupt", "interrupt", 175, 248, 94, 32);
    this.menuButton(card, "sendButton", "Send task", "submit", 277, 248, 143, 32);
    this.menuButton(card, "terminalButton", "Open Claude", "terminal", 20, 299, 195, 32);
    this.menuButton(card, "changesButton", "Changes", "changes", 225, 299, 195, 32);
    this.syncAgentMenu();
    return this.menuResult();
};
cpBridge.menuAction = function(action) {
    if (action == "close") return this.hideAgentMenu();
    var current = this.authorized();
    if (!current.ok) { this.hideAgentMenu(); return current; }
    var data = this.agentData;
    if (data.enabled != true) return this.fail("agent-menu-disabled");
    if (_global.getCurrentShell().getCurrentGameRoomId() != undefined) return this.fail("leave-minigame-first");
    if (action == "work" || action == "igloos") {
        this.hideAgentMenu();
        this.emit({type:"agent-menu-action", projectId:data.projectId, action:action, generation:this.generation});
        return this.menuResult();
    }
    if (this.agentMenu == undefined || this.agentMenuProject != data.projectId || !this.menuMapping(data.projectId)) return this.fail("unknown-project");
    if (current.roomId != this.agentMenuRoom) { this.hideAgentMenu(); return this.fail("room-changed"); }
    if (action != "terminal" && !data.connected) return this.fail("runtime-disconnected");
    if (action == "start" && !data.canStart) return this.fail("session-not-startable");
    if (action == "interrupt" && !data.running) return this.fail("session-not-running");
    if (action == "submit" && !data.canSubmit) return this.fail("session-not-ready");
    if (action == "submit" && this.agentSubmitPending == true) return this.fail("awaiting-task-event");
    if (action != "start" && action != "interrupt" && action != "submit" && action != "terminal" && action != "changes") return this.fail("unknown-menu-action");
    var event = {type:"agent-menu-action", projectId:data.projectId, action:action, generation:this.generation};
    if (action == "submit") {
        var text = this.agentMenu.card.taskInput.text;
        if (typeof text != "string" || text.length < 1 || text.length > 20000) return this.fail("invalid-task");
        event.text = text;
        this.agentSubmittedText = text;
        this.agentSubmittedProject = data.projectId;
        this.agentSubmitPending = true;
        this.enableMenuButton(this.agentMenu.card.sendButton, false);
    }
    if (action == "terminal" || action == "changes") this.hideAgentMenu();
    this.emit(event);
    return this.menuResult();
};
cpBridge.syncAgentMenu = function() {
    var current = this.authorized();
    var ui = _global.getCurrentInterface();
    var shell = _global.getCurrentShell();
    var available = this.agentData.enabled == true && current.ok && ui != undefined && ui.interface_mc != undefined && shell.getCurrentGameRoomId() == undefined;
    if (!available) {
        this.hideAgentMenu();
        if (this.agentHUD != undefined) this.agentHUD.removeMovieClip();
        this.agentHUD = undefined;
        return;
    }
    if (this.agentHUD == undefined) {
        var hud = ui.interface_mc.createEmptyMovieClip("__cpAgentHUD", ui.interface_mc.getNextHighestDepth());
        this.agentHUD = hud;
        hud._x = 465;
        hud._y = 12;
        this.menuButton(hud, "workButton", "Work", "work", 0, 0, 85, 31);
        this.menuButton(hud, "igloosButton", "Igloos", "igloos", 91, 0, 85, 31);
    }
    var data = this.agentData;
    if (!data.canSubmit || !data.connected) this.agentSubmitPending = false;
    if (data.status == "working" && this.agentSubmittedProject == data.projectId) {
        if (this.agentDrafts["project:" + data.projectId] == this.agentSubmittedText) this.agentDrafts["project:" + data.projectId] = "";
        if (this.agentMenu != undefined && this.agentMenuProject == data.projectId && this.agentMenu.card.taskInput.text == this.agentSubmittedText) this.agentMenu.card.taskInput.text = "";
        this.agentSubmittedText = undefined;
        this.agentSubmittedProject = undefined;
    }
    this.agentHUD.workButton.label.text = data.attention > 0 ? "Work (" + data.attention + ")" : "Work";
    if (this.agentMenu == undefined) return;
    if (current.roomId != this.agentMenuRoom || data.projectId != this.agentMenuProject) { this.hideAgentMenu(); return; }
    var card = this.agentMenu.card;
    var labels = {starting:"Waking up...", idle:"Ready for a task", working:"Working", review:"Ready for review", interrupted:"Taking a break", failed:"Something went wrong", offline:"Taking a break"};
    labels["needs-you"] = "Needs your help";
    card.title.text = data.name;
    card.project.text = data.projectName;
    card.status.text = !data.connected ? "Connection lost" : typeof labels[data.status] != "string" ? "Waiting" : labels[data.status];
    card.activity.text = !data.connected ? "Open Claude to reconnect." : data.activity;
    card.taskLabel.text = "Give " + data.name + " a task";
    this.enableMenuButton(card.startButton, data.connected && data.canStart);
    this.enableMenuButton(card.interruptButton, data.connected && data.running);
    this.enableMenuButton(card.sendButton, data.connected && data.canSubmit && this.agentSubmitPending != true);
    this.enableMenuButton(card.changesButton, data.connected);
    card.taskInput.type = data.connected && data.canSubmit ? "input" : "dynamic";
};
cpBridge.agentData = {enabled:false};
cpBridge.agentDrafts = {};
cpBridge.tick = function() {
    if (this.agentData.enabled == true) this.syncAgentMenu();
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
                        bridge.emit({type:"puffle-click", ownerId:snapshot.ownerId, puffleId:this.__cpBridgePuffleId, projectId:mapping.projectId, generation:bridge.generation});
                    }
                };
            }
        } else if (clip.__cpBridgeHook) {
            this.unhook(clip);
        }
    }
};
cpBridge.unhook = function(clip) {
    clip.onPress = clip.__cpBridgePreviousPress;
    delete clip.__cpBridgePreviousPress;
    delete clip.__cpBridgeHook;
    delete clip.__cpBridgePuffleId;
    delete clip.__cpBridgeOwnerId;
};
cpBridge.unhookAll = function() {
    var engine = _global.getCurrentEngine();
    var puffles = engine.puffleManager._puffles;
    for (var i = 0; i < puffles.length; i++) {
        if (puffles[i].clip.__cpBridgeHook) this.unhook(puffles[i].clip);
    }
};
flash.external.ExternalInterface.addCallback("cpBridgeSetAgentMenu", cpBridge, cpBridge.setAgentMenu);
flash.external.ExternalInterface.addCallback("cpBridgeShowAgentMenu", cpBridge, cpBridge.showAgentMenu);
flash.external.ExternalInterface.addCallback("cpBridgeHideAgentMenu", cpBridge, cpBridge.hideAgentMenu);
flash.external.ExternalInterface.addCallback("cpBridgeConfigure", cpBridge, cpBridge.configure);
flash.external.ExternalInterface.addCallback("cpBridgeSnapshot", cpBridge, cpBridge.snapshot);
flash.external.ExternalInterface.addCallback("cpBridgeJoinIgloo", cpBridge, cpBridge.joinIgloo);
flash.external.ExternalInterface.addCallback("cpBridgeJoinRoom", cpBridge, cpBridge.joinRoom);
flash.external.ExternalInterface.addCallback("cpBridgeAnimate", cpBridge, cpBridge.animate);
clearInterval(cpBridge.timer);
cpBridge.timer = setInterval(cpBridge, "tick", 250);
cpBridge.emit({type:"ready", version:2});
