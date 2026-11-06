// Opt-in game bridge. Native menus display host-reported state; animation alone is not execution.
// Added as a separate DoAction; none of the original client's actions are changed.
if (_global.__claudePenguinBridge == undefined) {
    _global.__claudePenguinBridge = {version:5, visitorId:0, projects:[], configured:false, generation:0};
}
var cpBridge = _global.__claudePenguinBridge;
// Contract version 5: every callback result carries `version`, refusals included.
// Each project maps a set of up to ten puffles with page-local draft slots.
// The browser mirrors the version and the bounds (web/bridge/model.mjs).
cpBridge.version = 5;
cpBridge.maxGameId = 999999999;
cpBridge.maxProjects = 32;
cpBridge.maxPuffles = 10;
if (typeof cpBridge.generation != "number") cpBridge.generation = 0;
cpBridge.validId = function(value) {
    return typeof value == "number" && !isNaN(value) && value > 0 && value <= this.maxGameId && Math.floor(value) == value;
};
cpBridge.fail = function(reason) {
    return {ok:false, error:reason, version:this.version};
};
cpBridge.emit = function(event) {
    flash.external.ExternalInterface.call("window.ClaudePenguinBridge.receive", event);
};
// Each successful configuration replaces every mapping and advances the
// generation. Hooks, snapshots, and events carry it so the browser can reject
// controls prepared against an older mapping. An empty list is a valid empty
// neighborhood for the verified visitor.
cpBridge.validSlot = function(value) {
    return typeof value == "number" && !isNaN(value) && value > 0 && value <= 100000 && Math.floor(value) == value;
};
cpBridge.configure = function(visitorId, projects) {
    if (!this.validId(visitorId) || !(projects instanceof Array) || projects.length > this.maxProjects) {
        return this.fail("invalid-configuration");
    }
    var checked = [];
    var owners = {};
    var puffles = {};
    var slots = {};
    var ids = {};
    for (var i = 0; i < projects.length; i++) {
        var project = projects[i];
        if (project == undefined || !this.validId(project.ownerId) || project.ownerId == visitorId ||
            typeof project.projectId != "string" || project.projectId.length < 1 || project.projectId.length > 100 ||
            owners[project.ownerId] || ids["id:" + project.projectId] || !(project.puffles instanceof Array) || project.puffles.length > this.maxPuffles) {
            return this.fail("invalid-project");
        }
        var mapped = [];
        for (var j = 0; j < project.puffles.length; j++) {
            var puffle = project.puffles[j];
            if (puffle == undefined || !this.validId(puffle.puffleId) || !this.validSlot(puffle.slot) || puffles[puffle.puffleId] || slots[puffle.slot]) {
                return this.fail("invalid-project");
            }
            puffles[puffle.puffleId] = true;
            slots[puffle.slot] = true;
            mapped.push({puffleId:puffle.puffleId, slot:puffle.slot});
        }
        owners[project.ownerId] = true;
        ids["id:" + project.projectId] = true;
        checked.push({ownerId:project.ownerId, projectId:project.projectId, puffles:mapped});
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
    this.hideAlerts();
    return {ok:true, version:this.version, generation:this.generation};
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
    var result = {ok:ready, version:this.version, configured:this.configured, generation:this.generation, playerId:0, roomId:0, ownerId:0, puffles:[], nativeMenuReady:this.agentHUD != undefined};
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
// The project mapped to an owner, and (with a puffle ID) that puffle's entry.
cpBridge.mapping = function(ownerId, puffleId) {
    for (var i = 0; i < this.projects.length; i++) {
        var project = this.projects[i];
        if (project.ownerId != ownerId) continue;
        if (puffleId == undefined) return {project:project, puffle:null};
        for (var j = 0; j < project.puffles.length; j++) {
            if (project.puffles[j].puffleId == puffleId) return {project:project, puffle:project.puffles[j]};
        }
        return null;
    }
    return null;
};
cpBridge.slotMapped = function(projectId, slot) {
    var project = this.menuMapping(projectId);
    if (!project) return false;
    for (var i = 0; i < project.puffles.length; i++) {
        if (project.puffles[i].slot == slot) return true;
    }
    return false;
};
cpBridge.authorized = function() {
    var result = this.snapshot();
    if (!this.configured) return this.fail("not-configured");
    if (!result.ok) return result;
    if (result.playerId != this.visitorId) return this.fail("visitor-mismatch");
    return result;
};
// `force` rejoins the igloo the visitor is already in, so a newly adopted puffle renders.
cpBridge.joinIgloo = function(ownerId, force) {
    var current = this.authorized();
    if (!current.ok) return current;
    if (!this.validId(ownerId) || !this.mapping(ownerId)) return this.fail("unknown-project");
    if (_global.getCurrentShell().getCurrentGameRoomId() != undefined) return this.fail("leave-minigame-first");
    if (current.ownerId == ownerId && force != true) return {ok:true, version:this.version, requestedOwnerId:ownerId, alreadyThere:true};
    _global.getCurrentShell().sendJoinPlayerIgloo(ownerId);
    return {ok:true, version:this.version, requestedOwnerId:ownerId};
};
cpBridge.joinRoom = function(roomId) {
    var current = this.authorized();
    if (!current.ok) return current;
    // The experiment has one island destination: Town. Existing in-game travel stays intact.
    if (roomId != 100) return this.fail("unknown-room");
    var shell = _global.getCurrentShell();
    if (shell.getCurrentGameRoomId() != undefined) return this.fail("leave-minigame-first");
    shell.sendJoinRoom(shell.getRoomNameById(roomId), 0, 0);
    return {ok:true, version:this.version, requestedRoomId:roomId};
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
    return {ok:true, version:this.version, state:state, simulated:true};
};
// The coding menu is drawn in the existing AVM1 display list. Host credentials,
// repository paths, terminal bytes, and Claude session IDs never enter Flash.
// removeMovieClip only works at depths 0 to 1048575. Owned clips are created
// at getNextHighestDepth(), which is out of that range once any clip above it
// exists in the parent, so move an owned clip into range before removing it.
cpBridge.removeClip = function(clip) {
    if (clip == undefined) return;
    var depth = clip.getDepth();
    if (depth < 0 || depth > 1048575) clip.swapDepths(1048000);
    clip.removeMovieClip();
};
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
    return {ok:true, version:this.version, nativeMenu:this.agentHUD != undefined, hudReady:this.agentHUD != undefined, menuVisible:this.agentMenu != undefined};
};
cpBridge.setAgentMenu = function(payload) {
    if (payload == undefined || typeof payload != "object" || typeof payload.enabled != "boolean") return this.fail("invalid-agent-menu");
    if (!payload.enabled) {
        this.hideAgentMenu();
        this.removeClip(this.agentHUD);
        this.agentHUD = undefined;
        this.agentData = {enabled:false};
        return this.menuResult();
    }
    var projectId = this.menuText(payload.projectId, "", 100);
    if (projectId != "" && payload.readOnly != true && !this.menuMapping(projectId)) return this.fail("unknown-project");
    var slot = typeof payload.draftSlot == "number" ? payload.draftSlot : 0;
    // An editable card must name one of its project's mapped puffles.
    if (projectId != "" && payload.readOnly != true && !this.slotMapped(projectId, slot)) return this.fail("unknown-puffle");
    if (this.agentData.projectId != projectId || this.agentData.draftSlot != slot) this.hideAgentMenu();
    this.agentData = {enabled:true, connected:payload.connected == true, projectId:projectId, draftSlot:slot, readOnly:payload.readOnly == true,
        name:this.menuText(payload.name, "Your puffle", 80), color:this.menuText(payload.color, "blue", 12), projectName:this.menuText(payload.projectName, "Your igloo", 80),
        status:this.menuText(payload.status, "offline", 30), activity:this.menuText(payload.activity, "", 160),
        canStart:payload.canStart == true, canSubmit:payload.canSubmit == true, running:payload.running == true,
        attention:typeof payload.attention == "number" ? Math.max(0, Math.min(99, Math.floor(payload.attention))) : 0,
        roster:this.menuRows(payload.roster, projectId, 10, false), alerts:this.menuRows(payload.alerts, "", 20, true)};
    this.syncAgentMenu();
    return this.menuResult();
};
// Bounded display rows. A roster row names a slot of the card's own project; an
// attention row names a mapped project and slot. Anything else is dropped.
cpBridge.menuRows = function(rows, projectId, limit, alerts) {
    var checked = [];
    if (!(rows instanceof Array)) return checked;
    for (var i = 0; i < rows.length && checked.length < limit; i++) {
        var row = rows[i];
        if (row == undefined || typeof row != "object" || !this.validSlot(row.slot)) continue;
        var owner = alerts ? this.menuText(row.projectId, "", 100) : projectId;
        if (owner == "" || !this.slotMapped(owner, row.slot)) continue;
        checked.push({projectId:owner, slot:row.slot, name:this.menuText(row.name, "Puffle", 16), status:this.menuText(row.status, "", 24),
            task:alerts ? "" : this.menuText(row.task, "", 60), projectName:alerts ? this.menuText(row.projectName, "", 30) : "",
            color:this.menuText(row.color, "blue", 12), selected:row.selected == true});
    }
    return checked;
};
cpBridge.puffleColors = {blue:0x2B6FD6, pink:0xF27FC3, black:0x333333, green:0x3FB34F, purple:0x8E4FC9, red:0xD9342B, yellow:0xF5D328,
    white:0xF4F4F4, orange:0xF28C28, brown:0x8A5A35};
cpBridge.puffleColors["blue-dog"] = 0x2B6FD6;
cpBridge.puffleColors["orange-cat"] = 0xF28C28;
// The archived puffle icon for a color. The Blue Dog and Orange Cat have only
// AS3 art in the archive, which AVM1 cannot load, so they use their base color.
cpBridge.portraitUrl = function(color) {
    var base = color == "blue-dog" ? "blue" : color == "orange-cat" ? "orange" : color;
    if (typeof this.puffleColors[base] != "number") base = "blue";
    return "/media/play/v2/content/global/puffle/icons/" + base + ".swf";
};
cpBridge.dot = function(mc, x, y, color) {
    var fill = typeof this.puffleColors[color] == "number" ? this.puffleColors[color] : 0x2B6FD6;
    mc.lineStyle(1, 0x003858, 100);
    mc.beginFill(fill, 100);
    mc.moveTo(x + 5, y);
    mc.curveTo(x + 10, y, x + 10, y + 5);
    mc.curveTo(x + 10, y + 10, x + 5, y + 10);
    mc.curveTo(x, y + 10, x, y + 5);
    mc.curveTo(x, y, x + 5, y);
    mc.endFill();
};
// One clickable row that selects a mapped puffle by project and slot. A compact
// row is one line: the name, then the detail.
cpBridge.selectRow = function(parent, name, row, x, y, width, label, detail, compact) {
    var clip = parent.createEmptyMovieClip(name, parent.getNextHighestDepth());
    clip._x = x;
    clip._y = y;
    this.roundBox(clip, 0, 0, width, compact ? 20 : 24, 7, row.selected ? 0xFFF4B8 : 0xF5FBFE, 0x00538E, 1);
    this.dot(clip, 6, compact ? 5 : 7, row.color);
    if (compact) {
        this.textField(clip, "label", label, 20, 2, 80, 16, 11, 0x002849, true);
        this.textField(clip, "detail", detail, 100, 4, width - 104, 14, 9, 0x254356, false);
    } else {
        this.textField(clip, "label", label, 20, 0, width - 24, 14, 11, 0x002849, true);
        this.textField(clip, "detail", detail, 20, 11, width - 24, 13, 9, 0x254356, false);
    }
    clip.label.wordWrap = false;
    clip.detail.wordWrap = false;
    clip.projectId = row.projectId;
    clip.slot = row.slot;
    clip.onRelease = function() { _global.__claudePenguinBridge.selectPuffle(this.projectId, this.slot); };
    return clip;
};
cpBridge.selectPuffle = function(projectId, slot) {
    var current = this.authorized();
    if (!current.ok) return current;
    if (!this.slotMapped(projectId, slot)) return this.fail("unknown-puffle");
    this.hideAlerts();
    this.emit({type:"agent-menu-action", projectId:projectId, draftSlot:slot, action:"select", generation:this.generation});
    return this.menuResult();
};
// Work: the actual puffles that need permission, an answer, recovery, or review.
cpBridge.showAlerts = function() {
    var current = this.authorized();
    if (!current.ok) return current;
    var ui = _global.getCurrentInterface();
    if (ui == undefined || ui.interface_mc == undefined) return this.fail("interface-not-ready");
    if (_global.getCurrentShell().getCurrentGameRoomId() != undefined) return this.fail("leave-minigame-first");
    var alerts = this.agentData.alerts;
    if (!(alerts instanceof Array) || alerts.length < 1) {
        this.emit({type:"agent-menu-action", action:"work", generation:this.generation});
        return this.menuResult();
    }
    this.hideAgentMenu();
    this.hideAlerts();
    var list = ui.interface_mc.createEmptyMovieClip("__cpAgentAlerts", ui.interface_mc.getNextHighestDepth());
    this.agentAlerts = list;
    list._x = 230;
    list._y = 52;
    var height = 70 + alerts.length * 28;
    this.roundBox(list, -3, -3, 306, height + 6, 20, 0xFFFFFF, 0x003858, 2);
    this.roundBox(list, 0, 0, 300, height, 18, 0x087AC1, 0x79DEFF, 3);
    this.textField(list, "title", "Puffles that need you", 18, 12, 240, 26, 17, 0xFFFFFF, true);
    this.menuButton(list, "closeButton", "X", "alerts-close", 262, 10, 27, 27);
    for (var i = 0; i < alerts.length; i++) {
        this.selectRow(list, "row" + i, alerts[i], 14, 48 + i * 28, 272, alerts[i].name + " \u00B7 " + alerts[i].projectName, alerts[i].status);
    }
    return this.menuResult();
};
cpBridge.hideAlerts = function() {
    this.removeClip(this.agentAlerts);
    this.agentAlerts = undefined;
    return this.menuResult();
};
cpBridge.hideAgentMenu = function() {
    this.agentSubmitPending = false;
    this.agentNotice = undefined;
    if (this.agentMenu != undefined) {
        this.agentDrafts["worker:" + this.agentMenuSlot] = this.agentMenu.card.taskInput.text;
        Selection.setFocus(null);
        this.removeClip(this.agentMenu);
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
    if (this.agentData.projectId == "" || (this.agentData.readOnly != true && !this.menuMapping(this.agentData.projectId))) {
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
    this.agentMenuSlot = this.agentData.draftSlot;
    var shield = menu.createEmptyMovieClip("shield", menu.getNextHighestDepth());
    this.roundBox(shield, 0, 0, 760, 480, 0, 0x002849, 0x002849, 0, 18);
    shield.onPress = function() {};
    shield.useHandCursor = false;
    var card = menu.createEmptyMovieClip("card", menu.getNextHighestDepth());
    card._x = 60;
    card._y = 62;
    this.roundBox(card, -3, -3, 646, 356, 24, 0xFFFFFF, 0x003858, 2);
    this.roundBox(card, 0, 0, 640, 350, 22, 0x087AC1, 0x79DEFF, 3);
    this.roundBox(card, 8, 8, 424, 334, 17, 0x087AC1, 0x005B9F, 1);
    this.roundBox(card, 440, 8, 192, 334, 17, 0x0B69A8, 0x005B9F, 1);
    this.textField(card, "title", "", 22, 12, 366, 30, 23, 0x001A2B, false);
    this.textField(card, "project", "", 23, 43, 365, 22, 13, 0xFFFFFF, false);
    this.textField(card, "rosterTitle", "In this igloo", 452, 16, 140, 22, 14, 0xFFFFFF, true);
    card.createEmptyMovieClip("roster", card.getNextHighestDepth());
    // The igloo Like widget sits in the host's AS3 layer above this card and
    // takes clicks across the stage's top-right corner (about x >= 600 and
    // y <= 165), so the X and the roster rows stay out of that area.
    this.menuButton(card, "closeButton", "X", "close", 396, 12, 27, 27);
    this.roundBox(card, 20, 72, 400, 65, 12, 0xF5FBFE, 0x00538E, 2);
    var portrait = card.createEmptyMovieClip("portrait", card.getNextHighestDepth());
    var loader = new MovieClipLoader();
    var listener = {};
    // Fit the loaded art inside the 65x54 portrait box at (30, 78), whatever
    // its registration point (the archived icons are centered on 0,0).
    listener.onLoadInit = function(clip) {
        clip.stop();
        var bounds = clip.getBounds(clip);
        var width = bounds.xMax - bounds.xMin;
        var height = bounds.yMax - bounds.yMin;
        if (!(width > 0 && height > 0)) return;
        var scale = Math.min(65 / width, 54 / height);
        clip._xscale = scale * 100;
        clip._yscale = scale * 100;
        clip._x = 30 + (65 - width * scale) / 2 - bounds.xMin * scale;
        clip._y = 78 + (54 - height * scale) / 2 - bounds.yMin * scale;
    };
    listener.onLoadError = function(clip) {
        if (clip.cpFallback == true) return;
        clip.cpFallback = true;
        loader.loadClip("/engine/art/puffle-blue.png", clip);
    };
    loader.addListener(listener);
    loader.loadClip(this.portraitUrl(this.agentData.color), portrait);
    menu.portraitLoader = loader;
    this.textField(card, "status", "", 105, 80, 305, 24, 17, 0x003B67, true);
    this.textField(card, "activity", "", 105, 104, 305, 31, 11, 0x254356, false);
    this.textField(card, "taskLabel", "Give your puffle a task", 22, 146, 395, 25, 16, 0xFFFFFF, true);
    this.roundBox(card, 20, 175, 400, 62, 9, 0xFFFFFF, 0x00497C, 2);
    var draft = this.agentDrafts["worker:" + this.agentMenuSlot];
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
    if (action == "alerts-close") return this.hideAlerts();
    if (action == "work" && this.agentMenu == undefined) return this.showAlerts();
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
    if (this.agentMenu == undefined || data.readOnly == true || this.agentMenuSlot != data.draftSlot || this.agentMenuProject != data.projectId || !this.menuMapping(data.projectId)) return this.fail("unknown-project");
    if (current.roomId != this.agentMenuRoom) { this.hideAgentMenu(); return this.fail("room-changed"); }
    if (action != "terminal" && !data.connected) return this.fail("runtime-disconnected");
    if (action == "start" && !data.canStart) return this.fail("session-not-startable");
    if (action == "interrupt" && !data.running) return this.fail("session-not-running");
    if (action == "submit" && !data.canSubmit) return this.fail("session-not-ready");
    if (action == "submit" && this.agentSubmitPending == true) return this.fail("awaiting-task-event");
    if (action != "start" && action != "interrupt" && action != "submit" && action != "terminal" && action != "changes") return this.fail("unknown-menu-action");
    var event = {type:"agent-menu-action", projectId:data.projectId, draftSlot:data.draftSlot, action:action, generation:this.generation};
    this.agentNotice = undefined;
    if (action == "submit") {
        var text = this.agentMenu.card.taskInput.text;
        if (typeof text != "string" || text.length < 1 || text.length > 20000) return this.fail("invalid-task");
        event.text = text;
        this.agentSubmittedText = text;
        this.agentSubmittedSlot = data.draftSlot;
        this.agentSubmittedProject = data.projectId;
        this.agentSubmitPending = true;
        this.enableMenuButton(this.agentMenu.card.sendButton, false);
    }
    if (action == "terminal" || action == "changes") this.hideAgentMenu();
    this.emit(event);
    return this.menuResult();
};
// The browser refused a card action, for example one prepared against an older
// configuration generation. Nothing was sent: release the matching pending task
// so Send follows the host-reported state again, keep the draft, and say so.
cpBridge.rejectAgentAction = function(action, projectId, slot) {
    if (typeof action != "string" || typeof projectId != "string") return this.fail("invalid-rejection");
    if (action == "submit" && this.agentSubmittedProject == projectId && this.agentSubmittedSlot == slot) {
        this.agentSubmitPending = false;
        this.agentSubmittedText = undefined;
        this.agentSubmittedProject = undefined;
    }
    if (this.agentMenu != undefined && projectId != "" && this.agentMenuProject == projectId && this.agentMenuSlot == slot) {
        this.agentNotice = action == "submit" ? "Task not sent. Try again." : "That did not go through. Try again.";
        this.syncAgentMenu();
    }
    return this.menuResult();
};
cpBridge.syncAgentMenu = function() {
    var current = this.authorized();
    var ui = _global.getCurrentInterface();
    var shell = _global.getCurrentShell();
    var available = this.agentData.enabled == true && current.ok && ui != undefined && ui.interface_mc != undefined && shell.getCurrentGameRoomId() == undefined;
    if (!available) {
        this.hideAgentMenu();
        this.hideAlerts();
        this.removeClip(this.agentHUD);
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
    if (data.status == "working" && this.agentSubmittedSlot == data.draftSlot && this.agentSubmittedProject == data.projectId) {
        if (this.agentDrafts["worker:" + data.draftSlot] == this.agentSubmittedText) this.agentDrafts["worker:" + data.draftSlot] = "";
        if (this.agentMenu != undefined && this.agentMenuProject == data.projectId && this.agentMenu.card.taskInput.text == this.agentSubmittedText) this.agentMenu.card.taskInput.text = "";
        this.agentSubmittedText = undefined;
        this.agentSubmittedProject = undefined;
    }
    this.agentHUD.workButton.label.text = data.attention > 0 ? "Work (" + data.attention + ")" : "Work";
    if (this.agentMenu == undefined) return;
    if (current.roomId != this.agentMenuRoom || data.projectId != this.agentMenuProject) { this.hideAgentMenu(); return; }
    var card = this.agentMenu.card;
    var labels = {starting:"Waking up...", idle:"Ready for a task", working:"Working", review:"Ready for review", interrupted:"Taking a break", failed:"Something went wrong", offline:"Taking a break"};
    labels.setup = "Setting up";
    labels.archived = "Archived";
    labels["setup-failed"] = "Setup failed";
    labels["needs-repair"] = "Needs repair";
    labels["source-unavailable"] = "Source unavailable";
    labels["needs-you"] = "Needs your help";
    card.title.text = data.name;
    card.project.text = data.projectName;
    card.status.text = !data.connected ? "Connection lost" : typeof labels[data.status] != "string" ? "Waiting" : labels[data.status];
    card.activity.text = !data.connected ? "Open Claude to reconnect." : data.activity;
    card.taskLabel.text = this.agentNotice != undefined ? this.agentNotice : "Give " + data.name + " a task";
    var editable = data.readOnly != true;
    card.startButton._visible = editable;
    card.interruptButton._visible = editable;
    card.sendButton._visible = editable;
    card.terminalButton._visible = editable;
    card.changesButton._visible = editable;
    card.taskLabel._visible = editable;
    card.taskInput._visible = editable;
    this.enableMenuButton(card.startButton, data.connected && data.canStart);
    this.enableMenuButton(card.interruptButton, data.connected && data.running);
    this.enableMenuButton(card.sendButton, data.connected && data.canSubmit && this.agentSubmitPending != true);
    this.enableMenuButton(card.changesButton, data.connected);
    card.taskInput.type = data.connected && data.canSubmit ? "input" : "dynamic";
    this.syncRoster(card, data);
};
// Redraws the roster column only when its rows change.
cpBridge.syncRoster = function(card, data) {
    var rows = data.roster instanceof Array ? data.roster : [];
    var key = "";
    for (var i = 0; i < rows.length; i++) key += rows[i].slot + "|" + rows[i].name + "|" + rows[i].status + "|" + rows[i].task + "|" + rows[i].selected + ";";
    if (card.roster.key == key) return;
    this.removeClip(card.roster);
    var roster = card.createEmptyMovieClip("roster", card.getNextHighestDepth());
    roster.key = key;
    var count = rows.length + " of " + this.maxPuffles + " puffles";
    var note = rows.length >= this.maxPuffles ? "This igloo is full." : "Adopt more at the Pet Shop.";
    this.textField(roster, "count", count, 452, 42, 168, 18, 12, 0xFFFFFF, true);
    this.textField(roster, "note", note, 452, 62, 168, 36, 11, 0xFFFFFF, false);
    // Rows start below the igloo Like widget's click area (see showAgentMenu).
    for (var j = 0; j < rows.length; j++) {
        var row = rows[j];
        this.selectRow(roster, "row" + j, row, 448, 116 + j * 22, 176, row.name, row.status, true);
    }
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
        var found = current.ok ? this.mapping(current.ownerId, puffle.id) : null;
        if (found && clip._visible && puffle._artClip._totalframes > 1) {
            if (!clip.__cpBridgeHook) {
                clip.__cpBridgePreviousPress = clip.onPress;
                clip.__cpBridgeHook = true;
                clip.__cpBridgePuffleId = puffle.id;
                clip.__cpBridgeOwnerId = found.project.ownerId;
                clip.onPress = function() {
                    var bridge = _global.__claudePenguinBridge;
                    var snapshot = bridge.authorized();
                    var mapping = bridge.mapping(snapshot.ownerId, this.__cpBridgePuffleId);
                    if (snapshot.ok && mapping && snapshot.ownerId == this.__cpBridgeOwnerId) {
                        bridge.emit({type:"puffle-click", ownerId:snapshot.ownerId, puffleId:this.__cpBridgePuffleId, projectId:mapping.project.projectId,
                            slot:mapping.puffle.slot, generation:bridge.generation});
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
// Project adoption (Plan B4). The browser passes the adoption ID the engine
// reserved and published; the overlay sends p#cpadopt through the shell's own
// connection and relays the reply. Only the world server debits coins; on
// success the shell shows the committed balance without a relog. The reply is
// never forwarded to AS3, so no puffle enters the visitor's own collections.
cpBridge.adoptionId = function(value) {
    if (typeof value != "string" || value.length != 36) return false;
    for (var i = 0; i < 36; i++) {
        var c = value.charAt(i);
        var dash = i == 8 || i == 13 || i == 18 || i == 23;
        if (dash ? c != "-" : !((c >= "0" && c <= "9") || (c >= "a" && c <= "f"))) return false;
    }
    return true;
};
cpBridge.puffleName = function(value) {
    if (typeof value != "string" || value.length < 1 || value.length > 12) return false;
    for (var i = 0; i < value.length; i++) {
        var c = value.charAt(i);
        if (!((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"))) return false;
    }
    return true;
};
cpBridge.adopt = function(adoptionId, typeId, name, subtypeId) {
    var current = this.authorized();
    if (!current.ok) return current;
    if (!this.adoptionId(adoptionId) || typeof typeId != "number" || typeId < 0 || typeId > 9 || Math.floor(typeId) != typeId ||
        typeof subtypeId != "number" || (subtypeId != 0 && subtypeId != 1006 && subtypeId != 1007) || !this.puffleName(name)) {
        return this.fail("invalid-adoption");
    }
    var shell = _global.getCurrentShell();
    var airtower = shell.AIRTOWER;
    if (airtower == undefined) return this.fail("connection-not-ready");
    if (this.adoptionListener == undefined) {
        this.adoptionListener = function(event) { _global.__claudePenguinBridge.adoptionReply(event); };
    }
    // Registered once per connection; Airtower ignores a duplicate listener.
    airtower.addListener("cpadopt", this.adoptionListener, this);
    airtower.send("s", "p#cpadopt", [adoptionId, typeId, name, subtypeId], "str", shell.getCurrentServerRoomId());
    return {ok:true, version:this.version, adoptionId:adoptionId};
};
// Reply fields after the command: [room, adoptionId, "ok", puffleId, typeId, subtypeId, name, coins, cost, createdAt, ownerId]
// or [room, adoptionId, "error", code]. Airtower passes them with the room first.
cpBridge.adoptionReply = function(event) {
    var fields = [];
    for (var i = 0; i < event.length; i++) fields.push(event[i]);
    if (fields.length > 0 && !this.adoptionId(String(fields[0])) && String(fields[0]) != "") fields.shift();
    var adoptionId = String(fields[0]);
    if (fields[1] == "ok" && fields.length >= 10) {
        var coins = Number(fields[6]);
        if (!isNaN(coins)) _global.getCurrentShell().setMyPlayerTotalCoins(coins);
        this.emit({type:"adoption-result", ok:true, adoptionId:adoptionId, puffleId:Number(fields[2]), typeId:Number(fields[3]), subtypeId:Number(fields[4]),
            name:String(fields[5]), coins:coins, cost:Number(fields[7]), createdAt:Number(fields[8]), ownerId:Number(fields[9])});
    } else {
        this.emit({type:"adoption-result", ok:false, adoptionId:adoptionId, code:String(fields[2])});
    }
};
flash.external.ExternalInterface.addCallback("cpBridgeAdopt", cpBridge, cpBridge.adopt);
flash.external.ExternalInterface.addCallback("cpBridgeSetAgentMenu", cpBridge, cpBridge.setAgentMenu);
flash.external.ExternalInterface.addCallback("cpBridgeShowAgentMenu", cpBridge, cpBridge.showAgentMenu);
flash.external.ExternalInterface.addCallback("cpBridgeHideAgentMenu", cpBridge, cpBridge.hideAgentMenu);
flash.external.ExternalInterface.addCallback("cpBridgeRejectAgentAction", cpBridge, cpBridge.rejectAgentAction);
flash.external.ExternalInterface.addCallback("cpBridgeConfigure", cpBridge, cpBridge.configure);
flash.external.ExternalInterface.addCallback("cpBridgeSnapshot", cpBridge, cpBridge.snapshot);
flash.external.ExternalInterface.addCallback("cpBridgeJoinIgloo", cpBridge, cpBridge.joinIgloo);
flash.external.ExternalInterface.addCallback("cpBridgeJoinRoom", cpBridge, cpBridge.joinRoom);
flash.external.ExternalInterface.addCallback("cpBridgeAnimate", cpBridge, cpBridge.animate);
clearInterval(cpBridge.timer);
cpBridge.timer = setInterval(cpBridge, "tick", 250);
cpBridge.emit({type:"ready", version:cpBridge.version});
