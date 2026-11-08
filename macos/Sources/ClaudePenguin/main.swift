import AppKit

// A closed controller pipe must surface as a write error, never as a fatal SIGPIPE.
signal(SIGPIPE, SIG_IGN)

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
