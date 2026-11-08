import AppKit

@MainActor
enum MainMenu {
    static func build(target: AppDelegate) -> NSMenu {
        let main = NSMenu()
        let name = Product.name

        // App menu
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About \(name)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        let editor = appMenu.addItem(withTitle: "Choose Editor…", action: #selector(AppDelegate.chooseEditor(_:)), keyEquivalent: "")
        editor.target = target
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide \(name)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit \(name)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        add(appMenu, titled: name, to: main)

        // Edit menu: standard responder-chain actions so the browser terminal gets Cmd-C/V/X/A.
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        add(edit, titled: "Edit", to: main)

        // View menu
        let view = NSMenu(title: "View")
        let reload = view.addItem(withTitle: "Reload", action: #selector(AppDelegate.reloadPage(_:)), keyEquivalent: "r")
        reload.target = target
        view.addItem(.separator())
        let full = view.addItem(withTitle: "Enter Full Screen", action: #selector(AppDelegate.toggleFullScreenWindow(_:)), keyEquivalent: "f")
        full.keyEquivalentModifierMask = [.command, .control]
        full.target = target
        add(view, titled: "View", to: main)

        // Window menu
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(.separator())
        let show = windowMenu.addItem(withTitle: name, action: #selector(AppDelegate.showMainWindow(_:)), keyEquivalent: "0")
        show.target = target
        add(windowMenu, titled: "Window", to: main)
        NSApp.windowsMenu = windowMenu

        // Help menu
        let help = NSMenu(title: "Help")
        let log = help.addItem(withTitle: "Show Controller Log", action: #selector(AppDelegate.showControllerLog(_:)), keyEquivalent: "")
        log.target = target
        let data = help.addItem(withTitle: "Show Data Folder", action: #selector(AppDelegate.showDataFolder(_:)), keyEquivalent: "")
        data.target = target
        add(help, titled: "Help", to: main)
        NSApp.helpMenu = help

        return main
    }

    private static func add(_ menu: NSMenu, titled title: String, to main: NSMenu) {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.submenu = menu
        menu.title = title
        main.addItem(item)
    }
}
