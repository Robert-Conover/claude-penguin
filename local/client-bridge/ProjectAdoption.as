package com.claudepenguin.adoption
{
   import flash.display.DisplayObject;
   import flash.display.DisplayObjectContainer;
   import flash.display.Sprite;
   import flash.events.Event;
   import flash.events.MouseEvent;
   import flash.events.TimerEvent;
   import flash.external.ExternalInterface;
   import flash.text.TextField;
   import flash.text.TextFormat;
   import flash.utils.Timer;
   import flash.utils.getQualifiedClassName;

   /**
    * Project adoption for the agent page's derived Pet Shop module.
    *
    * adoption_build.py adds one prologue to five module methods:
    * `if (ProjectAdoption.hook("<id>", this)) return;`. On the agent page the
    * page object window.ClaudePenguinAdoption (web/bridge/adoption.mjs) is
    * present and every adoption goes to a project igloo: the visitor picks the
    * destination first, buys with the original catalog and naming screens, and
    * sees the original certificate filled from the server's receipt. The
    * purchase itself is sent by the page through the AVM1 overlay as
    * p#cpadopt, never as p#pn, so nothing enters the visitor's own puffle
    * collections. Purchase hooks fail closed: an error here never falls
    * through to the native purchase.
    */
   public class ProjectAdoption
   {
      private static const PAGE:String = "window.ClaudePenguinAdoption.";
      private static const BLUE:uint = 0x087AC1;
      private static const DARK:uint = 0x003858;
      private static const LIGHT:uint = 0x79DEFF;

      private static var pen:Object;
      private static var penView:Sprite;
      private static var picker:Sprite;
      private static var banner:Sprite;
      private static var notice:Sprite;
      private static var model:Object;
      private static var poll:Timer;
      private static var destinationName:String = "";
      private static const PICKER_PAGE_SIZE:int = 5;
      private static var pickerPage:int = 0;
      private static var pendingNotice:String = "";

      public static function hook(id:String, target:Object) : Boolean
      {
         // This module is served only on the agent page. If the page glue cannot be
         // reached there, browsing stays original but the purchase never falls back
         // to upstream p#pn, which would give the visitor a puffle of its own.
         if (!projectMode()) return id == "purchase";
         try
         {
            if (id == "penReady") { penReady(target); return false; }
            if (id == "adoptClick") return adoptClick(target);
            if (id == "penAdopted") return true;
            if (id == "purchase") return purchase(target);
            if (id == "walk") { call("finish"); return true; }
         }
         catch (error:Error)
         {
            report("hook " + id + " failed: " + error.message);
            showNotice("Something went wrong. Check Your Igloos for the adoption status.");
         }
         return id != "penReady";
      }

      // ------------------------------------------------------------ page calls

      private static function projectMode() : Boolean
      {
         if (!ExternalInterface.available) return false;
         try { return call("session") != null; }
         catch (error:Error) { return false; }
         return false;
      }

      private static function call(name:String, ... args) : Object
      {
         return ExternalInterface.call.apply(null, [PAGE + name].concat(args));
      }

      private static function report(message:String) : void
      {
         try { ExternalInterface.call("console.warn", "claude-penguin adoption: " + message); } catch (ignored:Error) {}
      }

      // ------------------------------------------------------------ hooks

      private static function penReady(target:Object) : void
      {
         pen = target;
         penView = target.view as Sprite;
         penView.addEventListener(Event.REMOVED_FROM_STAGE, onClosed);
         // After the mediator finishes its own setup: project igloos never get Rainbow or Gold.
         penView.addEventListener(Event.ENTER_FRAME, afterPenSetup);
         showPicker();
      }

      private static function afterPenSetup(event:Event) : void
      {
         penView.removeEventListener(Event.ENTER_FRAME, afterPenSetup);
         var view:Object = penView;
         for each (var name:String in ["btnRainbowPoster", "btnGoldPoster"])
         {
            try { view[name].visible = false; } catch (ignored:Error) {}
         }
      }

      private static function onClosed(event:Event) : void
      {
         if (poll != null) { poll.stop(); poll = null; }
         if (penView != null) penView.removeEventListener(Event.REMOVED_FROM_STAGE, onClosed);
         hideNotice();
         pen = null;
         penView = null;
         picker = banner = notice = null;
         model = null;
         pendingNotice = "";
         try { call("closed"); } catch (error:Error) { report("closed failed: " + error.message); }
      }

      private static function adoptClick(target:Object) : Boolean
      {
         var session:Object = call("session");
         var chosen:Object = session == null ? null : find(session.destinations, session.chosen);
         if (chosen == null) { showPicker(); return true; }
         if (Number(chosen.puffles) + Number(chosen.pending) >= Number(chosen.capacity))
         {
            // The module's own "too many puffles" message.
            target.adoptionSignalBus.sendError.dispatch(440);
            return true;
         }
         if (chosen.available != true) { showNotice(String(chosen.reason)); return true; }
         return false;
      }

      private static function purchase(target:Object) : Boolean
      {
         if (poll != null) return true;
         var selected:Object = target.selectedPuffle;
         var typeId:int = 0;
         var subtypeId:int = 0;
         if (selected.subType != null)
         {
            subtypeId = int(selected.subType.id);
            typeId = int(selected.subType.baseTypeId);
         }
         else typeId = int(selected.type.value);
         var started:Object = call("buy", typeId, subtypeId, String(selected.name));
         if (started == null || started.ok != true)
         {
            if (started != null && started.code == "441") target.invalidNameSelected.dispatch();
            showNotice(started == null ? "Your puffles are offline." : String(started.message));
            return true;
         }
         model = target;
         pendingNotice = "";
         showNotice("Sending your puffle to its igloo...");
         poll = new Timer(250);
         poll.addEventListener(TimerEvent.TIMER, checkPurchase);
         poll.start();
         return true;
      }

      private static function checkPurchase(event:TimerEvent) : void
      {
         var status:Object = call("status");
         if (status == null) return;
         if (status.state == "pending")
         {
            var message:String = status.message == null ? "" : String(status.message);
            if (message != "" && message != pendingNotice)
            {
               pendingNotice = message;
               showNotice(message);
            }
            return;
         }
         pendingNotice = "";
         poll.stop();
         poll = null;
         hideNotice();
         var target:Object = model;
         model = null;
         if (target == null) return;
         if (status.state == "done")
         {
            var receipt:Object = status.receipt;
            var selected:Object = target.selectedPuffle;
            selected.id = int(receipt.puffleId);
            selected.name = String(receipt.name);
            selected.adoptionDate = new Date(Number(receipt.createdAt) * 1000);
            destinationName = String(status.destination);
            target.puffleAdopted.dispatch();
            certificateFor(String(receipt.name));
            return;
         }
         if (status.code == "401") target.notEnoughCoins.dispatch();
         else if (status.code == "441") target.invalidNameSelected.dispatch();
         else if (status.code == "440") { target.signalBus.sendError.dispatch(440); return; }
         showNotice(String(status.message));
      }

      // ------------------------------------------------------------ certificate

      /** The original certificate lists supplies; project adoption grants none. */
      private static function certificateFor(name:String) : void
      {
         var congrats:Object = findView(penView, "PuffleCongratsView");
         if (congrats == null) return;
         var adjust:Function = function(... ignored) : void {
            for each (var field:String in ["item1", "item2", "item1_Txt", "item2_Txt", "item1Amount_Txt", "item2Amount_Txt", "description_Txt"])
            {
               try { congrats[field].visible = false; } catch (ignored2:Error) {}
            }
            try { congrats.whereRegularPuffle_Txt.text = name + " is waiting for you in " + destinationName + "."; } catch (ignored3:Error) {}
            try { congrats.whereWildPuffle_Txt.text = name + " is waiting for you in " + destinationName + "."; } catch (ignored4:Error) {}
         };
         try { congrats.onCompleted.add(adjust); } catch (ignored5:Error) {}
         var later:Timer = new Timer(600, 3);
         later.addEventListener(TimerEvent.TIMER, adjust);
         later.start();
      }

      private static function findView(root:DisplayObjectContainer, suffix:String) : Object
      {
         if (root == null) return null;
         for (var i:int = 0; i < root.numChildren; i++)
         {
            var child:DisplayObject = root.getChildAt(i);
            var type:String = getQualifiedClassName(child);
            if (type.length >= suffix.length && type.substr(type.length - suffix.length) == suffix) return child;
            if (child is DisplayObjectContainer)
            {
               var found:Object = findView(child as DisplayObjectContainer, suffix);
               if (found != null) return found;
            }
         }
         return null;
      }

      // ------------------------------------------------------------ destination picker

      private static function find(list:Object, projectId:Object) : Object
      {
         if (list == null || projectId == null || projectId == "") return null;
         for (var i:int = 0; i < list.length; i++) if (list[i].projectId == projectId) return list[i];
         return null;
      }

      private static function text(value:String, size:int, color:uint, bold:Boolean, width:int, height:int) : TextField
      {
         var field:TextField = new TextField();
         var format:TextFormat = new TextFormat("Arial", size, color, bold);
         field.defaultTextFormat = format;
         field.selectable = false;
         field.mouseEnabled = false;
         field.wordWrap = true;
         field.width = width;
         field.height = height;
         field.text = value;
         return field;
      }

      private static function box(target:Sprite, x:Number, y:Number, w:Number, h:Number, fill:uint, line:uint, radius:Number) : void
      {
         target.graphics.lineStyle(2, line);
         target.graphics.beginFill(fill);
         target.graphics.drawRoundRect(x, y, w, h, radius, radius);
         target.graphics.endFill();
      }

      private static function button(label:String, width:int, handler:Function) : Sprite
      {
         var clip:Sprite = new Sprite();
         box(clip, 0, 0, width, 30, 0x168BD0, DARK, 14);
         var field:TextField = text(label, 14, 0xFFFFFF, true, width, 22);
         field.y = 5;
         var format:TextFormat = field.defaultTextFormat;
         format.align = "center";
         field.setTextFormat(format);
         clip.addChild(field);
         clip.buttonMode = true;
         clip.useHandCursor = true;
         clip.addEventListener(MouseEvent.CLICK, handler);
         return clip;
      }

      private static function setModal(visible:Boolean) : void
      {
         try { Object(penView).modalClip.visible = visible; } catch (ignored:Error) {}
      }

      private static function showPicker(focusChosen:Boolean = true) : void
      {
         if (penView == null) return;
         hidePicker();
         var session:Object = call("session");
         var destinations:Object = session == null ? [] : session.destinations;
         var total:int = destinations == null ? 0 : destinations.length;
         var pages:int = Math.max(1, Math.ceil(total / PICKER_PAGE_SIZE));
         // Reopening Change follows the chosen identity, even if the list was reordered.
         if (focusChosen && session != null && session.chosen != null && session.chosen != "")
         {
            for (var chosenIndex:int = 0; chosenIndex < total; chosenIndex++)
            {
               if (destinations[chosenIndex].projectId == session.chosen)
               {
                  pickerPage = Math.floor(chosenIndex / PICKER_PAGE_SIZE);
                  break;
               }
            }
         }
         // The list can shrink between button presses; never render an empty stale page.
         pickerPage = Math.max(0, Math.min(pickerPage, pages - 1));
         var offset:int = pickerPage * PICKER_PAGE_SIZE;
         var rows:int = Math.min(PICKER_PAGE_SIZE, total - offset);
         var message:String = session == null ? "Your puffles are offline." : String(session.message);
         if (message == "" && total == 0) message = "Add a project in Your Igloos first. Each project gets its own igloo.";
         var rowTop:int = message == "" ? 96 : 140;
         // Five rows, notice and both footer rows fit in the native 760 x 480 stage.
         var height:int = rowTop + Math.max(1, rows) * 44 + 88;
         picker = new Sprite();
         setModal(true);
         var card:Sprite = new Sprite();
         box(card, -3, -3, 466, height + 6, 30, 0xFFFFFF, 30);
         box(card, 0, 0, 460, height, BLUE, LIGHT, 26);
         card.x = 150;
         card.y = Math.max(20, 240 - height / 2);
         picker.addChild(card);
         var title:TextField = text("Which igloo will this puffle join?", 20, 0xFFFFFF, true, 400, 30);
         title.x = 24;
         title.y = 18;
         card.addChild(title);
         var subtitle:TextField = text("Each project igloo holds up to 10 coding puffles. You pay with your own coins.", 12, 0xE6F6FF, false, 410, 34);
         subtitle.x = 24;
         subtitle.y = 52;
         card.addChild(subtitle);
         if (message != "")
         {
            var note:TextField = text(message, 13, 0xFFF4B8, true, 410, 40);
            note.x = 24;
            note.y = 92;
            card.addChild(note);
         }
         for (var i:int = 0; i < rows; i++)
         {
            var item:Object = destinations[offset + i];
            var row:Sprite = new Sprite();
            var open:Boolean = item.available == true && session.connected == true;
            box(row, 0, 0, 412, 38, open ? 0xF5FBFE : 0xC9D9E4, 0x00538E, 14);
            var label:TextField = text(String(item.name), 15, open ? 0x002849 : 0x52687A, true, 250, 22);
            label.x = 14;
            label.y = 3;
            row.addChild(label);
            var count:TextField = text(item.puffles + " of " + item.capacity + " puffles", 11, 0x254356, false, 130, 18);
            count.x = 270;
            count.y = 4;
            row.addChild(count);
            var detail:TextField = text(open ? (item.projectId == session.chosen ? "Selected igloo" : "Choose this igloo") : String(item.reason), 10, 0x254356, false, 390, 16);
            detail.x = 14;
            detail.y = 21;
            row.addChild(detail);
            row.x = 24;
            row.y = rowTop + i * 44;
            if (open)
            {
               row.buttonMode = true;
               row.name = String(item.projectId);
               row.addEventListener(MouseEvent.CLICK, choose);
            }
            card.addChild(row);
         }
         var previous:Sprite = button("Previous", 110, previousPickerPage);
         previous.x = 24;
         previous.y = height - 78;
         previous.mouseEnabled = previous.buttonMode = previous.useHandCursor = pickerPage > 0;
         previous.mouseChildren = false;
         previous.alpha = pickerPage > 0 ? 1 : 0.45;
         card.addChild(previous);
         var pageLabel:TextField = text("Page " + (pickerPage + 1) + " of " + pages, 13, 0xFFFFFF, true, 170, 24);
         pageLabel.x = 148;
         pageLabel.y = height - 72;
         var pageFormat:TextFormat = pageLabel.defaultTextFormat;
         pageFormat.align = "center";
         pageLabel.setTextFormat(pageFormat);
         card.addChild(pageLabel);
         var next:Sprite = button("Next", 110, nextPickerPage);
         next.x = 326;
         next.y = height - 78;
         next.mouseEnabled = next.buttonMode = next.useHandCursor = pickerPage < pages - 1;
         next.mouseChildren = false;
         next.alpha = pickerPage < pages - 1 ? 1 : 0.45;
         card.addChild(next);
         var close:Sprite = button("Close", 110, closeModule);
         close.x = 175;
         close.y = height - 38;
         card.addChild(close);
         penView.addChild(picker);
      }

      private static function previousPickerPage(event:MouseEvent) : void
      {
         pickerPage--;
         showPicker(false);
      }

      private static function nextPickerPage(event:MouseEvent) : void
      {
         pickerPage++;
         showPicker(false);
      }

      private static function hidePicker() : void
      {
         if (picker != null && picker.parent != null) picker.parent.removeChild(picker);
         picker = null;
         setModal(false);
      }

      private static function choose(event:MouseEvent) : void
      {
         var result:Object = call("choose", Sprite(event.currentTarget).name);
         if (result == null || result.ok != true) { showNotice(result == null ? "Your puffles are offline." : String(result.message)); return; }
         hidePicker();
         showBanner(result.destination);
      }

      private static function closeModule(event:MouseEvent) : void
      {
         hidePicker();
         try { pen.closeModule.dispatch(pen.context.contextView); } catch (error:Error) { report("close failed: " + error.message); }
      }

      private static function showBanner(destination:Object) : void
      {
         if (banner != null && banner.parent != null) banner.parent.removeChild(banner);
         banner = new Sprite();
         box(banner, 0, 0, 330, 34, BLUE, LIGHT, 18);
         var label:TextField = text("Adopting for " + destination.name + " (" + destination.puffles + " of " + destination.capacity + ")", 12, 0xFFFFFF, true, 230, 20);
         label.x = 12;
         label.y = 8;
         banner.addChild(label);
         var change:Sprite = button("Change", 76, function(event:MouseEvent) : void { showPicker(); });
         change.scaleX = change.scaleY = 0.8;
         change.x = 262;
         change.y = 5;
         banner.addChild(change);
         banner.x = 16;
         banner.y = 438;
         penView.addChild(banner);
      }

      private static function showNotice(message:String) : void
      {
         if (penView == null) return;
         hideNotice();
         notice = new Sprite();
         box(notice, 0, 0, 420, 54, 0xFFF4B8, DARK, 18);
         var field:TextField = text(message, 13, 0x002849, true, 396, 44);
         field.x = 12;
         field.y = 8;
         notice.addChild(field);
         notice.x = 170;
         notice.y = 8;
         notice.buttonMode = true;
         notice.addEventListener(MouseEvent.CLICK, function(event:MouseEvent) : void { hideNotice(); });
         penView.addChild(notice);
      }

      private static function hideNotice() : void
      {
         if (notice != null && notice.parent != null) notice.parent.removeChild(notice);
         notice = null;
      }
   }
}
